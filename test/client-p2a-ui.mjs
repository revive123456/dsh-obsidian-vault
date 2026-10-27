/**
 * P2a client 交互接线测试（ui-agent；M11 折叠 / M12 脚注与锚点 / M13 alias + pending anchor）。
 *
 * 两种运行模式：
 *   - 默认（假渲染器）：`node test/client-p2a-ui.mjs`
 *     用 require("__fake-renderer") 注入按契约输出 DOM 的迷你 renderNumbered，jsdom 挂真 DOM，
 *     专测 client 接线（事件委托、collapsedCallouts 精确状态、滚动/高亮/pending anchor、alias
 *     解析顺序、search matchedAlias 小字）。也可在不依赖 renderer 进度的前提下直接钉
 *     options 语义（fake 会记录 renderNumbered 收到的参数）。
 *   - 真实渲染器：`P2A_UI_REAL=1 node test/client-p2a-ui.mjs`
 *     直接读 src/markdown.js（不需要 build），断言换成 DOM 可观测结果：M11 折叠 attrs/aria、
 *     嵌套/未知类型、父折叠传播、M10 onWikilink(target, anchor)、M13 alias，以及 M12 的
 *     脚注点击跳转/高亮、`^id` 块引用、标题锚点、跨篇 pending anchor。
 *
 * 覆盖：
 *  A. callout 折叠：首帧 options 不传（源码默认）→ seed 权威 Set → 点击委托 toggle → 重渲染
 *     传 Set（add/delete）→ aria-expanded 同步；折叠后滚动位置保持。（默认模式）
 *  B. 脚注引用点击委托：scrollIntoView 到定义行 + dsh-obs-md-fn-target 1.5s；缺定义 toast。
 *  C. 同篇锚点：[data-heading-anchor] 标题滚动、[data-block-id] 块滚动。
 *  D. 跨篇锚点：打开目标笔记后 pending anchor 滚动一次（标题 + 块）。
 *  E. alias 解析顺序：文件名精确 → matchedAlias → 第一个结果兜底；search 面板显示命中别名。
 *  R/W. 真实渲染器复看（M11 折叠 + M10/M13 双链，仅 P2A_UI_REAL=1）。
 *  F/G. M12 真实渲染器断言（脚注跳转/块引用/标题锚点/跨篇 pending anchor，仅 P2A_UI_REAL=1）。
 *
 * 无网络：fetch 全 stub。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientSrc = readFileSync(join(root, "src", "client.js"), "utf8");
const markdownSrc = readFileSync(join(root, "src", "markdown.js"), "utf8");
// 真实渲染器模式（P2A_UI_REAL=1）：直接读 src/markdown.js，断言走 DOM 可观测结果
const REAL = process.env.P2A_UI_REAL === "1";

// ═════════════════════════ jsdom 环境（真实 document/window）════════════════════
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;

// 定时器改为手动队列：脚注高亮 1.5s、搜索防抖 250ms 都由测试 flush
const timerQueue = new Map();
let timerSeq = 0;
window.setTimeout = (fn, ms) => { const id = ++timerSeq; timerQueue.set(id, { fn, ms }); return id; };
window.clearTimeout = (id) => { timerQueue.delete(id); };
window.setInterval = () => 0;
window.clearInterval = () => { };
globalThis.window = window;
globalThis.document = doc;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globalThis.localStorage = window.localStorage;
globalThis.Node = window.Node;
globalThis.NodeFilter = window.NodeFilter;
globalThis.setTimeout = window.setTimeout;
globalThis.clearTimeout = window.clearTimeout;
globalThis.setInterval = window.setInterval;
globalThis.clearInterval = window.clearInterval;

// jsdom 没有 scrollIntoView：桩下来记录滚动目标
const scrollCalls = [];
window.Element.prototype.scrollIntoView = function scrollIntoView(opts) {
  scrollCalls.push({ el: this, opts });
};

function flushTimers(rounds = 4) {
  for (let r = 0; r < rounds; r++) {
    if (timerQueue.size === 0) return;
    const pending = [...timerQueue.values()];
    timerQueue.clear();
    for (const timer of pending) timer.fn();
  }
}
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

// ═════════════════════════ fetch mock：/obsidian/* ═════════════════════════
const NOTE = {
  a: [
    "# 标题甲",
    "",
    "段落一 [[#标题甲]] [[#^blk1]]",
    "",
    "> [!note]- 可折叠 callout",
    "> 折叠正文行",
    "",
    "> [!tip] 普通提示（无折叠标记）",
    "> 普通正文",
    "",
    "正文带脚注 [^fn1] 与缺定义 [^nope]",
    "[^fn1]: 脚注定义内容",
    "",
    "段落尾 ^blk1",
    "",
    "[[目标笔记]] [[别名笔记]] [[b#标题乙]] [[b#^blk2]] [[占位]]",
  ].join("\n"),
  b: [
    "# 标题乙",
    "",
    "段落乙 ^blk2",
  ].join("\n"),
  c: "# 别名目标\n\n这是带 alias 的笔记。",
  "目标笔记": "# 目标笔记\n\n精确命中。",
};
NOTE.m11 = [
  "# 标题甲",
  "",
  "同篇标题链 [[#标题甲]] 与别名链 [[别名笔记]]",
  "",
  "> [!note]- 外层折叠",
  "> 外层正文",
  "> > [!tip]+ 子 callout",
  "> > 子正文",
  "",
  "> [!tip]+ 默认展开",
  "> 展开正文",
  "",
  "> [!custom] 未知类型标题",
  "> 未知正文",
  "",
  "> [!note] 普通无折叠",
  "> 普通正文",
].join("\n");
const notes = {
  "m11.md": { content: NOTE.m11, mtimeMs: 5 },
  "a.md": { content: NOTE.a, mtimeMs: 1 },
  "b.md": { content: NOTE.b, mtimeMs: 2 },
  "c.md": { content: NOTE.c, mtimeMs: 3 },
  "目标笔记.md": { content: NOTE["目标笔记"], mtimeMs: 4 },
};
const SEARCH = {
  "目标笔记": [{ path: "目标笔记.md", name: "目标笔记.md", snippet: "" }],
  "别名笔记": [{ path: "c.md", name: "c.md", snippet: "", matchedAlias: "别名笔记" }],
  // exact 优先于 alias：第一条只命中 alias，第二条文件名精确
  "目标": [{ path: "b.md", name: "b.md", snippet: "", matchedAlias: "目标" }, { path: "目标笔记.md", name: "目标笔记.md", snippet: "" }],
  "占位": [{ path: "b.md", name: "b.md", snippet: "" }],
  "b": [{ path: "b.md", name: "b.md", snippet: "" }],
  "不存在": [],
};
const fetchCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url, "http://localhost");
  fetchCalls.push(`${(init.method ?? "GET").toUpperCase()} ${u.pathname}${u.search}`);
  const json = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });
  if (u.pathname === "/obsidian/root") return json({ root: "/vault", exists: true });
  if (u.pathname === "/obsidian/tree") return json({ path: u.searchParams.get("path") ?? "", entries: Object.keys(notes).map((p) => ({ name: p, type: "note", size: 10, mtimeMs: notes[p].mtimeMs })) });
  if (u.pathname === "/obsidian/note") {
    const p = u.searchParams.get("path");
    const n = notes[p];
    if (!n) return json({ error: "note not found" }, 404);
    return json({ path: p, name: p.split("/").pop(), content: n.content, frontmatter: {}, links: [], aliases: p === "c.md" ? ["别名笔记"] : [], size: n.content.length, mtimeMs: n.mtimeMs });
  }
  if (u.pathname === "/obsidian/search") return json({ results: SEARCH[u.searchParams.get("q") ?? ""] ?? [] });
  if (u.pathname === "/obsidian/file") return json({ ok: true });
  return json({ error: `no route ${url}` }, 404);
};

// ═════════════════════════ 假渲染器（按 P2 契约 §3 / §12 输出 DOM）════════════════════
const rendererCalls = [];

/** 行内：只认 [[target#anchor|alias]] 与 [^label]，其余按纯文本 */
function fakeInlineNodes(text, handlers, keyBase) {
  const out = [];
  const re = /\[\[([^\]]+)\]\]|\[\^([^\]]+)\]/g;
  let last = 0;
  let m;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const raw = m[1];
      const pipe = raw.indexOf("|");
      const targetPart = pipe >= 0 ? raw.slice(0, pipe) : raw;
      const alias = pipe >= 0 ? raw.slice(pipe + 1) : null;
      const hash = targetPart.indexOf("#");
      const target = hash >= 0 ? targetPart.slice(0, hash) : targetPart;
      const anchor = hash >= 0 ? targetPart.slice(hash + 1) : undefined;
      out.push(stubReact.createElement("button", {
        key: `${keyBase}-w${k++}`,
        className: "dsh-obs-wikilink",
        title: `[[${raw}]]`,
        onClick: () => handlers.onWikilink(target, anchor),
      }, alias ?? (hash >= 0 ? targetPart.slice(1) : targetPart)));
    } else {
      out.push(stubReact.createElement("button", {
        key: `${keyBase}-f${k++}`,
        className: "dsh-obs-md-fnref",
        "data-footnote-ref": m[2],
        title: `[^${m[2]}]`,
      }, `[${m[2]}]`));
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function fakeRenderNumbered(md, handlers = {}, options) {
  rendererCalls.push({ md, handlers, options });
  const set = options && options.collapsedCallouts;
  const authoritative = !!(set && typeof set.has === "function");
  const lines = md.split("\n");
  const nodes = [];
  let offset = 0;
  let i = 0;
  let keySeq = 0;
  const mkRow = (num, cls, inner, attrs) => stubReact.createElement("div", {
    key: `row${keySeq++}`,
    className: `dsh-obs-md-row${cls ? ` ${cls}` : ""}`,
    "data-line-no": String(num),
    ...(attrs ?? {}),
  },
    stubReact.createElement("span", { className: "dsh-obs-md-ln" }, String(num)),
    stubReact.createElement("span", { className: "dsh-obs-md-lc" }, inner),
  );

  while (i < lines.length) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;
    const num = i + 1;

    // callout header：> [!type]<fold>? 标题
    const co = /^> \[!([A-Za-z]+)\]([+-]?)\s*(.*)$/.exec(line);
    if (co) {
      const key = String(lineStart);
      const collapsed = authoritative ? set.has(key) : co[2] === "-";
      const group = `c${key}`;
      const calloutAttrs = { "data-callout": co[1].toLowerCase(), "data-callout-group": group };
      nodes.push(stubReact.createElement("div", {
        key: `row${keySeq++}`,
        className: "dsh-obs-md-row dsh-obs-md-quote dsh-obs-md-callout-head",
        "data-line-no": String(num),
        ...calloutAttrs,
      },
        stubReact.createElement("span", { className: "dsh-obs-md-ln" }, String(num)),
        stubReact.createElement("span", { className: "dsh-obs-md-lc dsh-obs-md-callout-head" },
          stubReact.createElement("span", { className: "dsh-obs-md-callout-badge" }, `[!${co[1]}]`),
          co[2] === "" ? null : stubReact.createElement("button", {
            className: "dsh-obs-md-callout-toggle",
            "data-callout-toggle": key,
            "aria-expanded": collapsed ? "false" : "true",
          }, collapsed ? "▸" : "▾"),
          co[3],
        ),
      ));
      i += 1;
      while (i < lines.length && /^> /.test(lines[i])) {
        offset += lines[i].length + 1;
        nodes.push(stubReact.createElement("div", {
          key: `row${keySeq++}`,
          className: "dsh-obs-md-row dsh-obs-md-quote",
          "data-line-no": String(i + 1),
          ...calloutAttrs,
          ...(collapsed ? { "data-callout-collapsed": "1" } : {}),
        },
          stubReact.createElement("span", { className: "dsh-obs-md-ln" }, String(i + 1)),
          stubReact.createElement("span", { className: "dsh-obs-md-lc dsh-obs-md-callout-body" }, lines[i].slice(2)),
        ));
        i += 1;
      }
      continue;
    }

    // 脚注定义
    const fd = /^\[\^([^\]]+)\]:\s?(.*)$/.exec(line);
    if (fd) {
      nodes.push(mkRow(num, "dsh-obs-md-footnote-def", [
        stubReact.createElement("span", { key: "lab", className: "dsh-obs-md-footnote-label" }, `[^${fd[1]}]:`),
        fd[2],
      ], { "data-footnote-def": fd[1] }));
      i += 1;
      continue;
    }

    // 标题（ATX）
    const hd = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hd) {
      const level = hd[1].length;
      nodes.push(mkRow(num, `dsh-obs-md-heading dsh-obs-md-h${level}`, fakeInlineNodes(hd[2], handlers, `h${num}`), {
        "data-heading-anchor": hd[2].trim(),
        "data-heading-level": String(level),
      }));
      i += 1;
      continue;
    }

    // 行尾块引用 ^id（隐藏，行上带 data-block-id）
    let content = line;
    let blockId = null;
    const br = /^(.*?)\s+\^([A-Za-z0-9_-]+)\s*$/.exec(line);
    if (br) { content = br[1]; blockId = br[2]; }
    if (line.trim() === "") {
      nodes.push(mkRow(num, "", ""));
    } else {
      nodes.push(mkRow(num, "", fakeInlineNodes(content, handlers, `l${num}`), blockId ? { "data-block-id": blockId } : undefined));
    }
    i += 1;
  }
  return nodes;
}

// ═════════════════════════ React stub + 有状态钩子桩 ═════════════════════════
const Fragment = Symbol.for("react.fragment");
function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
}
const scopes = new Map();
const effectEntries = new Map();
let scopeSeq = 0;
let activeFn = null;

function depsChanged(prev, next) {
  if (prev === undefined) return true;
  if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return true;
  return prev.some((v, i) => v !== next[i]);
}
function hook() {
  const s = scopes.get(activeFn);
  const i = s.cursor++;
  if (s.hooks[i] === undefined) s.hooks[i] = {};
  return { s, h: s.hooks[i] };
}
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
  for (const entry of effectEntries.values()) {
    if (!depsChanged(entry.lastDeps, entry.deps)) continue;
    if (entry.cleanup) { try { entry.cleanup(); } catch { /* ignore */ } }
    entry.lastDeps = entry.deps;
    const result = entry.fn();
    if (typeof result === "function") entry.cleanup = result;
  }
}
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
function resetScopes() {
  scopes.clear();
  effectEntries.clear();
}

// ── 挂载：stub 树 → jsdom DOM（顺带把 ref.current 指到真实元素）──────────────
const domFor = new WeakMap();
const containers = new Map();
function mount(parent, node) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) { for (const child of node) mount(parent, child); return; }
  if (typeof node === "string" || typeof node === "number") { parent.appendChild(doc.createTextNode(String(node))); return; }
  const { type, props = {} } = node;
  if (typeof type !== "string") { mount(parent, props.children); return; }
  const el = doc.createElement(type);
  domFor.set(node, el);
  for (const [name, value] of Object.entries(props)) {
    if (name === "children" || name === "key" || value === undefined || value === null) continue;
    if (name === "ref") { if (value && typeof value === "object") value.current = el; continue; }
    if (name === "className") { el.setAttribute("class", String(value)); continue; }
    if (name === "style") {
      for (const [sk, sv] of Object.entries(value)) {
        if (typeof sv === "string" || typeof sv === "number") el.style[sk] = String(sv);
      }
      continue;
    }
    if (typeof value === "function" || typeof value === "object") continue;
    el.setAttribute(name, value === true ? "" : String(value));
  }
  const kids = Array.isArray(props.children) ? props.children : [props.children];
  for (const child of kids) mount(el, child);
  parent.appendChild(el);
}

function renderComponent(fn, props) {
  const tree = expand(invoke(fn, props));
  let container = containers.get(fn);
  if (!container) {
    container = doc.createElement("div");
    doc.body.appendChild(container);
    containers.set(fn, container);
  }
  // 模拟 React 复用 DOM 节点：重渲染不重建容器，滚动位置自然保留
  const prevBody = container.querySelector(".dsh-obs-dock-body");
  const prevScrollTop = prevBody ? prevBody.scrollTop : null;
  container.innerHTML = "";
  mount(container, tree);
  if (prevScrollTop !== null) {
    const body = container.querySelector(".dsh-obs-dock-body");
    if (body) body.scrollTop = prevScrollTop;
  }
  runEffects();
  return tree;
}

// ── 树/DOM 工具 ─────────────────────────────────────────────────────────────
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
const hasClass = (node, cls) => typeof (node.props ?? {}).className === "string"
  && (node.props.className.split(/\s+/).includes(cls));
const containerOf = (fn) => containers.get(fn);

function clickEventHandler(eventNode, event) {
  if (!eventNode || typeof eventNode.props.onClick !== "function") {
    check("click 目标没有 onClick", false);
    return;
  }
  eventNode.props.onClick({ preventDefault() { }, stopPropagation() { }, ...event });
}
/** 预览容器事件委托：用某个 DOM 节点作为 target 触发 wrapper 的 onClick */
function clickInPreview(previewTree, targetDom) {
  clickEventHandler(previewTree, { target: targetDom });
}

// ═════════════════════════ 断言工具 ═════════════════════════
const failures = [];
function check(name, cond, extra = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures.push(`${name}${extra ? ` (${extra})` : ""}`);
}

// ═════════════════════════ 装载 client bundle（注入假渲染器）════════════════════════
localStorage.setItem("dsh-obsidian:notesOpen", "1");
const factoryBody = `
var module = { exports: {} };
var exports = module.exports;
const React = require("react");
void require("react/jsx-runtime");
${REAL ? markdownSrc : 'const renderNumbered = require("__fake-renderer").renderNumbered;'}
${clientSrc}
return module.exports;
`;
const exports_ = new Function("require", factoryBody)((spec) => {
  if (spec === "react") return stubReact;
  if (spec === "react/jsx-runtime") return {};
  if (spec === "__fake-renderer") return { renderNumbered: fakeRenderNumbered };
  throw new Error(`unexpected require(${spec})`);
});

const registrations = [];
const fakeCtx = {
  effect: () => { },
  locale: { register: () => { } },
  slots: {
    inject: (_key, cb) => { cb(); return () => { }; },
    register: (options, component) => { registrations.push({ options, component }); return () => { }; },
  },
  sessions: {},
  workspaces: {},
  get: () => undefined,
};
exports_.apply(fakeCtx);
const byId = Object.fromEntries(registrations.map((r) => [r.options.id, r.component]));
const Sidebar = byId["obsidian-workspace-sidebar"];
const DockC = byId["obsidian-dock"];
const ToastC = byId["obsidian-toast"];
const t = (k, p) => (p ? `${k}(${JSON.stringify(p)})` : k);

const SF = { ids: [], byId: {}, current: null, phase: "ready" };
const WF = { items: [], archivedSessionIds: [], state: "ready", phase: "ready", error: null, baselinesReady: true, recentWorkspaceId: "" };
const sidebarProps = () => ({
  wide: true,
  expandSidebar: () => { },
  t,
  useSessions: (sel) => sel(SF),
  useWorkspaces: (sel) => sel(WF),
  workspaces: { create: async () => ({}), rename: async () => { }, delete: async () => { }, archiveSession: async () => { } },
  sessions: { create: async () => "s-new", open: () => { }, binding: () => ({ session: { rename: async () => ({ ok: true }) } }) },
  uiWorkspace: { startSession: () => { }, openSession: () => { }, pickDirectory: async () => "" },
});
const dockProps = () => ({ t, workspaces: null });

/** 打开某篇笔记：走真实 Sidebar 笔记树点击链路（设置 shared.openNote） */
async function openNoteViaSidebar(name) {
  let tree = renderComponent(Sidebar, sidebarProps());
  await settle();
  tree = renderComponent(Sidebar, sidebarProps());
  await settle();
  tree = renderComponent(Sidebar, sidebarProps());
  const row = findAll(tree, (p, n) => hasClass(n, "dsh-obs-row") && textOf(n).includes(name))[0];
  check(`Sidebar 里找到笔记「${name}」`, row !== undefined);
  if (row) clickEventHandler(row, {});
  await settle();
}

/** 渲染 Dock 到稳定（首帧加载笔记 → 后续 effects/setState 生效） */
async function pumpDock(rounds = 4) {
  let tree;
  for (let i = 0; i < rounds; i++) {
    tree = renderComponent(DockC, dockProps());
    await settle();
  }
  return tree;
}

async function openNote(name) {
  await openNoteViaSidebar(name);
  return pumpDock(5);
}

const dockContainer = () => containerOf(DockC);
const previewTreeOf = (tree) => findAll(tree, (p, n) => hasClass(n, "dsh-obs-md") && typeof p.onClick === "function")[0];
const lastRenderCall = () => rendererCalls[rendererCalls.length - 1];
const mdOf = (name) => notes[name].content;
const calloutKey = (name, needle) => String(mdOf(name).indexOf(needle));

if (!REAL) {
// ═════════════════════════ A. callout 折叠 ═════════════════════════
resetScopes();
{
  let tree = await openNote("a.md");
  await settle();
  tree = await pumpDock(3);
  const previewTree = previewTreeOf(tree);
  const key = calloutKey("a.md", "> [!note]-");

  check("A1 首帧 renderNumbered 不传 options（按源码默认渲染）",
    rendererCalls.some((c) => c.md === mdOf("a.md") && c.options === undefined));
  check("A2 seed 后重渲染传 collapsedCallouts Set，且含默认收起的 key",
    lastRenderCall().options !== undefined
    && lastRenderCall().options.collapsedCallouts instanceof Set
    && lastRenderCall().options.collapsedCallouts.has(key),
    `options=${JSON.stringify(lastRenderCall().options && [...(lastRenderCall().options.collapsedCallouts ?? [])])}`);

  const headerToggle = dockContainer().querySelector(`[data-callout-toggle="${key}"]`);
  check("A3 折叠态 header 按钮 aria-expanded=false、body 行 data-callout-collapsed=1",
    headerToggle !== null && headerToggle.getAttribute("aria-expanded") === "false"
    && dockContainer().querySelectorAll(`[data-callout-collapsed="1"]`).length >= 1);
  check("A4 无折叠标记的 callout 不产 toggle（只有 1 个 toggle）",
    dockContainer().querySelectorAll("[data-callout-toggle]").length === 1,
    `n=${dockContainer().querySelectorAll("[data-callout-toggle]").length}`);

  // 折叠 → 展开：滚动位置要保持
  const dockBody = dockContainer().querySelector(".dsh-obs-dock-body");
  dockBody.scrollTop = 120;
  clickInPreview(previewTree, headerToggle);
  tree = await pumpDock(3);
  const bodyAfter = dockContainer().querySelector(".dsh-obs-dock-body");
  const expandedToggle = dockContainer().querySelector(`[data-callout-toggle="${key}"]`);
  check("A5 点 toggle → 重渲染传的 Set 不再含该 key（展开）",
    lastRenderCall().options !== undefined && lastRenderCall().options.collapsedCallouts instanceof Set
    && !lastRenderCall().options.collapsedCallouts.has(key));
  check("A6 展开态 aria-expanded=true、body 行不再带 collapsed attr",
    expandedToggle !== null && expandedToggle.getAttribute("aria-expanded") === "true"
    && dockContainer().querySelectorAll("[data-callout-collapsed]").length === 0);
  check("A7 折叠/展开切换后滚动位置保持", bodyAfter.scrollTop === 120, `scrollTop=${bodyAfter.scrollTop}`);

  // 再点一次 → 收起
  clickInPreview(previewTreeOf(tree), expandedToggle);
  tree = await pumpDock(3);
  check("A8 再点 toggle → Set 重新加入 key（收起）",
    lastRenderCall().options.collapsedCallouts instanceof Set
    && lastRenderCall().options.collapsedCallouts.has(key)
    && dockContainer().querySelectorAll("[data-callout-collapsed=\"1\"]").length >= 1);
}

// ═════════════════════════ B. 脚注跳转 ═════════════════════════
resetScopes();
{
  scrollCalls.length = 0;
  timerQueue.clear();
  let tree = await openNote("a.md");
  await settle();
  tree = await pumpDock(2);
  const previewTree = previewTreeOf(tree);
  const defRow = dockContainer().querySelector('[data-footnote-def="fn1"]');
  check("B0 脚注定义行存在（data-footnote-def）", defRow !== null);

  const fnref = dockContainer().querySelector('[data-footnote-ref="fn1"]');
  check("B0b 脚注引用按钮存在（data-footnote-ref）", fnref !== null);
  clickInPreview(previewTree, fnref);
  check("B1 点脚注引用 → scrollIntoView 到定义行",
    scrollCalls.length === 1 && scrollCalls[0].el === defRow,
    `calls=${scrollCalls.length}`);
  check("B2 定义行加 dsh-obs-md-fn-target 高亮", defRow.classList.contains("dsh-obs-md-fn-target"));
  const targetTimer = [...timerQueue.values()].find((timer) => timer.ms === 1500);
  check("B3 高亮定时器 1.5s", targetTimer !== undefined);
  flushTimers();
  check("B4 1.5s 后移除 fn-target", !defRow.classList.contains("dsh-obs-md-fn-target"));

  // 缺定义：给 toast 提示，不滚动
  scrollCalls.length = 0;
  const missingRef = dockContainer().querySelector('[data-footnote-ref="nope"]');
  clickInPreview(previewTreeOf(tree), missingRef);
  const toastText = textOf(renderComponent(ToastC, { t }));
  check("B5 缺定义 → toast 提示未找到脚注定义",
    toastText.includes("footnoteMissing") && toastText.includes("nope") && scrollCalls.length === 0,
    toastText);
}

// ═════════════════════════ C. 同篇锚点（标题 / ^id）════════════════════════
resetScopes();
{
  scrollCalls.length = 0;
  let tree = await openNote("a.md");
  await settle();
  tree = await pumpDock(2);

  const headingWiki = findAll(tree, (p, n) => hasClass(n, "dsh-obs-wikilink") && p.title === "[[#标题甲]]")[0];
  check("C0 同篇标题双链按钮存在", headingWiki !== undefined);
  clickEventHandler(headingWiki, {});
  check("C1 [[#标题甲]] → scrollIntoView 到 data-heading-anchor 标题行",
    scrollCalls.length === 1
    && scrollCalls[0].el.getAttribute("data-heading-anchor") === "标题甲",
    `calls=${scrollCalls.length}`);

  scrollCalls.length = 0;
  const blockWiki = findAll(tree, (p, n) => hasClass(n, "dsh-obs-wikilink") && p.title === "[[#^blk1]]")[0];
  clickEventHandler(blockWiki, {});
  check("C2 [[#^blk1]] → scrollIntoView 到 data-block-id 行",
    scrollCalls.length === 1 && scrollCalls[0].el.getAttribute("data-block-id") === "blk1",
    `calls=${scrollCalls.length}`);
}

// ═════════════════════════ D. 跨篇锚点（pending anchor）════════════════════════
resetScopes();
{
  let tree = await openNote("a.md");
  await settle();
  tree = await pumpDock(2);

  scrollCalls.length = 0;
  const crossHeading = findAll(tree, (p, n) => hasClass(n, "dsh-obs-wikilink") && p.title === "[[b#标题乙]]")[0];
  check("D0 跨篇锚点双链按钮存在", crossHeading !== undefined);
  clickEventHandler(crossHeading, {});
  await settle();
  tree = await pumpDock(5);
  check("D1 跨篇打开目标笔记 b.md", textOf(tree).includes("b.md"), JSON.stringify(fetchCalls.slice(-3)));
  check("D2 打开后 pending anchor 滚动到标题「标题乙」",
    scrollCalls.length >= 1 && scrollCalls[scrollCalls.length - 1].el.getAttribute("data-heading-anchor") === "标题乙",
    `calls=${scrollCalls.length}`);

  // 回到 a 再点跨篇块锚点
  tree = await openNote("a.md");
  await settle();
  tree = await pumpDock(2);
  scrollCalls.length = 0;
  const crossBlock = findAll(tree, (p, n) => hasClass(n, "dsh-obs-wikilink") && p.title === "[[b#^blk2]]")[0];
  clickEventHandler(crossBlock, {});
  await settle();
  await pumpDock(5);
  check("D3 跨篇 [[b#^blk2]] → 打开后滚动到 data-block-id=blk2",
    scrollCalls.length >= 1 && scrollCalls[scrollCalls.length - 1].el.getAttribute("data-block-id") === "blk2",
    `calls=${scrollCalls.length}`);
}

// ═════════════════════════ E. alias 解析顺序 + search 小字 ═════════════════════════
resetScopes();
{
  let tree = await openNote("a.md");
  await settle();
  tree = await pumpDock(2);

  // alias 命中：search 返回 matchedAlias
  const aliasWiki = findAll(tree, (p, n) => hasClass(n, "dsh-obs-wikilink") && p.title === "[[别名笔记]]")[0];
  clickEventHandler(aliasWiki, {});
  await settle();
  tree = await pumpDock(5);
  check("E1 [[别名笔记]] → 按 search matchedAlias 打开 c.md", textOf(tree).includes("c.md"));

  // 精确文件名优先于 alias
  tree = await openNote("a.md");
  await settle();
  tree = await pumpDock(2);
  const exactWiki = findAll(tree, (p, n) => hasClass(n, "dsh-obs-wikilink") && p.title === "[[目标笔记]]")[0];
  clickEventHandler(exactWiki, {});
  await settle();
  tree = await pumpDock(5);
  check("E2 文件名精确匹配优先于 alias 命中", textOf(tree).includes("目标笔记.md"));

  // 无精确/alias → 第一个结果兜底（search("占位") 只回一个 b.md）
  tree = await openNote("a.md");
  await settle();
  tree = await pumpDock(2);
  const fallbackWiki = findAll(tree, (p, n) => hasClass(n, "dsh-obs-wikilink") && p.title === "[[占位]]")[0];
  check("E3 兜底双链按钮存在", fallbackWiki !== undefined);
  clickEventHandler(fallbackWiki, {});
  await settle();
  tree = await pumpDock(5);
  check("E3b 无精确/alias 命中 → 打开第一个搜索结果 b.md", textOf(tree).includes("b.md"));

  // search 面板命中别名小字：点开笔记树搜索 → 输入 "别名笔记"
  let sidebar = renderComponent(Sidebar, sidebarProps());
  await settle();
  sidebar = renderComponent(Sidebar, sidebarProps());
  await settle();
  sidebar = renderComponent(Sidebar, sidebarProps());
  const searchBtn = findAll(sidebar, (p) => p.title === "search")[0];
  check("E4 笔记树搜索按钮存在", searchBtn !== undefined);
  clickEventHandler(searchBtn, {});
  sidebar = renderComponent(Sidebar, sidebarProps());
  const searchInput = findAll(sidebar, (p) => p.placeholder === "searchPlaceholder")[0];
  check("E5 搜索输入框存在", searchInput !== undefined);
  searchInput.props.onChange({ target: { value: "别名笔记" } });
  sidebar = renderComponent(Sidebar, sidebarProps());   // 让 query effect 排上 debounce 定时器
  flushTimers();                                        // 250ms 防抖 → 发 search
  await settle();
  sidebar = renderComponent(Sidebar, sidebarProps());
  await settle();
  sidebar = renderComponent(Sidebar, sidebarProps());
  const sidebarText = textOf(sidebar);
  check("E6 搜索结果展示「命中别名」小字",
    sidebarText.includes("matchedAlias：别名笔记"),
    `text=${JSON.stringify(sidebarText.slice(0, 200))}`);
}


} else {
// ═════════════════════════ R. M11 折叠（真实渲染器）════════════════════════
{
  resetScopes();
  let tree = await openNote("m11.md");
  await settle();
  tree = await pumpDock(4);
  let previewTree = previewTreeOf(tree);
  const md11 = mdOf("m11.md");
  const outerKey = String(md11.indexOf("> [!note]- 外层折叠"));
  const childKey = String(md11.indexOf("> > [!tip]+ 子 callout"));
  const plusKey = String(md11.indexOf("> [!tip]+ 默认展开"));
  const unknownKey = String(md11.indexOf("> [!custom] 未知类型标题"));
  const plainKey = String(md11.indexOf("> [!note] 普通无折叠"));
  const dc = dockContainer();

  check("R1 只有带 -/+ 的 callout 产 toggle（外层-/子callout+/默认+ 共 3 个）",
    dc.querySelectorAll("[data-callout-toggle]").length === 3,
    `n=${dc.querySelectorAll("[data-callout-toggle]").length}`);
  const outerToggle = dc.querySelector(`[data-callout-toggle="${outerKey}"]`);
  const childToggle = dc.querySelector(`[data-callout-toggle="${childKey}"]`);
  const plusToggle = dc.querySelector(`[data-callout-toggle="${plusKey}"]`);
  check("R2 首帧按源码默认：- 收起 aria=false、+ 展开 aria=true",
    outerToggle !== null && outerToggle.getAttribute("aria-expanded") === "false"
    && childToggle !== null && childToggle.getAttribute("aria-expanded") === "true"
    && plusToggle !== null && plusToggle.getAttribute("aria-expanded") === "true",
    JSON.stringify([outerToggle?.getAttribute("aria-expanded"), childToggle?.getAttribute("aria-expanded"), plusToggle?.getAttribute("aria-expanded")]));
  check("R3 默认收起组 body 行 data-callout-collapsed=1；+ 组不折叠",
    dc.querySelectorAll(`[data-callout-group="c${outerKey}"][data-callout-collapsed="1"]`).length >= 1
    && dc.querySelectorAll(`[data-callout-group="c${plusKey}"][data-callout-collapsed="1"]`).length === 0);
  check("R4 父折叠传播到嵌套子 callout 行（子自身 + 展开也被父级折叠）",
    dc.querySelectorAll(`[data-callout-group="c${childKey}"][data-callout-collapsed="1"]`).length >= 1,
    `n=${dc.querySelectorAll(`[data-callout-group="c${childKey}"][data-callout-collapsed="1"]`).length}`);
  const unknownRows = [...dc.querySelectorAll(`[data-callout-group="c${unknownKey}"]`)];
  check("R5 未知类型：data-callout=原 type 小写 + callout-default + 无 toggle",
    unknownRows.length > 0
    && unknownRows.every((row) => row.getAttribute("data-callout") === "custom")
    && unknownRows.every((row) => row.classList.contains("dsh-obs-md-callout-default"))
    && dc.querySelector(`[data-callout-group="c${unknownKey}"] [data-callout-toggle]`) === null);
  check("R6 嵌套行 class/depth 与契约一致",
    (dc.querySelector(`[data-callout-group="c${childKey}"]`)?.classList.contains("dsh-obs-md-callout-nested") ?? false)
    && dc.querySelector(`[data-callout-group="c${childKey}"]`)?.getAttribute("data-callout-depth") === "1");
  check("R7 普通 callout（无折叠标记）无 toggle",
    dc.querySelector(`[data-callout-group="c${plainKey}"] [data-callout-toggle]`) === null);

  // 点外层 toggle → 展开：aria 同步、外层 body 显示、子 callout 按自身 + 展开
  clickInPreview(previewTree, outerToggle);
  tree = await pumpDock(4);
  const dc2 = dockContainer();
  check("R8 点外层 toggle → 展开（aria=true、外层 body 不再 collapsed）",
    dc2.querySelector(`[data-callout-toggle="${outerKey}"]`)?.getAttribute("aria-expanded") === "true"
    && dc2.querySelectorAll(`[data-callout-group="c${outerKey}"][data-callout-collapsed="1"]`).length === 0,
    `aria=${dc2.querySelector(`[data-callout-toggle="${outerKey}"]`)?.getAttribute("aria-expanded")}`);
  check("R9 展开外层后，子 callout 按自身 + 展开（Set 精确状态、不再被父折叠）",
    dc2.querySelector(`[data-callout-toggle="${childKey}"]`)?.getAttribute("aria-expanded") === "true"
    && dc2.querySelectorAll(`[data-callout-group="c${childKey}"][data-callout-collapsed="1"]`).length === 0);

  // 点 + 组 → 收起
  clickInPreview(previewTreeOf(tree), dc2.querySelector(`[data-callout-toggle="${plusKey}"]`));
  tree = await pumpDock(4);
  const dc3 = dockContainer();
  check("R10 点 + 组 toggle → 收起（aria=false + body collapsed）",
    dc3.querySelector(`[data-callout-toggle="${plusKey}"]`)?.getAttribute("aria-expanded") === "false"
    && dc3.querySelectorAll(`[data-callout-group="c${plusKey}"][data-callout-collapsed="1"]`).length >= 1);
  // 点子 callout toggle → 收起（独立状态）
  clickInPreview(previewTreeOf(tree), dc3.querySelector(`[data-callout-toggle="${childKey}"]`));
  tree = await pumpDock(4);
  check("R11 点子 callout toggle → 收起（独立于父级）",
    dockContainer().querySelector(`[data-callout-toggle="${childKey}"]`)?.getAttribute("aria-expanded") === "false"
    && dockContainer().querySelectorAll(`[data-callout-group="c${childKey}"][data-callout-collapsed="1"]`).length >= 1);
}

// ═════════════════════════ W. M10 onWikilink 签名 + M13 alias（真实渲染器）════════════════════════
{
  resetScopes();
  scrollCalls.length = 0;
  let tree = await openNote("m11.md");
  await settle();
  tree = await pumpDock(3);
  const wikis = findAll(tree, (p, n) => hasClass(n, "dsh-obs-wikilink"));
  check("W1 真实渲染器产出同篇标题链 + 别名链按钮", wikis.length >= 2, `n=${wikis.length}`);
  const headingWiki = wikis.find((w) => textOf(w).includes("标题甲"));
  check("W1b 同篇标题链按钮存在", headingWiki !== undefined);
  clickEventHandler(headingWiki, {});
  check("W2 M10 的 (\"\", \"标题甲\") → 同篇标题滚动（M12 后优先 data-heading-anchor）",
    scrollCalls.length >= 1
    && scrollCalls[scrollCalls.length - 1].el.className.includes("dsh-obs-md-heading")
    && scrollCalls[scrollCalls.length - 1].el.textContent.includes("标题甲"),
    `calls=${scrollCalls.length}`);
  const aliasWiki = wikis.find((w) => textOf(w).includes("别名笔记"));
  check("W2b 别名链按钮存在", aliasWiki !== undefined);
  clickEventHandler(aliasWiki, {});
  await settle();
  tree = await pumpDock(5);
  check("W3 M13 alias：matchedAlias 命中后打开 c.md", textOf(tree).includes("c.md"));
}

// ═════════════════════════ search 面板命中别名小字 ═════════════════════════
{
  resetScopes();
  let sidebar = renderComponent(Sidebar, sidebarProps());
  await settle();
  sidebar = renderComponent(Sidebar, sidebarProps());
  await settle();
  sidebar = renderComponent(Sidebar, sidebarProps());
  const searchBtn = findAll(sidebar, (p) => p.title === "search")[0];
  check("W4a 笔记树搜索按钮存在", searchBtn !== undefined);
  clickEventHandler(searchBtn, {});
  sidebar = renderComponent(Sidebar, sidebarProps());
  const searchInput = findAll(sidebar, (p) => p.placeholder === "searchPlaceholder")[0];
  check("W4b 搜索输入框存在", searchInput !== undefined);
  searchInput.props.onChange({ target: { value: "别名笔记" } });
  sidebar = renderComponent(Sidebar, sidebarProps());
  flushTimers();
  await settle();
  sidebar = renderComponent(Sidebar, sidebarProps());
  await settle();
  sidebar = renderComponent(Sidebar, sidebarProps());
  check("W4 搜索结果展示「命中别名」小字", textOf(sidebar).includes("matchedAlias：别名笔记"));
}

// ═════════ F. M12 真实渲染器（脚注 / 块引用 / 标题锚点）════════════════════
{
  resetScopes();
  scrollCalls.length = 0;
  timerQueue.clear();
  let tree = await openNote("a.md");
  await settle();
  tree = await pumpDock(3);
  const previewTree = previewTreeOf(tree);
  const dc = dockContainer();

  const defRow = dc.querySelector('[data-footnote-def="fn1"]');
  const fnref = dc.querySelector('[data-footnote-ref="fn1"]');
  check("F1 真实渲染器产出 M12 脚注结构（定义行/引用/生成 label）",
    defRow !== null && fnref !== null
    && defRow.querySelector(".dsh-obs-md-footnote-label")?.textContent?.includes("[^fn1]:") === true);
  clickInPreview(previewTree, fnref);
  check("F2 点脚注引用 → scrollIntoView 到定义行 + fn-target 高亮",
    scrollCalls.length === 1 && scrollCalls[0].el === defRow && defRow.classList.contains("dsh-obs-md-fn-target"),
    `calls=${scrollCalls.length}`);
  check("F2b 高亮定时器 1.5s", [...timerQueue.values()].some((x) => x.ms === 1500));
  flushTimers();
  check("F2c 1.5s 后移除 fn-target", !defRow.classList.contains("dsh-obs-md-fn-target"));

  const missingRef = dc.querySelector('[data-footnote-ref="nope"]');
  scrollCalls.length = 0;
  check("F3a 缺定义引用仍渲染为 fnref（带 title 提示）",
    missingRef !== null && (missingRef.getAttribute("title") ?? "").includes("未找到脚注定义"));
  if (missingRef) clickInPreview(previewTree, missingRef);
  const toastText = textOf(renderComponent(ToastC, { t }));
  check("F3 缺定义点击 → toast 提示且不滚动",
    toastText.includes("footnoteMissing") && toastText.includes("nope") && scrollCalls.length === 0, toastText);

  scrollCalls.length = 0;
  const headingWiki = findAll(tree, (p, n) => hasClass(n, "dsh-obs-wikilink") && textOf(n) === "标题甲")[0];
  check("F4 [[#标题甲]] 按钮存在（M13 显示无 target span）", headingWiki !== undefined);
  clickEventHandler(headingWiki, {});
  check("F5 同篇标题 → scrollIntoView 到 [data-heading-anchor=标题甲]",
    scrollCalls.length === 1 && scrollCalls[0].el.getAttribute("data-heading-anchor") === "标题甲",
    `calls=${scrollCalls.length}`);

  const blockRow = dc.querySelector('[data-block-id="blk1"]');
  check("F6 块引用行 data-block-id=blk1 且 ^blk1 源码不外漏",
    blockRow !== null && !blockRow.textContent.includes("^blk1"));
  scrollCalls.length = 0;
  const blockWiki = findAll(tree, (p, n) => hasClass(n, "dsh-obs-wikilink") && textOf(n) === "^blk1")[0];
  check("F7 [[#^blk1]] 按钮存在（显示 ^blk1）", blockWiki !== undefined);
  clickEventHandler(blockWiki, {});
  check("F8 同篇块引用 → scrollIntoView 到 [data-block-id=blk1]",
    scrollCalls.length === 1 && scrollCalls[0].el.getAttribute("data-block-id") === "blk1",
    `calls=${scrollCalls.length}`);
}

// ═════════ G. 跨篇 pending anchor（M12/M13）════════════════════════
{
  resetScopes();
  let tree = await openNote("a.md");
  await settle();
  tree = await pumpDock(3);
  const findWiki = (t, needle) => findAll(t, (p, n) => hasClass(n, "dsh-obs-wikilink") && textOf(n).includes(needle))[0];
  scrollCalls.length = 0;
  clickEventHandler(findWiki(tree, "标题乙"), {});
  await settle();
  tree = await pumpDock(6);
  check("G1 跨篇 [[b#标题乙]] → 打开 b.md 并滚动到 data-heading-anchor=标题乙",
    textOf(tree).includes("b.md")
    && scrollCalls.length >= 1
    && scrollCalls[scrollCalls.length - 1].el.getAttribute("data-heading-anchor") === "标题乙",
    `calls=${scrollCalls.length}`);

  tree = await openNote("a.md");
  await settle();
  tree = await pumpDock(3);
  scrollCalls.length = 0;
  clickEventHandler(findWiki(tree, "^blk2"), {});
  await settle();
  tree = await pumpDock(6);
  check("G2 跨篇 [[b#^blk2]] → 打开 b.md 并滚动到 data-block-id=blk2",
    textOf(tree).includes("b.md")
    && scrollCalls.length >= 1
    && scrollCalls[scrollCalls.length - 1].el.getAttribute("data-block-id") === "blk2",
    `calls=${scrollCalls.length}`);
}

}

console.log(`\n结果: ${failures.length === 0 ? "全部通过" : `${failures.length} 项失败`}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
