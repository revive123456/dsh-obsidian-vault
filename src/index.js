/**
 * dsh-obsidian-vault host 半边：
 * 挂载在 DSH webserver 上的 /obsidian/* 文件路由，
 * 所有读写被 realpath 包含性校验收窄到当前配置的 Vault 根内。
 */
import { readdir, readFile, writeFile, rename, unlink, stat, realpath, lstat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultVaultRoot, resolveVaultRoot, setVaultRoot } from "./vault-store.js";

const MAX_READ = 1024 * 1024;           // 单篇笔记读取上限 1MB
const MAX_WRITE = 1024 * 1024;          // 单篇笔记写入上限 1MB
const MAX_BODY = MAX_WRITE + 64 * 1024;
const SEARCH_LIMIT = 4000;              // 搜索最多扫描的文件数
const SEARCH_RESULT_LIMIT = 100;
const NOTE_EXT = ".md";

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
      if (req.headers["x-dsh-obsidian"] !== "1") {
        return send(res, 403, { error: "missing x-dsh-obsidian header" });
      }
      const url = new URL(req.url ?? "/", "http://internal");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "obsidian" || parts.length < 2) return send(res, 404, { error: "not found" });
      const action = parts[1];
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

      switch (action) {
        // ── Vault 根 ────────────────────────────────────────────────
        case "root": {
          if (req.method === "POST") {
            const body = JSON.parse(await readBody(req, 64 * 1024));
            const next = await setVaultRoot(String(body && body.root ? body.root : ""));
            return send(res, 200, { root: next, exists: true });
          }
          return send(res, 200, { root: rootCanon, exists: true });
        }

        // ── 目录树（懒加载；仅目录与 .md 笔记）────────────────────────
        case "tree": {
          const abs = await guarded(resolveInside());
          const st = await stat(abs);
          if (!st.isDirectory()) return send(res, 400, { error: "not a directory" });
          const entries = [];
          for (const d of await readdir(abs, { withFileTypes: true })) {
            const full = join(abs, d.name);
            if (d.isDirectory()) {
              if (IGNORED_DIRS.has(d.name)) continue;
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
            const tmp = join(dirname(target), `.dsh-obsidian-${randomUUID()}.tmp`);
            try {
              await writeFile(tmp, content, "utf8");
              await rename(tmp, target);
            } catch (error) {
              await unlink(tmp).catch(() => { /* ignore */ });
              throw error;
            }
            return send(res, 200, { ok: true });
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

        // ── 文件操作：new / rename / delete ──────────────────────────
        case "file": {
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
