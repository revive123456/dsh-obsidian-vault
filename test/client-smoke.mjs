/**
 * client bundle 冒烟测试：用 stub React 装载 lib/client.js 的 factory，
 * 并渲染各组件一次，捕捉引用错误 / 组件级运行时崩溃（无浏览器环境）。
 * 覆盖重构后的常驻 WorkspaceSidebar（宽/折叠两态）+ Dock + Toast。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const code = readFileSync(join(root, "lib", "client.js"), "utf8");

let registration = null;
const fakeWindow = {
  __ModuleLoader__: {
    load: (reg) => { registration = reg; },
  },
};

const Fragment = Symbol.for("react.fragment");
function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
}
const stubReact = {
  Fragment,
  createElement,
  useState: (init) => [typeof init === "function" ? init() : init, () => { }],
  useEffect: () => { },
  useRef: (init) => ({ current: init ?? null }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useSyncExternalStore: (_sub, get) => get(),
};

// bundle 内 readNotesOpen() 读裸 localStorage：stub 为已展开，使笔记树渲染路径生效
globalThis.localStorage = {
  getItem: (k) => (k === "dsh-obsidian:notesOpen" ? "1" : null),
  setItem: () => { },
};
globalThis.setTimeout = (fn) => { void fn; return 0; };
globalThis.clearTimeout = () => { };

// 执行 bundle（工厂闭包内的 window 来自 fakeWindow）
const factoryFactory = new Function("window", `${code}\nreturn null;`);
factoryFactory(fakeWindow);

if (!registration || registration.id !== "dsh-obsidian-vault") {
  console.error("✗ bundle did not register correctly");
  process.exit(1);
}
console.log(`✓ registered: ${registration.id}`);

const exports_ = registration.factory((spec) => {
  if (spec === "react") return stubReact;
  if (spec === "react/jsx-runtime") return {};
  throw new Error(`unexpected require(${spec})`);
});

if (typeof exports_.apply !== "function" || !Array.isArray(exports_.inject)) {
  console.error("✗ exports face missing apply/inject");
  process.exit(1);
}
console.log(`✓ exports face: inject=[${exports_.inject.join(",")}]`);

// 用 stub ctx 跑 apply，验证常驻注册路径
const registrations = [];
const disposers = [];
const stubSlots = {
  inject: (_key, cb) => { cb(); return () => { }; },
  register: (options, component) => {
    registrations.push({ options, component });
    return () => { disposers.push(options.id); };
  },
};
const stubCtx = {
  effect: () => { },
  locale: { register: () => { } },
  slots: stubSlots,
  workspaces: { pickDirectory: async () => null, create: async () => ({}), startSession: () => { } },
  sessions: { open: () => { } },
};
exports_.apply(stubCtx);
const ids = registrations.map((r) => r.options.id);
console.log(`✓ apply registrations: ${ids.join(", ")}`);
if (!ids.includes("obsidian-workspace-sidebar") || !ids.includes("obsidian-dock") || !ids.includes("obsidian-toast")) {
  console.error("✗ missing expected slot registrations (want obsidian-workspace-sidebar/dock/toast)");
  process.exit(1);
}
const sidebarReg = registrations.find((r) => r.options.id === "obsidian-workspace-sidebar");
if (sidebarReg.options.name !== "sidebar.workspaces" || sidebarReg.options.priority !== -100) {
  console.error("✗ WorkspaceSidebar must shadow sidebar.workspaces with priority -100");
  process.exit(1);
}
console.log("✓ WorkspaceSidebar shadows sidebar.workspaces at priority -100");

// 渲染各组件一次（stub t + 标准 hooks stub）
const t = (k, params) => (params ? `${k}(${JSON.stringify(params)})` : k);
const byId = Object.fromEntries(registrations.map((r) => [r.options.id, r.component]));
const failures = [];
function renderCheck(name, fn) {
  try {
    const out = fn();
    if (out !== null && typeof out !== "object") throw new Error("bad render return");
    console.log(`✓ render ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.error(`✗ render ${name}: ${e.message}`);
  }
}

const sessionsFixture = {
  ids: ["s1", "s2", "s3", "s4"],
  byId: {
    s1: { id: "s1", title: "会话一", displayTitle: "会话一", cwd: "D:\\code\\ds_workspace", updatedAt: Date.now() - 3 * 60000, blank: false, running: false },
    s2: { id: "s2", title: "会话二", displayTitle: "会话二", updatedAt: Date.now() - 3600000, blank: false, running: false },
    s3: { id: "s3", title: "未分组会话", displayTitle: "未分组会话", updatedAt: Date.now() - 7200000, blank: false, running: false },
    s4: { id: "s4", title: "obsidian_vault", displayTitle: "obsidian_vault", cwd: "D:\\obsidian_vault", updatedAt: Date.now() - 60000, blank: true, running: false },
  },
  current: "s1",
  phase: "ready",
};
const workspacesFixture = {
  items: [
    { workspaceId: "ws1", path: "D:\\code\\ds_workspace", title: "ds_workspace", sessionIds: ["s1", "s2"], createdAt: "", updatedAt: "" },
    { workspaceId: "ws2", path: "D:\\obsidian_vault", title: "obsidian_vault", sessionIds: ["s4"], createdAt: "", updatedAt: "" },
  ],
  archivedSessionIds: [],
  state: "ready",
  phase: "ready",
  error: null,
  baselinesReady: true,
  recentWorkspaceId: "ws1",
};
const hookStubs = {
  useSessions: (sel) => sel(sessionsFixture),
  useWorkspaces: (sel) => sel(workspacesFixture),
};
const serviceStubs = {
  // 真实 ctx.workspaces（IWorkspaces）没有 startSession / pickDirectory，
  // 二者由 ctx.uiWorkspace（官方 ui-workspace 插件）提供。
  workspaces: { create: async () => ({}) },
  sessions: { open: () => { } },
  uiWorkspace: { startSession: () => { }, pickDirectory: async () => null },
};

renderCheck("WorkspaceSidebar(wide)", () => byId["obsidian-workspace-sidebar"]({
  wide: true, expandSidebar: () => { }, t, ...hookStubs, ...serviceStubs,
}));
renderCheck("WorkspaceSidebar(rail)", () => byId["obsidian-workspace-sidebar"]({
  wide: false, expandSidebar: () => { }, t, ...hookStubs, workspaces: null, sessions: null,
}));
renderCheck("Dock(closed)", () => byId["obsidian-dock"]({ t, workspaces: null }));
renderCheck("Toast(empty)", () => byId["obsidian-toast"]({ t }));

// 管理动作断言：宽态渲染树中必须包含 会话归档 / 会话彻底删除 / 工作区删除 按钮
const wideTree = byId["obsidian-workspace-sidebar"]({
  wide: true, expandSidebar: () => { }, t, ...hookStubs, ...serviceStubs,
});
const found = { actions: 0, sessionDelete: 0, sessionArchive: 0, workspaceDelete: 0, ungroupedDelete: 0, ungroupedArchive: 0 };
(function walk(node) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item);
    return;
  }
  if (typeof node !== "object") return;
  const p = node.props ?? {};
  if (typeof p.className === "string" && p.className.includes("dsh-obs-actions")) found.actions += 1;
  if (p.title === "deleteSession") found.sessionDelete += 1;
  if (p.title === "archiveSession") found.sessionArchive += 1;
  if (p.title === "delete") found.workspaceDelete += 1;
  if (p.title === "deleteUngrouped") found.ungroupedDelete += 1;
  if (p.title === "archiveUngrouped") found.ungroupedArchive += 1;
  const kids = Array.isArray(p.children) ? p.children : [p.children];
  for (const kid of kids) walk(kid);
})(wideTree);
console.log(`✓ actions: ${found.actions}  session-archive: ${found.sessionArchive}  session-delete: ${found.sessionDelete}  ws-delete: ${found.workspaceDelete}  ungrouped-archive: ${found.ungroupedArchive}  ungrouped-del: ${found.ungroupedDelete}`);
if (found.sessionDelete < 2 || found.sessionArchive < 2 || found.workspaceDelete < 1
  || found.ungroupedDelete < 1 || found.ungroupedArchive < 1) {
  console.error("✗ archive/delete affordances missing from rendered sidebar tree");
  process.exit(1);
}
// 破坏性动作必须带 dsh-obs-danger 标记，归档绝不能带 —— 否则用户分不清哪个会毁数据
const marks = [];
(function walk(node) {
  if (!node) return;
  if (Array.isArray(node)) { for (const item of node) walk(item); return; }
  if (typeof node !== "object") return;
  const p = node.props ?? {};
  if (["deleteSession", "deleteUngrouped", "archiveSession", "archiveUngrouped"].includes(p.title)) {
    marks.push({ title: p.title, danger: typeof p.className === "string" && p.className.includes("dsh-obs-danger") });
  }
  const kids = Array.isArray(p.children) ? p.children : [p.children];
  for (const kid of kids) walk(kid);
})(wideTree);
const badMarks = marks.filter((m) => m.title.startsWith("delete") !== m.danger);
console.log(`✓ danger marking: ${JSON.stringify(marks)}`);
if (badMarks.length > 0) {
  console.error(`✗ danger class mismatch: ${JSON.stringify(badMarks)}`);
  process.exit(1);
}

// 当前会话落在「未分组」时：该组默认展开，组内会话行同样带删除按钮
const ungroupedCurrentFixture = { ...sessionsFixture, current: "s3" };
const treeUngrouped = byId["obsidian-workspace-sidebar"]({
  wide: true, expandSidebar: () => { }, t,
  useSessions: (s) => s(ungroupedCurrentFixture),
  useWorkspaces: (s) => s(workspacesFixture),
  ...serviceStubs,
});
let ungroupedSessionDelete = 0;
(function walk(node) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item);
    return;
  }
  if (typeof node !== "object") return;
  const p = node.props ?? {};
  if (p.title === "deleteSession") ungroupedSessionDelete += 1;
  const kids = Array.isArray(p.children) ? p.children : [p.children];
  for (const kid of kids) walk(kid);
})(treeUngrouped);
console.log(`✓ ungrouped-current render: session-delete buttons = ${ungroupedSessionDelete}`);
if (ungroupedSessionDelete < 1) {
  console.error("✗ ungrouped group with current session must render its delete buttons");
  process.exit(1);
}

// 空白会话（新建会话占位）不列入侧边栏 —— 包括当前会话为空白时。
// 点工作区「＋」/ 顶部「新会话」的可见反馈是主区的新会话空态页，
// 侧边栏不应多出一条「新建会话」占位行，工作区照常显示「暂无会话」。
const blankCurrentFixture = { ...sessionsFixture, current: "s4" };
const treeBlank = byId["obsidian-workspace-sidebar"]({
  wide: true, expandSidebar: () => { }, t,
  useSessions: (s) => s(blankCurrentFixture),
  useWorkspaces: (s) => s(workspacesFixture),
  ...serviceStubs,
});
let blankSessionRows = 0;
let blankWsEmpty = 0;
(function walk(node) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item);
    return;
  }
  if (typeof node !== "object") return;
  const p = node.props ?? {};
  const cls = typeof p.className === "string" ? p.className.split(/\s+/) : [];
  if (cls.includes("dsh-obs-session")) blankSessionRows += 1;
  if (cls.includes("dsh-obs-ws-empty")) blankWsEmpty += 1;
  const kids = Array.isArray(p.children) ? p.children : [p.children];
  for (const kid of kids) walk(kid);
})(treeBlank);
console.log(`✓ blank-current render: session rows = ${blankSessionRows}, empty-group markers = ${blankWsEmpty}`);
if (blankSessionRows !== 0 || blankWsEmpty < 1) {
  console.error("✗ blank session must stay hidden (workspace shows 暂无会话 / empty-group marker)");
  process.exit(1);
}

// Dock 打开态：绕过 openNote store 检查——直接给组件喂 store 初始态不可行，
// 这里至少验证 closed 路径；打开路径依赖真实 store，交由浏览器验证。

if (failures.length > 0) {
  console.error(`\n${failures.length} render check(s) FAILED`);
  process.exit(1);
}
console.log("\nall client smoke checks passed ✔");
