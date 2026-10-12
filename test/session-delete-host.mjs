/**
 * host 侧「彻底删除会话」测试（无需 DSH：直接拉起 createHandler 挂到本地 http server）。
 *
 * 覆盖：真实文件删除、投影缓存清理、无关会话不受牵连、id 校验、路径穿越拒绝、
 * 符号链接拒绝、活性护栏（**只拦真正在跑的会话**）、以及 vault 不存在时该路由
 * 照常可用。
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

// 活性护栏：判据是 `agents.get(id)?.status === "running"`（与 Host 自己算
// `running` 同源）。`sessions.get(id)` 只说明会话被载入过内存 —— 打开一次就驻留
// 到进程退出 —— 只用于回执 attached，**不作为拒绝依据**。这里的 PARENT 刻意
// 同时「驻留内存」且「不在跑」，用来锁死「打开过的会话删不掉」这个回归。
let runningIds = new Set([KEEPER]);
let attachedIds = new Set([KEEPER, PARENT]);
let sessionsThrows = false;
// 只读 /session-state 的会话查询桩：每条记录自带 `persisted`（磁盘上有 durable
// 日志）与 `live`（内存里有副本）标记，形状与 ctx.sessionQuery.listSessions() 一致。
let sessionQueryRecords = [];
let sessionQueryThrows = false;
const handler = createHandler({
  getAgents: () => ({ get: (id) => ({ status: runningIds.has(id) ? "running" : "idle" }) }),
  getSessions: () => ({
    get: (id) => {
      if (sessionsThrows) throw new Error("session registry exploded");
      return attachedIds.has(id) ? { id } : undefined;
    },
  }),
  getSessionQuery: () => ({
    listSessions: async () => {
      if (sessionQueryThrows) throw new Error("session query exploded");
      return sessionQueryRecords;
    },
  }),
});
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
const state = (ids) => call("/obsidian/session-state", {
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
// 4. 正在运行的会话 → 409，且**整批不删**（不能只删一半）
{
  const r = await post([PARENT, KEEPER]);
  check("含正在运行的会话 → 409", r.status === 409, String(r.status));
  check("409 报告在跑的 id", JSON.stringify(r.json.running) === JSON.stringify([KEEPER]), JSON.stringify(r.json.running));
  check("409 时父会话未被删", await exists(parentDir));
}
// 4b. 只是「驻留内存」（打开过）的会话必须可删 —— 回归：曾被误判成「在跑」而永远删不掉
{
  attachedIds = new Set([PARENT]);
  const probe = await post([PARENT]);
  check("驻留内存但不在跑 → 200 删除", probe.status === 200 && probe.json.deleted.length === 1, JSON.stringify(probe.json));
  check("响应回执 attached（提醒重启后行才彻底消失）", JSON.stringify(probe.json.attached) === JSON.stringify([PARENT]), JSON.stringify(probe.json.attached));
  check("attached 的会话日志确实已从磁盘删除", !(await exists(parentDir)));
  check("attached 不影响 verified", probe.json.verified === true, JSON.stringify(probe.json.verified));
  // 复原：后续用例还要用 PARENT 的目录
  await sessionDir(PARENT);
  await projectionCache(PARENT);
}
// 4c. sessions 注册表抛错只影响 attached 回执，不该阻止删除
{
  sessionsThrows = true;
  const probe = await post([PARENT]);
  check("sessions 抛错 → 仍可删除（它不参与活性判定）", probe.status === 200 && probe.json.deleted.length === 1, JSON.stringify(probe.json));
  check("sessions 抛错 → attached 退化为空数组", JSON.stringify(probe.json.attached) === JSON.stringify([]), JSON.stringify(probe.json.attached));
  sessionsThrows = false;
  await sessionDir(PARENT);
  await projectionCache(PARENT);
  attachedIds = new Set();
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
  check("无投影缓存残留", JSON.stringify(r.json.cacheResidue) === JSON.stringify([]), JSON.stringify(r.json.cacheResidue));
  check("未驻留内存 → attached 为空", JSON.stringify(r.json.attached) === JSON.stringify([]), JSON.stringify(r.json.attached));
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
// 10. 活性服务（agents）缺失时 fail closed：破坏性操作绝不靠「判不准」放行
{
  const bare = createHandler();
  const bareServer = createServer((req, res) => void bare(req, res));
  await new Promise((ok) => bareServer.listen(0, "127.0.0.1", ok));
  const bareOrigin = `http://127.0.0.1:${bareServer.address().port}`;
  const target = "session-88881111-2222-3333-4444-555566667777";
  const dir = await sessionDir(target);
  const res = await fetch(`${bareOrigin}/obsidian/session-delete`, {
    method: "POST",
    headers: { "x-dsh-obsidian": "1", "content-type": "application/json" },
    body: JSON.stringify({ ids: [target] }),
  });
  const json = await res.json();
  check("无活性服务 → 503 拒绝删除", res.status === 503 && json.deleted.length === 0, JSON.stringify(json));
  check("无活性服务 → 日志原封不动", await exists(dir));
  bareServer.close();
}
// 11. 活性查询抛错时也 fail closed（曾把它判成「不在跑」→ 活会话日志被真删）
{
  const throwing = createHandler({
    getAgents: () => ({ get: () => { throw new Error("registry exploded"); } }),
    getSessions: () => ({ get: () => undefined }),
  });
  const tServer = createServer((req, res) => void throwing(req, res));
  await new Promise((ok) => tServer.listen(0, "127.0.0.1", ok));
  const tOrigin = `http://127.0.0.1:${tServer.address().port}`;
  const target = "session-77771111-2222-3333-4444-555566667777";
  const dir = await sessionDir(target);
  const res = await fetch(`${tOrigin}/obsidian/session-delete`, {
    method: "POST",
    headers: { "x-dsh-obsidian": "1", "content-type": "application/json" },
    body: JSON.stringify({ ids: [target] }),
  });
  const json = await res.json();
  check("活性查询抛错 → 409 拒绝删除", res.status === 409 && json.deleted.length === 0, JSON.stringify(json));
  check("活性查询抛错 → 报告 unknown", JSON.stringify(json.unknown) === JSON.stringify([target]), JSON.stringify(json.unknown));
  check("活性查询抛错 → 日志原封不动", await exists(dir));
  tServer.close();
}
// 12. 畸形 / 空 JSON 体 → 400（不是 500）
{
  const empty = await call("/obsidian/session-delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "",
  });
  check("空 body → 400", empty.status === 400, JSON.stringify(empty));
  const broken = await call("/obsidian/session-delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  check("畸形 JSON → 400", broken.status === 400, JSON.stringify(broken));
}
// 13. 超限请求体 → 413（旧实现 req.destroy() 撕掉 socket，客户端只看到 fetch failed）
{
  const big = JSON.stringify({ ids: ["session-" + "a".repeat(70 * 1024)] });
  const r = await call("/obsidian/session-delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: big,
  });
  check("超限 body → 413", r.status === 413, JSON.stringify({ status: r.status, json: r.json }));
}

// 14. 只读 /session-state：给前端判定「僵死行」（磁盘上已无 durable 日志、只剩内存副本）
{
  const STALE = "session-12121111-2222-3333-4444-555566667777";
  const LIVE_ONLY = "session-13131111-2222-3333-4444-555566667777";
  const staleDir = await sessionDir(STALE);
  sessionQueryRecords = [
    { header: { id: STALE, cwd: "/tmp/x" }, live: true, persisted: false },
    { header: { id: KEEPER, cwd: "/tmp/x" }, live: true, persisted: true },
  ];
  runningIds = new Set([KEEPER]);
  const r = await state([STALE, KEEPER, LIVE_ONLY]);
  check("14a /session-state → 200 + available:true", r.status === 200 && r.json.available === true, JSON.stringify(r.json));
  const items = Object.fromEntries((r.json.items ?? []).map((it) => [it.id, it]));
  check("14b 磁盘无日志、只有内存副本：persisted=false / live=true",
    items[STALE].persisted === false && items[STALE].live === true, JSON.stringify(items[STALE]));
  check("14c 磁盘有 durable 日志：persisted=true", items[KEEPER].persisted === true, JSON.stringify(items[KEEPER]));
  check("14d 在跑的会话带 running=true", items[KEEPER].running === true, JSON.stringify(items[KEEPER]));
  check("14e Host 列表里没有的 id：known=false（前端不会据此隐藏）",
    items[LIVE_ONLY].known === false, JSON.stringify(items[LIVE_ONLY]));
  check("14f 只读：磁盘上的会话目录原封不动", await exists(staleDir));
  await rm(staleDir, { recursive: true, force: true });
  sessionQueryRecords = [];
}
// 15. /session-state 必须 fail soft：判不准就什么都不隐藏（available:false），绝不能 5xx
{
  sessionQueryRecords = [{ header: { id: KEEPER, cwd: "/tmp/x" }, live: true, persisted: false }];
  sessionQueryThrows = true;
  const r1 = await state([KEEPER]);
  check("15a 查询服务抛错 → available:false（不是 500）", r1.status === 200 && r1.json.available === false, JSON.stringify(r1.json));
  sessionQueryThrows = false;

  // agents 服务缺失 → 活性判不准 → available:false
  const noAgents = createHandler({ getSessionQuery: () => ({ listSessions: async () => sessionQueryRecords }) });
  const naServer = createServer((req, res) => void noAgents(req, res));
  await new Promise((ok) => naServer.listen(0, "127.0.0.1", ok));
  const naRes = await fetch(`http://127.0.0.1:${naServer.address().port}/obsidian/session-state`, {
    method: "POST", headers: { "x-dsh-obsidian": "1", "content-type": "application/json" }, body: JSON.stringify({ ids: [KEEPER] }),
  });
  const naJson = await naRes.json();
  check("15b 无 agents 服务 → available:false", naJson.available === false, JSON.stringify(naJson));
  naServer.close();

  // agents.get 抛错 → 该条按「在跑」处理（宁可多留一行，也不隐藏可能还活着的会话）
  const throwingAgents = createHandler({
    getAgents: () => ({ get: () => { throw new Error("agent registry exploded"); } }),
    getSessionQuery: () => ({ listSessions: async () => sessionQueryRecords }),
  });
  const taServer = createServer((req, res) => void throwingAgents(req, res));
  await new Promise((ok) => taServer.listen(0, "127.0.0.1", ok));
  const taRes = await fetch(`http://127.0.0.1:${taServer.address().port}/obsidian/session-state`, {
    method: "POST", headers: { "x-dsh-obsidian": "1", "content-type": "application/json" }, body: JSON.stringify({ ids: [KEEPER] }),
  });
  const taJson = await taRes.json();
  check("15c 活性查询抛错 → 该条 running:true（不隐藏）",
    taJson.available === true && taJson.items[0].running === true && taJson.items[0].persisted === false,
    JSON.stringify(taJson));
  taServer.close();

  // 服务整体缺失（未挂载 sessionQuery）→ available:false，而不是 404/500
  const bare = createHandler({ getAgents: () => ({ get: () => undefined }) });
  const bareServer2 = createServer((req, res) => void bare(req, res));
  await new Promise((ok) => bareServer2.listen(0, "127.0.0.1", ok));
  const bareRes = await fetch(`http://127.0.0.1:${bareServer2.address().port}/obsidian/session-state`, {
    method: "POST", headers: { "x-dsh-obsidian": "1", "content-type": "application/json" }, body: JSON.stringify({ ids: [KEEPER] }),
  });
  const bareJson = await bareRes.json();
  check("15d 未挂载 sessionQuery → available:false", bareRes.status === 200 && bareJson.available === false, JSON.stringify(bareJson));
  bareServer2.close();
  sessionQueryRecords = [];
}
// 16. /session-state 的输入校验与超限（与删除路由同款：任何非法输入都不许变成 500）
{
  const get = await call("/obsidian/session-state");
  check("16a GET → 405", get.status === 405, String(get.status));
  const empty = await state([]);
  check("16b 空 ids → 400", empty.status === 400, String(empty.status));
  const bad = await state(["../../etc/passwd"]);
  check("16c 路径穿越 id → 400", bad.status === 400, JSON.stringify(bad.json));
  const notArray = await call("/obsidian/session-state", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: "x" }),
  });
  check("16d ids 非数组 → 400", notArray.status === 400, String(notArray.status));
  const many = await state(Array.from({ length: 501 }, (_, i) => `session-${String(i).padStart(8, "0")}`));
  check("16e 超过 id 上限 → 413", many.status === 413, String(many.status));
  const big = await call("/obsidian/session-state", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: ["session-" + "a".repeat(70 * 1024)] }),
  });
  check("16f 超限 body → 413", big.status === 413, JSON.stringify({ status: big.status, json: big.json }));
}
// 17. 重删「磁盘上早已没有日志」的会话：missing 也要回执 attached
//     —— 前端据此说明「这行其实是内存副本撑着，重启后消失」，否则提示会漏掉原因
{
  attachedIds = new Set([PARENT]);
  const r = await post([PARENT]);
  check("17a 目录不存在 → missing（不是错误）",
    r.status === 200 && r.json.missing.length === 1 && r.json.deleted.length === 0, JSON.stringify(r.json));
  check("17b missing 也回执 attached",
    JSON.stringify(r.json.attached) === JSON.stringify([PARENT]), JSON.stringify(r.json.attached));
  attachedIds = new Set();
}

server.close();
await rm(base, { recursive: true, force: true });

console.log("");
if (failures.length > 0) {
  console.error(`${failures.length} check(s) FAILED: ${failures.join(" | ")}`);
  process.exit(1);
}
console.log("all session-delete host checks passed ✔");
