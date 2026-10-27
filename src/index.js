/**
 * dsh-obsidian-vault host 半边：
 * 挂载在 DSH webserver 上的 /obsidian/* 文件路由，
 * 所有读写被 realpath 包含性校验收窄到当前配置的 Vault 根内。
 * 例外是 /obsidian/vendor/*：懒加载的第三方静态资源（KaTeX/mermaid），
 * 只读插件自身的 lib/vendor，不碰 Vault（版本/许可/体积见 lib/vendor/README.md）。
 */
import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile, rename, unlink, stat, realpath, lstat, mkdir, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defaultVaultRoot, readSettings, resolveVaultRoot, setAttachmentDir, setVaultRoot, updateSettings, ATTACHMENT_MODES } from "./vault-store.js";
import { SESSION_DELETE_LIMIT, isValidSessionId, purgeSession, sessionArtifactsPresent } from "./session-store.js";

const MAX_READ = 1024 * 1024;           // 单篇笔记读取上限 1MB
const MAX_WRITE = 1024 * 1024;          // 单篇笔记写入上限 1MB
const MAX_BODY = MAX_WRITE + 64 * 1024;
const ATTACH_MAX = 20 * 1024 * 1024;    // 附件写入上限 20MB（截图常超 1MB，独立上限）
const ATTACH_BODY = ATTACH_MAX + 64 * 1024;
const SESSION_BODY = 64 * 1024;         // 会话删除请求体上限（id 列表）
const SEARCH_LIMIT = 4000;              // 搜索最多扫描的文件数
const SEARCH_RESULT_LIMIT = 100;
const EMBED_SEARCH_LIMIT = 4000;        // embed 目标「后缀匹配」最多扫描的文件数
const NOTE_EXT = ".md";
const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
// 「图片/附件目录」判定用的扩展名集合（图片 + svg）
const ASSET_EXT = new Set([...Object.keys(IMAGE_MIME), ".svg"]);

// 媒体嵌入（M19）的读取白名单：音频/视频/PDF。`/obsidian/file` GET 免
// `x-dsh-obsidian` 头只对白名单 MIME 生效（其它扩展在路由内部返回 400，读不到字节）；
// SVG 继续不放行（XSS）。图片仍是 IMAGE_MIME（行为保持 P1 不变）。
const MEDIA_MIME = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};
// 媒体 GET 上限：只 stat 判断、不整块读入内存（流式 + Range）；超限 413。
const FILE_GET_MAX = 256 * 1024 * 1024;

// ── vendor 静态资源（KaTeX/mermaid 懒加载；版本/许可/体积见 lib/vendor/README.md）──
// 路由形状：/obsidian/vendor/<name>/<相对 lib/vendor/<name>/ 的文件路径>，
// 例：/obsidian/vendor/katex/katex.min.js、/obsidian/vendor/katex/fonts/KaTeX_Main-Regular.woff2。
// 安全口径：只读插件自身的 lib/vendor；vendor 名与扩展名双白名单（不服务 svg/html，
// 不给 XSS 面）；路径段先字面拒绝 "."/".."/反斜杠/NUL，再做 resolve 包含性兜底。
const VENDOR_NAMES = new Set(["katex", "mermaid"]);
const VENDOR_EXT_MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};
// 插件根 = src/index.js 的上一级；不要用 cwd / DSH_HOME（宿主可能从任意目录启动）。
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDOR_ROOT = join(PLUGIN_ROOT, "lib", "vendor");
// client 懒加载时 URL 必须带 `?v=<vendor 版本>`（见 lib/vendor/README.md）：
// 带版本才允许一年 immutable 缓存；不带版本则回落 no-cache + ETag 重校验，防止升级后拿到旧脚本。
const VENDOR_IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

export const ROUTE_PREFIX = "/obsidian";

const IGNORED_DIRS = new Set([".git", "node_modules", ".obsidian", ".claudian", ".trash", ".DS_Store", "$RECYCLE.BIN", "__MACOSX"]);

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function readBody(req, cap) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) {
        // 超限：停止累积并暂停读取，让调用方**先**把 413 写回去。
        // 这里不能 req.destroy()：响应之前撕掉 socket，客户端只会看到
        // `fetch failed`，413 分支永远不可达。
        req.pause();
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 解析 JSON 请求体：语法错误归为 400（而不是 500）。 */
async function readJsonBody(req, cap) {
  const text = await readBody(req, cap);
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("body must be valid JSON"), { status: 400 });
  }
}

function isInside(canonicalRoot, abs) {
  return abs === canonicalRoot || abs.startsWith(canonicalRoot + sep);
}

/** 规范化 client 传来的 vault 相对路径（"/" 分隔），拒绝绝对路径与 ".."。 */
function normalizeRel(rel) {
  if (typeof rel !== "string") return null;
  if (rel.includes("\\")) return null;
  const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) return null;
  return parts.join(sep);
}

function isNoteName(name) {
  return typeof name === "string"
    && name.trim() !== ""
    && !/[\\/:*?"<>|]/.test(name)
    && !name.startsWith(".");
}

/** 从字节流嗅探图片扩展名（png/jpg/gif/webp），非图片返回 null。 */
function sniffImageExt(buf) {
  if (Buffer.isBuffer(buf) === false) return null;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return ".gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return null;
}

/** 生成 Obsidian 风格时间戳文件名主干：Pasted image yyyyMMdd-HHmmss-fff。 */
function pastedNameStamp(now = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `Pasted image ${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    + `-${pad(now.getMilliseconds(), 3)}`;
}

/** 若附件目录为 Vault 根则返回 ""，否则返回以 "/" 分隔的相对路径。 */
function toRelPosix(rootCanon, abs) {
  if (abs === rootCanon) return "";
  return abs.slice(rootCanon.length + 1).replaceAll(sep, "/");
}

/** 提取 markdown 中引用的图片 embed 相对路径（POSIX，去 |别名/ #章节 后缀）。 */
function imageRefs(content) {
  const set = new Set();
  if (typeof content !== "string") return set;
  const re = /!\[\[([^\]\n]+)\]\]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const raw = m[1].split("|")[0].split("#")[0].trim();
    if (IMAGE_MIME[extname(raw).toLowerCase()]) set.add(raw);
  }
  return set;
}

/** 全库扫描所有 .md 笔记引用的图片（**解析为绝对路径**），可排除指定笔记。 */
async function refsInVault(rootCanon, excludePosix, budgetLimit) {
  const refs = new Set();
  let budget = budgetLimit;
  const walk = async (dir, prefix) => {
    if (budget <= 0) return;
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (budget <= 0) return;
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(name)) await walk(full, prefix === "" ? name : `${prefix}/${name}`);
      } else if (st.isFile() && extname(name).toLowerCase() === NOTE_EXT) {
        const relPath = prefix === "" ? name : `${prefix}/${name}`;
        budget -= 1;
        if (excludePosix && relPath === excludePosix) continue;
        try {
          for (const abs of await resolvedImageRefs(rootCanon, relPath, await readFile(full, "utf8"))) refs.add(abs);
        } catch { /* ignore */ }
      }
    }
  };
  await walk(rootCanon, "");
  return refs;
}

/**
 * 解析 embed 图片目标（**与 Obsidian 的 [[...]] 解析语义对齐**），返回 Vault 内绝对
 * 路径；找不到返回 null。
 *
 * Obsidian 的 `![[...]]` 不是「相对当前笔记」，解析顺序为：
 *   1) 精确的 Vault 根相对路径（`attachments/a.png`）
 *   2) 相对「引用它的那篇笔记」所在目录（`./a.png`、`../img/a.png`）
 *   3) 路径后缀 / 文件名匹配（短链接 `a.png`、部分路径 `img/a.png`）——
 *      命中多个时取层级最浅的，与 Obsidian「shortest path when possible」一致
 *
 * 只做 1) 时，`![[附件/a.png]]`（笔记在子目录、图片在另一个子目录）会被解析成
 * `<vault>/附件/a.png` → 403 → 页面里只剩一个断图占位。
 */
async function resolveEmbedPath(rootCanon, target, fromRel) {
  const norm = normalizeRel(target);
  if (norm === null) return null;

  const candidates = [resolve(rootCanon, norm)];
  const fromNorm = typeof fromRel === "string" && fromRel !== "" ? normalizeRel(fromRel) : null;
  if (fromNorm !== null) {
    const noteAbs = resolve(rootCanon, fromNorm);
    if (isInside(rootCanon, noteAbs)) candidates.push(resolve(dirname(noteAbs), norm));
  }
  for (const c of candidates) {
    if (!isInside(rootCanon, c)) continue;
    try {
      if ((await lstat(c)).isFile()) return c;
    } catch { /* 该候选不存在，试下一个 */ }
  }

  // 后缀匹配：逐段比较路径尾部（不做字符串 endsWith，否则 `x附件/a.png` 会误命中）。
  const wantPosix = norm.split(sep).join("/");
  const wantLen = wantPosix.split("/").length;
  let best = null;
  let bestDepth = Infinity;
  let budget = EMBED_SEARCH_LIMIT;
  const walk = async (dir, prefix) => {
    if (budget <= 0) return;
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (budget <= 0) return;
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(name)) await walk(full, prefix === "" ? name : `${prefix}/${name}`);
        continue;
      }
      if (!st.isFile()) continue;
      budget -= 1;
      const relPath = prefix === "" ? name : `${prefix}/${name}`;
      const parts = relPath.split("/");
      if (parts.length < wantLen) continue;
      if (parts.slice(parts.length - wantLen).join("/") !== wantPosix) continue;
      if (parts.length < bestDepth) {
        best = full;
        bestDepth = parts.length;
      }
    }
  };
  await walk(rootCanon, "");
  return best;
}

/**
 * 文件名在 Vault 内是否唯一。
 * 用于按 Obsidian 的默认链接格式「shortest path when possible」决定 embed 目标：
 * 唯一 → 裸文件名；重名 → 退回 Vault 相对路径（仍可被后缀匹配命中）。
 */
async function isNameUniqueInVault(rootCanon, fileName) {
  let count = 0;
  let budget = EMBED_SEARCH_LIMIT;
  const walk = async (dir) => {
    if (budget <= 0 || count > 1) return;
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (budget <= 0 || count > 1) return;
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(name)) await walk(full);
        continue;
      }
      budget -= 1;
      if (name === fileName) count += 1;
    }
  };
  await walk(rootCanon);
  return count === 1;
}

/** 附件在 Vault 内的最短引用形式（Obsidian 默认链接格式「shortest path when possible」）。 */
async function embedTargetFor(rootCanon, abs) {
  const base = basename(abs);
  if (await isNameUniqueInVault(rootCanon, base)) return base;
  return abs.slice(rootCanon.length + 1).replaceAll(sep, "/");
}

/**
 * 一篇笔记里的图片引用 → Vault 内绝对路径集合（按 Obsidian 语义解析）。
 * 孤儿清理与迁移都必须基于「解析后的真实路径」，否则换个链接写法（裸文件名 /
 * 部分路径 / 相对路径）就会被误判成「已不再引用」而删掉，或判成「引用了」而漏改。
 */
async function resolvedImageRefs(rootCanon, noteRel, content) {
  const out = new Set();
  for (const r of imageRefs(content)) {
    const abs = await resolveEmbedPath(rootCanon, r, noteRel);
    if (abs !== null) out.add(abs);
  }
  return out;
}

/**
 * 按「位置模式」解析新附件的落盘目录（对齐 Obsidian 的 Default location for
 * new attachments）。返回 { dir } 或 { error, status }。
 *
 *   root  → Vault 根
 *   fixed → 设置里的固定目录（attachmentDir）
 *   note  → 与引用它的那篇笔记同目录
 *   sub   → 笔记目录下的 attachmentSubfolder 子目录
 */
async function resolveAttachmentDir(rootCanon, settings, noteRelRaw) {
  const mode = settings.attachmentMode;
  if (mode === "note" || mode === "sub") {
    const noteRel = normalizeRel(typeof noteRelRaw === "string" ? noteRelRaw : "");
    if (noteRel === null || noteRel === "") {
      return { error: "note path required for this attachment mode", status: 400 };
    }
    const noteAbs = resolve(rootCanon, noteRel);
    if (!isInside(rootCanon, noteAbs)) return { error: "path escapes vault", status: 403 };
    let dir = dirname(noteAbs);
    if (mode === "sub") {
      const subRel = normalizeRel(settings.attachmentSubfolder);
      if (subRel === null || subRel === "") return { error: "invalid attachment subfolder", status: 400 };
      dir = resolve(dir, subRel);
    }
    if (!isInside(rootCanon, dir)) return { error: "path escapes vault", status: 403 };
    return { dir };
  }
  const attachRel = normalizeRel(mode === "root" ? "" : settings.attachmentDir);
  if (attachRel === null) return { error: "invalid attachment dir", status: 403 };
  const dir = resolve(rootCanon, attachRel);
  if (!isInside(rootCanon, dir)) return { error: "invalid attachment dir", status: 403 };
  return { dir };
}

/**
 * 扫描一个目录的子树，判断它是「笔记目录」还是「图片/附件目录」。
 *
 * 通用规则：**不含任何 .md 笔记、但含有图片附件的目录，一律不显示**。
 * 不绑定「配置的附件目录」—— 附件目录设到哪儿、甚至用 note/sub 模式分散到各笔记
 * 目录下，只要那个目录是纯图片目录就隐藏；反过来，含笔记的目录即使混着图片也照常显示。
 * 空目录不算图片目录（用户刚建的空文件夹应该可见）。
 */
async function classifySubtree(dirAbs, budgetLeft = 5000) {
  const state = { hasNote: false, hasAsset: false, budget: budgetLeft };
  const walk = async (d) => {
    if (state.hasNote || state.budget <= 0) return;
    let names;
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (state.hasNote || state.budget <= 0) return;
      if (name.startsWith(".")) continue;
      const full = join(d, name);
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      state.budget -= 1;
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(name)) await walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      const ext = extname(name).toLowerCase();
      if (ext === NOTE_EXT) {
        state.hasNote = true;
        return;
      }
      if (ASSET_EXT.has(ext)) state.hasAsset = true;
    }
  };
  await walk(dirAbs);
  return { hasNote: state.hasNote, hasAsset: state.hasAsset, truncated: state.budget <= 0 };
}

/** 把附件目录从 oldRel 迁移到 newRel（均为 POSIX，"" = Vault 根）：
 *  移动旧目录下所有图片文件到新目录（冲突递增改名），删除旧目录（若空且非根），
 *  并同步改写所有笔记里的 ![[oldRel]] 引用为 ![[newRel]]。返回迁移结果。 */
async function migrateAttachments(rootCanon, oldRel, newRel) {
  const result = { moved: [], notesUpdated: [], deletedOld: false };
  const oldNorm = normalizeRel(oldRel);
  const newNorm = normalizeRel(newRel);
  if (oldNorm === null || newNorm === null) return result;
  const oldAbs = resolve(rootCanon, oldNorm);
  const newAbs = resolve(rootCanon, newNorm);
  if (!isInside(rootCanon, oldAbs) || !isInside(rootCanon, newAbs)) return result;

  let entries;
  try {
    entries = (await readdir(oldAbs, { withFileTypes: true }))
      .filter((d) => d.isFile() && IMAGE_MIME[extname(d.name).toLowerCase()]);
  } catch {
    return result;                                   // 旧目录不存在
  }
  if (entries.length === 0) return result;

  // 新旧目录指向同一真实目录（不同 rel 表示同一处）→ 无需迁移
  let sameDir = false;
  try {
    const rOld = await realpath(oldAbs);
    const rNew = await realpath(newAbs).catch(() => null);
    sameDir = rNew === rOld;
  } catch { sameDir = false; }
  if (sameDir) return result;

  await mkdir(newAbs, { recursive: true });
  const map = new Map();                             // oldRelPosix -> newRelPosix
  for (const d of entries) {
    const base = d.name;
    const oldRelPosix = oldNorm === "" ? base : `${oldNorm.replaceAll(sep, "/")}/${base}`;
    const ext = extname(base).toLowerCase();
    const stem = base.slice(0, -ext.length);
    let finalName = base, i = 1;
    while (true) {
      try {
        await stat(join(newAbs, finalName));
      } catch (e) {
        if (e && e.code === "ENOENT") break;
        throw e;
      }
      finalName = `${stem} (${i})${ext}`;
      i += 1;
    }
    try {
      await rename(join(oldAbs, base), join(newAbs, finalName));
    } catch { continue; }                             // 单个移动失败跳过
    const newRelPosix = newNorm === "" ? finalName : `${newNorm.replaceAll(sep, "/")}/${finalName}`;
    // 映射以「绝对路径 → 绝对路径」记录：引用改写要按真实文件判断，而不是按
    // `oldRel/前缀` 做字符串替换（裸文件名 / 相对路径等写法都不含该前缀）。
    map.set(join(oldAbs, base), join(newAbs, finalName));
    result.moved.push({ from: oldRelPosix, to: newRelPosix });
  }

  if (map.size > 0) result.notesUpdated = await updateNoteRefs(rootCanon, map);

  // 删除旧目录（仅当为空，且不是 Vault 根）；非空则保留（避免误删其它内容）
  // 用 rmdir（空目录才成功，否则 ENOTEMPTY → 保留），fs.rm(recursive:false) 在 Windows 对目录返回 EISDIR。
  if (oldNorm !== "" && oldAbs !== rootCanon) {
    try {
      await rmdir(oldAbs);
      result.deletedOld = true;
    } catch { /* 非空 / 失败 → 保留 */ }
  }
  return result;
}

/**
 * 按「旧绝对路径 → 新绝对路径」映射改写全库笔记里的图片引用（原子写），
 * 返回被改写的笔记相对路径。
 *
 * 不按字符串前缀替换：`![[x.png]]`（裸文件名）、`![[img/x.png]]`（部分路径）、
 * `![[./x.png]]`（相对当前笔记）指向同一个文件时写法各异，前缀法要么漏改、
 * 要么在文件被改名为 `x (1).png` 后留下断链。这里逐条解析回真实路径再决定。
 * 文件名没变的移动，裸文件名引用本就仍然有效，此时不产生改动。
 */
async function updateNoteRefs(rootCanon, map) {
  const updated = [];
  if (map.size === 0) return updated;
  const REF_RE = /!\[\[([^\]|#\n]+)((?:[|#][^\]\n]*)?)\]\]/g;
  const walk = async (dir, prefix) => {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(name)) await walk(full, prefix === "" ? name : `${prefix}/${name}`);
        continue;
      }
      if (!st.isFile() || extname(name).toLowerCase() !== NOTE_EXT) continue;
      const relPath = prefix === "" ? name : `${prefix}/${name}`;
      let content;
      try {
        content = await readFile(full, "utf8");
      } catch {
        continue;
      }
      const hits = [...content.matchAll(REF_RE)];
      if (hits.length === 0) continue;

      let next = "";
      let cursor = 0;
      let changed = false;
      for (const m of hits) {
        next += content.slice(cursor, m.index);
        cursor = m.index + m[0].length;
        const target = m[1].trim();
        const abs = await resolveEmbedPath(rootCanon, target, relPath);
        let dest = abs === null ? undefined : map.get(abs);
        if (dest === undefined) {
          // 迁移是「先移动、后改写」，此时旧路径已经不存在，解析必然落空。
          // 退回按「旧路径的文件名」匹配：一次迁移批次内旧 basename 唯一，
          // 改名冲突只改新名（`x (1).png`），不会与旧名相撞。
          const want = basename(normalizeRel(target) ?? "");
          if (want !== "") {
            for (const [oldAbs, newAbs] of map) {
              if (basename(oldAbs) === want) {
                dest = newAbs;
                break;
              }
            }
          }
        }
        if (dest === undefined) {
          next += m[0];
          continue;
        }
        const replacement = `![[${await embedTargetFor(rootCanon, dest)}${m[2] ?? ""}]]`;
        if (replacement !== m[0]) changed = true;
        next += replacement;
      }
      next += content.slice(cursor);
      if (!changed) continue;
      try {
        const tmp = join(dirname(full), `.dsh-obsidian-${randomUUID()}.tmp`);
        await writeFile(tmp, next, "utf8");
        await rename(tmp, full);
        updated.push(relPath);
      } catch { /* 写入失败忽略 */ }
    }
  };
  await walk(rootCanon, "");
  return updated;
}

/**
 * 拆 inline YAML 列表：`[a, b]` / `["a", "b"]` → 字符串数组（去引号、trim、去空项）。
 * 只支持 Obsidian aliases 会用到的简单形状，不追求完整 YAML parser。
 */
function splitInlineYamlList(text) {
  const out = [];
  let cur = "";
  let quote = "";
  for (const ch of text) {
    if (quote !== "") {
      if (ch === quote) quote = "";
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * 从原始笔记文本解析 frontmatter 里的 `aliases`（Obsidian 别名）。
 * 兼容两种 YAML 形状（同一份 frontmatter 可以混用，容错）：
 *   aliases: [别名一, 别名二]
 *   aliases:
 *     - 别名一
 *     - 别名二
 * 返回去重后的字符串数组（保留原大小写；没有/语法不完整返回 []）。
 * 只扫开头的 frontmatter 块，不碰正文；GET note 与 search 共用。
 * @param raw - 笔记原文。
 */
function parseAliases(raw) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (fm === null) return [];
  const lines = fm[1].split(/\r?\n/);
  const aliases = [];
  const push = (value) => {
    const alias = value.trim().replace(/^["']|["']$/g, "").trim();
    if (alias !== "" && !aliases.includes(alias)) aliases.push(alias);
  };
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^aliases\s*:\s*(.*)$/.exec(lines[i]);
    if (m === null) continue;
    const inline = m[1].trim();
    if (inline !== "") {
      const inner = inline.startsWith("[") && inline.endsWith("]") ? inline.slice(1, -1) : inline;
      for (const item of splitInlineYamlList(inner)) push(item);
      continue;
    }
    // 块形式：只收集紧随其后的 `- x` 行（允许任意缩进），遇非列表行结束。
    for (let j = i + 1; j < lines.length; j += 1) {
      const item = /^\s*-\s+(.*)$/.exec(lines[j]);
      if (item === null) break;
      push(item[1]);
    }
  }
  return aliases;
}

/**
 * 解析 frontmatter（--- 包裹的 key: value 行）并提取 [[双链]]。
 * 额外返回 frontmatterRaw：开头 `---` 到闭 `---` 的原文（含其后的行尾换行，
 * CRLF 原样保留）。保存接口拿它原样拼回，客户端只回写 body 也不会丢属性。
 * `aliases` 是解析后的数组（M13：双链解析与搜索用），`frontmatter` 的形状保持不变。
 */
function parseNote(raw) {
  let body = raw;
  let frontmatterRaw = "";
  const frontmatter = {};
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
    frontmatterRaw = fm[0];
    body = raw.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      frontmatter[m[1]] = value;
    }
  }
  const links = [...new Set([...body.matchAll(/\[\[([^\]|#\n]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1].trim()))];
  return { frontmatter, frontmatterRaw, body, links, aliases: parseAliases(raw) };
}

/**
 * 解析单段 HTTP Range（RFC 9110 `bytes=` 单区间），供 `/obsidian/file` 媒体读取用。
 * 返回：
 *   `null`             → 没有 Range / 不支持的形状（多区间、其它单位、语法错误）→ 整文件 200；
 *   `{ start, end }`   → 可满足区间（`end` 含，字节偏移）→ 206 + Content-Range；
 *   `"invalid"`        → 语法合法但不可满足（起始越界、起止倒置、空文件带 Range）→ 416。
 * @param header - `req.headers.range` 原文。
 * @param size - 文件字节数。
 */
function parseByteRange(header, size) {
  if (typeof header !== "string") return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    // suffix 形式 `bytes=-N`：最后 N 字节
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    if (size === 0) return "invalid";
    if (suffix >= size) return { start: 0, end: size - 1 };
    return { start: size - suffix, end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return "invalid";
  let end;
  if (rawEnd === "") {
    end = size - 1;
  } else {
    end = Number(rawEnd);
    if (!Number.isSafeInteger(end) || end < start) return "invalid";
    if (end >= size) end = size - 1;
  }
  return { start, end };
}

/**
 * 解析 vendor 静态资源请求。只做纯字符串/路径判断，不碰文件系统。
 *
 * 不用 `new URL(req.url).pathname` 取路径：WHATWG URL 解析会先把 `..` 段规范化掉，
 * 原始路径信息就丢了；这里从原始 `req.url` 解析，先拒绝再兜底。返回：
 * `{ abs, mime }` 或 `{ status, error }`。
 * @param rawUrl - `req.url` 原文（可带 query，`?v=` 用于版本化缓存）。
 */
function resolveVendorAsset(rawUrl) {
  const rawPath = rawUrl.split("?")[0].split("#")[0];
  if (!rawPath.startsWith(`${ROUTE_PREFIX}/vendor/`)) return { status: 404, error: "not found" };
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { status: 400, error: "invalid percent-encoding" };
  }
  // 解出反斜杠/NUL 或任何 "." / ".." 段一律拒绝（双保险之一；resolve 包含性校验是另一道）。
  if (decoded.includes("\\") || decoded.includes("\0")) return { status: 403, error: "invalid path" };
  const parts = decoded.split("/").filter((p) => p !== "");
  // parts = ["obsidian", "vendor", <name>, ...<file segments>]
  if (parts.length < 4 || parts[0] !== "obsidian" || parts[1] !== "vendor") {
    return { status: 404, error: "not found" };
  }
  const name = parts[2];
  if (!VENDOR_NAMES.has(name)) return { status: 404, error: "not found" };
  const segments = parts.slice(3);
  if (segments.some((s) => s === "." || s === ".." || s.includes("/"))) {
    return { status: 403, error: "invalid path" };
  }
  const mime = VENDOR_EXT_MIME[extname(segments[segments.length - 1]).toLowerCase()];
  if (mime === undefined) return { status: 404, error: "not found" };
  const root = join(VENDOR_ROOT, name);
  const abs = resolve(root, ...segments);
  if (abs !== root && !abs.startsWith(root + sep)) return { status: 403, error: "invalid path" };
  return { abs, mime };
}

/**
 * 构造 /obsidian/* 的请求处理器。
 * @param options - 可选依赖注入。
 * @param options.getAgents - 惰性返回 host agent 注册表（`ctx.agents`，
 *   `AgentRegistry`）。删除会话的活性判据只用它：`agents.get(id)?.status
 *   === "running"` 与 Host 自己算 `running` 的口径一致。缺失或抛错时
 *   **拒绝删除**（fail closed）。
 * @param options.getSessions - 惰性返回 host 活跃会话注册表（`ctx.sessions`，
 *   `SessionStore`）。只用于在响应里回执「删掉的 id 里还有哪些仍被进程持有
 *   内存副本」（`attached`），不作为拒绝删除的依据。
 * @param options.getSessionQuery - 惰性返回 host 会话查询服务（`ctx.sessionQuery`，
 *   `SessionQueryEngine`）。只读的 `/session-state` 用它判定「这些 id 在磁盘上
 *   还有没有日志」：它的 `listSessions()` 记录自带 `persisted` 标记，正是
 *   「durable 日志存在」的权威口径（不依赖本插件镜像的路径布局）。缺失时该路由
 *   返回 `{ available: false }`，前端不做任何隐藏（fail soft：只读探测不该
 *   因为服务缺失而误判）。
 * @returns Node http 处理器。
 */
export function createHandler(options = {}) {
  const getAgents = typeof options.getAgents === "function" ? options.getAgents : () => undefined;
  const getSessions = typeof options.getSessions === "function" ? options.getSessions : () => undefined;
  const getSessionQuery = typeof options.getSessionQuery === "function" ? options.getSessionQuery : () => undefined;
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://internal");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "obsidian" || parts.length < 2) return send(res, 404, { error: "not found" });
      const action = parts[1];

      // `/vendor/*` 是懒加载的静态第三方资源（KaTeX/mermaid）：只读插件自身的
      // `lib/vendor`，GET 免 `x-dsh-obsidian` 头——`<script src>`/`<link>`/`@font-face`
      // 这些浏览器发起的子资源请求带不了自定义头。必须放在通用 header 校验之前，
      // 且非 GET 一律 405（没有写操作，不涉及数据）。
      if (action === "vendor") {
        if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
        const asset = resolveVendorAsset(req.url ?? "/");
        if (asset.abs === undefined) return send(res, asset.status, { error: asset.error });
        let vst;
        try {
          vst = await stat(asset.abs);
        } catch (error) {
          if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
            return send(res, 404, { error: "not found" });
          }
          throw error;
        }
        if (!vst.isFile()) return send(res, 404, { error: "not found" });
        // client 懒加载 URL 带 `?v=<版本>` 时按 immutable 缓存；不带版本则 no-cache +
        // ETag 重校验（升级 vendor 后不会拿到一年前的旧脚本）。
        const versioned = url.searchParams.has("v");
        const etag = `"${vst.size.toString(16)}-${Math.floor(vst.mtimeMs).toString(16)}"`;
        const cacheControl = versioned ? VENDOR_IMMUTABLE_CACHE : "no-cache";
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { etag, "cache-control": cacheControl });
          res.end();
          return;
        }
        const buf = await readFile(asset.abs);
        res.writeHead(200, {
          "content-type": asset.mime,
          "content-length": String(buf.length),
          "cache-control": cacheControl,
          "x-content-type-options": "nosniff",
          etag,
        });
        res.end(buf);
        return;
      }

      // 附件读取（file GET）由 <img>/<audio>/<video>/<iframe> 直接加载（媒体还会发
      // Range 请求），浏览器无法携带自定义头，故豁免 header 校验；路由内部只放行
      // IMAGE_MIME / MEDIA_MIME 白名单，其它扩展返回 400（读不到字节），路径照旧
      // 收窄在 vault 根内。其余 /obsidian/* 写读操作仍强制要求 x-dsh-obsidian: 1。
      const isFileRead = action === "file" && req.method === "GET";
      if (!isFileRead && req.headers["x-dsh-obsidian"] !== "1") {
        return send(res, 403, { error: "missing x-dsh-obsidian header" });
      }
      const rel = url.searchParams.get("path") ?? "";

      // 只读附件设置；供 /root 回显与各分支共用。
      const settings = await readSettings();
      const attachmentDir = settings.attachmentDir ?? "attachments";
      const attachSettings = {
        attachmentDir,
        attachmentMode: settings.attachmentMode,
        attachmentSubfolder: settings.attachmentSubfolder,
        hideAttachmentDir: settings.hideAttachmentDir,
        deleteOrphanAttachments: settings.deleteOrphanAttachments,
      };

      // `/root` is self-managed: GET reports the resolved vault root, POST
      // (re)sets it. Handle it before the existence short-circuit below so a
      // missing current root cannot block setting a new one — the panel must be
      // configurable before any vault directory exists yet.
      if (action === "root") {
        if (req.method === "POST") {
          const body = JSON.parse(await readBody(req, 64 * 1024));
          const next = await setVaultRoot(String(body && body.root ? body.root : ""));
          return send(res, 200, { root: next, exists: true, ...attachSettings });
        }
        const current = await resolveVaultRoot();
        let currentCanon;
        try {
          currentCanon = await realpath(current);
          const st = await stat(currentCanon);
          if (!st.isDirectory()) throw new Error("not a directory");
        } catch {
          return send(res, 200, { root: current, exists: false, attachmentDir });
        }
        return send(res, 200, { root: currentCanon, exists: true, ...attachSettings });
      }

      // `/session-delete` is vault-independent: deleting a session's log has
      // nothing to do with the configured note vault, so it must be handled
      // before the vault-existence short-circuit below — otherwise a missing or
      // misconfigured vault would silently disable deletion.
      if (action === "session-delete") {
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        const body = await readJsonBody(req, SESSION_BODY);
        const raw = body && Array.isArray(body.ids) ? body.ids : null;
        if (raw === null || raw.length === 0) return send(res, 400, { error: "body must be { ids: string[] }" });
        if (raw.length > SESSION_DELETE_LIMIT) {
          return send(res, 413, { error: `too many ids (limit ${SESSION_DELETE_LIMIT})` });
        }
        const ids = [...new Set(raw)];
        const invalid = ids.filter((id) => !isValidSessionId(id));
        if (invalid.length > 0) return send(res, 400, { error: `invalid session id: ${String(invalid[0])}` });

        // 活性护栏：**只有真正在跑的会话**才拒绝删除。
        //
        // 判据不能是 `ctx.sessions.get(id) !== undefined`：那只说明会话被载入过
        // 内存（打开一次就驻留到进程退出，Host 没有释放接口），与「在跑」无关。
        // 用它当活性会让任何打开过的会话永远删不掉，提示却是「已被打开或正在
        // 运行」——用户看到的是一条早已结束的会话记录无法删除。
        // 唯一与 Host 一致的口径是它自己算 `running` 用的表达式：
        // `ctx.agents.get(id)?.status === "running"`（见 api-session-controller
        // 的 summaryFor）。在跑（含在跑的子代理，它们各自是独立 id）就拒绝；
        // 只是驻留内存则放行。
        //
        // 判不准时仍然 fail closed：这是不可恢复的破坏性操作，fail-open 等于
        // 拿用户的历史去赌一个 `undefined`。曾出现会话注册表 `get()` 抛错被判成
        // 「不在跑」，活会话的日志被真删掉的情形。
        const agents = getAgents();
        if (agents === undefined || agents === null || typeof agents.get !== "function") {
          return send(res, 503, {
            error: "session liveness service unavailable; refusing to delete",
            deleted: [],
          });
        }
        const running = [];
        const unknown = [];
        for (const id of ids) {
          try {
            if (agents.get(id)?.status === "running") running.push(id);
          } catch (error) {
            unknown.push(id);
          }
        }
        if (running.length > 0 || unknown.length > 0) {
          return send(res, 409, {
            error: unknown.length > 0 ? "session liveness unknown; refusing to delete" : "session is running",
            running,
            unknown,
            deleted: [],
          });
        }

        // 仅用于回执：删掉的（或磁盘上本来就没有日志的）id 里哪些仍被本进程持有
        // 内存副本。这些行的日志已经从磁盘消失，但 Host 的会话列表仍会列出它们
        // （列表优先用内存里的会话），直到 DSH 重启 —— 前端据此隐藏行并说明原因。
        // `missing` 也要一并回执：日志早在别处删过时，行同样是靠内存副本撑着的。
        const sessions = getSessions();
        const isAttached = (id) => {
          if (sessions === undefined || sessions === null || typeof sessions.get !== "function") return false;
          try {
            return sessions.get(id) !== undefined;
          } catch {
            return false;
          }
        };

        const deleted = [];
        const missing = [];
        const failed = [];
        const attached = [];
        const cacheResidue = [];
        let sessionsDir = "";
        for (const id of ids) {
          try {
            const result = await purgeSession(id);
            sessionsDir = result.root;
            if (result.dirs.length === 0) {
              missing.push(id);
              if (isAttached(id)) attached.push(id);
              continue;
            }
            // 报成功前必须回读确认**会话目录**真的不在了 —— 调用方（以及用户）
            // 据此相信「彻底删除」，所以不能只看 rm 有没有抛错。
            //
            // 投影缓存单独存在不算失败：它是派生数据（DSH 按需重建），而且对一个
            // 仍驻留内存的会话，删除后它随时可能被再写一次；列表来自日志枚举，
            // 光有缓存不会让会话回到列表。只把残留如实回执，便于排查。
            const left = await sessionArtifactsPresent(id);
            if (left.present && left.reason === "session directory") {
              failed.push({ id, error: `still present after removal: ${left.reason}` });
              continue;
            }
            deleted.push(id);
            if (left.present) cacheResidue.push(id);
            if (isAttached(id)) attached.push(id);
          } catch (error) {
            failed.push({ id, error: error && error.message ? error.message : String(error) });
          }
        }
        return send(res, 200, {
          deleted,
          missing,
          failed,
          attached,
          cacheResidue,
          root: sessionsDir,
          verified: failed.length === 0,
        });
      }

      // `/session-state` is read-only and vault-independent, exactly like
      // `/session-delete` above: it answers "do these session ids still have a
      // **durable** log, and is each one running?".
      //
      // 用途：Host 的会话列表优先用内存里的会话，所以日志早已被删掉的会话会一直
      // 列在侧边栏里 —— 表现为「删过的记录还在前端显示，再点删除却说没有可删除
      // 的会话」。前端本地墓碑只能记住「本浏览器、本插件、带墓碑之后」删掉的 id，
      // 更早删的（或别的客户端删的）救不回来；这里用 Host 自己的权威口径补上：
      // `sessionQuery.listSessions()` 的每条记录都带 `persisted`（磁盘上有
      // durable 日志）与 `live`（内存里有副本）标记。
      //
      // 只读、且**必须 fail soft**：查询服务缺失或抛错时返回
      // `{ available: false }`，前端据此什么都不隐藏（误隐藏真实会话远比多显示
      // 一行严重）。活性判不准（agents 缺失/抛错）时按「在跑」处理，同样不隐藏。
      if (action === "session-state") {
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        const body = await readJsonBody(req, SESSION_BODY);
        const raw = body && Array.isArray(body.ids) ? body.ids : null;
        if (raw === null || raw.length === 0) return send(res, 400, { error: "body must be { ids: string[] }" });
        if (raw.length > SESSION_DELETE_LIMIT) {
          return send(res, 413, { error: `too many ids (limit ${SESSION_DELETE_LIMIT})` });
        }
        const ids = [...new Set(raw)];
        const invalid = ids.filter((id) => !isValidSessionId(id));
        if (invalid.length > 0) return send(res, 400, { error: `invalid session id: ${String(invalid[0])}` });

        const query = getSessionQuery();
        const agents = getAgents();
        if (query === undefined || query === null || typeof query.listSessions !== "function"
          || agents === undefined || agents === null || typeof agents.get !== "function") {
          return send(res, 200, { available: false, items: [] });
        }
        let records;
        try {
          records = await query.listSessions();
        } catch {
          return send(res, 200, { available: false, items: [] });
        }
        const known = new Map();
        for (const record of Array.isArray(records) ? records : []) {
          const id = record && record.header ? record.header.id : undefined;
          if (typeof id === "string") known.set(id, record);
        }
        const items = ids.map((id) => {
          const record = known.get(id);
          let running = true;
          try {
            running = agents.get(id)?.status === "running";
          } catch {
            // 判不准 → 当作在跑：宁可多留一行，也不隐藏可能还活着的会话。
            running = true;
          }
          return {
            id,
            // `known`：Host 的权威列表里是否还列着它。没列的话前端本来就不会渲染，
            // 也就无所谓隐藏；带上它便于排查。
            known: record !== undefined,
            persisted: record !== undefined && record.persisted === true,
            live: record !== undefined && record.live === true,
            running,
          };
        });
        return send(res, 200, { available: true, items });
      }

      const root = await resolveVaultRoot();
      let rootCanon;
      try {
        rootCanon = await realpath(root);
        const st = await stat(rootCanon);
        if (!st.isDirectory()) throw new Error("not a directory");
      } catch {
        return send(res, 200, { root, exists: false });
      }
      const relNorm = normalizeRel(rel);
      const resolveInside = () => {
        if (relNorm === null) return null;
        return resolve(rootCanon, relNorm);
      };
      const ensureContained = async (abs) => {
        try {
          return isInside(rootCanon, await realpath(abs));
        } catch (error) {
          const code = error && error.code;
          if (code === "ENOENT") {
            try {
              return isInside(rootCanon, await realpath(dirname(abs)));
            } catch {
              return false;
            }
          }
          return false;
        }
      };
      const guarded = async (abs) => {
        if (abs === null || !(await ensureContained(abs))) {
          throw Object.assign(new Error("path escapes vault"), { status: 403 });
        }
        return abs;
      };

      switch (action) {
        // ── 上传粘贴的图片到附件目录并返回 embed 相对路径 ─────────────
        case "attach": {
          if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
          const body = JSON.parse(await readBody(req, ATTACH_BODY));
          if (!body || typeof body.data !== "string" || body.data === "") {
            return send(res, 400, { error: "body must be { data }" });
          }
          let buf;
          try {
            buf = Buffer.from(body.data, "base64");
          } catch {
            return send(res, 400, { error: "invalid base64 data" });
          }
          if (buf.length === 0) return send(res, 400, { error: "empty image data" });
          if (buf.length > ATTACH_MAX) return send(res, 413, { error: "image too large" });
          const ext = sniffImageExt(buf);
          if (ext === null) return send(res, 415, { error: "unsupported image type" });
          // 定位附件目录（按位置模式；目录不存在则自动 mkdir，含多级）。
          // 先做词法包含性校验 → mkdir recursive → 对真实路径再做一次 realpath
          // 包含性校验（防 symlink 逃逸）。
          const picked = await resolveAttachmentDir(rootCanon, settings, body.note);
          if (picked.dir === undefined) return send(res, picked.status ?? 400, { error: picked.error });
          const attachAbs = picked.dir;
          const attachRel = toRelPosix(rootCanon, attachAbs);
          await mkdir(attachAbs, { recursive: true });
          await guarded(attachAbs);
          // 生成文件名（时间戳 + 冲突递增后缀），不信任客户端给定名
          const baseName = pastedNameStamp();
          let fileName = `${baseName}${ext}`;
          let counter = 1;
          while (true) {
            try {
              await stat(join(attachAbs, fileName));
            } catch (error) {
              if (error && error.code === "ENOENT") break;
              throw error;
            }
            fileName = `${baseName} (${counter})${ext}`;
            counter += 1;
          }
          const target = join(attachAbs, fileName);
          if (!isInside(rootCanon, target)) return send(res, 403, { error: "path escapes vault" });
          const tmp = join(dirname(target), `.dsh-obsidian-${randomUUID()}.tmp`);
          try {
            await writeFile(tmp, buf);
            await rename(tmp, target);
          } catch (error) {
            await unlink(tmp).catch(() => { /* ignore */ });
            throw error;
          }
          // 返回给前端拼 `![[...]]` 的目标。按 Obsidian 默认链接格式
          // 「shortest path when possible」：文件名在 Vault 内唯一就给最短形式（裸
          // 文件名），重名才退回 Vault 相对路径。两种形式都能被 embed 解析命中，
          // 且裸文件名在附件目录迁移后依然有效（不依赖旧目录前缀）。
          const relFromRoot = attachRel === "" ? fileName : `${attachRel}/${fileName}`;
          const unique = await isNameUniqueInVault(rootCanon, fileName);
          return send(res, 200, { path: unique ? fileName : relFromRoot });
        }

        // ── 设置附件目录（相对 / Vault 内绝对 / 空=回根）；变更时自动迁移既有截图 ──
        case "attach-dir": {
          if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
          const body = JSON.parse(await readBody(req, 64 * 1024));
          const dir = typeof body === "object" && body !== null ? String(body.dir ?? "") : "";
          let newRelPosix;
          if (dir === "") {
            newRelPosix = "";
          } else if (/^[a-zA-Z]:/.test(dir) || dir.startsWith("/") || /^\\\\/.test(dir)) {
            // Vault 内绝对路径 → 换算相对路径
            const real = await realpath(dir).catch(() => null);
            if (real === null || !isInside(rootCanon, real)) {
              return send(res, 403, { error: "attachment dir must be inside vault" });
            }
            newRelPosix = toRelPosix(rootCanon, real);
          } else {
            // 相对路径：normalizeRel 校验（拒 .. / \ / 绝对）
            const relN = normalizeRel(dir);
            if (relN === null) return send(res, 403, { error: "invalid attachment dir" });
            const abs = resolve(rootCanon, relN);
            if (!isInside(rootCanon, abs)) return send(res, 403, { error: "attachment dir escapes vault" });
            newRelPosix = relN === "" ? "" : relN.replaceAll(sep, "/");
          }
          // 迁移既有截图到新目录 + 更新笔记引用（仅当目录真的改变）
          const migration = newRelPosix !== attachmentDir
            ? await migrateAttachments(rootCanon, attachmentDir, newRelPosix)
            : { moved: [], notesUpdated: [], deletedOld: false };
          await setAttachmentDir(newRelPosix);
          return send(res, 200, { attachmentDir: newRelPosix, ...migration });
        }

        // ── 附件位置模式 / 子目录名 / 隐藏目录 / 自动清理孤儿 ─────────────
        //    对应 Obsidian「Files & Links」里的附件位置与链接相关选项。
        case "attach-settings": {
          if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
          const body = await readJsonBody(req, 64 * 1024);
          const patch = {};
          if (body !== null && body.mode !== undefined) {
            const mode = String(body.mode);
            if (!ATTACHMENT_MODES.has(mode)) return send(res, 400, { error: `unknown attachment mode: ${mode}` });
            patch.attachmentMode = mode;
          }
          if (body !== null && body.subfolder !== undefined) {
            const sub = String(body.subfolder).trim();
            if (sub === "" || normalizeRel(sub) === null) {
              return send(res, 400, { error: "invalid attachment subfolder" });
            }
            patch.attachmentSubfolder = sub;
          }
          if (body !== null && body.hideAttachmentDir !== undefined) {
            patch.hideAttachmentDir = body.hideAttachmentDir === true;
          }
          if (body !== null && body.deleteOrphanAttachments !== undefined) {
            patch.deleteOrphanAttachments = body.deleteOrphanAttachments === true;
          }
          const next = await updateSettings(patch);
          return send(res, 200, {
            attachmentDir: next.attachmentDir,
            attachmentMode: next.attachmentMode,
            attachmentSubfolder: next.attachmentSubfolder,
            hideAttachmentDir: next.hideAttachmentDir,
            deleteOrphanAttachments: next.deleteOrphanAttachments,
          });
        }

        // ── 目录树（懒加载；仅目录与 .md 笔记）────────────────────────
        case "tree": {
          const abs = await guarded(resolveInside());
          const st = await stat(abs);
          if (!st.isDirectory()) return send(res, 400, { error: "not a directory" });
          const entries = [];
          const baseRel = rel === "" ? "" : rel.replaceAll(sep, "/");
          const entryRel = (name) => (baseRel === "" ? name : `${baseRel}/${name}`);
          for (const d of await readdir(abs, { withFileTypes: true })) {
            const full = join(abs, d.name);
            if (d.isDirectory()) {
              if (IGNORED_DIRS.has(d.name)) continue;
              // 把配置的附件目录从目录树隐藏（跳过其整棵子树）
              // 通用规则：不含笔记、只含图片附件的目录不显示（与附件目录设置在哪无关）
              if (settings.hideAttachmentDir === true) {
                const kind = await classifySubtree(full);
                if (!kind.hasNote && kind.hasAsset) continue;
              }
              let mtimeMs = 0;
              try {
                mtimeMs = (await lstat(full)).mtimeMs;
              } catch { /* ignore */ }
              entries.push({ name: d.name, type: "dir", size: 0, mtimeMs });
            } else if (d.isFile() && extname(d.name).toLowerCase() === NOTE_EXT) {
              let size = 0;
              let mtimeMs = 0;
              try {
                const s = await lstat(full);
                size = s.size;
                mtimeMs = s.mtimeMs;
              } catch { /* ignore */ }
              entries.push({ name: d.name, type: "note", size, mtimeMs });
            }
          }
          entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
          return send(res, 200, { path: rel, entries });
        }

        // ── 读笔记（frontmatter + 双链）──────────────────────────────
        case "note": {
          if (req.method === "POST") {
            const body = JSON.parse(await readBody(req, MAX_BODY));
            const path = body && body.path;
            const content = body && body.content;
            if (typeof path !== "string" || typeof content !== "string") {
              return send(res, 400, { error: "body must be { path, content }" });
            }
            if (Buffer.byteLength(content, "utf8") > MAX_WRITE) return send(res, 413, { error: "content too large" });
            if (content.includes("\0")) return send(res, 400, { error: "binary content not allowed" });
            if (extname(path).toLowerCase() !== NOTE_EXT) return send(res, 400, { error: "only .md notes can be written" });
            const relN = normalizeRel(path);
            if (relN === null) return send(res, 403, { error: "invalid path" });
            const target = resolve(rootCanon, relN);
            if (!isInside(rootCanon, target)) return send(res, 403, { error: "path escapes vault" });
            const parentReal = await realpath(dirname(target)).catch(() => null);
            if (parentReal === null || !isInside(rootCanon, parentReal)) {
              return send(res, 403, { error: "path escapes vault" });
            }
            // 保存前读取旧内容：既用于比较移除的图片 embed（同步删除孤儿附件），
            // 也用于取回旧 frontmatter 原样拼回 —— 编辑器只显示 body、YAML 不进
            // 客户端；服务端拼装还能取到外部 Obsidian 刚改过的属性。
            let oldContent = "";
            try {
              oldContent = await readFile(target, "utf8");
            } catch { /* 新笔记：无旧 frontmatter 可拼 */ }
            const oldFrontmatter = parseNote(oldContent).frontmatterRaw;
            // frontmatterRaw 正常带闭 `---` 后的换行；文件恰好终止于闭 `---` 时
            // 补一个同风格的换行，别把旧属性行和新正文粘在同一行。
            const fmGap = oldFrontmatter !== "" && !/[\r\n]$/.test(oldFrontmatter)
              ? (oldFrontmatter.includes("\r\n") ? "\r\n" : "\n")
              : "";
            const nextContent = oldFrontmatter + fmGap + content;
            // 拼回属性后再校验一次：body 本身没超限，加上旧属性仍可能超。
            if (Buffer.byteLength(nextContent, "utf8") > MAX_WRITE) {
              return send(res, 413, { error: "content too large" });
            }
            const tmp = join(dirname(target), `.dsh-obsidian-${randomUUID()}.tmp`);
            try {
              await writeFile(tmp, nextContent, "utf8");
              await rename(tmp, target);
            } catch (error) {
              await unlink(tmp).catch(() => { /* ignore */ });
              throw error;
            }
            // 同步删除：本次保存中被移除且全库不再被引用的图片附件。
            // 按**解析后的真实路径**比较，而不是链接字符串 —— 同一张图可能被写成
            // `x.png` / `img/x.png` / `./x.png`，字符串法会误判成「已不再引用」删掉。
            const deletedAttachments = [];
            const oldRefs = await resolvedImageRefs(rootCanon, path, oldContent);
            // 用拼回属性后的整篇内容算引用：属性里的嵌入（虽然少见）也算仍被引用。
            const newRefs = await resolvedImageRefs(rootCanon, path, nextContent);
            // 自动删除孤儿附件默认关闭（Obsidian 不自动删；误删不可恢复），
            // 需要时在附件设置里显式打开。
            const removedAbs = settings.deleteOrphanAttachments
              ? [...oldRefs].filter((abs) => !newRefs.has(abs))
              : [];
            if (removedAbs.length > 0) {
              const usedElsewhere = await refsInVault(rootCanon, path, SEARCH_LIMIT);
              for (const abs of removedAbs) {
                if (usedElsewhere.has(abs)) continue;               // 仍被其它笔记引用 → 保留
                if (!isInside(rootCanon, abs)) continue;            // 包含性兜底
                if (!IMAGE_MIME[extname(abs).toLowerCase()]) continue;
                try {
                  await unlink(abs);
                  deletedAttachments.push(abs.slice(rootCanon.length + 1).replaceAll(sep, "/"));
                } catch { /* 文件不存在或删除失败，忽略 */ }
              }
            }
            return send(res, 200, { ok: true, deletedAttachments });
          }
          const abs = await guarded(resolveInside());
          const st = await stat(abs);
          if (st.isDirectory()) return send(res, 400, { error: "is a directory" });
          if (st.size > MAX_READ) return send(res, 413, { error: "note too large to open" });
          const buf = await readFile(abs);
          if (buf.subarray(0, 8192).includes(0)) return send(res, 415, { error: "binary file" });
          const { frontmatter, body, links, aliases } = parseNote(buf.toString("utf8"));
          return send(res, 200, {
            path: rel,
            name: basename(abs),
            content: body,
            frontmatter,
            aliases,
            links,
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        }

        // ── 文件操作：new / rename / delete；GET = 读图片/媒体字节流供预览 ──
        case "file": {
          if (req.method === "GET") {
            const relN = normalizeRel(rel);
            if (relN === null) return send(res, 403, { error: "invalid path" });
            // `from` = 引用该附件/媒体的笔记相对路径；用于「相对当前笔记」的那一级解析。
            const fromRel = url.searchParams.get("from") ?? "";
            const abs = await resolveEmbedPath(rootCanon, rel, fromRel);
            if (abs === null) return send(res, 404, { error: "not found" });
            const ext = extname(abs).toLowerCase();
            const imageType = IMAGE_MIME[ext];
            const mediaType = MEDIA_MIME[ext];
            if (imageType === undefined && mediaType === undefined) {
              return send(res, 400, { error: "unsupported file type" });
            }
            // 图片：行为保持 P1 原样（整块读、不支持 Range、no-store）。
            if (imageType !== undefined) {
              let buf;
              try {
                buf = await readFile(abs);
              } catch (error) {
                if (error && error.code === "ENOENT") return send(res, 404, { error: "not found" });
                throw error;
              }
              res.writeHead(200, {
                "content-type": imageType,
                "cache-control": "no-store",
                "content-length": String(buf.length),
              });
              res.end(buf);
              return;
            }
            // 媒体（M19）：流式输出 + 单段 Range（音频/视频 seek、PDF 分块加载都需要）。
            // 只 stat 判断大小，不整块读进内存；256MB 上限防止误服务超大文件。
            let fst;
            try {
              fst = await stat(abs);
            } catch (error) {
              if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
                return send(res, 404, { error: "not found" });
              }
              throw error;
            }
            if (!fst.isFile()) return send(res, 404, { error: "not found" });
            if (fst.size > FILE_GET_MAX) return send(res, 413, { error: "file too large to stream" });
            const range = parseByteRange(req.headers["range"], fst.size);
            if (range === "invalid") {
              res.writeHead(416, {
                "content-type": "application/json; charset=utf-8",
                "content-range": `bytes */${fst.size}`,
                "accept-ranges": "bytes",
                "cache-control": "no-store",
                "content-length": "0",
              });
              res.end();
              return;
            }
            const headers = {
              "content-type": mediaType,
              "accept-ranges": "bytes",
              "cache-control": "no-store",
            };
            let stream;
            if (range === null) {
              headers["content-length"] = String(fst.size);
              stream = createReadStream(abs);
            } else {
              headers["content-length"] = String(range.end - range.start + 1);
              headers["content-range"] = `bytes ${range.start}-${range.end}/${fst.size}`;
              stream = createReadStream(abs, { start: range.start, end: range.end });
            }
            res.writeHead(range === null ? 200 : 206, headers);
            stream.on("error", () => res.destroy());
            stream.pipe(res);
            return;
          }
          const body = JSON.parse(await readBody(req, MAX_BODY));
          const op = body && body.action;
          if (op === "new") {
            const dirRel = normalizeRel(typeof body.path === "string" ? body.path : "");
            const name = isNoteName(String(body.name ?? "")) ? String(body.name).trim() : null;
            if (dirRel === null || name === null) return send(res, 400, { error: "invalid new note parameters" });
            const dirAbs = await guarded(resolve(rootCanon, dirRel));
            const st = await stat(dirAbs);
            if (!st.isDirectory()) return send(res, 400, { error: "not a directory" });
            const fileName = name.toLowerCase().endsWith(NOTE_EXT) ? name : `${name}${NOTE_EXT}`;
            const target = join(dirAbs, fileName);
            try {
              await stat(target);
              return send(res, 409, { error: "note already exists" });
            } catch { /* ENOENT: 可以创建 */ }
            const title = fileName.slice(0, -NOTE_EXT.length);
            await writeFile(target, `# ${title}\n\n`, "utf8");
            return send(res, 200, { ok: true, path: dirRel === "" ? fileName : `${dirRel.replaceAll(sep, "/")}/${fileName}` });
          }
          if (op === "mkdir") {
            const dirRel = normalizeRel(typeof body.path === "string" ? body.path : "");
            const name = isNoteName(String(body.name ?? "")) ? String(body.name).trim() : null;
            if (dirRel === null || name === null) return send(res, 400, { error: "invalid folder parameters" });
            const parentAbs = await guarded(resolve(rootCanon, dirRel));
            const st = await stat(parentAbs).catch(() => null);
            if (!st || !st.isDirectory()) return send(res, 400, { error: "not a directory" });
            const target = join(parentAbs, name);
            if (!isInside(rootCanon, target)) return send(res, 403, { error: "path escapes vault" });
            try {
              await mkdir(target);
            } catch (error) {
              if (error && error.code === "EEXIST") return send(res, 409, { error: "folder already exists" });
              throw error;
            }
            return send(res, 200, { ok: true, path: dirRel === "" ? name : `${dirRel.replaceAll(sep, "/")}/${name}` });
          }
          if (op === "rename") {
            const relN = normalizeRel(typeof body.path === "string" ? body.path : "");
            const newName = isNoteName(String(body.newName ?? "")) ? String(body.newName).trim() : null;
            if (relN === null || newName === null) return send(res, 400, { error: "invalid rename parameters" });
            const abs = await guarded(resolve(rootCanon, relN));
            const st = await stat(abs).catch(() => null);
            if (!st || st.isDirectory()) return send(res, 400, { error: "note not found" });
            const fileName = newName.toLowerCase().endsWith(NOTE_EXT) ? newName : `${newName}${NOTE_EXT}`;
            const target = join(dirname(abs), fileName);
            if (!isInside(rootCanon, target)) return send(res, 403, { error: "path escapes vault" });
            await rename(abs, target);
            return send(res, 200, { ok: true, name: fileName });
          }
          if (op === "delete") {
            const relN = normalizeRel(typeof body.path === "string" ? body.path : "");
            if (relN === null) return send(res, 400, { error: "invalid path" });
            if (relN === "") return send(res, 403, { error: "cannot delete vault root" });
            const abs = await guarded(resolve(rootCanon, relN));
            const st = await stat(abs).catch(() => null);
            if (!st) return send(res, 400, { error: "not found" });
            if (st.isDirectory()) {
              await rm(abs, { recursive: true, force: false });
            } else if (st.isFile()) {
              await unlink(abs);
            } else {
              return send(res, 400, { error: "unsupported file type" });
            }
            return send(res, 200, { ok: true, deleted: relN });
          }
          return send(res, 400, { error: `unknown action ${op}` });
        }

        // ── 标题/正文模糊搜索 ────────────────────────────────────────
        case "search": {
          const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
          if (q === "") return send(res, 200, { results: [] });
          const results = [];
          const walk = async (dir, prefix, budget) => {
            if (budget.left <= 0) return;
            let names = [];
            try {
              names = await readdir(dir);
            } catch {
              return;
            }
            for (const name of names) {
              if (budget.left <= 0) return;
              const full = join(dir, name);
              if (name.startsWith(".")) continue;
              let st;
              try {
                st = await lstat(full);
              } catch {
                continue;
              }
              if (st.isDirectory()) {
                if (!IGNORED_DIRS.has(name)) await walk(full, prefix === "" ? name : `${prefix}/${name}`, budget);
              } else if (st.isFile() && extname(name).toLowerCase() === NOTE_EXT) {
                budget.left -= 1;
                const relPath = prefix === "" ? name : `${prefix}/${name}`;
                if (name.toLowerCase().includes(q)) {
                  results.push({ path: relPath, name, snippet: "" });
                  continue;
                }
                if (st.size > 0 && st.size <= MAX_READ) {
                  try {
                    const raw = await readFile(full, "utf8");
                    // 先按 aliases 命中（大小写沿用现有 lower-case 口径）：
                    // 结果带 matchedAlias 供前端标注「命中别名」，snippet 留空。
                    const alias = parseAliases(raw).find((a) => a.toLowerCase().includes(q));
                    if (alias !== undefined) {
                      results.push({ path: relPath, name, snippet: "", matchedAlias: alias });
                      continue;
                    }
                    const content = raw.toLowerCase();
                    const at = content.indexOf(q);
                    if (at >= 0) {
                      const start = Math.max(0, at - 60);
                      const rawSnippet = content.slice(start, at + q.length + 80);
                      const snippet = `${start > 0 ? "…" : ""}${rawSnippet.replace(/\s+/g, " ").trim()}`;
                      results.push({ path: relPath, name, snippet });
                    }
                  } catch { /* ignore */ }
                }
              }
            }
          };
          await walk(rootCanon, "", { left: SEARCH_LIMIT });
          results.sort((a, b) => a.path.localeCompare(b.path));
          return send(res, 200, { results: results.slice(0, SEARCH_RESULT_LIMIT) });
        }

        default:
          return send(res, 404, { error: `unknown action ${action}` });
      }
    } catch (error) {
      const status = error && error.status
        ? error.status
        : error && error.code === "ENOENT" ? 404
        : error && error.code === "ENOTDIR" ? 404
        : 500;
      send(res, status, { error: error && error.message ? error.message : String(error) });
    }
  };
}

export function apply(ctx) {
  ctx.inject(["webServer"], (httpCtx) => {
    // `agents`（host agent 注册表）、`sessions`（host 活跃会话注册表）与
    // `sessionQuery`（会话查询：`persisted` = 磁盘上有 durable 日志）都按请求
    // 惰性解析，不写进 inject 列表：否则这些服务晚于本插件就位时整条路由都不会
    // 注册。会话删除的活性判据只用 `agents`（`agents.get(id)?.status ===
    // "running"`，与 Host 自己算 `running` 同源）；`sessions` 只用于回执「删掉的
    // id 里哪些仍驻留内存」。服务缺失/异常时删除一律拒绝（503/409）—— 破坏性
    // 且不可恢复的操作不做 fail-open 降级。只读的 `/session-state` 则相反：
    // 判不准就回 `{ available: false }`，由前端保持现状（fail soft）。
    const resolveService = (name) => {
      if (typeof httpCtx.get !== "function") return undefined;
      const svc = httpCtx.get(name);
      return svc === undefined || svc === null ? undefined : svc;
    };
    const handler = createHandler({
      getAgents: () => resolveService("agents"),
      getSessions: () => resolveService("sessions"),
      getSessionQuery: () => resolveService("sessionQuery"),
    });
    httpCtx.effect(
      () => httpCtx.webServer.register({ kind: "prefix", path: ROUTE_PREFIX, handler }),
      "dsh-obsidian-vault: /obsidian file API routes",
    );
  });
}
