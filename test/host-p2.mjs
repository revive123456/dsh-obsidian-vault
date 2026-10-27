/**
 * host P2 路由测试（不需要 DSH 运行时，直接起本地 node:http server 挂 createHandler）。
 *
 * 本文件随 P2 host 侧任务扩展：
 *   - M16：`/obsidian/vendor/*` 静态资源路由（KaTeX/mermaid 懒加载）——GET 免
 *     `x-dsh-obsidian` 头、扩展名/目录白名单、路径逃逸拒绝、缓存头/304；
 *   - M19：`/obsidian/file` 媒体 MIME + Range（后续任务补）；
 *   - M13：aliases 解析 / search matchedAlias（后续任务补）。
 *
 * vendor 断言直接用仓库 `lib/vendor` 里的真实产物，保证「路由返回的字节 == 磁盘文件」。
 */
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler } from "../src/index.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const VENDOR = join(REPO, "lib", "vendor");

const base = await realpath(await mkdtemp(join(tmpdir(), "dsh-obs-p2-host-")));
process.env.DSH_HOME = join(base, "dshhome");
process.env.DSH_WORKSPACE = join(base, "ws");
await mkdir(process.env.DSH_WORKSPACE, { recursive: true });
const vault = join(process.env.DSH_WORKSPACE, "obsidian_vault");
await mkdir(vault, { recursive: true });
// 给 `/obsidian/file` 的免头边界用：一张真 PNG + 一个非图片文件
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);
await writeFile(join(vault, "img.png"), PNG);
await writeFile(join(vault, "not-image.txt"), "hello");

const handler = createHandler();
const server = createServer((req, res) => void handler(req, res));
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

const failures = [];
function check(name, cond, extra = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures.push(name);
}

/** fetch 包一层：默认带 x-dsh-obsidian；返回 status/headers/buffer（可选 JSON）。 */
async function call(path, init = {}) {
  const withHeader = init.withHeader !== false;
  const headers = { ...(init.headers ?? {}) };
  if (withHeader) headers["x-dsh-obsidian"] = "1";
  const res = await fetch(`${origin}${path}`, { ...init, headers });
  const buffer = Buffer.from(await res.arrayBuffer());
  let json;
  try { json = JSON.parse(buffer.toString("utf8")); } catch { json = null; }
  return { status: res.status, headers: res.headers, buffer, json };
}

/** 原始路径请求（fetch 会先规范化 `..`，这里用 node:http 原样发，才能测深路径逃逸）。 */
function rawGet(rawPath, { method = "GET", headers = {} } = {}) {
  return new Promise((ok) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: rawPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({
        status: res.statusCode,
        headers: res.headers,
        buffer: Buffer.concat(chunks),
      }));
    });
    req.on("error", (error) => ok({ status: 0, headers: {}, buffer: Buffer.from(String(error)) }));
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════
// 1. vendor 正常 GET：免 x-dsh-obsidian 头、200、MIME、字节一致、缓存头
// ══════════════════════════════════════════════════════════════════════════
const VENDOR_CASES = [
  { rel: "katex/katex.min.js", type: "text/javascript" },
  { rel: "katex/katex.min.css", type: "text/css" },
  { rel: "katex/fonts/KaTeX_Main-Regular.woff2", type: "font/woff2" },
  { rel: "mermaid/mermaid.min.js", type: "text/javascript" },
];
for (const { rel, type } of VENDOR_CASES) {
  const expected = await readFile(join(VENDOR, rel));
  const r = await call(`/obsidian/vendor/${rel}`);
  check(`vendor GET ${rel} 200`, r.status === 200, String(r.status));
  check(`vendor GET ${rel} content-type`, String(r.headers.get("content-type")).startsWith(type), String(r.headers.get("content-type")));
  check(`vendor GET ${rel} 字节一致`, r.buffer.equals(expected), `${r.buffer.length} vs ${expected.length}`);
  check(`vendor GET ${rel} content-length`, r.headers.get("content-length") === String(expected.length), String(r.headers.get("content-length")));
  check(`vendor GET ${rel} nosniff`, r.headers.get("x-content-type-options") === "nosniff");
  check(`vendor GET ${rel} 无版本号 → no-cache`, r.headers.get("cache-control") === "no-cache", String(r.headers.get("cache-control")));
  check(`vendor GET ${rel} 带 ETag`, typeof r.headers.get("etag") === "string" && r.headers.get("etag").startsWith('"'), String(r.headers.get("etag")));
}
// 显式「完全不带任何自定义头」的 GET（模拟 <script src>/<link>/字体请求）
{
  const r = await rawGet("/obsidian/vendor/katex/katex.min.js");
  check("vendor GET 完全无自定义头 200", r.status === 200);
}

// ══════════════════════════════════════════════════════════════════════════
// 2. 版本化缓存：?v= → immutable；If-None-Match → 304
// ══════════════════════════════════════════════════════════════════════════
{
  const r = await call("/obsidian/vendor/katex/katex.min.js?v=0.19.1");
  check("vendor 带 ?v= → immutable 缓存", r.status === 200 && String(r.headers.get("cache-control")).includes("immutable"), String(r.headers.get("cache-control")));
  const etag = r.headers.get("etag");
  const r304 = await call("/obsidian/vendor/katex/katex.min.js?v=0.19.1", { headers: { "if-none-match": etag } });
  check("vendor If-None-Match → 304", r304.status === 304 && r304.buffer.length === 0, `${r304.status}/${r304.buffer.length}`);
  check("vendor 304 仍带缓存头", String(r304.headers.get("cache-control")).includes("immutable"), String(r304.headers.get("cache-control")));
}

// ══════════════════════════════════════════════════════════════════════════
// 3. 非 GET → 405（有无头都是 405，因为根本没有写操作）
// ══════════════════════════════════════════════════════════════════════════
{
  const noHeader = await rawGet("/obsidian/vendor/katex/katex.min.js", { method: "POST" });
  check("vendor POST 无头 → 405", noHeader.status === 405, String(noHeader.status));
  const withHeader = await call("/obsidian/vendor/katex/katex.min.js", { method: "POST", body: "{}" });
  check("vendor POST 带头 → 405", withHeader.status === 405, String(withHeader.status));
  const put = await rawGet("/obsidian/vendor/katex/katex.min.js", { method: "PUT" });
  check("vendor PUT → 405", put.status === 405, String(put.status));
}

// ══════════════════════════════════════════════════════════════════════════
// 4. 白名单/不存在 → 404（不暴露存在性与非白名单扩展）
// ══════════════════════════════════════════════════════════════════════════
const NOT_FOUND_CASES = [
  "/obsidian/vendor",
  "/obsidian/vendor/katex",
  "/obsidian/vendor/katex/",
  "/obsidian/vendor/other/katex.min.js",            // vendor 名不在白名单
  "/obsidian/vendor/KATEX/katex.min.js",            // 大小写敏感，不放行
  "/obsidian/vendor/katex/package.json",            // 非白名单扩展
  "/obsidian/vendor/katex/fake.svg",                // svg 不放行（XSS 面）
  "/obsidian/vendor/katex/fake.html",               // html 不放行
  "/obsidian/vendor/katex/nope.js",                 // 白名单扩展但文件不存在
  "/obsidian/vendor/mermaid/nope.css",              // 跨目录不存在
];
for (const path of NOT_FOUND_CASES) {
  const r = await rawGet(path);
  check(`vendor 404 ${path}`, r.status === 404, String(r.status));
}

// ══════════════════════════════════════════════════════════════════════════
// 5. 路径逃逸：原始路径（不规范化）与编码变体一律拒绝
// ══════════════════════════════════════════════════════════════════════════
const ESCAPE_CASES = [
  "/obsidian/vendor/katex/../../../etc/passwd",
  "/obsidian/vendor/katex/../../package.json",
  "/obsidian/vendor/katex/..%2f..%2f..%2fetc/passwd",
  "/obsidian/vendor/katex/%2e%2e/%2e%2e/etc/passwd",
  "/obsidian/vendor/katex/..%5c..%5cetc%5cpasswd",
  "/obsidian/vendor/katex/katex.min.js%00.png",
  "/obsidian/vendor/katex/./katex.min.js",
];
for (const path of ESCAPE_CASES) {
  const r = await rawGet(path);
  const rejected = r.status === 403 || r.status === 404 || r.status === 400;
  const leaked = r.buffer.toString("utf8").includes("root:");
  check(`vendor 逃逸拒绝 ${path}`, rejected && !leaked, `${r.status}${leaked ? " (内容泄漏!)" : ""}`);
}

// ══════════════════════════════════════════════════════════════════════════
// 6. 免头边界：只有 vendor 静态资源与 file-GET 白名单 MIME 免头，其它照旧要头
// ══════════════════════════════════════════════════════════════════════════
{
  // file GET 的图片免头（P1 既有行为，不能回归）
  const img = await call("/obsidian/file?path=" + encodeURIComponent("img.png"), { withHeader: false });
  check("file GET 图片免头 200", img.status === 200 && img.buffer.equals(PNG), String(img.status));
  // file GET 的非白名单扩展即使免头也不放行（不能借豁免读任意文件）
  const txt = await call("/obsidian/file?path=" + encodeURIComponent("not-image.txt"), { withHeader: false });
  check("file GET 非图片扩展不放行", txt.status === 400, `${txt.status} ${JSON.stringify(txt.json)}`);
  // file GET 的路径逃逸照旧拒绝
  const esc = await call("/obsidian/file?path=" + encodeURIComponent("../etc/passwd"), { withHeader: false });
  check("file GET 路径逃逸拒绝", esc.status === 403 || esc.status === 404, `${esc.status} ${JSON.stringify(esc.json)}`);
  // 普通读接口仍要求头
  const note = await call("/obsidian/note?path=" + encodeURIComponent("img.png"), { withHeader: false });
  check("note 缺头 403（未扩大豁免）", note.status === 403, String(note.status));
  const tree = await call("/obsidian/tree?path=", { withHeader: false });
  check("tree 缺头 403（未扩大豁免）", tree.status === 403, String(tree.status));
  // vendor 带头也正常（冗余头不报错）
  const v = await call("/obsidian/vendor/katex/katex.min.js");
  check("vendor 带头 200", v.status === 200);
}

// ══════════════════════════════════════════════════════════════════════════
// 7. vendor 与 vault 解耦：vault 根不存在时也能读（懒加载不该被笔记库配置卡住）
// ══════════════════════════════════════════════════════════════════════════
{
  await rm(vault, { recursive: true, force: true });
  const r = await call("/obsidian/vendor/katex/katex.min.css");
  check("vendor 无 vault 仍 200", r.status === 200, String(r.status));
}

server.close();
await rm(base, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall host P2 checks passed ✔");
