/**
 * 插入截图（方案 B）host 链路验证：
 *   真实 createHandler + 临时 Vault，覆盖
 *   attach（上传落盘 + mime 嗅探 + 冲突递增 + 原子写 + 包含性）/
 *   file GET（图片字节流 + 白名单 + 404）/
 *   attach-dir（相对/绝对换算/清空/逃逸拒绝）/
 *   root（返回 attachmentDir）/ tree（隐藏附件目录）。
 */
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/index.js";

const base = await mkdtemp(join(tmpdir(), "dsh-obs-attach-"));
process.env.DSH_HOME = join(base, "dshhome");
process.env.DSH_WORKSPACE = join(base, "ws");
const vault = join(process.env.DSH_WORKSPACE, "obsidian_vault");
await mkdir(join(vault, "sub"), { recursive: true });
await writeFile(join(vault, "你好.md"), "# 标题\n", "utf8");

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
  return _read(res);
}
async function callNoHeader(path, init = {}) {
  const res = await fetch(`${origin}${path}`, init);
  return _read(res);
}
async function _read(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json, res };
  }
  // 非 JSON（图片字节流）：保留 res 供调用方读取原始体
  return { status: res.status, json: null, res };
}
function post(path, body) {
  return call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const failures = [];
function check(name, cond, extra = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures.push(name);
}

/** 起一个独立临时 Vault + server（迁移类隔离测试用，避免与主测试累积文件互相干扰）。 */
async function freshServer() {
  const b = await mkdtemp(join(tmpdir(), "dsh-obs-mig-"));
  const oldHome = process.env.DSH_HOME, oldWs = process.env.DSH_WORKSPACE;
  process.env.DSH_HOME = join(b, "dshhome");
  process.env.DSH_WORKSPACE = join(b, "ws");
  const v = join(process.env.DSH_WORKSPACE, "obsidian_vault");
  await mkdir(v, { recursive: true });
  const h = createHandler();
  const srv = createServer((q, r) => void h(q, r));
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const ori = `http://127.0.0.1:${srv.address().port}`;
  const call = async (p, init = {}) => {
    const res = await fetch(`${ori}${p}`, { ...init, headers: { "x-dsh-obsidian": "1", ...(init.headers ?? {}) } });
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return { status: res.status, json: await res.json().catch(() => ({})), res };
    return { status: res.status, json: null, res };
  };
  const post = (p, body) => call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const close = async () => {
    srv.close();
    process.env.DSH_HOME = oldHome;
    process.env.DSH_WORKSPACE = oldWs;
    await rm(b, { recursive: true, force: true });
  };
  return { origin: ori, vault: v, call, post, close };
}

// 有效的 1x1 PNG 字节（真正的 PNG 签名 + 内容），经 sniffImageExt 识别为 .png
const pngBytes = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
  Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77]),
]);
const pngB64 = pngBytes.toString("base64");

// 1. root 默认返回 attachmentDir
{
  const r = await call("/obsidian/root");
  check("root exists + attachmentDir=attachments", r.status === 200 && r.json.exists === true && r.json.attachmentDir === "attachments", JSON.stringify(r.json));
}

// 2. attach 上传 → 落盘 attachments/，返回 POSIX 相对路径
let attachPath = "";
{
  const r = await post("/obsidian/attach", { data: pngB64 });
  check("attach 200 path starts with attachments/", r.status === 200 && typeof r.json.path === "string" && r.json.path.startsWith("attachments/") && r.json.path.endsWith(".png"), JSON.stringify(r.json));
  attachPath = r.json.path;
  const abs = join(vault, ...attachPath.split("/"));
  const statRes = await stat(abs).then(() => true).catch(() => false);
  check("attach file written on disk", statRes);
  const written = await readFile(abs);
  check("attach bytes roundtrip", written.equals(pngBytes));
}

// 3. file GET：读出图片字节流；且不要求 x-dsh-obsidian 头（<img> 原生加载无法带自定义头）
{
  const r = await call(`/obsidian/file?path=${encodeURIComponent(attachPath)}`);
  const buf = Buffer.from(await r.res.arrayBuffer());
  check("file GET 200 + image/png + bytes match", r.status === 200 && (r.res.headers.get("content-type") || "").startsWith("image/png") && buf.equals(pngBytes), `ct=${r.res.headers.get("content-type")}`);
  const rNoHead = await callNoHeader(`/obsidian/file?path=${encodeURIComponent(attachPath)}`);
  const bufNoHead = Buffer.from(await rNoHead.res.arrayBuffer());
  check("file GET works WITHOUT header (img tag)", rNoHead.status === 200 && bufNoHead.equals(pngBytes), `status=${rNoHead.status}`);
  const rootNoHead = await callNoHeader("/obsidian/root");
  check("root still rejects WITHOUT header", rootNoHead.status === 403, `status=${rootNoHead.status}`);
}

// 4. file GET 边界：非图片 / 不存在 / 逃逸
{
  const r1 = await call(`/obsidian/file?path=${encodeURIComponent("你好.md")}`);
  check("file GET non-image 400", r1.status === 400, String(r1.json.error));
  const r2 = await call(`/obsidian/file?path=${encodeURIComponent("nope.png")}`);
  check("file GET missing 404", r2.status === 404, String(r2.json.error));
  const r3 = await call(`/obsidian/file?path=${encodeURIComponent("../outside.png")}`);
  check("file GET escape 403", r3.status === 403, String(r3.json.error));
}

// 5. attach 边界：非图片 base64 / 空 / 坏 base64
{
  const r1 = await post("/obsidian/attach", { data: Buffer.from("just text").toString("base64") });
  check("attach non-image 415", r1.status === 415, String(r1.json.error));
  const r2 = await post("/obsidian/attach", { data: "" });
  check("attach empty 400", r2.status === 400, String(r2.json.error));
  const r3 = await post("/obsidian/attach", { data: "!!not-base64!!" });
  check("attach garbage data rejected", r3.status === 415 || r3.status === 400, `${r3.status} ${String(r3.json.error)}`);
}

// 6. 冲突递增：固定时钟使两次上传时间戳相同，第二次应带 (1) 递增后缀
{
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [1700000000000])); }
    static now() { return 1700000000000; }
  };
  try {
    const r1 = await post("/obsidian/attach", { data: pngB64 });
    const r2 = await post("/obsidian/attach", { data: pngB64 });
    check("attach same-ms second gets (1)", r1.status === 200 && r2.status === 200 && /\(1\)\.png$/.test(r2.json.path), `${r1.json.path} | ${r2.json.path}`);
  } finally {
    globalThis.Date = RealDate;
  }
}

// 7. 目录树隐藏附件目录（configured = attachments，上传已建目录，不应出现在树里）
{
  const r = await call("/obsidian/tree?path=");
  const names = r.json.entries.map((e) => e.name);
  check("tree hides attachments dir", r.status === 200 && !names.includes("attachments"), names.join(","));
}

// 8. attach-dir：相对多级路径
{
  const r = await post("/obsidian/attach-dir", { dir: "docs/images" });
  check("attach-dir relative docs/images", r.status === 200 && r.json.attachmentDir === "docs/images", JSON.stringify(r.json));
  const root = await call("/obsidian/root");
  check("root reflects attachmentDir", root.json.attachmentDir === "docs/images");
  const a = await post("/obsidian/attach", { data: pngB64 });
  check("attach into docs/images", a.status === 200 && a.json.path.startsWith("docs/images/") && a.json.path.endsWith(".png"), JSON.stringify(a.json));
  const abs = join(vault, ...a.json.path.split("/"));
  check("docs/images dir auto-created", await stat(abs).then(() => true).catch(() => false));
}

// 9. attach-dir：Vault 内绝对路径 → 换算相对路径
{
  const absDir = join(vault, "imgs");
  await mkdir(absDir, { recursive: true });
  const r = await post("/obsidian/attach-dir", { dir: absDir });
  check("attach-dir absolute converts to rel", r.status === 200 && r.json.attachmentDir === "imgs", JSON.stringify(r.json));
}

// 10. attach-dir：逃逸 / Vault 外绝对路径拒绝
{
  const outside = join(base, "outside");
  await mkdir(outside, { recursive: true });
  const r1 = await post("/obsidian/attach-dir", { dir: outside });
  check("attach-dir outside vault 403", r1.status === 403, String(r1.json.error));
  const r2 = await post("/obsidian/attach-dir", { dir: "../evil" });
  check("attach-dir dotdot 403", r2.status === 403, String(r2.json.error));
}

// 11. attach-dir：清空回 Vault 根
{
  const r = await post("/obsidian/attach-dir", { dir: "" });
  check("attach-dir clear to root", r.status === 200 && r.json.attachmentDir === "");
  const a = await post("/obsidian/attach", { data: pngB64 });
  check("attach lands at vault root", a.status === 200 && !a.json.path.includes("/") && a.json.path.endsWith(".png"), JSON.stringify(a.json));
}

// 12. 回归：笔记读/写不受影响（note POST 仍只允许 .md、仍拒二进制）
{
  const w = await post("/obsidian/note", { path: "你好.md", content: "改过\n" });
  check("note write still works", w.status === 200 && w.json.ok === true);
  const b = await post("/obsidian/note", { path: "x.md", content: "a\0b" });
  check("note binary still rejected", b.status === 400, String(b.json.error));
  const txt = await post("/obsidian/note", { path: "x.txt", content: "y" });
  check("note non-md still rejected", txt.status === 400, String(txt.json.error));
}

// 13. 同步删除：保存时从笔记移除、且全库不再引用的图片附件被删除；仍被引用则保留
{
  const dir = await post("/obsidian/attach-dir", { dir: "attachments" });
  check("sync: reset attach-dir", dir.status === 200 && dir.json.attachmentDir === "attachments", JSON.stringify(dir.json));
  const up = await post("/obsidian/attach", { data: pngB64 });
  check("sync: upload image", up.status === 200, JSON.stringify(up.json));
  const ref = up.json.path;   // attachments/Pasted image ...png
  const abs = join(vault, ...ref.split("/"));
  // 1) 新建 a.md 引用该图 → 保存
  const a1 = await post("/obsidian/note", { path: "a.md", content: `A 开头\n![[${ref}]]\n结尾\n` });
  check("sync: save a.md refs img", a1.status === 200 && Array.isArray(a1.json.deletedAttachments) && a1.json.deletedAttachments.length === 0, JSON.stringify(a1.json));
  // 2) 新建 b.md 也引用同图 → 保存
  const b1 = await post("/obsidian/note", { path: "b.md", content: `![[${ref}]]\n` });
  check("sync: save b.md refs img", b1.status === 200 && b1.json.deletedAttachments.length === 0, JSON.stringify(b1.json));
  // 3) 从 a.md 移除引用并保存 → 仍被 b.md 引用，附件保留
  const a2 = await post("/obsidian/note", { path: "a.md", content: "A 开头\n结尾\n" });
  check("sync: remove ref in a, still referenced by b → keep", a2.status === 200 && a2.json.deletedAttachments.length === 0 && (await stat(abs).then(() => true).catch(() => false)), JSON.stringify(a2.json));
  // 4) 从 b.md 移除引用并保存 → 全库无引用 → 附件删除
  const b2 = await post("/obsidian/note", { path: "b.md", content: "empty\n" });
  const gone = await stat(abs).then(() => false).catch(() => true);
  check("sync: remove ref in b, orphaned → file deleted", b2.status === 200 && b2.json.deletedAttachments.includes(ref) && gone, JSON.stringify(b2.json));
  // 5) 无引用保存不崩溃
  const c = await post("/obsidian/note", { path: "c.md", content: "x\n" });
  const c2 = await post("/obsidian/note", { path: "c.md", content: "y\n" });
  check("sync: no refs, no crash", c.status === 200 && c2.status === 200 && c2.json.deletedAttachments.length === 0, JSON.stringify(c2.json));
}

// 14. 落盘目录迁移 —— 干净迁移（独立 base/server）
{
  const s = await freshServer();
  try {
    await s.post("/obsidian/attach-dir", { dir: "attachments" });
    const upA = await s.post("/obsidian/attach", { data: pngB64 });
    const upB = await s.post("/obsidian/attach", { data: pngB64 });
    const refA = upA.json.path, refB = upB.json.path;            // attachments/Pasted...png
    await s.post("/obsidian/note", { path: "n1.md", content: `见 ![[${refA}]]\n` });
    await s.post("/obsidian/note", { path: "n2.md", content: `![[${refA}]] 与 ![[${refB}]]\n` });
    const r = await s.post("/obsidian/attach-dir", { dir: "assets" });
    const movedCount = r.json.moved ? r.json.moved.length : 0;
    const notesUpd = r.json.notesUpdated ? r.json.notesUpdated.length : 0;
    check("migrate: response moved 2 + notesUpdated 2 + deletedOld", r.status === 200 && movedCount === 2 && notesUpd === 2 && r.json.deletedOld === true, JSON.stringify(r.json));
    const aNew = join(s.vault, "assets", refA.split("/").pop());
    const bNew = join(s.vault, "assets", refB.split("/").pop());
    check("migrate: files now under assets/", await stat(aNew).then(() => true).catch(() => false) && await stat(bNew).then(() => true).catch(() => false));
    check("migrate: old attachments dir removed", await stat(join(s.vault, "attachments")).then(() => false).catch(() => true));
    const n1 = await readFile(join(s.vault, "n1.md"), "utf8");
    const n2 = await readFile(join(s.vault, "n2.md"), "utf8");
    const aNewRel = refA.replace("attachments/", "assets/");
    const bNewRel = refB.replace("attachments/", "assets/");
    check("migrate: n1 ref updated to assets/", n1.includes(`![[${aNewRel}]]`), n1.trim());
    check("migrate: n2 refs updated to assets/", n2.includes(`![[${aNewRel}]]`) && n2.includes(`![[${bNewRel}]]`), n2.trim());
    const get = await s.call(`/obsidian/file?path=${encodeURIComponent(aNewRel)}`);
    check("migrate: new path serves bytes", get.status === 200 && (get.res.headers.get("content-type") || "").startsWith("image/png"), `status=${get.status} ct=${get.res.headers.get("content-type")}`);
  } finally {
    await s.close();
  }
}

// 15. 迁移冲突：目标目录已存在同 basename → 移动到 ` (n)`，并改写引用（独立 base/server）
{
  const s = await freshServer();
  try {
    await s.post("/obsidian/attach-dir", { dir: "attachments" });
    const upC = await s.post("/obsidian/attach", { data: pngB64 });
    const refC = upC.json.path;
    await s.post("/obsidian/note", { path: "n3.md", content: `![[${refC}]]\n` });
    const baseName = refC.split("/").pop();
    const assetsDir = join(s.vault, "assets");
    await mkdir(assetsDir, { recursive: true });
    await writeFile(join(assetsDir, baseName), pngBytes);          // 预置同名，制造冲突
    const conflict = await s.post("/obsidian/attach-dir", { dir: "assets" });
    const n3 = await readFile(join(s.vault, "n3.md"), "utf8");
    check("migrate(conflict): moved to (1) name & ref updated", conflict.status === 200
      && conflict.json.moved.length === 1
      && conflict.json.moved[0].to.endsWith(" (1).png")
      && n3.includes(`![[${conflict.json.moved[0].to}]]`)
      && !n3.includes(`![[${refC}]]`), JSON.stringify({ n3: n3.trim(), moved: conflict.json.moved }));
  } finally {
    await s.close();
  }
}

server.close();
await rm(base, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall attachment-host checks passed ✔");
