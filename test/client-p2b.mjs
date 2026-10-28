/**
 * P2b client 侧测试（ui-agent；M16 vendor 懒加载 / M19 媒体 / M18 transclusion / M20 mermaid）。
 *
 * 与 `test/client-p2a-ui.mjs` 同一思路：jsdom 真 DOM + stub React + 假渲染器注入
 * （`require("__fake-renderer")`），假渲染器只按「契约标记」调用 client 通过 handlers
 * 暴露的 P2b 工厂（mediaKind/mediaElement、embedElement、mermaidElement、mathElement、
 * loadVendor/vendor），专测 client 侧的懒加载、缓存、降级 UI 与 URL 拼接；不测
 * markdown 解析（renderer-c 落地后由 gate 用真实渲染器复看）。
 *
 * 覆盖：
 *  A. vendor 懒加载：script/css URL 带 ?v=0.19.1、单例只插一次、成功后 client 重渲染换真产物、
 *     失败降级 + toast 且不重试；mermaid 无 CSS 资源。
 *  B. 媒体：audio/video/pdf 结构、`/obsidian/file?path=...&from=...`、PDF iframe 失败降级链接。
 *  C. transclusion：fetch 一次 + 缓存命中、按标题切片段、缺失/循环/超深/超限 UI。
 *  D. mermaid：懒加载成功 → sanitize 后 SVG（脚本被丢弃）、失败降级源码块。
 *  E. handlers 扩展面（renderer-c 集成 API）齐备。
 *
 * 无网络：fetch 全 stub。运行：node test/client-p2b.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientSrc = readFileSync(join(root, "src", "client.js"), "utf8");
const sanitizeSrc = readFileSync(join(root, "src", "sanitize.js"), "utf8");

// ═════════════════════════ jsdom 环境 ═════════════════════════
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;

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
globalThis.DOMParser = window.DOMParser;      // sanitizer 解析 mermaid SVG 用
globalThis.MutationObserver = window.MutationObserver;
globalThis.setTimeout = window.setTimeout;
globalThis.clearTimeout = window.clearTimeout;
globalThis.setInterval = window.setInterval;
globalThis.clearInterval = window.clearInterval;

function flushTimers(rounds = 4) {
  for (let r = 0; r < rounds; r++) {
    if (timerQueue.size === 0) return;
    const pending = [...timerQueue.values()];
    timerQueue.clear();
    for (const timer of pending) timer.fn();
  }
}
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

// ═════════════════════════ fetch mock ═════════════════════════
const NOTES = {
  "math.md": "MATH: x^2 + y^2",
  "math-error.md": "MATH: 坏公式",
  "media.md": [
    "MEDIA: attachments/音频.mp3",
    "MEDIA: attachments/视频.webm",
    "MEDIA: attachments/手册.pdf",
  ].join("\n"),
  "embed.md": "EMBED: b.md",
  "anchor.md": "EMBED: b.md|标题二",
  "embed-h.md": "# 嵌入小节\n\n嵌入小节正文\n\n# 同级别下一节\n\n下一节正文",
  "anchor-h.md": "EMBED: embed-h.md|嵌入小节",
  "embed-b.md": "普通段落\n\n段落带块引用 ^embed-block\n\n下划线块 ^a_b\n\n中文块 ^中文块",
  "anchor-b.md": "EMBED: embed-b.md|^embed-block",
  "anchor-b2.md": "EMBED: embed-b.md|^a_b",
  "anchor-b3.md": "EMBED: embed-b.md|^中文块",
  "missing.md": "EMBED: 不存在.md",
  "cyc.md": "EMBED: cyc.md",
  "depth-a.md": "EMBED: depth-b.md",
  "depth-b.md": "b 层正文\nEMBED: depth-c.md",
  "depth-c.md": "c 层正文\nEMBED: depth-d.md",
  "depth-d.md": "第 3 层内容（应被截断）",
  "trunc.md": "EMBED: long.md",
  "mermaid.md": "MERMAID: graph TD; A-->B",
  "mermaid2.md": "MERMAID: 坏图",
  "mermaid3.md": "MERMAID: 无回退图",
  "b.md": "# 标题一\n\n第一节内容\n\n# 标题二\n\n第二节内容",
  "long.md": Array.from({ length: 260 }, (_, i) => `第${i + 1}行`).join("\n"),
};
const notes = Object.fromEntries(Object.entries(NOTES).map(([p, content]) => [p, { content, mtimeMs: p.length }]));
const SEARCH = {
  "不存在": [],
  "b.md": [{ path: "b.md", name: "b.md", snippet: "" }],
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
    return json({ path: p, name: p.split("/").pop(), content: n.content, frontmatter: {}, links: [], aliases: [], size: n.content.length, mtimeMs: n.mtimeMs });
  }
  if (u.pathname === "/obsidian/search") return json({ results: SEARCH[u.searchParams.get("q") ?? ""] ?? [] });
  return json({ error: `no route ${url}` }, 404);
};
const countFetch = (fragment) => fetchCalls.filter((call) => call.includes(fragment)).length;

// ═════════════════════════ stub React + 有状态钩子桩 ═════════════════════════
const Fragment = Symbol.for("react.fragment");
function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
}
// 钩子桩按「组件实例路径」分 scope（同一函数组件的多个实例不共享 state/effect），
// 与 React 的组件实例语义一致；元素有 key 时按 key 稳定。
const scopes = new Map();
const effectEntries = new Map();
let scopeSeq = 0;
let fnSeq = 0;
let activeFn = null;
let activeScopeKey = "";
function depsChanged(prev, next) {
  if (prev === undefined) return true;
  if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return true;
  return prev.some((v, i) => v !== next[i]);
}
function hook() {
  const s = scopes.get(activeScopeKey);
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
    const key = `${activeScopeKey}:${s.cursor - 1}`;
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
function invoke(fn, props, path) {
  if (fn.__scopeId === undefined) fn.__scopeId = ++fnSeq;
  const scopeKey = `${fn.__scopeId}:${path}`;
  let s = scopes.get(scopeKey);
  if (!s) { s = { id: ++scopeSeq, hooks: [] }; scopes.set(scopeKey, s); }
  s.cursor = 0;
  activeFn = fn;
  activeScopeKey = scopeKey;
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
function childPath(child, index) {
  if (child && typeof child === "object" && child.props && child.props.key !== undefined) return `k=${child.props.key}`;
  return `i=${index}`;
}
function expand(node, path = "root") {
  if (node === null || node === undefined || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}[${childPath(child, i)}]`));
  const { type, props } = node;
  if (typeof type === "function") {
    const name = type.__scopeId ?? (type.__scopeId = ++fnSeq);
    return expand(invoke(type, props, `${path}>${name}:${props.key ?? ""}`), path);
  }
  if (type === Fragment) {
    const kids = Array.isArray(props.children) ? props.children : [props.children];
    return kids.map((child, i) => expand(child, `${path}#${childPath(child, i)}`));
  }
  const kids = props?.children;
  if (kids !== undefined) {
    const mapKid = (child, i) => expand(child, `${path}/${type}[${childPath(child, i)}]`);
    return { ...node, props: { ...props, children: Array.isArray(kids) ? kids.map(mapKid) : mapKid(kids, 0) } };
  }
  return node;
}

// ── stub 树 → jsdom DOM ──────────────────────────────────────────────────────
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
      for (const [sk, sv] of Object.entries(value)) if (typeof sv === "string" || typeof sv === "number") el.style[sk] = String(sv);
      continue;
    }
    if (name === "dangerouslySetInnerHTML") {
      if (value && typeof value.__html === "string") el.innerHTML = value.__html;
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
  const tree = expand(invoke(fn, props, "component"));
  let container = containers.get(fn);
  if (!container) {
    container = doc.createElement("div");
    doc.body.appendChild(container);
    containers.set(fn, container);
  }
  container.innerHTML = "";
  mount(container, tree);
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

// ═════════════════════════ 假渲染器（按标记调用 handlers 的 P2b 工厂）════════════════════════
const handlerLog = { last: null, calls: [] };
let fallbackCalls = 0;
function plainRow(num, text) {
  return createElement("div", { className: "dsh-obs-md-row", "data-line-no": String(num) },
    createElement("span", { className: "dsh-obs-md-ln" }, String(num)),
    createElement("span", { className: "dsh-obs-md-lc" }, text));
}
function fakeRenderNumbered(md, handlers = {}, options) {
  handlerLog.last = handlers;
  handlerLog.calls.push(options);
  const nodes = [];
  md.split("\n").forEach((line, i) => {
    const num = i + 1;
    if (line.startsWith("MATH: ")) {
      const tex = line.slice(6);
      const ready = typeof handlers.vendor === "function" ? handlers.vendor("katex") : null;
      if (ready === null && typeof handlers.loadVendor === "function") void handlers.loadVendor("katex");
      const node = typeof handlers.mathElement === "function" ? handlers.mathElement(tex, false, `math${num}`) : null;
      nodes.push(node === null ? plainRow(num, `数学源码：${tex}`) : node);
      return;
    }
    if (line.startsWith("MEDIA: ")) {
      const rel = line.slice(7);
      const node = typeof handlers.mediaElement === "function" ? handlers.mediaElement(rel, `media${num}`) : null;
      nodes.push(node === null ? plainRow(num, rel) : node);
      return;
    }
    if (line.startsWith("EMBED: ")) {
      const spec = line.slice(7);
      const pipe = spec.indexOf("|");
      const target = pipe >= 0 ? spec.slice(0, pipe) : spec;
      const anchorText = pipe >= 0 ? spec.slice(pipe + 1) : undefined;
      const node = typeof handlers.embedElement === "function" ? handlers.embedElement(target, anchorText, `embed${num}`) : null;
      nodes.push(createElement("div", { className: "dsh-obs-md-block", "data-block-kind": "embed", "data-line-no": String(num) },
        createElement("span", { className: "dsh-obs-md-glno", "data-line-no": String(num) }, String(num)),
        createElement("div", { className: "dsh-obs-md-block-body" }, node)));
      return;
    }
    if (line.startsWith("MERMAID: ")) {
      const code = line.slice(9);
      // renderer-c 契约：第 3 参是惰性构造的 fallback（返回带精确 src span 的逐行源码节点）
      const renderFallback = () => {
        fallbackCalls += 1;
        return code.split("\n").map((srcLine, idx) => createElement("div", {
          key: `fb-line-${num}-${idx}`,
          className: "dsh-obs-md-src-line",
        }, createElement("span", {
          key: `fb-src-${num}-${idx}`,
          className: "dsh-obs-src",
          "data-obs-src": `${idx},${idx + srcLine.length}`,
        }, srcLine)));
      };
      const node = typeof handlers.mermaidElement === "function"
        ? (code.includes("无回退")
          ? handlers.mermaidElement(code, `mermaid${num}`)            // 缺第 3 参：向后兼容
          : handlers.mermaidElement(code, `mermaid${num}`, renderFallback))
        : null;
      nodes.push(createElement("div", { className: "dsh-obs-md-block", "data-block-kind": "mermaid", "data-line-no": String(num) },
        createElement("span", { className: "dsh-obs-md-glno", "data-line-no": String(num) }, String(num)),
        createElement("div", { className: "dsh-obs-md-block-body" }, node)));
      return;
    }
    nodes.push(plainRow(num, line));
  });
  return nodes;
}

// ═════════════════════════ 断言工具 ═════════════════════════
const failures = [];
function check(name, cond, extra = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures.push(`${name}${extra ? ` (${extra})` : ""}`);
}

// ═════════════════════════ 装载 client bundle（sanitize + client + 假渲染器）════════════════════════
localStorage.setItem("dsh-obsidian:notesOpen", "1");
const factoryBody = `
var module = { exports: {} };
var exports = module.exports;
const React = require("react");
void require("react/jsx-runtime");
const renderNumbered = require("__fake-renderer").renderNumbered;
${sanitizeSrc}
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
exports_.apply({
  effect: () => { },
  locale: { register: () => { } },
  slots: {
    inject: (_key, cb) => { cb(); return () => { }; },
    register: (options, component) => { registrations.push({ options, component }); return () => { }; },
  },
  sessions: {},
  workspaces: {},
  get: () => undefined,
});
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
const dockContainer = () => containerOf(DockC);

async function openNote(name) {
  let tree = renderComponent(Sidebar, sidebarProps());
  await settle();
  tree = renderComponent(Sidebar, sidebarProps());
  await settle();
  tree = renderComponent(Sidebar, sidebarProps());
  const row = findAll(tree, (p, n) => hasClass(n, "dsh-obs-row") && textOf(n).includes(name))[0];
  check(`Sidebar 里找到笔记「${name}」`, row !== undefined);
  if (row) row.props.onClick({ stopPropagation() { }, preventDefault() { } });
  await settle();
  for (let i = 0; i < 5; i++) { renderComponent(DockC, dockProps()); await settle(); }
  return renderComponent(DockC, dockProps());
}
/** 渲染 Dock 到稳定（首帧/异步 effects 需要多轮） */
async function pumpDock(rounds = 4) {
  let tree;
  for (let i = 0; i < rounds; i++) { tree = renderComponent(DockC, dockProps()); await settle(); }
  return tree;
}
const headVendorScripts = () => [...doc.head.querySelectorAll("script[data-dsh-obs-vendor-script]")];
const headVendorCss = () => [...doc.head.querySelectorAll("link[data-dsh-obs-vendor-css]")];

// ═════════════════════════ A. vendor 懒加载（KaTeX）════════════════════════
{
  let tree = await openNote("math.md");
  await settle();
  tree = renderComponent(DockC, dockProps());

  check("A1 handlers 暴露 loadVendor/vendor（renderer-c 集成面）",
    handlerLog.last && typeof handlerLog.last.loadVendor === "function" && typeof handlerLog.last.vendor === "function");
  const scripts = headVendorScripts();
  const css = headVendorCss();
  check("A2 首次遇到数学 → 插入 1 个 katex script（带 ?v=0.19.1）",
    scripts.length === 1
    && scripts[0].getAttribute("src").includes("/obsidian/vendor/katex/katex.min.js?v=0.19.1"),
    JSON.stringify(scripts.map((s) => s.getAttribute("src"))));
  check("A3 KaTeX CSS 同时插入且只加载一次（?v=0.19.1）",
    css.length === 1 && css[0].getAttribute("href").includes("/obsidian/vendor/katex/katex.min.css?v=0.19.1"),
    JSON.stringify(css.map((l) => l.getAttribute("href"))));
  check("A4 未就绪时渲染器拿到 null → 显示源码降级",
    textOf(tree).includes("数学源码：x^2 + y^2"));

  // 模拟脚本加载成功
  window.katex = {
    renderToString: (tex, opts) => {
      if (String(tex).includes("坏公式")) throw new Error("KaTeX parse error");
      return `<span class="katex">${tex}|displayMode=${opts.displayMode === true}</span>`;
    },
  };
  scripts[0].onload();
  await settle();
  for (let i = 0; i < 4; i++) { tree = renderComponent(DockC, dockProps()); await settle(); }
  check("A5 加载完成 → vendorRev 触发重渲染，出现 KaTeX 产物（无源码降级）",
    dockContainer().querySelector(".dsh-obs-md-math-inline .katex") !== null
    && dockContainer().textContent.includes("x^2 + y^2|displayMode=false"),
    JSON.stringify(dockContainer().querySelector(".dsh-obs-md")?.innerHTML?.slice(0, 160) ?? ""));
  check("A6 重复渲染不重复插脚本/CSS（单例 Promise 缓存）",
    headVendorScripts().length === 1 && headVendorCss().length === 1);

  // throwOnError:true → 非法公式返回 null，让 markdown 走「源码 + src span」降级
  tree = await openNote("math-error.md");
  await settle();
  tree = await pumpDock(3);
  check("A7 非法公式 → mathElement 返回 null（源码降级、不产 KaTeX 产物）",
    textOf(tree).includes("数学源码：坏公式")
    && dockContainer().querySelector(".dsh-obs-md-math-inline") === null);
}

// ═════════════════════════ B. 媒体渲染（M19 client 侧）════════════════════════
{
  const tree = await openNote("media.md");
  await settle();
  check("B1 audio 原生控件 + /obsidian/file URL（带 from）", (() => {
    const audio = dockContainer().querySelector("audio.dsh-obs-md-audio");
    if (audio === null) return false;
    const src = audio.getAttribute("src");
    return audio.hasAttribute("controls")
      && src.includes("/obsidian/file?path=attachments%2F") && src.includes(".mp3")
      && src.includes("from=media.md");
  })(), JSON.stringify(findAll(tree, (p, n) => n.type === "audio").map((n) => n.props.src)));
  check("B2 video 原生控件 + max-height 样式类", (() => {
    const video = dockContainer().querySelector("video.dsh-obs-md-video");
    return video !== null && video.hasAttribute("controls") && video.getAttribute("src").includes(".webm");
  })());
  check("B3 PDF 用 iframe", (() => {
    const pdf = dockContainer().querySelector("iframe.dsh-obs-md-pdf");
    return pdf !== null && pdf.getAttribute("src").includes(".pdf");
  })());

  // iframe onError → 降级为打开/下载链接
  const pdfTree = findAll(tree, (p, n) => n.type === "iframe" && p.className === "dsh-obs-md-pdf")[0];
  check("B4 iframe 带 onError（用于 CSP/加载失败降级）", pdfTree !== undefined && typeof pdfTree.props.onError === "function");
  if (pdfTree) pdfTree.props.onError();
  for (let i = 0; i < 2; i++) { renderComponent(DockC, dockProps()); await settle(); }
  check("B5 PDF 失败 → 降级为 a.dsh-obs-md-pdf-open 打开链接", (() => {
    const link = dockContainer().querySelector("a.dsh-obs-md-pdf-open");
    return link !== null && link.getAttribute("href").includes(".pdf")
      && (link.getAttribute("target") === "_blank") && textOf({ props: { children: link.textContent } }).includes("mediaOpen");
  })(), dockContainer().querySelector("a.dsh-obs-md-pdf-open")?.outerHTML ?? "");
}

// ═════════════════════════ C. transclusion（M18 client 侧）════════════════════════
{
  const tree = await openNote("embed.md");
  await settle();
  check("C1 嵌入笔记内容渲染进 dsh-obs-md-embed", (() => {
    const embed = dockContainer().querySelector(".dsh-obs-md-embed");
    return embed !== null && embed.textContent.includes("第一节内容") && embed.textContent.includes("第二节内容");
  })(), JSON.stringify(textOf(tree).slice(0, 160)));
  // Oracle 1.14.4：整篇嵌入有标题栏（embed-title=笔记名，无扩展名/无行号/无 src span）
  const wholeBlock = dockContainer().querySelector('.dsh-obs-md-block[data-block-kind="embed"]');
  const wholeTitle = dockContainer().querySelector(".dsh-obs-md-embed-title");
  check("C1b 整篇嵌入有标题栏（笔记 basename，无行号/src span；外层 gutter 仍只有 1 个行号）",
    wholeTitle !== null && wholeTitle.textContent === "b"
    && wholeTitle.querySelector("[data-line-no]") === null
    && wholeTitle.querySelector("[data-obs-src]") === null
    && wholeBlock.querySelectorAll(".dsh-obs-md-glno[data-line-no]").length === 1,
    JSON.stringify(wholeTitle?.textContent ?? null));
  const fetchCountB = countFetch("/obsidian/note?path=b.md");
  check("C2 读取被嵌入笔记一次（缓存按 path+vaultRev）", fetchCountB === 1, `n=${fetchCountB}`);
}

{
  // 重开同一篇笔记：嵌入缓存命中，不再重复读 b.md
  await openNote("embed.md");
  await settle();
  check("C3 重开笔记后嵌入缓存命中（不重复 fetch）", countFetch("/obsidian/note?path=b.md") === 1, `n=${countFetch("/obsidian/note?path=b.md")}`);
}

{
  const tree = await openNote("anchor.md");
  await settle();
  const embedText = dockContainer().querySelector(".dsh-obs-md-embed")?.textContent ?? "";
  check("C4 按标题切片段：包含标题行本身（Oracle 对齐）且只到下一同级标题前",
    embedText.includes("标题二") && embedText.includes("第二节内容")
    && !embedText.includes("第一节内容") && !embedText.includes("标题一"),
    JSON.stringify(embedText));
  check("C4b 标题/块嵌入没有 embed 标题栏（Obsidian 空 title）",
    dockContainer().querySelector(".dsh-obs-md-embed-title") === null);
  check("C4c 切片内容经 renderNumbered 内层渲染（不产外层 data-obs-src）",
    findAll(tree, (p) => p["data-obs-src"] !== undefined).length === 0);
}

// Oracle 1.14.4：标题切片包含标题行（真机 <h2 data-heading="嵌入小节"> 开头）
{
  await openNote("anchor-h.md");
  await settle();
  await pumpDock(3);
  const embed = dockContainer().querySelector(".dsh-obs-md-embed");
  const text = embed?.textContent ?? "";
  check("C9 标题切片以标题行开头（含「嵌入小节」标题文本）",
    embed !== null && text.includes("嵌入小节") && text.includes("嵌入小节正文"),
    JSON.stringify(text));
  check("C10 标题切片到下一个同级标题前（不含下一节正文）", !text.includes("下一节正文"));
  check("C10b 标题嵌入无 embed 标题栏", dockContainer().querySelector(".dsh-obs-md-embed-title") === null);
}

// Oracle 1.14.4：块 id 只认 [A-Za-z0-9-]；^a_b / ^中文块 不是合法 id（未找到）
{
  await openNote("anchor-b.md");
  await settle();
  await pumpDock(3);
  const block = dockContainer().querySelector('.dsh-obs-md-block[data-block-kind="embed"]');
  check("C11 合法块 id ^embed-block 能切到所属段落",
    block !== null && (block.textContent ?? "").includes("段落带块引用")
    && !(block.textContent ?? "").includes("下划线块"),
    JSON.stringify(block?.textContent?.slice(0, 120) ?? null));
  check("C11b 块嵌入无 embed 标题栏", dockContainer().querySelector(".dsh-obs-md-embed-title") === null);
}

{
  await openNote("anchor-b2.md");
  await settle();
  await pumpDock(3);
  check("C12 下划线 id ^a_b 不是合法块 id → 报未找到",
    textOf(renderComponent(DockC, dockProps())).includes("embedAnchorMissing"));
}

{
  await openNote("anchor-b3.md");
  await settle();
  await pumpDock(3);
  check("C13 中文 id ^中文块 不是合法块 id → 报未找到",
    textOf(renderComponent(DockC, dockProps())).includes("embedAnchorMissing"));
}

// 整篇嵌入标题栏点击 → onWikilink 打开目标笔记
{
  let tree = await openNote("embed.md");
  await settle();
  tree = await pumpDock(4);
  const titleTree = findAll(tree, (p, n) => hasClass(n, "dsh-obs-md-embed-title"))[0];
  check("C14 整篇嵌入标题栏可点击（走 onWikilink）", titleTree !== undefined && typeof titleTree.props.onClick === "function");
  if (titleTree) titleTree.props.onClick({});
  await settle();
  tree = await pumpDock(6);
  check("C15 点标题栏 → 打开目标笔记 b.md", textOf(tree).includes("b.md"),
    JSON.stringify(textOf(tree).slice(0, 120)));
}

{
  await openNote("missing.md");
  await settle();
  check("C5 目标不存在 → embedMissing 错误卡", textOf(renderComponent(DockC, dockProps())).includes("embedMissing"),
    JSON.stringify(textOf(renderComponent(DockC, dockProps())).slice(0, 160)));
}

{
  await openNote("cyc.md");
  await settle();
  check("C6 自引用循环 → embedCycle 错误卡", textOf(renderComponent(DockC, dockProps())).includes("embedCycle"));
}

{
  await openNote("depth-a.md");
  await settle();
  for (let i = 0; i < 8; i++) { renderComponent(DockC, dockProps()); await settle(); }
  const after = textOf(renderComponent(DockC, dockProps()));
  check("C7 深度语义（§14）：root 不计，A/B 两层嵌入渲染，第 3 层起 embedDepth 截断",
    after.includes("b 层正文") && after.includes("c 层正文") && after.includes("embedDepth")
    && !after.includes("第 3 层内容"),
    JSON.stringify(after.slice(0, 260)));
}

{
  await openNote("trunc.md");
  await settle();
  for (let i = 0; i < 3; i++) { renderComponent(DockC, dockProps()); await settle(); }
  const after = textOf(renderComponent(DockC, dockProps()));
  check("C8 超过 200 行 → embedTooLong + 打开按钮", after.includes("embedTooLong") && after.includes("embedOpen"),
    JSON.stringify(after.slice(0, 200)));
}

// ═════════════════════════ D. mermaid（M20 client 侧）════════════════════════
{
  const initCalls = [];
  await openNote("mermaid.md");
  await settle();
  const scripts = headVendorScripts().filter((s) => s.getAttribute("src").includes("mermaid"));
  check("D1 首次遇到 mermaid → 懒加载 mermaid.min.js（带 ?v=12.2.0）",
    scripts.length === 1 && scripts[0].getAttribute("src").includes("/obsidian/vendor/mermaid/mermaid.min.js?v=12.2.0"),
    JSON.stringify(headVendorScripts().map((s) => s.getAttribute("src"))));
  check("D1b mermaid 无 CSS 资源（不插 link）",
    headVendorCss().every((l) => !l.getAttribute("href").includes("mermaid")));
  // 模拟脚本加载成功：先挂全局对象（vendorGlobal 读 window.mermaid）再触发 onload
  window.mermaid = {
    initialize: (opts) => initCalls.push(opts),
    render: async (_id, _code) => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/><script>alert(1)</script></svg>',
    }),
  };
  scripts[0].onload();
  await settle();
  for (let i = 0; i < 6; i++) { renderComponent(DockC, dockProps()); await settle(); }
  const svg = dockContainer().querySelector(".dsh-obs-md-mermaid svg");
  check("D2 加载完成 → 渲染出 SVG 且脚本节点被 sanitizer 丢弃", svg !== null && svg.querySelector("script") === null,
    dockContainer().querySelector(".dsh-obs-md-mermaid")?.innerHTML?.slice(0, 160) ?? "null");
  check("D3 mermaid.initialize 用 strict/htmlLabels:false/非 startOnLoad", initCalls.length >= 1
    && initCalls[0].startOnLoad === false && initCalls[0].securityLevel === "strict"
    && initCalls[0].htmlLabels === false,
    JSON.stringify(initCalls[0] ?? null));
  const fallbackCallsAtReady = fallbackCalls;
  for (let i = 0; i < 2; i++) { renderComponent(DockC, dockProps()); await settle(); }
  check("D3b ready 后再次重渲染不再调用 renderFallback（图正常渲染时不吐源码）",
    fallbackCalls === fallbackCallsAtReady, `before=${fallbackCallsAtReady} after=${fallbackCalls}`);

  // 浅/深主题切换：MutationObserver → themeRev → 重新 initialize(theme=dark)/render
  const rendersBeforeTheme = initCalls.length;
  document.body.setAttribute("data-ds-dark-theme", "");
  await settle();
  for (let i = 0; i < 4; i++) { renderComponent(DockC, dockProps()); await settle(); }
  check("D5 主题切换 → 重新 initialize(theme=dark) 并重渲染",
    initCalls.length > rendersBeforeTheme && initCalls[initCalls.length - 1].theme === "dark",
    JSON.stringify(initCalls.map((c) => c.theme)));
  document.body.removeAttribute("data-ds-dark-theme");
  await settle();
}

{
  // 第二个 mermaid：render 抛错 → 降级源码 + 错误提示
  window.mermaid = { initialize: () => { }, render: async () => { throw new Error("bad graph"); } };
  await openNote("mermaid2.md");
  await settle();
  for (let i = 0; i < 4; i++) { renderComponent(DockC, dockProps()); await settle(); }
  const after = textOf(renderComponent(DockC, dockProps()));
  check("D4 render 失败 → 错误提示 + renderFallback 源码行（带 src span，不重复 pre）",
    after.includes("mermaidError")
    && dockContainer().querySelector(".dsh-obs-md-mermaid-fallback .dsh-obs-md-src-line .dsh-obs-src") !== null
    && dockContainer().querySelector("pre.dsh-obs-code") === null
    && after.includes("坏图"),
    JSON.stringify(after.slice(0, 200)));
  check("D4b loading/失败态调用 renderFallback（ready 后不再调用）", fallbackCalls >= 1, `calls=${fallbackCalls}`);
}

{
  // 缺第 3 参（渲染器未升级 / 不传 fallback）：仍能降级成无 span 的源码块，不崩
  window.mermaid = { initialize: () => { }, render: async () => { throw new Error("bad compat"); } };
  await openNote("mermaid3.md");
  await settle();
  for (let i = 0; i < 4; i++) { renderComponent(DockC, dockProps()); await settle(); }
  const after = textOf(renderComponent(DockC, dockProps()));
  check("D6 缺 renderFallback 时向后兼容：错误提示 + 无 span 源码块",
    after.includes("mermaidError")
    && dockContainer().querySelector("pre.dsh-obs-code") !== null
    && dockContainer().querySelector(".dsh-obs-md-mermaid-fallback") === null,
    JSON.stringify(after.slice(0, 160)));
}

// ═════════════════════════ E. handlers 扩展面（renderer-c 集成 API）════════════════════════
{
  await openNote("media.md");
  await settle();
  const h = handlerLog.last ?? {};
  const names = ["loadVendor", "vendor", "mediaKind", "mediaElement", "mathElement", "mermaidElement", "embedElement", "onWikilink", "assetUrl"];
  check("E1 renderNumbered 收到的 handlers 含全部 P2b 扩展字段",
    names.every((n) => typeof h[n] === "function"), names.filter((n) => typeof h[n] !== "function").join(","));
  check("E2 mediaKind 按扩展名分派（audio/video/pdf/非媒体）",
    h.mediaKind("a.mp3") === "audio" && h.mediaKind("a.webm") === "video"
    && h.mediaKind("a.pdf") === "pdf" && h.mediaKind("a.png") === null && h.mediaKind("a.md") === null);
  check("E3 vendor() 未加载时同步返回 null、不触发请求",
    h.vendor("katex") === null || typeof h.vendor("katex").renderToString === "function");
}

console.log(`\n结果: ${failures.length === 0 ? "全部通过" : `${failures.length} 项失败`}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
