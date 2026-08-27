/**
 * host 路由冒烟测试（无需 DSH，直接拉起 createHandler 挂到本地 http server）。
 * 用工作区内的临时 DSH_HOME/DSH_WORKSPACE，覆盖 root/tree/note/file/search 全链路。
 */
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/index.js";

const base = await mkdtemp(join(tmpdir(), "dsh-obs-test-"));
process.env.DSH_HOME = join(base, "dshhome");
process.env.DSH_WORKSPACE = join(base, "ws");
const vault = join(process.env.DSH_WORKSPACE, "obsidian_vault");
await mkdir(join(vault, "sub"), { recursive: true });
await writeFile(join(vault, "你好.md"), "---\ntags: [ai, gpu]\n---\n# 标题\n\n正文内容 hello [[双链测试]]\n", "utf8");
await writeFile(join(vault, "sub", "second.md"), "# Second\n\nsome target words\n", "utf8");
await writeFile(join(vault, "escape-test.txt"), "not a note", "utf8");

const handler = createHandler();
const server = createServer((req, res) => void handler(req, res));
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

async function call(path, init = {}) {
  const res = await fetch(`${origin}${path}`, {
    ...init,
    headers: { "x-dsh-obsidian": "1", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const failures = [];
function check(name, cond, extra = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures.push(name);
}

// 1. root
{
  const r = await call("/obsidian/root");
  check("root", r.status === 200 && r.json.root === vault && r.json.exists === true, r.json.root);
}
// 2. tree
{
  const r = await call("/obsidian/tree?path=");
  const names = r.json.entries.map((e) => `${e.type}:${e.name}`);
  check("tree root", r.status === 200 && names.includes("dir:sub") && names.includes("note:你好.md") && !names.includes("note:escape-test.txt"), names.join(","));
  const r2 = await call("/obsidian/tree?path=" + encodeURIComponent("sub"));
  check("tree sub", r2.status === 200 && r2.json.entries.some((e) => e.name === "second.md"));
}
// 3. note read（frontmatter + 双链）
{
  const r = await call("/obsidian/note?path=" + encodeURIComponent("你好.md"));
  check("note read", r.status === 200
    && r.json.content.includes("# 标题")
    && r.json.frontmatter.tags === "[ai, gpu]"
    && r.json.links.includes("双链测试"), JSON.stringify(r.json.frontmatter));
}
// 4. note write（原子写）
{
  const r = await call("/obsidian/note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "你好.md", content: "改过了\n" }) });
  check("note write", r.status === 200 && r.json.ok === true);
  const back = await readFile(join(vault, "你好.md"), "utf8");
  check("note write content", back === "改过了\n");
}
// 5. 逃逸防护
{
  const r = await call("/obsidian/note?path=" + encodeURIComponent("../outside.md"));
  check("escape blocked", r.status === 403, String(r.json.error));
  const r2 = await call("/obsidian/note?path=" + encodeURIComponent("..%2F..%2Fpackage.json"));
  check("escape blocked (encoded)", r2.status === 403 || r2.status === 404);
  const r3 = await call("/obsidian/note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "../evil.md", content: "x" }) });
  check("escape write blocked", r3.status === 403);
  const r4 = await call("/obsidian/note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "sub/../../evil.md", content: "x" }) });
  check("escape write blocked (dotdot)", r4.status === 403);
  const r5 = await call("/obsidian/tree?path=" + encodeURIComponent(".."));
  check("tree escape blocked", r5.status === 403, String(r5.json.error));
}
// 5b. 读取/写入边界
{
  const r1 = await call("/obsidian/note?path=" + encodeURIComponent("不存在.md"));
  check("note missing 404", r1.status === 404);
  const r2 = await call("/obsidian/note?path=" + encodeURIComponent("sub"));
  check("note dir 400", r2.status === 400, String(r2.json.error));
  const r3 = await call("/obsidian/tree?path=" + encodeURIComponent("不存在"));
  check("tree missing 404", r3.status === 404);
  const r4 = await call("/obsidian/note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "x.txt", content: "y" }) });
  check("write non-md 400", r4.status === 400, String(r4.json.error));
  const r5 = await call("/obsidian/note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "x.md", content: "a\0b" }) });
  check("write binary 400", r5.status === 400);
  const big = "x".repeat(1024 * 1024 + 1);
  const r6 = await call("/obsidian/note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "x.md", content: big }) });
  check("write too large 413", r6.status === 413, String(r6.status));
  const r7 = await call("/obsidian/search?q=");
  check("search empty q → []", r7.status === 200 && Array.isArray(r7.json.results) && r7.json.results.length === 0);
}
// 5c. 忽略目录（.git 等）
{
  await mkdir(join(vault, ".git"), { recursive: true });
  await writeFile(join(vault, ".git", "inside.md"), "# hidden", "utf8");
  const r = await call("/obsidian/tree?path=");
  const names = r.json.entries.map((e) => e.name);
  check("ignored dir .git not listed", r.status === 200 && !names.includes(".git"), names.join(","));
}
// 6. file new / rename / delete
{
  const r = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "new", path: "", name: "新笔记" }) });
  check("file new", r.status === 200 && r.json.path === "新笔记.md", JSON.stringify(r.json));
  const exists = await readFile(join(vault, "新笔记.md"), "utf8").then(() => true).catch(() => false);
  check("file new on disk", exists);
  const r2 = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "rename", path: "新笔记.md", newName: "改名" }) });
  check("file rename", r2.status === 200 && r2.json.name === "改名.md", JSON.stringify(r2.json));
  const r3 = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", path: "改名.md" }) });
  check("file delete", r3.status === 200 && r3.json.ok === true);
}
// 6b. file mkdir（新建文件夹）
{
  const r = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "mkdir", path: "", name: "新目录" }) });
  check("file mkdir root", r.status === 200 && r.json.path === "新目录", JSON.stringify(r.json));
  const isDir = await stat(join(vault, "新目录")).then((s) => s.isDirectory()).catch(() => false);
  check("file mkdir on disk (dir)", isDir);
  const r0 = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "mkdir", path: "", name: "新目录" }) });
  check("file mkdir duplicate 409", r0.status === 409, String(r0.json.error));
  const r1 = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "mkdir", path: "", name: "" }) });
  check("file mkdir empty name 400", r1.status === 400);
  const r2 = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "mkdir", path: "sub", name: "子目录" }) });
  check("file mkdir in subdir", r2.status === 200 && r2.json.path === "sub/子目录", JSON.stringify(r2.json));
  const r3 = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "mkdir", path: "", name: "../escape" }) });
  check("file mkdir escape name 400", r3.status === 400, String(r3.json.error));
}
// 6c. file 边界
{
  const r1 = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "new", path: "", name: "dup" }) });
  const r2 = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "new", path: "", name: "dup" }) });
  check("file new duplicate 409", r1.status === 200 && r2.status === 409, `${r1.status}→${r2.status}`);
  const r3 = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "new", path: "", name: "a/b" }) });
  check("file new invalid name 400", r3.status === 400);
  const r4 = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "new", path: "sub", name: "三" }) });
  check("file new in subdir", r4.status === 200 && r4.json.path === "sub/三.md", JSON.stringify(r4.json));
  const r5 = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", path: "不存在.md" }) });
  check("file delete missing 400", r5.status === 400, String(r5.json.error));
}
// 6d. file delete：笔记 / 文件夹（递归）/ 根目录保护
{
  const rn = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "new", path: "sub", name: "待删" }) });
  check("file delete note prep", rn.status === 200 && rn.json.path === "sub/待删.md", JSON.stringify(rn.json));
  const rd = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", path: "sub/待删.md" }) });
  check("file delete note", rd.status === 200 && rd.json.ok === true && rd.json.deleted.replaceAll("\\", "/") === "sub/待删.md", JSON.stringify(rd.json));
  const gone = await stat(join(vault, "sub", "待删.md")).then(() => false).catch(() => true);
  check("file delete note on disk", gone);
  const rm1 = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "mkdir", path: "", name: "垃圾袋" }) });
  check("folder delete prep", rm1.status === 200);
  const rmc = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "new", path: "垃圾袋", name: "内容" }) });
  check("folder delete prep (note)", rmc.status === 200 && rmc.json.path === "垃圾袋/内容.md", JSON.stringify(rmc.json));
  const rmd = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", path: "垃圾袋" }) });
  check("file delete folder recursive", rmd.status === 200 && rmd.json.deleted === "垃圾袋", JSON.stringify(rmd.json));
  const dgone = await stat(join(vault, "垃圾袋")).then(() => false).catch(() => true);
  check("folder delete recursive on disk", dgone);
  const rroot = await call("/obsidian/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", path: "" }) });
  check("file delete root blocked 403", rroot.status === 403, String(rroot.json.error));
}
// 7. search
{
  const r = await call("/obsidian/search?q=" + encodeURIComponent("target words"));
  check("search content", r.status === 200 && r.json.results.some((x) => x.path === "sub/second.md"), JSON.stringify(r.json.results));
  const r2 = await call("/obsidian/search?q=" + encodeURIComponent("second"));
  check("search title", r2.status === 200 && r2.json.results.some((x) => x.path === "sub/second.md"));
}
// 8. vault 根切换（setVaultRoot 持久化）
{
  const other = join(base, "other-vault");
  await mkdir(other, { recursive: true });
  const r0 = await call("/obsidian/root", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: join(base, "no-such-vault") }) });
  check("set root nonexistent 400", r0.status === 400, String(r0.json.error));
  const r = await call("/obsidian/root", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: other }) });
  check("set root", r.status === 200 && r.json.root === other);
  const r2 = await call("/obsidian/root");
  check("root persisted", r2.status === 200 && r2.json.root === other);
  const r3 = await call("/obsidian/tree?path=");
  check("tree after switch", r3.status === 200 && Array.isArray(r3.json.entries) && r3.json.entries.length === 0);
  const r4 = await call("/obsidian/note?path=" + encodeURIComponent("你好.md"));
  check("old vault out of scope after switch", r4.status === 404);
}
// 8b. 已配置根与默认根都不存在时 → {exists:false}
{
  const other = join(base, "other-vault");
  await rm(other, { recursive: true });
  await rm(join(process.env.DSH_WORKSPACE, "obsidian_vault"), { recursive: true });
  const r = await call("/obsidian/root");
  check("root exists:false after vault removed", r.status === 200 && r.json.exists === false, JSON.stringify(r.json));
}
// 9. 缺头防护
{
  const res = await fetch(`${origin}/obsidian/root`);
  check("missing header rejected", res.status === 403);
}

server.close();
await rm(base, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall host smoke checks passed ✔");
