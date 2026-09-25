/**
 * host 侧「彻底删除会话」测试（无需 DSH：直接拉起 createHandler 挂到本地 http server）。
 *
 * 覆盖：真实文件删除、投影缓存清理、无关会话不受牵连、id 校验、路径穿越拒绝、
 * 符号链接拒绝、活跃会话护栏、以及 vault 不存在时该路由照常可用。
 */
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, symlink, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/index.js";
import { encodeSegment, sessionArtifactsPresent } from "../src/session-store.js";

const base = await realpath(await mkdtemp(join(tmpdir(), "dsh-obs-sess-")));
process.env.DSH_HOME = join(base, "dshhome");
// 刻意不创建 vault 目录：会话删除必须与 Vault 无关。
process.env.DSH_WORKSPACE = join(base, "ws");

const sessionsRoot = join(process.env.DSH_HOME, "sessions");
const group = join(sessionsRoot, "--Users-me-proj--");
const projCacheDir = join(process.env.DSH_HOME, "storages", "session_projcache", "sessions");

const PARENT = "session-aaaa1111-2222-3333-4444-555566667777";
const CHILD_1 = "sub-bbbb1111-2222-3333-4444-555566667777";
const CHILD_2 = "sub-cccc1111-2222-3333-4444-555566667777";
const KEEPER = "session-dddd1111-2222-3333-4444-555566667777";

async function sessionDir(id, logName = "session.v3.jsonl.zstd") {
  const dir = join(group, encodeSegment(id));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, logName), "stub-log-bytes", "utf8");
  await writeFile(join(dir, "session.lock"), "", "utf8");
  return dir;
}
async function projectionCache(id) {
  await mkdir(projCacheDir, { recursive: true });
  await writeFile(join(projCacheDir, `${encodeSegment(id)}.json`), '{"version":7}', "utf8");
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const parentDir = await sessionDir(PARENT);
const child1Dir = await sessionDir(CHILD_1);
const child2Dir = await sessionDir(CHILD_2);
const keeperDir = await sessionDir(KEEPER, "session.jsonl.zstd");   // 老格式（v0 文件名）
await projectionCache(PARENT);
await projectionCache(KEEPER);

// 陷阱：一个名为某会话 id 的**符号链接**；真删除必须跳过它而不是删掉链接目标
const trapTarget = join(base, "trap-target");
await mkdir(trapTarget, { recursive: true });
await writeFile(join(trapTarget, "keep-me.txt"), "x", "utf8");
const linkId = "session-eeee1111-2222-3333-4444-555566667777";
await symlink(trapTarget, join(group, encodeSegment(linkId)), "dir");

// 活跃会话护栏：host 侧 SessionStore.get(id) 有值即视为在跑
let liveIds = new Set([KEEPER]);
const handler = createHandler({ getSessions: () => ({ get: (id) => (liveIds.has(id) ? { id } : undefined) }) });
const server = createServer((req, res) => void handler(req, res));
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const origin = `http://127.0.0.1:${server.address().port}`;

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
const post = (ids) => call("/obsidian/session-delete", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ids }),
});

const failures = [];
function check(name, cond, extra = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures.push(name);
}

// 0. encodeSegment 与官方规则一致（`.` / `..` 特判 + 非法单元转义）
check("encodeSegment 常规 id 原样", encodeSegment(PARENT) === PARENT);
check("encodeSegment 单点转义", encodeSegment(".") === "~002E");
check("encodeSegment 双点转义", encodeSegment("..") === "~002E~002E");
check("encodeSegment 斜杠转义", encodeSegment("a/b") === "a~002Fb");
check("encodeSegment 波浪号转义", encodeSegment("a~b") === "a~007Eb");

// 1. 缺少自定义头 → 403（沿用全局守卫）
{
  const r = await call("/obsidian/session-delete", {
    method: "POST",
    headers: { "x-dsh-obsidian": "0", "content-type": "application/json" },
    body: JSON.stringify({ ids: [PARENT] }),
  });
  check("缺头 → 403", r.status === 403, String(r.status));
}
// 2. 非 POST → 405
{
  const r = await call(`/obsidian/session-delete`);
  check("GET → 405", r.status === 405, String(r.status));
}
// 3. 非法 body / 空数组 / 非法 id / 路径穿越 → 400
{
  const empty = await post([]);
  check("空 ids → 400", empty.status === 400, String(empty.status));
  const bad = await post(["../../etc/passwd"]);
  check("路径穿越 id → 400", bad.status === 400, JSON.stringify(bad.json));
  const dot = await post([".."]);
  check("`..` id → 400", dot.status === 400, JSON.stringify(dot.json));
  const notArray = await call("/obsidian/session-delete", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: "x" }),
  });
  check("ids 非数组 → 400", notArray.status === 400, String(notArray.status));
  check("非法请求未动磁盘", await exists(parentDir));
}
// 4. 活跃会话 → 409，且**整批不删**（不能只删一半）
{
  const r = await post([PARENT, KEEPER]);
  check("含活跃会话 → 409", r.status === 409, String(r.status));
  check("409 报告活跃 id", JSON.stringify(r.json.live) === JSON.stringify([KEEPER]), JSON.stringify(r.json.live));
  check("409 时父会话未被删", await exists(parentDir));
}
// 5. 正常删除父 + 两个子代理
{
  // 删之前：校验探针必须能看到会话目录（否则下面的「删后为假」不算证据）
  const before = await sessionArtifactsPresent(PARENT);
  check("删前探针：目录存在", before.present === true && before.reason === "session directory", JSON.stringify(before));
  const r = await post([PARENT, CHILD_1, CHILD_2]);
  check("删除 → 200", r.status === 200, JSON.stringify(r.json));
  check("deleted 覆盖 3 条", r.json.deleted.length === 3, JSON.stringify(r.json.deleted));
  check("missing 为空", r.json.missing.length === 0, JSON.stringify(r.json.missing));
  check("failed 为空", r.json.failed.length === 0, JSON.stringify(r.json.failed));
  check("verified 为真", r.json.verified === true, JSON.stringify(r.json.verified));
  check("父会话目录已删", !(await exists(parentDir)));
  check("子代理目录 1 已删", !(await exists(child1Dir)));
  check("子代理目录 2 已删", !(await exists(child2Dir)));
  check("投影缓存已删", !(await exists(join(projCacheDir, `${PARENT}.json`))));
  check("响应带 sessions root", r.json.root === sessionsRoot, r.json.root);
  // 契约：报进 deleted 的每一条，磁盘上都必须真的什么都不剩
  for (const id of r.json.deleted) {
    const left = await sessionArtifactsPresent(id);
    check(`deleted 契约：${id.slice(0, 12)} 无残留`, left.present === false, JSON.stringify(left));
  }
  const after = await sessionArtifactsPresent(PARENT);
  check("删后探针：无残留", after.present === false, JSON.stringify(after));
}
// 6. 无关会话（含活跃的 keeper）完好无损
{
  check("无关会话目录保留", await exists(keeperDir));
  check("无关会话投影缓存保留", await exists(join(projCacheDir, `${KEEPER}.json`)));
  check("陷阱目录目标保留", await exists(join(trapTarget, "keep-me.txt")));
}
// 7. 符号链接同名目录：报告为 missing（跳过），绝不删链接目标
{
  const r = await post([linkId]);
  check("符号链接不作为命中", r.json.deleted.length === 0 && r.json.missing.length === 1, JSON.stringify(r.json));
  check("链接目标未被删", await exists(join(trapTarget, "keep-me.txt")));
  check("链接本身仍在", await exists(join(group, encodeSegment(linkId))));
}
// 8. 不存在的 id → missing（不是错误），幂等重删也走 missing
{
  const r = await post(["session-ffff1111-2222-3333-4444-555566667777"]);
  check("不存在的 id → missing", r.status === 200 && r.json.missing.length === 1, JSON.stringify(r.json));
  const again = await post([PARENT]);
  check("重复删除 → missing（幂等）", again.status === 200 && again.json.missing.length === 1, JSON.stringify(again.json));
}
// 9. 去重：同一 id 传两次只处理一次
{
  const dir = await sessionDir("session-99991111-2222-3333-4444-555566667777");
  const r = await post([dir.split("/").pop(), dir.split("/").pop()]);
  check("重复 id 去重", r.json.deleted.length === 1, JSON.stringify(r.json));
}
// 10. handler 不注入 getSessions 时降级为不校验活性（路由仍可用）
{
  const bare = createHandler();
  const bareServer = createServer((req, res) => void bare(req, res));
  await new Promise((ok) => bareServer.listen(0, "127.0.0.1", ok));
  const bareOrigin = `http://127.0.0.1:${bareServer.address().port}`;
  const target = "session-88881111-2222-3333-4444-555566667777";
  await sessionDir(target);
  const res = await fetch(`${bareOrigin}/obsidian/session-delete`, {
    method: "POST",
    headers: { "x-dsh-obsidian": "1", "content-type": "application/json" },
    body: JSON.stringify({ ids: [target] }),
  });
  const json = await res.json();
  check("无活性服务时降级可用", res.status === 200 && json.deleted.length === 1, JSON.stringify(json));
  bareServer.close();
}

server.close();
await rm(base, { recursive: true, force: true });

console.log("");
if (failures.length > 0) {
  console.error(`${failures.length} check(s) FAILED: ${failures.join(" | ")}`);
  process.exit(1);
}
console.log("all session-delete host checks passed ✔");
