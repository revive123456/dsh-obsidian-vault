/**
 * client 交互 + 数据层测试（无真实 React/浏览器）：
 *  - 有状态钩子桩 + 微渲染器（函数组件展开），驱动真实 onClick / onChange
 *  - fetch mock（/obsidian/* 路由表，记录调用），覆盖 TreeView/Dock 全链路
 *  - window/document/navigator 桩：prompt/confirm、剪贴板、对话输入框注入
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const code = readFileSync(join(root, "lib", "client.js"), "utf8");

// ── 断言工具 ────────────────────────────────────────────────────────────────
const failures = [];
function check(name, cond, extra = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures.push(name);
}

// ── window / document / navigator / fetch 桩 ────────────────────────────────
const timers = [];
const promptCalls = [];
const confirmCalls = [];
let promptResult = null;
let confirmResult = true;
const composer = {
  value: "",
  disabled: false,
  readOnly: false,
  events: [],
  setSelectionRange() { },
  focus() { },
  dispatchEvent(e) { composer.events.push(e.type); },
};
let composerAvailable = true;
const clipboardWrites = [];
let registration = null;
const fakeWindow = {
  __ModuleLoader__: { load: (reg) => { registration = reg; } },
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
  clearTimeout: (id) => { if (id) timers[id - 1] = null; },
  setInterval: () => 0,
  clearInterval: () => { },
  prompt: (msg, def) => { promptCalls.push({ msg, def }); return promptResult; },
  confirm: (msg) => { confirmCalls.push(msg); return confirmResult; },
  HTMLTextAreaElement: { prototype: { value: undefined } },
};
globalThis.localStorage = {
  store: new Map([["dsh-obsidian:notesOpen", "1"]]),
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
  setItem(k, v) { this.store.set(k, String(v)); },
  removeItem(k) { this.store.delete(k); },
};
globalThis.document = {
  querySelector: (sel) => {
    if (sel.includes("data-plugin-css")) return null;
    if (sel === "div[data-input-scroll]") return composerAvailable ? { querySelector: () => composer } : null;
    return null;
  },
  createElement: () => ({ dataset: {} }),
  head: { appendChild: () => { } },
  body: { classList: { add() { }, remove() { } } },
};
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async (t) => { clipboardWrites.push(t); } } },
  configurable: true,
});
globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
globalThis.clearTimeout = () => { };
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => { };

function flushTimers() {
  const pending = [...timers];
  timers.length = 0;
  for (const fn of pending) if (fn) fn();
}
async function settle(n = 4) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

// ── fetch mock：/obsidian/* 路由表 ──────────────────────────────────────────
const fetchCalls = [];
let vault = { root: "D:\\vault", exists: true };
// 最近一次 /obsidian/session-delete 的返回（模拟 host 全部命中）
let deletedIds = [];
// 非 null 时该路由固定返回该状态码（模拟 host 未重启 → 404）
let deleteRouteStatus = null;
const vaultFiles = {
  "": [
    { name: "sub", type: "dir", size: 0, mtimeMs: 1 },
    { name: "a.md", type: "note", size: 633, mtimeMs: 1 },
    { name: "b.md", type: "note", size: 1536, mtimeMs: 1 },
    { name: "c.md", type: "note", size: 2621440, mtimeMs: 1 },
  ],
  sub: [{ name: "deep.md", type: "note", size: 20, mtimeMs: 2 }],
};
const noteContent = {
  "a.md": { content: "# Hello\n\nWorld [[双链目标]]", mtimeMs: 1, size: 633 },
  "sub/deep.md": { content: "# Deep\n\n终端笔记", mtimeMs: 2, size: 20 },
};
const searchResults = {
  "gpu": [{ path: "a.md", name: "a.md", snippet: "…gpu 内容…" }],
  "双链目标": [{ path: "sub/deep.md", name: "deep.md", snippet: "" }],
};

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj };
}
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url, "http://x");
  const method = (init.method ?? "GET").toUpperCase();
  let body;
  try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
  fetchCalls.push({ method, path: u.pathname, search: u.search, body });
  if (u.pathname === "/obsidian/root") {
    if (method === "POST") {
      vault = { root: body.root, exists: true };
      return jsonResponse({ root: vault.root, exists: true });
    }
    return jsonResponse({ root: vault.root, exists: vault.exists });
  }
  if (u.pathname === "/obsidian/tree") {
    const p = decodeURIComponent(u.searchParams.get("path") ?? "");
    return jsonResponse({ path: p, entries: vaultFiles[p] ?? [] });
  }
  if (u.pathname === "/obsidian/note") {
    if (method === "POST") {
      noteContent[body.path] = { content: body.content, mtimeMs: Date.now(), size: body.content.length };
      return jsonResponse({ ok: true });
    }
    const p = u.searchParams.get("path");
    const stored = noteContent[p];
    if (!stored) return jsonResponse({ error: "note not found" }, 404);
    return jsonResponse({ path: p, name: p.split("/").pop(), content: stored.content, frontmatter: {}, links: [], size: stored.size, mtimeMs: stored.mtimeMs });
  }
  if (u.pathname === "/obsidian/file") {
    if (body.action === "new") return jsonResponse({ ok: true, path: body.path === "" ? `${body.name}.md` : `${body.path}/${body.name}.md` });
    if (body.action === "mkdir") return jsonResponse({ ok: true, path: body.path === "" ? body.name : `${body.path}/${body.name}` });
    if (body.action === "rename") {
      const target = `${body.newName}.md`;
      noteContent[target] = { content: "# 改名后\n", mtimeMs: Date.now(), size: 12 };
      return jsonResponse({ ok: true, name: target });
    }
    if (body.action === "delete") return jsonResponse({ ok: true });
  }
  if (u.pathname === "/obsidian/session-delete") {
    // 可切换成 404：模拟 host 未重启（旧进程没有这条路由）
    if (deleteRouteStatus !== null) {
      return jsonResponse({ error: "unknown action session-delete" }, deleteRouteStatus);
    }
    // host 侧真删除：模拟「全部命中且删后校验通过」，只回 explicit 的 id
    deletedIds = [...(body.ids ?? [])];
    return jsonResponse({ deleted: deletedIds, missing: [], failed: [], verified: true, root: "/home/.dsh/sessions" });
  }
  if (u.pathname === "/obsidian/search") {
    const q = u.searchParams.get("q") ?? "";
    return jsonResponse({ results: searchResults[q] ?? [] });
  }
  return jsonResponse({ error: `no route ${url}` }, 404);
};

// ── 有状态钩子桩 + 微渲染器 ─────────────────────────────────────────────────
const Fragment = Symbol.for("react.fragment");
function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
}
const scopes = new Map();      // fn → { id, hooks }
const effectEntries = new Map(); // `${scopeId}:${slot}` → { fn, deps, lastDeps, cleanup }
let scopeSeq = 0;

function depsChanged(prev, next) {
  if (prev === undefined) return true;
  if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return true;
  return prev.some((v, i) => v !== next[i]);
}
let activeFn = null;
const hook = (init) => {
  const s = scopes.get(activeFn);
  const i = s.cursor++;
  if (s.hooks[i] === undefined) s.hooks[i] = {};
  return { s, h: s.hooks[i] };
};
const stubReact = {
  Fragment,
  createElement,
  useState(init) {
    const { h } = hook();
    if (!("value" in h)) h.value = typeof init === "function" ? init() : init;
    return [h.value, (v) => { h.value = typeof v === "function" ? v(h.value) : v; }];
  },
  useEffect(fn, deps) {
    const { s } = hook();
    const key = `${s.id}:${s.cursor - 1}`;
    const prev = effectEntries.get(key);
    effectEntries.set(key, { fn, deps, lastDeps: prev?.lastDeps, cleanup: prev?.cleanup });
  },
  useRef(init) {
    const { h } = hook();
    if (!("ref" in h)) h.ref = { current: init ?? null };
    return h.ref;
  },
  useCallback(fn, deps) {
    const { h } = hook();
    if (depsChanged(h.deps, deps)) h.fn = fn;
    h.deps = deps;
    return h.fn;
  },
  useMemo(fn, deps) {
    const { h } = hook();
    if (depsChanged(h.deps, deps)) h.value = fn();
    h.deps = deps;
    return h.value;
  },
  useSyncExternalStore(_sub, get) { return get(); },
};

function invoke(fn, props) {
  let s = scopes.get(fn);
  if (!s) { s = { id: ++scopeSeq, hooks: [] }; scopes.set(fn, s); }
  s.cursor = 0;
  activeFn = fn;
  try {
    return fn(props);
  } finally {
    activeFn = null;
  }
}
function runEffects() {
  for (const e of effectEntries.values()) {
    if (!depsChanged(e.lastDeps, e.deps)) continue;
    if (e.cleanup) { try { e.cleanup(); } catch { /* ignore */ } }
    e.lastDeps = e.deps;
    const r = e.fn();
    if (typeof r === "function") e.cleanup = r;
  }
}
// 展开函数组件/Fragment 元素（模拟 React 挂载）
function expand(node) {
  if (node === null || node === undefined || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expand);
  const { type, props } = node;
  if (typeof type === "function") return expand(invoke(type, props));
  if (type === Fragment) {
    const kids = Array.isArray(props.children) ? props.children : [props.children];
    return kids.map(expand);
  }
  const kids = props?.children;
  if (kids !== undefined) {
    return { ...node, props: { ...props, children: Array.isArray(kids) ? kids.map(expand) : expand(kids) } };
  }
  return node;
}
function renderTree(fn, props) {
  const tree = expand(invoke(fn, props));
  runEffects();
  return tree;
}
function resetScopes() {
  scopes.clear();
  effectEntries.clear();
}

// ── 树遍历工具 ──────────────────────────────────────────────────────────────
function findAll(node, pred, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out; }
  if (typeof node !== "object") return out;
  if (pred(node.props ?? {}, node)) out.push(node);
  const kids = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
  for (const k of kids) findAll(k, pred, out);
  return out;
}
function textOf(node, out = "") {
  if (!node) return out;
  if (Array.isArray(node)) return node.reduce((acc, n) => textOf(n, acc), out);
  if (typeof node !== "object") return out + String(node);
  const kids = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
  return kids.reduce((acc, k) => textOf(k, acc), out);
}
const byTitle = (title) => (p) => p.title === title;
const byText = (txt) => (p, n) => textOf(n) === txt;
const byTextIncludes = (txt) => (p, n) => textOf(n).includes(txt);
const byClass = (cls) => (p, n) => typeof p.className === "string" && p.className.includes(cls);
const byRowText = (text) => (p, n) => typeof p.className === "string" && p.className.includes("dsh-obs-row") && textOf(n).includes(text);
const click = (el) => {
  if (!el) { check("click target not found", false); return; }
  el.props.onClick({ stopPropagation() { }, preventDefault() { }, target: {} });
};

// ── 装载 bundle ─────────────────────────────────────────────────────────────
new Function("window", `${code}\nreturn null;`)(fakeWindow);
const exports_ = registration.factory((spec) => {
  if (spec === "react") return stubReact;
  if (spec === "react/jsx-runtime") return {};
  throw new Error(`unexpected require(${spec})`);
});
const registrations = [];
const stubSlots = {
  inject: (_k, cb) => { cb(); return () => { }; },
  register: (options, component) => {
    registrations.push({ options, component });
    return () => { };
  },
};
// ctx.workspaces = IWorkspaces（纯控制器）：只有 list/create/rename/delete/
// archiveSession/insert*，没有 startSession / pickDirectory —— 这两个方法属于
// ctx.uiWorkspace。夹具必须与真实服务一致，否则「＋无反应」这类 bug 测不出来。
const ctxWorkspaces = { create: async () => ({}), rename: async () => { }, delete: async () => { }, archiveSession: async () => { } };
const ctxSessionCalls = [];
const ctxSessions = {
  create: async (opts) => { ctxSessionCalls.push(["create", opts]); return "s-new"; },
  open: (id) => ctxSessionCalls.push(["open", id]),
  binding: () => ({ session: { rename: async () => ({ ok: true }) } }),
};
const ctxUiWorkspaceCalls = [];
const ctxUiWorkspace = {
  startSession: (id) => ctxUiWorkspaceCalls.push(["startSession", id]),
  pickDirectory: async () => { ctxUiWorkspaceCalls.push(["pickDirectory"]); return "D:\\picked"; },
};
// 模拟「官方 ui-workspace 服务不在位」：插件应退回 sessions.create + open
let uiWorkspaceReady = true;
const fakeCtx = {
  effect: () => { },
  locale: { register: () => { } },
  slots: stubSlots,
  workspaces: ctxWorkspaces,
  sessions: ctxSessions,
  // 服务经 ctx.get 惰性解析；undefined 即服务缺失
  get: (name) => (name === "uiWorkspace" && uiWorkspaceReady ? ctxUiWorkspace : undefined),
};
exports_.apply(fakeCtx);
const byId = Object.fromEntries(registrations.map((r) => [r.options.id, r.component]));
const Sidebar = byId["obsidian-workspace-sidebar"];
const DockC = byId["obsidian-dock"];
const ToastC = byId["obsidian-toast"];
const t = (k, p) => (p ? `${k}(${JSON.stringify(p)})` : k);

// ── 夹具（模块级共享，保持引用稳定以符合真实 React 的 deps 语义）──────────
const NOW = Date.now();
function sessionsFixture() {
  return {
    ids: ["s1", "s2", "s3", "s4"],
    byId: {
      s1: { id: "s1", title: "会话一", displayTitle: "会话一", cwd: "D:\\code\\ds_workspace", updatedAt: NOW - 30 * 1000, blank: false },
      s2: { id: "s2", title: "会话二", displayTitle: "会话二", updatedAt: NOW - 3 * 60000, blank: false },
      s3: { id: "s3", title: "游离会话", displayTitle: "游离会话", updatedAt: NOW - 12600000, blank: false },
      s4: { id: "s4", title: "obsidian_vault", displayTitle: "obsidian_vault", cwd: "D:\\obsidian_vault", updatedAt: NOW - 60000, blank: true },
    },
    current: "s1",
    phase: "ready",
  };
}
function workspacesFixture() {
  return {
    items: [
      { workspaceId: "ws1", path: "D:\\code\\ds_workspace", title: "ds_workspace", sessionIds: ["s1", "s2"], createdAt: "", updatedAt: "" },
      { workspaceId: "ws2", path: "D:\\obsidian_vault", title: "obsidian_vault", sessionIds: ["s4"], createdAt: "", updatedAt: "" },
    ],
    archivedSessionIds: [],
    state: "ready", phase: "ready", error: null, baselinesReady: true, recentWorkspaceId: "ws1",
  };
}
const SF = sessionsFixture();
const WF = workspacesFixture();
const serviceLog = { calls: [] };
const services = {
  // 真实 ctx.workspaces（IWorkspaces）没有 startSession / pickDirectory：
  // 这里刻意不提供，保证「＋」只能命中 uiWorkspace，回归可被测试捕获。
  workspaces: {
    create: async (input) => { serviceLog.calls.push(["createWs", input && input.path]); return { workspaceId: "ws9", path: "D:\\picked", title: "picked" }; },
    rename: async (id, title) => serviceLog.calls.push(["renameWs", id, title]),
    delete: async (id) => serviceLog.calls.push(["deleteWs", id]),
    archiveSession: async (id) => serviceLog.calls.push(["archiveSession", id]),
  },
  // ctx.uiWorkspace（官方 @deepseek-ai/dsh-client-ui-workspace）：新建会话 + 选目录。
  // 夹具传入的 uiWorkspace 是插件 apply() 里真正装配的外观对象（见 sidebarProps），
  // 它经 ctx.get("uiWorkspace") 惰性解析后落到本 mock，故断言看 ctxUiWorkspaceCalls。
  sessions: {
    open: (id) => serviceLog.calls.push(["open", id]),
    // 删除成功后插件必须调用它刷新 Host 权威列表，否则已删会话仍留在前端行里
    refresh: async () => serviceLog.calls.push(["sessionsRefresh"]),
    binding: (id) => ({ session: { rename: async (title) => { serviceLog.calls.push(["renameSession", id, title]); return { ok: true, title, seq: 1 }; } } }),
  },
};
const sidebarProps = () => ({
  wide: true,
  expandSidebar: () => serviceLog.calls.push(["expandSidebar"]),
  t,
  useSessions: (sel) => sel(SF),
  useWorkspaces: (sel) => sel(WF),
  ...services,
  // 生产链路里就是这个外观对象（slots 的 inject 工厂交付），
  // 它内部按点击时刻解析 ctx.get("uiWorkspace")。
  uiWorkspace: registrations.find((r) => r.options.id === "obsidian-workspace-sidebar").options.inject().uiWorkspace,
});
const event = { stopPropagation() { }, preventDefault() { }, target: {} };

// ═════════════════════════ A. 纯函数行为（渲染输出断言） ═════════════════════════
resetScopes();
{
  const fs = sessionsFixture();
  fs.ids = ["s1", "s2", "s3", "s4", "s5"];
  fs.byId = {
    s1: { id: "s1", title: "t0", displayTitle: "t0", cwd: "D:\\code\\ds_workspace", updatedAt: NOW - 30 * 1000, blank: false },
    s2: { id: "s2", title: "t1", displayTitle: "t1", cwd: "D:\\code\\ds_workspace", updatedAt: NOW - 3 * 60000, blank: false },
    s3: { id: "s3", title: "t2", displayTitle: "t2", cwd: "D:\\code\\ds_workspace", updatedAt: NOW - 2 * 3600000, blank: false },
    s4: { id: "s4", title: "t3", displayTitle: "t3", cwd: "D:\\code\\ds_workspace", updatedAt: NOW - 3 * 86400000, blank: false },
    s5: { id: "s5", title: "t4", displayTitle: "t4", cwd: "D:\\code\\ds_workspace", updatedAt: NOW - 40 * 86400000, blank: false },
  };
  fs.current = "s1";
  const wf = workspacesFixture();
  wf.items[0].sessionIds = ["s1", "s2", "s3", "s4", "s5"];
  const props = { ...sidebarProps(), useSessions: (sel) => sel(fs), useWorkspaces: (sel) => sel(wf) };
  const tree = renderTree(Sidebar, props);
  const times = findAll(tree, byClass("dsh-obs-time")).map((n) => textOf(n));
  const d = new Date(fs.byId.s5.updatedAt);
  const dateStr = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  check("A1 相对时间·刚刚", times.some((x) => x === t("time.justNow")), JSON.stringify(times));
  check("A2 相对时间·分钟", times.some((x) => x === t("time.minutes", { n: 3 })));
  check("A3 相对时间·小时", times.some((x) => x === t("time.hours", { n: 2 })));
  check("A4 相对时间·天", times.some((x) => x === t("time.days", { n: 3 })));
  check("A5 相对时间·日期", times.some((x) => x === dateStr), `${JSON.stringify(times)} vs ${dateStr}`);
}

// ═════════════════════════ B. WorkspaceSidebar 交互 ═════════════════════════
// B1 打开会话
resetScopes();
{
  serviceLog.calls.length = 0;
  const tree = renderTree(Sidebar, sidebarProps());
  const row = findAll(tree, byClass("dsh-obs-session"))[0]; // 行 div（含 onClick）
  check("B1 会话行存在且可点击", row !== undefined && typeof row.props.onClick === "function");
  click(row);
  check("B1b 点击会话行 → sessions.open(id)", serviceLog.calls.some((c) => c[0] === "open" && c[1] === "s1"), JSON.stringify(serviceLog.calls));
}
// B2 工作区组展开/收起
resetScopes();
{
  const tree1 = renderTree(Sidebar, sidebarProps());
  check("B2a 初始当前组展开", findAll(tree1, byClass("dsh-obs-session")).length >= 2);
  click(findAll(tree1, byClass("dsh-obs-ws-row"))[0]);
  const tree2 = renderTree(Sidebar, sidebarProps());
  const collapsed = findAll(tree2, byClass("dsh-obs-session")).length;
  check("B2b 点组行收起 → 会话被隐藏", collapsed === 0, `rows=${collapsed}`);
  click(findAll(tree2, byClass("dsh-obs-ws-row"))[0]);
  const tree3 = renderTree(Sidebar, sidebarProps());
  check("B2c 再点组行 → 会话恢复", findAll(tree3, byClass("dsh-obs-session")).length >= 2);
}
// B3 工作区行 ＋ 新建会话（必须走 ctx.uiWorkspace，而非 ctx.workspaces）
resetScopes();
{
  serviceLog.calls.length = 0;
  ctxUiWorkspaceCalls.length = 0;
  const tree = renderTree(Sidebar, sidebarProps());
  const plus = findAll(tree, byTitle("newSession"))[0];
  check("B3a 工作区行 ＋ 存在", plus !== undefined);
  click(plus);
  // 根因回归：以前调 workspaces.startSession（真实 IWorkspaces 无此方法）→ 静默无反应
  check("B3b 工作区 ＋ → uiWorkspace.startSession(wsId)",
    ctxUiWorkspaceCalls.some((c) => c[0] === "startSession" && c[1] === "ws1"), JSON.stringify(ctxUiWorkspaceCalls));
  check("B3c 完全不依赖 workspaces.startSession", typeof services.workspaces.startSession === "undefined");
  check("B3d 点 ＋ 展开目标工作区", findAll(renderTree(Sidebar, sidebarProps()), byClass("dsh-obs-session")).length >= 2);
}
// B3x uiWorkspace 服务缺失 → 退回 sessions.create + open，仍然能新建
resetScopes();
{
  uiWorkspaceReady = false;
  serviceLog.calls.length = 0;
  ctxSessionCalls.length = 0;
  const tree = renderTree(Sidebar, sidebarProps());
  click(findAll(tree, byTitle("newSession"))[0]);
  await settle();
  check("B3x-1 无 uiWorkspace → sessions.create({workspaceId})",
    ctxSessionCalls.some((c) => c[0] === "create" && c[1] && c[1].workspaceId === "ws1"), JSON.stringify(ctxSessionCalls));
  check("B3x-2 无 uiWorkspace → create 后 open 新会话",
    ctxSessionCalls.some((c) => c[0] === "open" && c[1] === "s-new"), JSON.stringify(ctxSessionCalls));
  uiWorkspaceReady = true;
}
// B4 区头 ＋ 添加工作区（pick → create → startSession）
resetScopes();
{
  serviceLog.calls.length = 0;
  const tree = renderTree(Sidebar, sidebarProps());
  ctxUiWorkspaceCalls.length = 0;
  click(findAll(tree, byTitle("addWorkspace"))[0]);
  await settle();
  check("B4 添加工作区 pick(uiWorkspace)→create→startSession(uiWorkspace)",
    ctxUiWorkspaceCalls.some((c) => c[0] === "pickDirectory")
    && serviceLog.calls.some((c) => c[0] === "createWs" && c[1] === "D:\\picked")
    && ctxUiWorkspaceCalls.some((c) => c[0] === "startSession" && c[1] === "ws9"),
    JSON.stringify({ ui: ctxUiWorkspaceCalls, ws: serviceLog.calls }));
}
// B5 工作区删除（确认/取消）
resetScopes();
{
  serviceLog.calls.length = 0;
  confirmResult = true;
  let tree = renderTree(Sidebar, sidebarProps());
  click(findAll(tree, byTitle("delete"))[0]);
  check("B5a 确认删除 → workspaces.delete(wsId)", serviceLog.calls.some((c) => c[0] === "deleteWs" && c[1] === "ws1"), JSON.stringify(serviceLog.calls));
  check("B5b confirm 提示含工作区名", confirmCalls.some((m) => typeof m === "string" && m.includes("ds_workspace")));
  serviceLog.calls.length = 0;
  confirmResult = false;
  tree = renderTree(Sidebar, sidebarProps());
  click(findAll(tree, byTitle("delete"))[0]);
  check("B5c 取消删除 → 不调用 delete", !serviceLog.calls.some((c) => c[0] === "deleteWs"));
}
// B6 工作区重命名（输入/取消）
resetScopes();
{
  serviceLog.calls.length = 0;
  promptResult = "新名字";
  let tree = renderTree(Sidebar, sidebarProps());
  click(findAll(tree, byTitle("rename"))[0]);
  await settle();
  check("B6a 重命名 → workspaces.rename(id,title)", serviceLog.calls.some((c) => c[0] === "renameWs" && c[1] === "ws1" && c[2] === "新名字"), JSON.stringify(serviceLog.calls));
  serviceLog.calls.length = 0;
  promptResult = null;
  tree = renderTree(Sidebar, sidebarProps());
  click(findAll(tree, byTitle("rename"))[0]);
  check("B6b prompt 取消 → 不调用 rename", !serviceLog.calls.some((c) => c[0] === "renameWs"));
}
// B7 会话「归档」：确认 → archiveSession（移出列表，日志保留；不碰 host 删除路由）
resetScopes();
{
  serviceLog.calls.length = 0;
  fetchCalls.length = 0;
  confirmResult = true;
  let tree = renderTree(Sidebar, sidebarProps());
  const btns = findAll(tree, byTitle("archiveSession"));
  check("B7a 归档按钮每行一个", btns.length === 2, `n=${btns.length}`);
  click(btns[0]);
  await settle();
  check("B7b 确认 → archiveSession(s1)", serviceLog.calls.some((c) => c[0] === "archiveSession" && c[1] === "s1"), JSON.stringify(serviceLog.calls));
  check("B7c 归档不调用 host 删除路由", !fetchCalls.some((c) => c.path === "/obsidian/session-delete"), JSON.stringify(fetchCalls.map((c) => c.path)));
  serviceLog.calls.length = 0;
  confirmResult = false;
  tree = renderTree(Sidebar, sidebarProps());
  click(findAll(tree, byTitle("archiveSession"))[0]);
  check("B7d 取消 → 不调用 archiveSession", !serviceLog.calls.some((c) => c[0] === "archiveSession"));
}
// B7e 会话「彻底删除」：确认 → host /obsidian/session-delete，且不带 archiveSession
resetScopes();
{
  serviceLog.calls.length = 0;
  fetchCalls.length = 0;
  confirmResult = true;
  let tree = renderTree(Sidebar, sidebarProps());
  // 第 0 行是当前会话 s1（必须被拒绝，见 B7f），所以这里删 s2
  const rowS2 = findAll(tree, byClass("dsh-obs-session")).find((r) => textOf(r).includes("会话二"));
  click(findAll(rowS2, byTitle("deleteSession"))[0]);
  await settle();
  const call = fetchCalls.find((c) => c.method === "POST" && c.path === "/obsidian/session-delete");
  check("B7e-1 确认 → POST /obsidian/session-delete", call !== undefined, JSON.stringify(fetchCalls.map((c) => c.path)));
  check("B7e-2 请求体只含该会话（无子代理）", JSON.stringify(call && call.body) === JSON.stringify({ ids: ["s2"] }), JSON.stringify(call && call.body));
  check("B7e-3 彻底删除不走归档 RPC", !serviceLog.calls.some((c) => c[0] === "archiveSession"), JSON.stringify(serviceLog.calls));
  check("B7e-5 删除成功后刷新 Host 会话列表", serviceLog.calls.some((c) => c[0] === "sessionsRefresh"), JSON.stringify(serviceLog.calls));
  serviceLog.calls.length = 0;
  fetchCalls.length = 0;
  confirmResult = false;
  tree = renderTree(Sidebar, sidebarProps());
  click(findAll(tree, byTitle("deleteSession"))[1]);
  check("B7e-4 取消 → 不调用 host 删除路由", !fetchCalls.some((c) => c.path === "/obsidian/session-delete"));
  check("B7e-6 取消 → 不刷新列表", !serviceLog.calls.some((c) => c[0] === "sessionsRefresh"));
}
// B7i host 未重启（路由 404）时：必须明确报「接口未生效」，不能伪装成「没找到会话」
resetScopes();
{
  serviceLog.calls.length = 0;
  fetchCalls.length = 0;
  confirmResult = true;
  deleteRouteStatus = 404;
  let tree = renderTree(Sidebar, sidebarProps());
  const rowS2 = findAll(tree, byClass("dsh-obs-session")).find((r) => textOf(r).includes("会话二"));
  click(findAll(rowS2, byTitle("deleteSession"))[0]);
  await settle();
  const toast = textOf(renderTree(ToastC, { t }));
  check("B7i-1 404 → 提示需重启 dsh web", toast.includes(t("sessionDeleteUnavailable")), `toast=${toast}`);
  check("B7i-2 404 不谎报「没找到会话」", !toast.includes(t("nothingDeleted")), `toast=${toast}`);
  check("B7i-3 404 不刷新列表", !serviceLog.calls.some((c) => c[0] === "sessionsRefresh"), JSON.stringify(serviceLog.calls));
  deleteRouteStatus = null;
  // 恢复后再验一次：路由正常时提示成功
  serviceLog.calls.length = 0;
  fetchCalls.length = 0;
  tree = renderTree(Sidebar, sidebarProps());
  const rowS2b = findAll(tree, byClass("dsh-obs-session")).find((r) => textOf(r).includes("会话二"));
  click(findAll(rowS2b, byTitle("deleteSession"))[0]);
  await settle();
  const okToast = textOf(renderTree(ToastC, { t }));
  check("B7i-4 正常路径 → 报成功", okToast.includes(t("deletedPermanently")), `toast=${okToast}`);
}
// B7f 当前会话（正在运行的那条）拒绝彻底删除 —— 删了会把日志从运行中的进程脚下抽走
resetScopes();
{
  fetchCalls.length = 0;
  confirmResult = true;
  const tree = renderTree(Sidebar, sidebarProps());   // current = s1
  // 直接调组件闭包里的回调：当前会话行是 s1，其 🗑 必须被拒绝
  click(findAll(tree, byTitle("deleteSession"))[0]);
  await settle();
  check("B7f 当前会话拒绝删除（不发请求）", !fetchCalls.some((c) => c.path === "/obsidian/session-delete"), JSON.stringify(fetchCalls.map((c) => c.path)));
}
// B7g 父会话彻底删除必须连同子代理闭包一起删（否则子会话悬空）
resetScopes();
{
  fetchCalls.length = 0;
  confirmResult = true;
  const fs = sessionsFixture();
  fs.current = "s2";   // 当前会话不能是要删的那个（会被活性护栏拒绝）
  fs.ids = ["s1", "s2", "sub1", "sub2", "sub3"];
  fs.byId = {
    s1: { id: "s1", title: "会话一", displayTitle: "会话一", cwd: "D:\\code\\ds_workspace", updatedAt: NOW, blank: false },
    s2: { id: "s2", title: "会话二", displayTitle: "会话二", updatedAt: NOW - 60000, blank: false },
    sub1: { id: "sub1", title: "子代理一", displayTitle: "子代理一", updatedAt: NOW, blank: false, origin: "subagent", parentId: "s1" },
    sub2: { id: "sub2", title: "子代理二", displayTitle: "子代理二", updatedAt: NOW, blank: false, origin: "subagent", parentId: "sub1" },
    sub3: { id: "sub3", title: "别的子代理", displayTitle: "别的子代理", updatedAt: NOW, blank: false, origin: "subagent", parentId: "s2" },
  };
  const wf = workspacesFixture();
  wf.items[0].sessionIds = ["s1", "s2", "sub1", "sub2", "sub3"];
  const props = { ...sidebarProps(), useSessions: (sel) => sel(fs), useWorkspaces: (sel) => sel(wf) };
  const tree = renderTree(Sidebar, props);
  // byClass 是 includes 匹配，会连 dsh-obs-session-title 一起命中，这里要精确到行
  const rows = findAll(tree, (p) => typeof p.className === "string" && p.className.split(/\s+/).includes("dsh-obs-session"));
  check("B7g-1 子代理不单独成行", rows.length === 2, `n=${rows.length}`);
  // 第一行是 s1（父）：只点它，验证闭包把 sub1/sub2 一起带上，且不带 s2 的 sub3
  const parentRow = rows.find((r) => textOf(r).includes("会话一"));
  const delBtn = findAll(parentRow, byTitle("deleteSession"))[0];
  check("B7g-2 父行有彻底删除按钮", delBtn !== undefined);
  click(delBtn);
  await settle();
  const call = fetchCalls.find((c) => c.path === "/obsidian/session-delete");
  const ids = call ? [...call.body.ids].sort() : [];
  check("B7g-3 闭包 = 父 + 全部后代", JSON.stringify(ids) === JSON.stringify(["s1", "sub1", "sub2"]), JSON.stringify(ids));
  check("B7g-4 不牵连无关会话", !ids.includes("s2") && !ids.includes("sub3"), JSON.stringify(ids));
}
// B7h 子代理正在运行时，父会话拒绝彻底删除
resetScopes();
{
  fetchCalls.length = 0;
  confirmResult = true;
  const fs = sessionsFixture();
  fs.ids = ["s1", "sub1"];
  fs.byId = {
    s1: { id: "s1", title: "会话一", displayTitle: "会话一", cwd: "D:\\code\\ds_workspace", updatedAt: NOW, blank: false },
    sub1: { id: "sub1", title: "子代理一", displayTitle: "子代理一", updatedAt: NOW, blank: false, origin: "subagent", parentId: "s1", running: true },
  };
  const wf = workspacesFixture();
  wf.items[0].sessionIds = ["s1", "sub1"];
  const props = { ...sidebarProps(), useSessions: (sel) => sel(fs), useWorkspaces: (sel) => sel(wf) };
  const tree = renderTree(Sidebar, props);
  const parentRow = findAll(tree, byClass("dsh-obs-session")).find((r) => textOf(r).includes("会话一"));
  click(findAll(parentRow, byTitle("deleteSession"))[0]);
  await settle();
  check("B7h 子代理运行中 → 父会话拒绝删除", !fetchCalls.some((c) => c.path === "/obsidian/session-delete"), JSON.stringify(fetchCalls.map((c) => c.path)));
}
// B8 未分组整组：归档 / 彻底删除 两个动作分开
resetScopes();
{
  serviceLog.calls.length = 0;
  fetchCalls.length = 0;
  confirmResult = true;
  let tree = renderTree(Sidebar, sidebarProps());
  const archiveBtns = findAll(tree, byTitle("archiveUngrouped"));
  check("B8a 未分组归档按钮存在", archiveBtns.length === 1, `n=${archiveBtns.length}`);
  click(archiveBtns[0]);
  await settle();
  check("B8b 确认 → 归档未分组全部会话 s3", serviceLog.calls.some((c) => c[0] === "archiveSession" && c[1] === "s3"), JSON.stringify(serviceLog.calls));
  check("B8c 整组归档不碰删除路由", !fetchCalls.some((c) => c.path === "/obsidian/session-delete"));
  serviceLog.calls.length = 0;
  fetchCalls.length = 0;
  confirmResult = false;
  tree = renderTree(Sidebar, sidebarProps());
  click(findAll(tree, byTitle("archiveUngrouped"))[0]);
  check("B8d 取消 → 不调用", !serviceLog.calls.some((c) => c[0] === "archiveSession"));
  // 整组彻底删除
  serviceLog.calls.length = 0;
  fetchCalls.length = 0;
  confirmResult = true;
  tree = renderTree(Sidebar, sidebarProps());
  const delBtns = findAll(tree, byTitle("deleteUngrouped"));
  check("B8e 未分组彻底删除按钮存在", delBtns.length === 1, `n=${delBtns.length}`);
  click(delBtns[0]);
  await settle();
  const call = fetchCalls.find((c) => c.path === "/obsidian/session-delete");
  check("B8f 确认 → 整组走 host 删除", JSON.stringify(call && call.body) === JSON.stringify({ ids: ["s3"] }), JSON.stringify(call && call.body));
  check("B8g 整组彻底删除不归档", !serviceLog.calls.some((c) => c[0] === "archiveSession"), JSON.stringify(serviceLog.calls));
}
// B9 会话搜索（过滤 + Escape 关闭）
resetScopes();
{
  const t1 = renderTree(Sidebar, sidebarProps());
  click(findAll(t1, byTitle("searchSessions"))[0]);
  const t2 = renderTree(Sidebar, sidebarProps());
  const input = findAll(t2, (p) => p.placeholder === t("sessionSearchPlaceholder"))[0];
  check("B9a 点🔍出现搜索框", input !== undefined);
  input.props.onChange({ target: { value: "会话二" } });
  const t3 = renderTree(Sidebar, sidebarProps());
  const titles = findAll(t3, byClass("dsh-obs-session-title")).map((n) => textOf(n));
  check("B9b 搜索过滤只剩匹配会话", titles.length === 1 && titles[0] === "会话二", JSON.stringify(titles));
  const t4 = renderTree(Sidebar, sidebarProps());
  const input2 = findAll(t4, (p) => p.placeholder === t("sessionSearchPlaceholder"))[0];
  input2.props.onKeyDown({ key: "Escape" });
  const t5 = renderTree(Sidebar, sidebarProps());
  check("B9c Escape 关闭搜索恢复全部", findAll(t5, (p) => p.placeholder === t("sessionSearchPlaceholder")).length === 0
    && findAll(t5, byClass("dsh-obs-session")).length >= 2);
}
// B10 inject 工厂交付 ctx 服务
{
  const sidebarReg = registrations.find((r) => r.options.id === "obsidian-workspace-sidebar");
  const injected = sidebarReg.options.inject();
  check("B10a inject 工厂 → workspaces/sessions 透传 ctx",
    injected.workspaces === ctxWorkspaces && injected.sessions === ctxSessions);
  // 契约断言：真实 IWorkspaces 上没有 startSession / pickDirectory，
  // 二者只能来自 uiWorkspace —— 这就是「＋无反应」的根因守卫。
  check("B10b ctx.workspaces 无 startSession（方法属于 uiWorkspace）",
    typeof ctxWorkspaces.startSession === "undefined" && typeof ctxWorkspaces.pickDirectory === "undefined");
  check("B10c inject 工厂 → uiWorkspace 外观对象（startSession + pickDirectory）",
    injected.uiWorkspace !== undefined
    && typeof injected.uiWorkspace.startSession === "function"
    && typeof injected.uiWorkspace.pickDirectory === "function");
}
// B10x 空白会话（新建会话占位）不列入侧边栏
// —— 点工作区「＋」/ 顶部「新会话」后的可见反馈是主区的新会话空态页，
//    侧边栏不再多出一条「新建会话」行（当前空白会话同样不列出）。
resetScopes();
{
  const blankFs = sessionsFixture();
  blankFs.current = "s4";           // s4 = blank，属于 ws2（obsidian_vault）
  const tree = renderTree(Sidebar, { ...sidebarProps(), useSessions: (sel) => sel(blankFs) });
  check("B10x-1 当前空白会话不出现在列表（无会话行）",
    findAll(tree, byClass("dsh-obs-session")).length === 0,
    JSON.stringify(findAll(tree, byClass("dsh-obs-session-title")).map((n) => textOf(n))));
  check("B10x-2 也不以本地化「新建会话」标题出现",
    !findAll(tree, byClass("dsh-obs-session-title")).map((n) => textOf(n)).includes(t("newSession")));
  check("B10x-3 该工作区显示「暂无会话」占位", findAll(tree, byClass("dsh-obs-ws-empty")).length >= 1);
}
// B10y 非当前 / 当前空白会话都不列出，普通会话照常列出
resetScopes();
{
  const normalFs = sessionsFixture();
  normalFs.current = "s1";
  const tree = renderTree(Sidebar, { ...sidebarProps(), useSessions: (sel) => sel(normalFs) });
  const titles = findAll(tree, byClass("dsh-obs-session-title")).map((n) => textOf(n));
  check("B10y-1 非当前空白会话不列入列表",
    !titles.includes(t("newSession")) && !titles.includes("obsidian_vault"), JSON.stringify(titles));
  check("B10y-2 普通会话照常列出（ws1 展开）",
    titles.includes("会话一") && titles.includes("会话二"), JSON.stringify(titles));
}
// B10z 子代理会话（origin=subagent）不列入侧边栏
// —— 与官方 @deepseek-ai/dsh-client-ui-workspace 的 sessionVisible 一致：
//    子代理不是用户会话，只挂在父会话行的「N 个子代理运行中」状态（等价于
//    官方 indexSubagentDescendants 的祖先累加）与正文血缘面包屑上，不单独成行。
resetScopes();
{
  const subFs = sessionsFixture();
  const subWf = workspacesFixture();
  subFs.ids = ["s1", "s2", "s5", "s6", "s3", "s4"];
  // s5 = s1 的子代理（运行中）；s6 = s5 的子代理（运行中）→ 两级都记到 s1
  subFs.byId.s5 = { id: "s5", title: "安装 dsh-...", displayTitle: "安装 dsh-...", parentId: "s1", origin: "subagent", running: true, blank: false, updatedAt: NOW - 10 * 1000 };
  subFs.byId.s6 = { id: "s6", title: "孙代理任务", displayTitle: "孙代理任务", parentId: "s5", origin: "subagent", running: true, blank: false, updatedAt: NOW - 20 * 1000 };
  // s7 = s2 的已结束子代理（不运行 → 不产生状态点）
  subFs.byId.s7 = { id: "s7", title: "已结束子代理", displayTitle: "已结束子代理", parentId: "s2", origin: "subagent", running: false, blank: false, updatedAt: NOW - 30 * 1000 };
  subFs.ids.push("s7");
  subWf.items[0].sessionIds = ["s1", "s2", "s5"]; // 子代理也会被 host 账户进工作区
  const subProps = { ...sidebarProps(), useSessions: (sel) => sel(subFs), useWorkspaces: (sel) => sel(subWf) };
  const tree = renderTree(Sidebar, subProps);
  const titles = findAll(tree, byClass("dsh-obs-session-title")).map((n) => textOf(n));
  check("B10z-1 子代理会话不列为会话行",
    !titles.includes("安装 dsh-...") && !titles.includes("孙代理任务") && !titles.includes("已结束子代理"), JSON.stringify(titles));
  check("B10z-2 子代理不落进「未分组」，普通会话照常列出",
    titles.includes("会话一") && titles.includes("会话二") && !findAll(tree, byClass("dsh-obs-session")).some((row) => textOf(row).includes("安装 dsh-...")),
    JSON.stringify(titles));
  const dots = findAll(tree, byClass("dsh-obs-dot-subs"));
  check("B10z-3 父行显示运行中子代理状态点（两级累加 n=2）",
    dots.length === 1 && dots[0].props.title === t("subagentsRunning", { n: 2 }), JSON.stringify(dots.map((d) => d.props.title)));
  // 搜索路径同样过滤子代理
  click(findAll(tree, byTitle("searchSessions"))[0]);
  const tree2 = renderTree(Sidebar, subProps);
  const input = findAll(tree2, (p) => p.placeholder === t("sessionSearchPlaceholder"))[0];
  input.props.onChange({ target: { value: "子代理" } });
  const tree3 = renderTree(Sidebar, subProps);
  check("B10z-4 搜索也不返回子代理会话",
    findAll(tree3, byClass("dsh-obs-session")).length === 0
    && textOf(tree3).includes(t("noSessions")),
    JSON.stringify(findAll(tree3, byClass("dsh-obs-session-title")).map((n) => textOf(n))));
}
// B11 折叠轨道：📚 点击 → expandSidebar
resetScopes();
{
  serviceLog.calls.length = 0;
  const tree = renderTree(Sidebar, { ...sidebarProps(), wide: false, workspaces: null, sessions: null });
  click(findAll(tree, byTitle("notes"))[0]);
  check("B11 轨道📚 → expandSidebar() 被调用", serviceLog.calls.some((c) => c[0] === "expandSidebar"), JSON.stringify(serviceLog.calls));
}

// ═════════════════════════ C. TreeView 状态（fetch mock） ═════════════════════════
// C1 vault 不存在 → noVault + 选择按钮
resetScopes();
{
  vault = { root: "D:\\missing", exists: false };
  let tree = renderTree(Sidebar, sidebarProps());
  await settle();
  tree = renderTree(Sidebar, sidebarProps());
  check("C1a 无 vault → 提示 noVault", textOf(tree).includes(t("noVault")));
  check("C1b 无 vault → 出现选择按钮", findAll(tree, byTitle("pickVaultTitle")).length >= 1);
}
// C1x 📂 选择 Vault：目录选择器同样只能走 uiWorkspace.pickDirectory
resetScopes();
{
  vault = { root: "D:\\missing", exists: false };
  ctxUiWorkspaceCalls.length = 0;
  fetchCalls.length = 0;
  let tree = renderTree(Sidebar, sidebarProps());
  await settle();
  tree = renderTree(Sidebar, sidebarProps());
  click(findAll(tree, byTitle("pickVaultTitle"))[0]);
  await settle();
  check("C1x-1 📂 → uiWorkspace.pickDirectory()",
    ctxUiWorkspaceCalls.some((c) => c[0] === "pickDirectory"), JSON.stringify(ctxUiWorkspaceCalls));
  const rootCall = fetchCalls.find((c) => c.method === "POST" && c.path === "/obsidian/root");
  check("C1x-2 选中目录 → POST /obsidian/root 落库",
    rootCall !== undefined && rootCall.body.root === "D:\\picked", JSON.stringify(rootCall && rootCall.body));
}
// C2 树加载 + 文件大小 + 目录展开
resetScopes();
{
  vault = { root: "D:\\vault", exists: true };
  fetchCalls.length = 0;
  let tree = renderTree(Sidebar, sidebarProps());
  await settle();
  tree = renderTree(Sidebar, sidebarProps());
  const sizes = findAll(tree, byClass("dsh-obs-size")).map((n) => textOf(n));
  check("C2a 树加载 → 目录/笔记行渲染", findAll(tree, byRowText("sub")).length >= 1 && sizes.length >= 3, JSON.stringify(sizes));
  check("C2b 文件大小格式化 B/KB/MB", sizes.includes("633 B") && sizes.includes("1.5 KB") && sizes.includes("2.5 MB"), JSON.stringify(sizes));
  check("C2c 树经 /tree 请求填充", fetchCalls.some((c) => c.method === "GET" && c.path === "/obsidian/tree"));
  click(findAll(tree, byRowText("sub"))[0]);
  await settle();
  tree = renderTree(Sidebar, sidebarProps());
  check("C2d 展开目录 → 子级渲染", textOf(tree).includes("deep.md"), JSON.stringify(fetchCalls.filter((c) => c.path === "/obsidian/tree").map((c) => c.search)));
}
// C3 笔记搜索（🔍 → 防抖 → 结果）
resetScopes();
{
  vault = { root: "D:\\vault", exists: true };
  let tree = renderTree(Sidebar, sidebarProps());
  await settle();
  tree = renderTree(Sidebar, sidebarProps());
  const head = findAll(tree, byClass("dsh-obs-tree-head"))[0];
  click(findAll(head, byTitle("search"))[0]);
  const t2 = renderTree(Sidebar, sidebarProps());
  const input = findAll(t2, (p) => p.placeholder === t("searchPlaceholder"))[0];
  check("C3a 点🔍出笔记搜索框", input !== undefined);
  input.props.onChange({ target: { value: "gpu" } });
  const t3mid = renderTree(Sidebar, sidebarProps());
  flushTimers();
  await settle();
  const t3 = renderTree(Sidebar, sidebarProps());
  check("C3b 搜索结果渲染（名称+摘要）", textOf(t3).includes("gpu") && textOf(t3).includes("a.md"),
    JSON.stringify(fetchCalls.filter((c) => c.path === "/obsidian/search")));
}
// C4 新建文件夹（📁 → 输入名称 → POST /file mkdir → 刷新）
resetScopes();
{
  vault = { root: "D:\\vault", exists: true };
  fetchCalls.length = 0;
  promptResult = "新分类";
  let tree = renderTree(Sidebar, sidebarProps());
  await settle();
  tree = renderTree(Sidebar, sidebarProps());
  const btn = findAll(tree, byTitle("newFolder"))[0];
  check("C4a 新建文件夹按钮存在", btn !== undefined);
  click(btn);
  await settle();
  const call = fetchCalls.find((c) => c.method === "POST" && c.path === "/obsidian/file" && c.body.action === "mkdir");
  check("C4b 新建文件夹 → POST /file mkdir（名=新分类）", call !== undefined && call.body.name === "新分类", JSON.stringify(call && call.body));
  const cancelled = (() => {
    promptResult = null;
    fetchCalls.length = 0;
    resetScopes();
    let t2 = renderTree(Sidebar, sidebarProps());
    return t2;
  })();
  const btn2 = findAll(cancelled, byTitle("newFolder"))[0];
  click(btn2);
  await settle();
  check("C4c 取消输入 → 不调用 mkdir", !fetchCalls.some((c) => c.path === "/obsidian/file" && c.body.action === "mkdir"));
}
// C5 逐行「＋」新建笔记：根路径行右侧 / 文件夹行右侧
resetScopes();
{
  vault = { root: "D:\\vault", exists: true };
  // 根路径行右侧 ＋ → 在根新增
  fetchCalls.length = 0;
  promptResult = "根笔记";
  let tree = renderTree(Sidebar, sidebarProps());
  await settle();
  tree = renderTree(Sidebar, sidebarProps());
  const rootRow = findAll(tree, byClass("dsh-obs-root-row"))[0];
  check("C5a 根路径行存在", rootRow !== undefined);
  const rootPlus = findAll(rootRow, byTitle("newNote"))[0];
  check("C5b 根路径行右侧 ＋ 存在", rootPlus !== undefined);
  click(rootPlus);
  await settle();
  const call = fetchCalls.find((c) => c.method === "POST" && c.path === "/obsidian/file" && c.body.action === "new");
  check("C5c 根路径＋ → 在根新增笔记", call !== undefined && call.body.path === "" && call.body.name === "根笔记", JSON.stringify(call && call.body));
  // 文件夹行右侧 ＋ → 在该文件夹内新增
  resetScopes();
  fetchCalls.length = 0;
  promptResult = "文件夹笔记";
  let t2 = renderTree(Sidebar, sidebarProps());
  await settle();
  t2 = renderTree(Sidebar, sidebarProps());
  const dirRow = findAll(t2, byRowText("sub"))[0];
  check("C5d 文件夹行存在", dirRow !== undefined);
  const dirPlus = findAll(dirRow, byTitle("newNote"))[0];
  check("C5e 文件夹行右侧 ＋ 存在", dirPlus !== undefined);
  click(dirPlus);
  await settle();
  const call2 = fetchCalls.find((c) => c.method === "POST" && c.path === "/obsidian/file" && c.body.action === "new");
  check("C5f 文件夹＋ → 在 sub 内新增笔记", call2 !== undefined && call2.body.path === "sub" && call2.body.name === "文件夹笔记", JSON.stringify(call2 && call2.body));
  // 取消输入 → 不调用 new
  resetScopes();
  promptResult = null;
  fetchCalls.length = 0;
  let t3 = renderTree(Sidebar, sidebarProps());
  await settle();
  t3 = renderTree(Sidebar, sidebarProps());
  const dirRow3 = findAll(t3, byRowText("sub"))[0];
  click(findAll(dirRow3, byTitle("newNote"))[0]);
  await settle();
  check("C5g 取消输入 → 不调用 new", !fetchCalls.some((c) => c.path === "/obsidian/file" && c.body.action === "new"));
}
// C6 逐行「🗑」删除：笔记 / 文件夹（递归）
resetScopes();
{
  vault = { root: "D:\\vault", exists: true };
  // 删笔记
  resetScopes();
  confirmCalls.length = 0;
  fetchCalls.length = 0;
  confirmResult = true;
  let tree = renderTree(Sidebar, sidebarProps());
  await settle();
  tree = renderTree(Sidebar, sidebarProps());
  const noteRow = findAll(tree, byRowText("a.md"))[0];
  const delBtn = findAll(noteRow, byTitle("delete"))[0];
  check("C6a 笔记行 🗑 存在", delBtn !== undefined);
  click(delBtn);
  await settle();
  const call = fetchCalls.find((c) => c.method === "POST" && c.path === "/obsidian/file" && c.body.action === "delete");
  check("C6b 删笔记 → POST /file delete a.md", call !== undefined && call.body.path === "a.md", JSON.stringify(call && call.body));
  check("C6c 笔记删除有确认提示（含笔记名）", confirmCalls.some((m) => typeof m === "string" && m.includes("a.md")));
  // 删文件夹
  resetScopes();
  confirmCalls.length = 0;
  fetchCalls.length = 0;
  confirmResult = true;
  let t2 = renderTree(Sidebar, sidebarProps());
  await settle();
  t2 = renderTree(Sidebar, sidebarProps());
  const dirRow = findAll(t2, byRowText("sub"))[0];
  const dirDel = findAll(dirRow, byTitle("delete"))[0];
  check("C6d 文件夹行 🗑 存在", dirDel !== undefined);
  click(dirDel);
  await settle();
  const call2 = fetchCalls.find((c) => c.method === "POST" && c.path === "/obsidian/file" && c.body.action === "delete");
  check("C6e 删文件夹 → POST /file delete sub", call2 !== undefined && call2.body.path === "sub", JSON.stringify(call2 && call2.body));
  check("C6f 文件夹删除有专门确认（含文件夹名）", confirmCalls.some((m) => typeof m === "string" && m.includes("sub")));
  // 取消确认 → 不调用 delete
  resetScopes();
  confirmResult = false;
  fetchCalls.length = 0;
  let t3 = renderTree(Sidebar, sidebarProps());
  await settle();
  t3 = renderTree(Sidebar, sidebarProps());
  const noteRow3 = findAll(t3, byRowText("a.md"))[0];
  click(findAll(noteRow3, byTitle("delete"))[0]);
  await settle();
  check("C6g 取消确认 → 不调用 delete", !fetchCalls.some((c) => c.path === "/obsidian/file" && c.body.action === "delete"));
}

// ═════════════════════════ D. Dock 全链路 ═════════════════════════
// D1 点笔记 → Dock 打开渲染 markdown + 双链跳转
resetScopes();
{
  vault = { root: "D:\\vault", exists: true };
  let tree = renderTree(Sidebar, sidebarProps());
  await settle();
  tree = renderTree(Sidebar, sidebarProps());
  click(findAll(tree, byRowText("a.md"))[0]);
  await settle();
  let dock = renderTree(DockC, { t, workspaces: null });
  await settle();
  dock = renderTree(DockC, { t, workspaces: null });
  check("D1a Dock 打开 → 渲染标题", textOf(dock).includes("a.md"));
  check("D1b Dock 打开 → markdown 段落渲染", textOf(dock).includes("World"));
  const wiki = findAll(dock, byTitle("[[双链目标]]"));
  check("D1c Dock 打开 → 双链按钮存在", wiki.length === 1, `n=${wiki.length}`);
  click(wiki[0]);
  await settle();
  dock = renderTree(DockC, { t, workspaces: null });
  await settle();
  dock = renderTree(DockC, { t, workspaces: null });
  check("D1d 双链跳转 → 打开目标笔记", textOf(dock).includes("deep.md") && textOf(dock).includes("Deep"),
    JSON.stringify(fetchCalls.filter((c) => c.path === "/obsidian/search")));
}
// D2 编辑/保存
resetScopes();
{
  vault = { root: "D:\\vault", exists: true };
  let tree = renderTree(Sidebar, sidebarProps());
  await settle();
  tree = renderTree(Sidebar, sidebarProps());
  click(findAll(tree, byRowText("a.md"))[0]);
  await settle();
  let dock = renderTree(DockC, { t, workspaces: null });
  await settle();
  dock = renderTree(DockC, { t, workspaces: null });
  click(findAll(dock, byText(t("edit")))[0]);
  const t2 = renderTree(DockC, { t, workspaces: null });
  const ta = findAll(t2, (p) => p.autoFocus === true)[0];
  check("D2a 点编辑 → textarea 带原文", ta !== undefined && ta.props.value.includes("Hello"), `has=${ta !== undefined}`);
  ta.props.onChange({ target: { value: "# 新标题\n\n新正文" } });
  const t3 = renderTree(DockC, { t, workspaces: null });
  const saveBtn = findAll(t3, byClass("dsh-obs-primary"))[0];
  check("D2b 保存按钮出现", saveBtn !== undefined);
  click(saveBtn);
  await settle();
  const saved = fetchCalls.find((c) => c.method === "POST" && c.path === "/obsidian/note");
  check("D2c 保存 → POST /note 内容正确", saved !== undefined && saved.body.content.includes("新标题"), JSON.stringify(saved && saved.body));
  const t4 = renderTree(DockC, { t, workspaces: null });
  check("D2d 保存后回到预览且内容已更新", textOf(t4).includes("新标题"));
}
// D3 引用到对话（注入输入框 + toast）
resetScopes();
{
  vault = { root: "D:\\vault", exists: true };
  composer.value = "已有内容\n";
  composer.events.length = 0;
  let tree = renderTree(Sidebar, sidebarProps());
  await settle();
  tree = renderTree(Sidebar, sidebarProps());
  click(findAll(tree, byRowText("a.md"))[0]);
  await settle();
  let dock = renderTree(DockC, { t, workspaces: null });
  await settle();
  dock = renderTree(DockC, { t, workspaces: null });
  click(findAll(dock, byText(`⤴ ${t("cite")}`))[0]);
  await settle();
  check("D3a 引用 → @D:\\vault\\a.md 注入输入框", composer.value.includes("@D:\\vault\\a.md"), JSON.stringify(composer.value));
  check("D3b 引用 → 派发 input/change 事件", composer.events.includes("input") && composer.events.includes("change"), JSON.stringify(composer.events));
  const toast = renderTree(ToastC, { t });
  check("D3c 引用 → toast 出现", textOf(toast).includes(t("cited")), `toast=${textOf(toast)}`);
}
// D4 引用兜底：无输入框 → 剪贴板
resetScopes();
{
  vault = { root: "D:\\vault", exists: true };
  composerAvailable = false;
  clipboardWrites.length = 0;
  let tree = renderTree(Sidebar, sidebarProps());
  await settle();
  tree = renderTree(Sidebar, sidebarProps());
  click(findAll(tree, byRowText("a.md"))[0]);
  await settle();
  let dock = renderTree(DockC, { t, workspaces: null });
  await settle();
  dock = renderTree(DockC, { t, workspaces: null });
  click(findAll(dock, byText(`⤴ ${t("cite")}`))[0]);
  await settle();
  check("D4 无输入框 → 引用复制到剪贴板", clipboardWrites.some((w) => w.includes("@D:\\vault\\a.md")), JSON.stringify(clipboardWrites));
  composerAvailable = true;
}
// D5 关闭 Dock
resetScopes();
{
  vault = { root: "D:\\vault", exists: true };
  let tree = renderTree(Sidebar, sidebarProps());
  await settle();
  tree = renderTree(Sidebar, sidebarProps());
  click(findAll(tree, byRowText("a.md"))[0]);
  await settle();
  renderTree(DockC, { t, workspaces: null });
  await settle();
  renderTree(DockC, { t, workspaces: null });
  click(findAll(renderTree(DockC, { t, workspaces: null }), byTitle("close"))[0]);
  const closed = renderTree(DockC, { t, workspaces: null });
  check("D5 点✕关闭 Dock → null", closed === null);
}
// D6 重命名 / D7 删除
resetScopes();
{
  vault = { root: "D:\\vault", exists: true };
  let tree = renderTree(Sidebar, sidebarProps());
  await settle();
  tree = renderTree(Sidebar, sidebarProps());
  click(findAll(tree, byRowText("a.md"))[0]);
  await settle();
  let dock = renderTree(DockC, { t, workspaces: null });
  await settle();
  dock = renderTree(DockC, { t, workspaces: null });
  fetchCalls.length = 0;
  promptResult = "改名后";
  click(findAll(dock, byTitle("rename"))[0]);
  await settle();
  check("D6 重命名 → /file rename 请求", fetchCalls.some((c) => c.method === "POST" && c.path === "/obsidian/file" && c.body.action === "rename" && c.body.newName === "改名后"),
    JSON.stringify(fetchCalls.filter((c) => c.path === "/obsidian/file")));
  await settle();
  dock = renderTree(DockC, { t, workspaces: null });
  confirmResult = true;
  click(findAll(dock, byTitle("delete"))[0]);
  await settle();
  check("D7 删除 → /file delete 请求", fetchCalls.some((c) => c.method === "POST" && c.path === "/obsidian/file" && c.body.action === "delete"));
  const closed = renderTree(DockC, { t, workspaces: null });
  check("D7b 删除后 Dock 为 null", closed === null);
}
// E. 错误分支 → toast（工作区重命名失败）
resetScopes();
{
  const failingWorkspaces = {
    ...services.workspaces,
    rename: async () => { throw new Error("rename rejected"); },
  };
  const props = { ...sidebarProps(), workspaces: failingWorkspaces };
  promptResult = "新名";
  const tree = renderTree(Sidebar, props);
  click(findAll(tree, byTitle("rename"))[0]);
  await settle();
  const toast = renderTree(ToastC, { t });
  check("E 服务失败 → toast 错误提示", textOf(toast).includes(t("error")), `toast=${textOf(toast)}`);
}

// ═════════════════════════ 汇总 ═════════════════════════
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) FAILED: ${failures.join(" | ")}`);
  process.exit(1);
}
console.log("\nall client interaction checks passed ✔");
