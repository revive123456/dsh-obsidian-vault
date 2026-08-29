/**
 * dsh-obsidian-vault host 半边：
 * 挂载在 DSH webserver 上的 /obsidian/* 文件路由，
 * 所有读写被 realpath 包含性校验收窄到当前配置的 Vault 根内。
 */
import { readdir, readFile, writeFile, rename, unlink, stat, realpath, lstat, mkdir, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultVaultRoot, readSettings, resolveVaultRoot, setAttachmentDir, setVaultRoot } from "./vault-store.js";

const MAX_READ = 1024 * 1024;           // 单篇笔记读取上限 1MB
const MAX_WRITE = 1024 * 1024;          // 单篇笔记写入上限 1MB
const MAX_BODY = MAX_WRITE + 64 * 1024;
const ATTACH_MAX = 20 * 1024 * 1024;    // 附件写入上限 20MB（截图常超 1MB，独立上限）
const ATTACH_BODY = ATTACH_MAX + 64 * 1024;
const SEARCH_LIMIT = 4000;              // 搜索最多扫描的文件数
const SEARCH_RESULT_LIMIT = 100;
const NOTE_EXT = ".md";
const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const ROUTE_PREFIX = "/obsidian";

const IGNORED_DIRS = new Set([".git", "node_modules", ".obsidian", ".trash", ".DS_Store", "$RECYCLE.BIN", "__MACOSX"]);

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
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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

/** 全库扫描所有 .md 笔记引用的图片 embed 相对路径（可排除指定笔记）。 */
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
          for (const r of imageRefs(await readFile(full, "utf8"))) refs.add(r);
        } catch { /* ignore */ }
      }
    }
  };
  await walk(rootCanon, "");
  return refs;
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
    map.set(oldRelPosix, newRelPosix);
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

/** 按映射表改写所有 .md 笔记里的图片 embed 引用（原子写），返回被改写的笔记相对路径。 */
async function updateNoteRefs(rootCanon, map) {
  const updated = [];
  if (map.size === 0) return updated;
  const replacements = [...map.entries()];
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
      } else if (st.isFile() && extname(name).toLowerCase() === NOTE_EXT) {
        const relPath = prefix === "" ? name : `${prefix}/${name}`;
        let content;
        try {
          content = await readFile(full, "utf8");
        } catch {
          continue;
        }
        let changed = false;
        for (const [from, to] of replacements) {
          const needle = `![[${from}`;
          if (content.includes(needle)) {
            content = content.split(needle).join(`![[${to}`);
            changed = true;
          }
        }
        if (changed) {
          try {
            const tmp = join(dirname(full), `.dsh-obsidian-${randomUUID()}.tmp`);
            await writeFile(tmp, content, "utf8");
            await rename(tmp, full);
            updated.push(relPath);
          } catch { /* 写入失败忽略 */ }
        }
      }
    }
  };
  await walk(rootCanon, "");
  return updated;
}

/** 解析 frontmatter（--- 包裹的 key: value 行）并提取 [[双链]]。 */
function parseNote(raw) {
  let body = raw;
  const frontmatter = {};
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
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
  return { frontmatter, body, links };
}

export function createHandler() {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://internal");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "obsidian" || parts.length < 2) return send(res, 404, { error: "not found" });
      const action = parts[1];
      // 图片读取（file GET）由 <img> 标签直接加载，浏览器无法携带自定义头，故豁免 header 校验；
      // 其余 /obsidian/* 写读操作仍强制要求 x-dsh-obsidian: 1。
      const isImageRead = action === "file" && req.method === "GET";
      if (!isImageRead && req.headers["x-dsh-obsidian"] !== "1") {
        return send(res, 403, { error: "missing x-dsh-obsidian header" });
      }
      const rel = url.searchParams.get("path") ?? "";
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
      const settings = await readSettings();
      const attachmentDir = settings.attachmentDir ?? "attachments"; // POSIX，"" = Vault 根

      switch (action) {
        // ── Vault 根 ────────────────────────────────────────────────
        case "root": {
          if (req.method === "POST") {
            const body = JSON.parse(await readBody(req, 64 * 1024));
            const next = await setVaultRoot(String(body && body.root ? body.root : ""));
            return send(res, 200, { root: next, exists: true, attachmentDir });
          }
          return send(res, 200, { root: rootCanon, exists: true, attachmentDir });
        }

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
          // 定位附件目录（缺省自动 mkdir）；attachmentDir 为空 = Vault 根。
          // 目录可能尚不存在（含多级），先做词法包含性校验 → mkdir recursive →
          // 创建成功后对真实路径再做一次 realpath 包含性校验（防 symlink 逃逸）。
          const attachRel = normalizeRel(attachmentDir);
          if (attachRel === null) return send(res, 403, { error: "invalid attachment dir" });
          const attachAbs = resolve(rootCanon, attachRel);
          if (!isInside(rootCanon, attachAbs)) return send(res, 403, { error: "invalid attachment dir" });
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
          const respPath = attachRel === "" ? fileName : `${attachRel.replaceAll(sep, "/")}/${fileName}`;
          return send(res, 200, { path: respPath });
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
              if (attachmentDir !== "" && entryRel(d.name) === attachmentDir) continue;
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
            // 保存前读取旧内容，用于比较移除的图片 embed（同步删除孤儿附件）
            let oldContent = "";
            try {
              oldContent = await readFile(target, "utf8");
            } catch { /* 新笔记 */ }
            const tmp = join(dirname(target), `.dsh-obsidian-${randomUUID()}.tmp`);
            try {
              await writeFile(tmp, content, "utf8");
              await rename(tmp, target);
            } catch (error) {
              await unlink(tmp).catch(() => { /* ignore */ });
              throw error;
            }
            // 同步删除：本次保存中被移除且全库不再被引用的图片附件
            const deletedAttachments = [];
            const removedRefs = [...imageRefs(oldContent)].filter((r) => !imageRefs(content).has(r));
            if (removedRefs.length > 0) {
              const usedElsewhere = await refsInVault(rootCanon, path, SEARCH_LIMIT);
              for (const r of removedRefs) {
                if (usedElsewhere.has(r)) continue;            // 仍被其它笔记引用 → 保留
                const relNRef = normalizeRel(r);
                if (relNRef === null) continue;                 // 逃逸路径不删
                const abs = resolve(rootCanon, relNRef);
                if (!isInside(rootCanon, abs)) continue;        // 包含性兜底
                if (!IMAGE_MIME[extname(abs).toLowerCase()]) continue;
                try {
                  await unlink(abs);
                  deletedAttachments.push(r);
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
          const { frontmatter, body, links } = parseNote(buf.toString("utf8"));
          return send(res, 200, {
            path: rel,
            name: basename(abs),
            content: body,
            frontmatter,
            links,
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        }

        // ── 文件操作：new / rename / delete；GET = 读图片字节流供预览 ──
        case "file": {
          if (req.method === "GET") {
            const relN = normalizeRel(rel);
            if (relN === null) return send(res, 403, { error: "invalid path" });
            const abs = await guarded(resolve(rootCanon, relN));
            const ext = extname(abs).toLowerCase();
            if (!IMAGE_MIME[ext]) return send(res, 400, { error: "not an image" });
            let buf;
            try {
              buf = await readFile(abs);
            } catch (error) {
              if (error && error.code === "ENOENT") return send(res, 404, { error: "not found" });
              throw error;
            }
            res.writeHead(200, {
              "content-type": IMAGE_MIME[ext],
              "cache-control": "no-store",
              "content-length": String(buf.length),
            });
            res.end(buf);
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
                    const content = (await readFile(full, "utf8")).toLowerCase();
                    const at = content.indexOf(q);
                    if (at >= 0) {
                      const start = Math.max(0, at - 60);
                      const raw = content.slice(start, at + q.length + 80);
                      const snippet = `${start > 0 ? "…" : ""}${raw.replace(/\s+/g, " ").trim()}`;
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
    httpCtx.effect(
      () => httpCtx.webServer.register({ kind: "prefix", path: ROUTE_PREFIX, handler: createHandler() }),
      "dsh-obsidian-vault: /obsidian file API routes",
    );
  });
}
