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
import { mkdtemp, rm, mkdir, readFile, realpath, truncate, writeFile } from "node:fs/promises";
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
// 7. M13 aliases：parseNote 解析（inline/块两种形状）、GET note 字段、search matchedAlias
// ══════════════════════════════════════════════════════════════════════════
{
  const INLINE_FM = "---\ntags: [p2]\naliases: [知识库别名, \"GPU 笔记\"]\n---\n";
  const BLOCK_FM = "---\naliases:\n  - 块别名一\n  - \"块别名二\"\n---\n";
  await writeFile(join(vault, "别名内联.md"), INLINE_FM + "\n正文只有这句话\n", "utf8");
  await writeFile(join(vault, "别名块.md"), BLOCK_FM + "\n另一篇正文\n", "utf8");
  await writeFile(join(vault, "无别名.md"), "纯正文，没有 frontmatter\n", "utf8");
  await writeFile(join(vault, "空别名.md"), "---\ntags: [p2]\naliases: []\n---\n\n正文\n", "utf8");

  // GET note：新增 aliases 字段，两种 YAML 形状都解析；旧字段形状不变
  const inline = await call("/obsidian/note?path=" + encodeURIComponent("别名内联.md"));
  check("aliases inline 解析", inline.status === 200 && JSON.stringify(inline.json.aliases) === JSON.stringify(["知识库别名", "GPU 笔记"]), JSON.stringify(inline.json.aliases));
  check("aliases 不破坏 frontmatter 字段", inline.json.frontmatter.tags === "[p2]" && typeof inline.json.frontmatter.aliases === "string", JSON.stringify(inline.json.frontmatter));
  check("aliases GET 整体形状不变", inline.json.content === "\n正文只有这句话\n"
    && typeof inline.json.name === "string" && typeof inline.json.size === "number"
    && typeof inline.json.mtimeMs === "number" && Array.isArray(inline.json.links), Object.keys(inline.json).join(","));
  const block = await call("/obsidian/note?path=" + encodeURIComponent("别名块.md"));
  check("aliases 块形式解析", block.status === 200 && JSON.stringify(block.json.aliases) === JSON.stringify(["块别名一", "块别名二"]), JSON.stringify(block.json.aliases));
  const none = await call("/obsidian/note?path=" + encodeURIComponent("无别名.md"));
  check("aliases 缺省为空数组", none.status === 200 && Array.isArray(none.json.aliases) && none.json.aliases.length === 0, JSON.stringify(none.json.aliases));
  const empty = await call("/obsidian/note?path=" + encodeURIComponent("空别名.md"));
  check("aliases 空数组写法", empty.status === 200 && Array.isArray(empty.json.aliases) && empty.json.aliases.length === 0, JSON.stringify(empty.json.aliases));

  // 保存回写后 aliases 不丢（frontmatterRaw 原样拼回）
  const saved = await call("/obsidian/note", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "别名内联.md", content: "改过的正文\n" }) });
  const after = await call("/obsidian/note?path=" + encodeURIComponent("别名内联.md"));
  check("aliases 保存后仍在", saved.status === 200 && JSON.stringify(after.json.aliases) === JSON.stringify(["知识库别名", "GPU 笔记"]), JSON.stringify(after.json.aliases));

  // search：alias 命中带 matchedAlias（大小写不敏感，保留别名原文大小写）；标题/正文命中保持旧形状
  const s1 = await call("/obsidian/search?q=" + encodeURIComponent("知识库别名"));
  const hit1 = s1.json.results.find((r) => r.path === "别名内联.md");
  check("search alias 命中带 matchedAlias", s1.status === 200 && hit1 !== undefined && hit1.matchedAlias === "知识库别名" && hit1.snippet === "", JSON.stringify(hit1));
  const s2 = await call("/obsidian/search?q=" + encodeURIComponent("gpu"));
  const hit2 = s2.json.results.find((r) => r.path === "别名内联.md");
  check("search alias 大小写不敏感", hit2 !== undefined && hit2.matchedAlias === "GPU 笔记", JSON.stringify(hit2));
  const s3 = await call("/obsidian/search?q=" + encodeURIComponent("块别名二"));
  const hit3 = s3.json.results.find((r) => r.path === "别名块.md");
  check("search 块形式 alias 命中", hit3 !== undefined && hit3.matchedAlias === "块别名二", JSON.stringify(hit3));
  const s4 = await call("/obsidian/search?q=" + encodeURIComponent("别名内联"));
  const hit4 = s4.json.results.find((r) => r.path === "别名内联.md");
  check("search 标题命中不带 matchedAlias", hit4 !== undefined && hit4.matchedAlias === undefined && hit4.snippet === "", JSON.stringify(hit4));
}

// ══════════════════════════════════════════════════════════════════════════
// 8. M19 媒体：MIME 白名单 + /obsidian/file Range（200/206/416）+ 免头 + 图片回归
// ══════════════════════════════════════════════════════════════════════════
{
  // 每个媒体扩展各造一个可辨识内容的小文件
  const MEDIA_FILES = {
    "m.mp3": Buffer.from("0123456789"),                 // audio/mpeg（10 字节，Range 用例主文件）
    "m.wav": Buffer.from("wav-data"),
    "m.ogg": Buffer.from("ogg-data"),
    "m.m4a": Buffer.from("m4a-data"),
    "v.mp4": Buffer.from("mp4-data"),
    "v.webm": Buffer.from("webm-data"),
    "doc.pdf": Buffer.from("%PDF-1.4 test"),
  };
  for (const [name, bytes] of Object.entries(MEDIA_FILES)) {
    await writeFile(join(vault, name), bytes);
  }
  const MIME_EXPECT = {
    "m.mp3": "audio/mpeg",
    "m.wav": "audio/wav",
    "m.ogg": "audio/ogg",
    "m.m4a": "audio/mp4",
    "v.mp4": "video/mp4",
    "v.webm": "video/webm",
    "doc.pdf": "application/pdf",
  };

  // 8.1 MIME 白名单 + GET 免 x-dsh-obsidian 头 + Accept-Ranges
  for (const [name, type] of Object.entries(MIME_EXPECT)) {
    const r = await call("/obsidian/file?path=" + encodeURIComponent(name), { withHeader: false });
    check(`media MIME ${name}`, r.status === 200 && r.headers.get("content-type") === type, `${r.status} ${r.headers.get("content-type")}`);
    check(`media ${name} 免头 + 字节一致`, r.buffer.equals(MEDIA_FILES[name]), `${r.buffer.length} vs ${MEDIA_FILES[name].length}`);
    check(`media ${name} Accept-Ranges`, r.headers.get("accept-ranges") === "bytes", String(r.headers.get("accept-ranges")));
  }

  // 8.2 Range: bytes=a-b → 206 + Content-Range
  {
    const r = await call("/obsidian/file?path=" + encodeURIComponent("m.mp3"), { withHeader: false, headers: { range: "bytes=0-3" } });
    check("media Range 0-3 → 206", r.status === 206, String(r.status));
    check("media Range 0-3 Content-Range", r.headers.get("content-range") === "bytes 0-3/10", String(r.headers.get("content-range")));
    check("media Range 0-3 body", r.buffer.toString() === "0123" && r.headers.get("content-length") === "4", `${JSON.stringify(r.buffer.toString())} cl=${r.headers.get("content-length")}`);
    check("media Range 0-3 Accept-Ranges", r.headers.get("accept-ranges") === "bytes");
  }
  // 8.3 开放范围 bytes=a-
  {
    const r = await call("/obsidian/file?path=" + encodeURIComponent("m.mp3"), { withHeader: false, headers: { range: "bytes=4-" } });
    check("media Range 4- → 206", r.status === 206 && r.buffer.toString() === "456789", `${r.status} ${JSON.stringify(r.buffer.toString())}`);
    check("media Range 4- Content-Range", r.headers.get("content-range") === "bytes 4-9/10", String(r.headers.get("content-range")));
  }
  // 8.4 后缀范围 bytes=-N
  {
    const r = await call("/obsidian/file?path=" + encodeURIComponent("m.mp3"), { withHeader: false, headers: { range: "bytes=-3" } });
    check("media Range -3 → 206", r.status === 206 && r.buffer.toString() === "789", `${r.status} ${JSON.stringify(r.buffer.toString())}`);
    check("media Range -3 Content-Range", r.headers.get("content-range") === "bytes 7-9/10", String(r.headers.get("content-range")));
    const over = await call("/obsidian/file?path=" + encodeURIComponent("m.mp3"), { withHeader: false, headers: { range: "bytes=-999" } });
    check("media Range -999 超长度 → 206 全文件", over.status === 206 && over.buffer.toString() === "0123456789", `${over.status} ${JSON.stringify(over.buffer.toString())}`);
    check("media Range -999 Content-Range 全覆盖", over.headers.get("content-range") === "bytes 0-9/10", String(over.headers.get("content-range")));
  }
  // 8.5 区间末端越界 → clamp 到文件尾（RFC 行为）
  {
    const r = await call("/obsidian/file?path=" + encodeURIComponent("m.mp3"), { withHeader: false, headers: { range: "bytes=5-999" } });
    check("media Range 5-999 clamp", r.status === 206 && r.buffer.toString() === "56789", `${r.status} ${JSON.stringify(r.buffer.toString())}`);
    check("media Range 5-999 Content-Range", r.headers.get("content-range") === "bytes 5-9/10", String(r.headers.get("content-range")));
  }
  // 8.6 不可满足 → 416 + Content-Range: bytes */size
  const BAD_RANGES = ["bytes=10-", "bytes=10-20", "bytes=5-3", "bytes=-0"];
  for (const range of BAD_RANGES) {
    const r = await call("/obsidian/file?path=" + encodeURIComponent("m.mp3"), { withHeader: false, headers: { range } });
    check(`media Range 416 ${range}`, r.status === 416, String(r.status));
    check(`media Range 416 ${range} Content-Range`, r.headers.get("content-range") === "bytes */10", String(r.headers.get("content-range")));
    check(`media Range 416 ${range} 空 body`, r.buffer.length === 0, String(r.buffer.length));
  }
  // 8.7 语法不合法/多区间 → 按 RFC 忽略，回 200 整文件（不 416）
  for (const range of ["bytes=abc", "bytes=0-1,3-4", "items=0-3", "bytes=-"]) {
    const r = await call("/obsidian/file?path=" + encodeURIComponent("m.mp3"), { withHeader: false, headers: { range } });
    check(`media Range 忽略 ${range} → 200 全文件`, r.status === 200 && r.buffer.toString() === "0123456789", `${r.status} ${JSON.stringify(r.buffer.toString())}`);
  }
  // 8.8 非白名单扩展 / SVG 仍不放行（即使免头）
  for (const name of ["not-image.txt", "evil.svg"]) {
    if (name === "evil.svg") await writeFile(join(vault, name), "<svg onload=alert(1) />");
    const r = await call("/obsidian/file?path=" + encodeURIComponent(name), { withHeader: false });
    check(`media 非白名单 ${name} 拒绝`, r.status === 400, `${r.status} ${JSON.stringify(r.json)}`);
  }
  // 8.9 媒体路径逃逸仍拒绝
  {
    const r = await call("/obsidian/file?path=" + encodeURIComponent("../media/m.mp3"), { withHeader: false });
    check("media 路径逃逸拒绝", r.status === 403 || r.status === 404, `${r.status} ${JSON.stringify(r.json)}`);
  }
  // 8.10 图片 GET 行为保持 P1：200 + image/png + 不支持 Range（带 Range 仍 200 整图）
  {
    const plain = await call("/obsidian/file?path=" + encodeURIComponent("img.png"), { withHeader: false });
    check("图片 GET 回归 200 image/png", plain.status === 200 && plain.headers.get("content-type") === "image/png" && plain.buffer.equals(PNG), `${plain.status} ${plain.headers.get("content-type")}`);
    check("图片 GET 无 Accept-Ranges（保持现状）", plain.headers.get("accept-ranges") === null);
    const ranged = await call("/obsidian/file?path=" + encodeURIComponent("img.png"), { withHeader: false, headers: { range: "bytes=0-3" } });
    check("图片带 Range 仍 200 整图（不 206）", ranged.status === 200 && ranged.buffer.equals(PNG), `${ranged.status} ${ranged.buffer.length}`);
  }
  // 8.11 子目录里的媒体：短链接（suffix 匹配）也能取到
  {
    await mkdir(join(vault, "media"), { recursive: true });
    await writeFile(join(vault, "media", "clip.mp3"), Buffer.from("clip-bytes"));
    const r = await call("/obsidian/file?path=" + encodeURIComponent("clip.mp3"), { withHeader: false });
    check("media 子目录短链接", r.status === 200 && r.buffer.toString() === "clip-bytes" && r.headers.get("content-type") === "audio/mpeg", `${r.status} ${JSON.stringify(r.buffer.toString())}`);
  }
  // 8.12 大小上限：超过 256MB 的媒体 → 413（只 stat，不读）
  {
    const big = join(vault, "big.mp4");
    await writeFile(big, "");
    await truncate(big, 256 * 1024 * 1024 + 1);
    const r = await call("/obsidian/file?path=" + encodeURIComponent("big.mp4"), { withHeader: false });
    check("media 超大小上限 413", r.status === 413, `${r.status} ${JSON.stringify(r.json)}`);
    await rm(big, { force: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 9. vendor 与 vault 解耦：vault 根不存在时也能读（懒加载不该被笔记库配置卡住）
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
