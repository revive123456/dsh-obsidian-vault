/**
 * Obsidian P2b 面板路径测试（renderer 侧）：M16 数学 KaTeX 接线 + 降级；M17 行内 HTML 接 sanitizer。
 * 后续 M18（transclusion）/M19（媒体分派）/M20（mermaid）在同一文件里继续扩展。
 *
 * 只测面板实际使用的 `renderNumbered`。加载方式模拟 build.mjs 的拼接顺序：
 *   sanitize.js → markdown.js（new Function("React", ...)），stub createElement 收树；
 *   另保留一份「只加载 markdown.js」的渲染器，专门测「Node 未拼 sanitize」的 typeof 守卫降级。
 * Node 侧注入 jsdom DOMParser（浏览器里用原生 globalThis.DOMParser）；不用真 KaTeX
 * （注入 stub `handlers.mathElement(tex, displayMode, key)`）。
 *
 * 覆盖（方案 §4 M16/M17 + P2 契约 §3.8/§4/§5/§10/§15）：
 *   M16-A..L 数学：行内/块级降级与成功路径、`\$`/货币/空格边界、多行 aligned、未闭合、
 *             防吞行、mathElement 抛错、围栏优先级；
 *   M17-A..I 行内 HTML：白名单元素重建（b/kbd/sup/abbr title）、textHandler 精确偏移、
 *             未知标签展开文本、禁止标签整段丢弃（script/style/iframe/svg/form/input）、
 *             属性清洗（on* 事件、class、style 丢弃；title 保留）、实体解码文本不产 span、
 *             `[]` 不回退原文、null/sanitize 缺失 → 原文降级、50KB 超限降级、
 *             多行 block HTML 原文降级、表格单元格内 HTML 偏移；
 *   M18 整行 transclusion：D2 embed 块 + 1 个 glno、body 放 embedElement 节点、
 *             lineNumbers:false 递归（无行号/无 span/无 D2）、循环/深度/降级卡/图片 media 分派；
 *   M19 媒体分派：图片 > mediaKind/mediaElement > transclusion 的优先级、行内与整行、
 *             控件无 src span、handler 缺失回退；
 *   M16/M17/M18/M19 全部 fixture 跑行号覆盖、偏移记账、标记外漏三条不变量（含 stub 路径）。
 *
 * 运行：`node test/obsidian-p2b.mjs`；失败信息带 fixture id。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const code = readFileSync(join(root, "src", "markdown.js"), "utf8");
const sanitizeCode = readFileSync(join(root, "src", "sanitize.js"), "utf8");

// ── stub React.createElement 收集元素树（同 test/obsidian-p2a.mjs）──
const Fragment = Symbol.for("react.fragment");
function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
}
const React = { Fragment, createElement };
// 与 build.mjs 等价：sanitize → markdown 同一闭包
const { renderNumbered } = new Function("React", `${sanitizeCode}\n${code}\nreturn { renderNumbered };`)(React);
// 「Node 只加载 markdown.js、未拼 sanitize」的对照渲染器（测 typeof 守卫）
const markdownOnly = new Function("React", `${code}\nreturn { renderNumbered };`)(React).renderNumbered;
const { window: jsdomWindow } = new JSDOM("<!doctype html><html><body></body></html>");
const DOMParser = jsdomWindow.DOMParser;

// ── fixtures（方案附录 B「数学」清单 + 边界补充）────────────────────────────
const FIXTURES = [
  { id: "math-inline", md: "勾股 $a^2+b^2=c^2$ 结束" },
  { id: "math-multiline", md: "$$\n\\begin{aligned}\na &= b + c \\\\\nd &= e\n\\end{aligned}\n$$" },
  { id: "math-block", md: "$$\nE = mc^2\n$$" },
  { id: "math-escape", md: "价格 \\$5 与公式 $x$ 结束" },
  { id: "math-error", md: "非法公式 $\\frac{a}{$ 结束" },
  { id: "math-mixed-text", md: "文本 **粗** $a+b$ 中间 `code` 结束" },
  // 边界补充
  { id: "math-currency", md: "我有 $5 和 $10，公式 $x$ 结束" },
  { id: "math-space", md: "$ x$ 与 $x $ 与 $x$" },
  { id: "math-inline-dollars", md: "文本 $$a+b$$ 后面" },
  { id: "math-block-single", md: "$$E=mc^2$$" },
  { id: "math-block-unclosed", md: "$$\na = b" },
  { id: "math-block-mixed", md: "前\n\n$$\nx = 1\n$$\n\n后" },
  { id: "math-block-trailing", md: "前\n\n$$a$$ 后面\n\n后" },
  { id: "math-block-close-indent", md: "$$\nE\n  $$  " },
  { id: "math-fence-priority", md: "```\n$$\nE = mc^2\n$$\n```" },
  // ── M17 行内 HTML（附录 B 安全语料 + 边界补充）──────────────────────────
  { id: "html-basic", md: '<b>粗</b> <kbd>Ctrl</kbd> <sup>上标</sup> <abbr title="超文本">HTML</abbr> 结束' },
  { id: "html-details", md: "<details><summary>展开标题</summary>隐藏内容</details>" },
  { id: "html-xss-script", md: "<script>alert('xss')</script> 结束" },
  { id: "html-xss-img-onerror", md: '<img src=x onerror=alert(1)> 结束' },
  { id: "html-xss-js-url", md: '<a href="javascript:alert(1)">点我</a> 结束' },
  { id: "html-xss-svg", md: '<svg onload=alert(1)><circle r=10></circle></svg> 结束' },
  { id: "html-xss-style", md: "<style>body{display:none}</style><b>粗</b> 结束" },
  { id: "html-xss-iframe", md: '<iframe src="https://evil.example"></iframe> 结束' },
  { id: "html-xss-entity", md: "&lt;script&gt;alert(1)&lt;/script&gt; 结束" },
  { id: "html-xss-dom-clobber", md: '<form id="__proto__"><input name="innerHTML"></form> 结束' },
  { id: "html-xss-nested-script", md: "<b>前<script>alert(1)</script>后</b> 结束" },
  { id: "html-attr-strip", md: '<b onclick="alert(1)" class="x" style="color:red" title="T">粗</b>' },
  { id: "html-entity-text", md: "<b>a&amp;b</b>" },
  { id: "html-nested", md: "<b><i>粗斜</i></b> 尾" },
  { id: "html-void-br", md: "前<br>后" },
  { id: "html-unknown-inline", md: "<u2>未知</u2> 尾" },
  { id: "html-unclosed-tag", md: "前 <b>未闭合" },
  { id: "html-block-multiline", md: "<details>\n<summary>展开</summary>\n内文\n</details>" },
  { id: "html-long-token", md: `<b>${"x".repeat(60 * 1024)}</b>` },
  { id: "html-table-cell", md: "| 列 |\n| --- |\n| <b>粗</b> |" },
  // ── M18 transclusion / M19 媒体分派（内容由 stub handlers 提供；默认 handler 走降级卡）──
  { id: "embed-note", md: "![[笔记A]]" },
  { id: "embed-heading", md: "![[笔记A#标题]]" },
  { id: "embed-block", md: "![[笔记A#^blockid]]" },
  { id: "embed-inline", md: "前 ![[笔记A]] 后" },
  { id: "embed-alias", md: "![[笔记A|别名]]" },
  { id: "embed-image-line", md: "![[pic.png]]" },
  { id: "embed-media-line", md: "![[录音.mp3]]" },
  { id: "embed-media-inline", md: "前 ![[录音.mp3]] 后" },
  { id: "embed-media-missing", md: "![[不存在.mp3]]" },
  { id: "embed-media-escape", md: "![[../外面.mp3]]" },
  { id: "embed-depth", md: "![[深度一]]" },
  { id: "embed-cycle", md: "![[循环A]]" },
];
const FIXTURES_BY_ID = Object.fromEntries(FIXTURES.map((fx) => [fx.id, fx]));
const normMd = (md) => md.replace(/\r\n/g, "\n");

// 每个 fixture 的「不得外漏」标记（定界符按 D13/契约 §15 隐藏）
const LEAK = {
  "math-inline": ["$"],
  "math-multiline": ["$$"],
  "math-block": ["$$"],
  "math-error": ["$"],
  "math-mixed-text": ["$"],
  "math-currency": ["$ "], // 允许 $5/$10（货币文本），但不允许 `$ 公式` 这类残留
  "math-space": ["$$"],
  "math-inline-dollars": ["$"],
  "math-block-single": ["$$"],
  "math-block-unclosed": ["$$"],
  "math-block-mixed": ["$$"],
  "math-block-trailing": ["$$"],
  "math-block-close-indent": ["$$"],
  // M17：HTML 标签/事件属性不得以原文出现在可见文本（实体文本除外）
  "html-basic": ["<b>", "</b>", "<kbd>", "<sup>", "<abbr"],
  "html-xss-script": ["<script>"],
  "html-xss-img-onerror": ["onerror"],
  "html-xss-js-url": ["javascript:"],
  "html-xss-svg": ["<svg"],
  "html-xss-style": ["<style>"],
  "html-xss-iframe": ["<iframe"],
  "html-xss-entity": ["<script>"],
  "html-xss-nested-script": ["<script>", "alert"],
  "html-attr-strip": ["onclick="],
  "html-nested": ["<b>", "<i>"],
  "html-unknown-inline": ["<u2>"],
  // M18/M19：整行嵌入标记不得以原文出现在可见文本（内容由 handler/降级卡提供）
  "embed-note": ["![["],
  "embed-heading": ["![["],
  "embed-block": ["![["],
  "embed-inline": ["![["],
  "embed-alias": ["![["],
  "embed-media-line": ["![["],
  "embed-media-inline": ["![["],
  "embed-media-missing": ["![["],
  "embed-media-escape": ["![["],
  "embed-depth": ["![["],
  "embed-cycle": ["![["],
};

// 面板真实传参（src/client.js）+ P2b 可选扩展点；DOMParser 由 Node 侧注入（浏览器用原生）
const HANDLERS = {
  onText: () => {},
  onWikilink: () => {},
  assetUrl: (rel) => `/obsidian/file?path=${encodeURIComponent(rel)}`,
  DOMParser,
};
function render(id, extraHandlers) {
  return renderNumbered(FIXTURES_BY_ID[id].md, { ...HANDLERS, ...(extraHandlers ?? {}) });
}
/** 模拟「Node 只加载 markdown.js、未拼 sanitize」：typeof 守卫应走原文降级 */
function renderWithoutSanitizer(id, extraHandlers) {
  return markdownOnly(FIXTURES_BY_ID[id].md, { ...HANDLERS, ...(extraHandlers ?? {}) });
}

/**
 * stub KaTeX 引擎（Node 侧替代 ui 的 handlers.mathElement）：
 * - 正常：返回带 class 的假节点（模拟 client 的 KaTeX 产物；无 data-obs-src）；
 * - `failWhen(tex)` 命中 → 返回 null（模拟非法公式/未加载）；
 * - mode:"throw" → 抛错（防御性降级路径）。
 */
function makeMathStub(opts = {}) {
  const calls = [];
  const failWhen = typeof opts.failWhen === "function" ? opts.failWhen : () => false;
  const stub = (tex, displayMode, key) => {
    calls.push({ tex, displayMode, key });
    if (opts.mode === "throw") throw new Error("stub katex boom");
    if (failWhen(tex)) return null;
    return createElement("span", {
      key,
      className: displayMode === true ? "dsh-obs-md-math-block" : "dsh-obs-md-math-inline",
      "data-fake-katex": tex,
      dangerouslySetInnerHTML: { __html: `<span class="katex">${tex}</span>` },
    });
  };
  stub.calls = calls;
  return stub;
}
const FAIL_INVALID = (tex) => tex.includes("\\frac");

// ── M18/M19 stub handlers（Node 侧替代 ui 的 embedElement/mediaKind/mediaElement）──
const EMBED_CONTENT = {
  "笔记A": "# 标题\n\n内嵌正文内容\n\n段落内容 ^blockid",
  "深度一": "![[深度二]]",
  "深度二": "![[深度三]]",
  "深度三": "最深内容",
  "循环A": "![[循环B]]",
  "循环B": "![[循环A]]",
  "相对笔记": "![[pic.png]]\n\n相对图片",
};
/**
 * transclusion stub：模拟 ui 的 TransclusionEmbed（记录调用、循环栈/深度、用
 * renderNumbered(..., {lineNumbers:false}) 渲染嵌套内容）。depth 语义与 client 一致：
 * root 不计数；A=1/B=2 渲染；第 3 层截断（stack.length >= 2 时给 embedDepth 错误卡）。
 */
function makeEmbedStub(opts = {}) {
  const calls = [];
  const stack = [];
  const stub = (target, anchor, key) => {
    calls.push({ target, anchor, key, depth: stack.length });
    if (opts.mode === "throw") throw new Error("stub embed boom");
    if (stack.includes(target)) {
      return createElement("div", { key, className: "dsh-obs-md-embed-error" }, "embedCycle");
    }
    if (stack.length >= 2) {
      return createElement("div", { key, className: "dsh-obs-md-embed-error" }, "embedDepth");
    }
    const content = EMBED_CONTENT[target];
    if (content === undefined) {
      return createElement("div", { key, className: "dsh-obs-md-embed-error" }, `embedMissing:${target}`);
    }
    stack.push(target);
    const inner = renderNumbered(content, { ...HANDLERS, embedElement: stub }, { lineNumbers: false });
    stack.pop();
    return createElement("div", { key, className: "dsh-obs-md-embed" }, inner);
  };
  stub.calls = calls;
  return stub;
}
function makeMediaStub() {
  const calls = [];
  const kindCalls = [];
  const kindOf = (rel) => {
    kindCalls.push(rel);
    if (/\.(mp3|wav|ogg|m4a)$/i.test(rel)) return "audio";
    if (/\.(mp4|webm)$/i.test(rel)) return "video";
    if (/\.pdf$/i.test(rel)) return "pdf";
    return null;
  };
  const mediaElement = (rel, key) => {
    calls.push({ rel, key });
    const kind = kindOf(rel) ?? "pdf";
    const tag = kind === "audio" ? "audio" : kind === "video" ? "video" : "iframe";
    const cls = kind === "audio" ? "dsh-obs-md-audio" : kind === "video" ? "dsh-obs-md-video" : "dsh-obs-md-pdf";
    return createElement(tag, {
      key,
      className: cls,
      controls: kind === "audio" || kind === "video" ? true : undefined,
      src: `/obsidian/file?path=${encodeURIComponent(rel)}`,
    });
  };
  return { mediaKind: kindOf, mediaElement, calls, kindCalls };
}

// ── 树/DOM 工具（与 obsidian-p2a.mjs 同口径的精简副本）──────────────────────
const isElement = (n) => n !== null && typeof n === "object" && !Array.isArray(n);
function localName(node) {
  if (!isElement(node)) return "#text";
  if (typeof node.type === "string") return node.type;
  return node.type === Fragment ? "#fragment" : String(node.type);
}
function childrenOf(node) {
  if (!isElement(node)) return [];
  const c = node.props?.children;
  if (c === undefined || c === null || c === false) return [];
  return Array.isArray(c) ? c : [c];
}
function walk(node, visit) {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (typeof node !== "object") return;
  visit(node);
  for (const c of childrenOf(node)) walk(c, visit);
}
function findAll(root, pred) {
  const out = [];
  walk(root, (n) => { if (isElement(n) && pred(n)) out.push(n); });
  return out;
}
function findFirst(root, pred) {
  return findAll(root, pred)[0] ?? null;
}
function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node !== "object") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return childrenOf(node).map(textOf).join("");
}
function classList(node) {
  const cn = isElement(node) ? node.props?.className : undefined;
  return typeof cn === "string" ? cn.split(/\s+/).filter(Boolean) : [];
}
const hasClass = (node, cls) => isElement(node) && classList(node).includes(cls);
const dataOf = (node, name) => (isElement(node) ? node.props?.[name] : undefined);
function srcSpanList(root) {
  return findAll(root, (n) => isElement(n) && n.props !== undefined &&
    Object.prototype.hasOwnProperty.call(n.props, "data-obs-src"));
}
function rangeOf(node) {
  const raw = dataOf(node, "data-obs-src");
  if (typeof raw !== "string") return null;
  const m = /^(\d+),(\d+)$/.exec(raw);
  return m ? { start: Number(m[1]), end: Number(m[2]), raw } : null;
}
function sliceOf(span, md) {
  const r = rangeOf(span);
  return r === null ? null : normMd(md).slice(r.start, r.end);
}
function srcSpanTexts(node) {
  return srcSpanList(node).map((s) => textOf(s));
}
/** 块级数学块（data-block-kind=math） */
function mathBlocks(tree) {
  return findAll(tree, (n) => dataOf(n, "data-block-kind") === "math");
}
function gutterNums(block) {
  const gutter = block ? findFirst(block, (n) => hasClass(n, "dsh-obs-md-gutter")) : null;
  return gutter === null
    ? []
    : findAll(gutter, (n) => typeof dataOf(n, "data-line-no") === "string").map((n) => Number(dataOf(n, "data-line-no")));
}
function bodyOf(block) {
  return block ? findFirst(block, (n) => hasClass(n, "dsh-obs-md-block-body")) : null;
}
function topChildren(tree) {
  return childrenOf(tree);
}
/** 可见文本：剔除行号元素（ln/glno/tln），对应面板里用户能看到的文本 */
function visibleText(tree) {
  let out = "";
  (function rec(node) {
    if (node === null || node === undefined || node === false) return;
    if (typeof node !== "object") { out += String(node); return; }
    if (Array.isArray(node)) { for (const n of node) rec(n); return; }
    if (hasClass(node, "dsh-obs-md-ln") || hasClass(node, "dsh-obs-md-glno") || hasClass(node, "dsh-obs-md-tln")) return;
    for (const c of childrenOf(node)) rec(c);
  })(tree);
  return out;
}

// ── M17 安全巡检 helper（renderer 侧复核，独立于 sanitizer 自己的单测）────────
const FORBIDDEN_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "link", "meta", "base", "title",
  "form", "input", "button", "select", "textarea", "svg", "math", "template", "noscript",
  "audio", "video", "canvas", "source", "track", "img",
]);
function allElements(tree) {
  return findAll(tree, () => true);
}
function forbiddenElements(tree) {
  return allElements(tree).filter((n) => FORBIDDEN_TAGS.has(localName(n)));
}
function eventAttrProps(tree) {
  const out = [];
  for (const el of allElements(tree)) {
    for (const [k, v] of Object.entries(el.props ?? {})) {
      if (/^on[A-Z]/.test(k) && typeof v !== "function") out.push(`${localName(el)}.${k}`);
    }
  }
  return out;
}
function dangerousHtmlProps(tree) {
  return allElements(tree).filter((n) => isElement(n.props?.dangerouslySetInnerHTML));
}
function dangerousUrlProps(tree) {
  const out = [];
  for (const el of allElements(tree)) {
    for (const name of ["href", "src", "xlink:href", "action", "formaction"]) {
      const v = el.props?.[name];
      if (typeof v === "string" && /^\s*(?:javascript|data|vbscript):/i.test(v)) {
        out.push(`${localName(el)}.${name}=${v.slice(0, 40)}`);
      }
    }
  }
  return out;
}
function attrNamesOf(tree) {
  const names = new Set();
  for (const el of allElements(tree)) {
    for (const k of Object.keys(el.props ?? {})) {
      if (k === "children" || k === "key" || k === "className") continue;
      names.add(`${localName(el)}.${k}`);
    }
  }
  return [...names].sort();
}

// ── 断言框架（失败信息带 fixture id）────────────────────────────────────────
const failures = [];
let checkTotal = 0;
let checkPassed = 0;
let currentSection = "（未分组）";
function section(name) {
  currentSection = name;
  const head = `── ${name} ──`;
  console.log(`\n${head}`);
}
function check(fixtureId, label, cond, detail) {
  checkTotal += 1;
  if (cond) {
    checkPassed += 1;
    return true;
  }
  failures.push({ section: currentSection, fixtureId, label, detail });
  const d = detail === undefined || detail === null || detail === ""
    ? ""
    : `\n      实测: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`  ✗ [${fixtureId}] ${label}${d}`);
  return false;
}
const checkEq = (fixtureId, label, actual, expected) =>
  check(fixtureId, label, JSON.stringify(actual) === JSON.stringify(expected),
    `期望 ${JSON.stringify(expected)}；实测 ${JSON.stringify(actual)}`);
const j = (v) => JSON.stringify(v);

// ── 三条全量不变量（契约 §5；行号统一读 [data-line-no]）────────────────────
function checkLineInvariant(id, md, tree) {
  const n = normMd(md).split("\n").length;
  const nodes = findAll(tree, (n2) => isElement(n2) && n2.props !== undefined &&
    Object.prototype.hasOwnProperty.call(n2.props, "data-line-no"));
  const texts = nodes.map((x) => String(dataOf(x, "data-line-no")));
  check(id, `行号覆盖：${n} 行源码应有 ${n} 个 [data-line-no]`, nodes.length === n,
    `${nodes.length} 个：${j(texts.slice(0, 40))}`);
  check(id, "行号覆盖：data-line-no 是纯数字且与行号文本一致",
    nodes.length > 0 && texts.every((t, k) => /^\d+$/.test(t) && textOf(nodes[k]).trim() === t),
    nodes.slice(0, 6).map((x) => `${j(dataOf(x, "data-line-no"))}/${j(textOf(x))}`).join(", "));
  const nums = texts.map(Number);
  const expected = Array.from({ length: n }, (_, k) => k + 1);
  check(id, "行号覆盖：1..N 恰好各一次且按文档序递增",
    nums.length === expected.length && nums.every((v, k) => v === expected[k]), j(nums));
  const badShape = nodes.filter((node) => {
    if (hasClass(node, "dsh-obs-md-ln")) return localName(node) !== "span";
    if (hasClass(node, "dsh-obs-md-glno")) return localName(node) !== "span";
    if (hasClass(node, "dsh-obs-md-tln")) return !["th", "td"].includes(localName(node));
    return true;
  });
  check(id, "行号覆盖：行号节点形状合法（ln/glno 是 span，tln 是 th/td）",
    badShape.length === 0, badShape.slice(0, 3).map((x) => localName(x)).join(","));
}
function checkOffsetInvariant(id, md, tree) {
  const norm = normMd(md);
  const spans = srcSpanList(tree);
  const badHost = spans.filter((n) => localName(n) !== "span" || !hasClass(n, "dsh-obs-src"));
  check(id, "偏移记账：data-obs-src 只出现在 span.dsh-obs-src 上", badHost.length === 0,
    badHost.slice(0, 3).map((n) => localName(n)).join(" | "));
  const badKids = spans.filter((n) => childrenOf(n).some((c) => typeof c === "object"));
  check(id, "偏移记账：偏移 span 内只有文本子节点", badKids.length === 0,
    badKids.slice(0, 3).map((n) => j(textOf(n))).join(" | "));
  const mismatched = spans.filter((s) => {
    const r = rangeOf(s);
    return r === null || r.end > norm.length || norm.slice(r.start, r.end) !== textOf(s);
  });
  check(id, "偏移记账：md.slice(start,end) === span 文本", mismatched.length === 0,
    mismatched.slice(0, 3).map((s) => `${j(dataOf(s, "data-obs-src"))} 文本=${j(textOf(s))}`).join(" | "));
  const ranges = spans.map((s) => rangeOf(s)).filter(Boolean);
  const overlapAt = ranges.findIndex((r, k) => k > 0 && ranges[k - 1].end > r.start);
  check(id, "偏移记账：各偏移区间按文档序不重叠", overlapAt < 0,
    overlapAt > 0 ? `${ranges[overlapAt - 1].raw} 与 ${ranges[overlapAt].raw} 重叠` : "");
}
function checkMarkerLeak(id, md, tree) {
  const forbid = LEAK[id];
  if (!forbid || forbid.length === 0) return;
  const text = textOf(tree);
  for (const marker of forbid) {
    check(id, `标记不外漏：可见文本不含 ${j(marker)}`, !text.includes(marker),
      j(text.length > 160 ? `${text.slice(0, 160)}…` : text));
  }
}

// ── 执行：全量不变量（默认降级路径 + stub 成功路径各跑一遍）─────────────────
console.log("Obsidian P2b 面板路径断言（M16 数学 KaTeX 接线 + 降级）");
console.log(`fixtures：${FIXTURES.length} 个；markdown 源码 ${code.length} 字符`);
section("全量不变量 0：语料");
check("fixtures", "fixture id 无重复", new Set(FIXTURES.map((f) => f.id)).size === FIXTURES.length);
for (const fx of FIXTURES) {
  check(fx.id, "渲染不抛异常且返回元素树", isElement(render(fx.id)));
}
section("全量不变量 1：行号覆盖（默认降级路径）");
for (const fx of FIXTURES) checkLineInvariant(fx.id, fx.md, render(fx.id));
section("全量不变量 2：偏移记账（默认降级路径）");
for (const fx of FIXTURES) checkOffsetInvariant(fx.id, fx.md, render(fx.id));
section("全量不变量 3：标记外漏（默认降级路径）");
for (const fx of FIXTURES) checkMarkerLeak(fx.id, fx.md, render(fx.id));
section("全量不变量 1b/2b：stub 成功路径（行号覆盖 + 偏移记账）");
for (const fx of FIXTURES) {
  const stub = makeMathStub({ failWhen: FAIL_INVALID });
  const tree = render(fx.id, { mathElement: stub });
  checkLineInvariant(fx.id, fx.md, tree);
  checkOffsetInvariant(fx.id, fx.md, tree);
}

// ══════════════════════════════════════════════════════════════════════════
// A. 行内 `$…$` 降级（无 mathElement / 返回 null）
// ══════════════════════════════════════════════════════════════════════════
section("M16-A 行内数学降级（math-inline）");
{
  const id = "math-inline";
  const md = FIXTURES_BY_ID[id].md;
  const tree = render(id);
  const math = findAll(tree, (n) => hasClass(n, "dsh-obs-md-math-inline"));
  checkEq(id, "结构：1 个 span.dsh-obs-md-math-inline", math.length, 1);
  const spans = math.length > 0 ? srcSpanList(math[0]) : [];
  checkEq(id, "偏移：内部 1 个 src span，映射去定界符公式内容", spans.map((s) => textOf(s)), ["a^2+b^2=c^2"]);
  check(id, "偏移：span 切片 === 公式内容", spans.length === 1 && sliceOf(spans[0], md) === "a^2+b^2=c^2",
    spans.length === 1 ? j(sliceOf(spans[0], md)) : "缺 span");
  check(id, "文本：前后文本完整且无 $ 定界符", textOf(tree).includes("勾股") && textOf(tree).includes("结束") && !textOf(tree).includes("$"),
    j(textOf(tree)));
}
section("M16-A2 行内数学成功（stub mathElement）");
{
  const id = "math-inline";
  const stub = makeMathStub();
  const tree = render(id, { mathElement: stub });
  const math = findAll(tree, (n) => hasClass(n, "dsh-obs-md-math-inline"));
  checkEq(id, "结构：1 个 math-inline 节点（client 产物）", math.length, 1);
  checkEq(id, "入参：tex=去定界符内容、displayMode=false、key 为字符串",
    stub.calls.map((c) => [c.tex, c.displayMode, typeof c.key]), [["a^2+b^2=c^2", false, "string"]]);
  check(id, "契约：成功产物不带 data-obs-src", math.length === 1 && srcSpanList(math[0]).length === 0,
    math.length === 1 ? j(srcSpanList(math[0]).length) : "缺节点");
  check(id, "文本：无 $ 定界符", !textOf(tree).includes("$"), j(textOf(tree)));
}

// ══════════════════════════════════════════════════════════════════════════
// B. `\$` 转义与金额/空白边界
// ══════════════════════════════════════════════════════════════════════════
section("M16-B \\$ 转义（math-escape）");
{
  const id = "math-escape";
  const md = FIXTURES_BY_ID[id].md;
  const tree = render(id);
  const text = textOf(tree);
  check(id, "文本：\\$5 显示为可见 $5", text.includes("$5"), j(text));
  const math = findAll(tree, (n) => hasClass(n, "dsh-obs-md-math-inline"));
  checkEq(id, "结构：仅 $x$ 成数学（1 个 math-inline）", math.length, 1);
  const spans = math.length > 0 ? srcSpanList(math[0]) : [];
  checkEq(id, "偏移：降级 span 映射 x（不含 $）", spans.map((s) => textOf(s)), ["x"]);
  check(id, "文本：可见 $ 恰好 1 个（转义来的）", (text.match(/\$/g) ?? []).length === 1, j(text));
  const stub = makeMathStub();
  render(id, { mathElement: stub });
  checkEq(id, "成功路径入参：tex=x", stub.calls.map((c) => c.tex), ["x"]);
}
section("M16-C 货币/空格边界（math-currency / math-space）");
{
  const id = "math-currency";
  const tree = render(id);
  const text = textOf(tree);
  check(id, "文本：$5 / $10 保留为普通文本", text.includes("$5") && text.includes("$10"), j(text));
  checkEq(id, "结构：只有 $x$ 成数学", findAll(tree, (n) => hasClass(n, "dsh-obs-md-math-inline")).length, 1);
  const stub = makeMathStub();
  render(id, { mathElement: stub });
  checkEq(id, "成功路径入参：tex=x（货币不误判）", stub.calls.map((c) => c.tex), ["x"]);
}
{
  const id = "math-space";
  const tree = render(id);
  checkEq(id, "结构：开/闭定界紧邻空白的写法不解析，仅尾 $x$ 成数学",
    findAll(tree, (n) => hasClass(n, "dsh-obs-md-math-inline")).length, 1);
  const stub = makeMathStub();
  render(id, { mathElement: stub });
  checkEq(id, "成功路径入参：tex=x", stub.calls.map((c) => c.tex), ["x"]);
}
section("M16-D 非法公式降级（math-error）");
{
  const id = "math-error";
  const md = FIXTURES_BY_ID[id].md;
  const stub = makeMathStub({ failWhen: FAIL_INVALID });
  const tree = render(id, { mathElement: stub });
  const math = findAll(tree, (n) => hasClass(n, "dsh-obs-md-math-inline"));
  checkEq(id, "结构：stub 返回 null → 降级为 math-inline 占位", math.length, 1);
  const spans = math.length > 0 ? srcSpanList(math[0]) : [];
  checkEq(id, "偏移：降级 span 带精确 src span（公式内容）", spans.map((s) => textOf(s)), ["\\frac{a}{"]);
  check(id, "偏移：切片 === 公式内容", spans.length === 1 && sliceOf(spans[0], md) === "\\frac{a}{",
    spans.length === 1 ? j(sliceOf(spans[0], md)) : "缺 span");
  check(id, "文本：前后文本完整且无 $ 外漏",
    textOf(tree).includes("非法公式") && textOf(tree).includes("结束") && !textOf(tree).includes("$"), j(textOf(tree)));
}

// ══════════════════════════════════════════════════════════════════════════
// C. 混排与单行 display
// ══════════════════════════════════════════════════════════════════════════
section("M16-E 与强调/代码混排（math-mixed-text）");
{
  const id = "math-mixed-text";
  const tree = render(id);
  check(id, "结构：强调/代码/数学共存",
    findFirst(tree, (n) => localName(n) === "strong") !== null &&
    findAll(tree, (n) => hasClass(n, "dsh-obs-md-math-inline")).length === 1);
  check(id, "文本：非数学部分完整且无 $ 外漏",
    ["文本", "粗", "中间", "code", "结束"].every((s) => textOf(tree).includes(s)) && !textOf(tree).includes("$"),
    j(textOf(tree)));
}
section("M16-F 单行 `$$…$$`（math-inline-dollars）");
{
  const id = "math-inline-dollars";
  const tree = render(id);
  const math = findAll(tree, (n) => hasClass(n, "dsh-obs-md-math-inline"));
  checkEq(id, "结构：1 个行内数学节点", math.length, 1);
  checkEq(id, "偏移：降级内容 a+b（无 $$）", math.length > 0 ? srcSpanTexts(math[0]) : [], ["a+b"]);
  const stub = makeMathStub();
  render(id, { mathElement: stub });
  checkEq(id, "成功路径：displayMode=true、tex=a+b",
    stub.calls.map((c) => [c.tex, c.displayMode]), [["a+b", true]]);
}

// ══════════════════════════════════════════════════════════════════════════
// D. 块级 `$$…$$`：D2 块 + gutter 行号 + body
// ══════════════════════════════════════════════════════════════════════════
section("M16-G 块级数学结构（math-block 降级）");
{
  const id = "math-block";
  const md = FIXTURES_BY_ID[id].md;
  const tree = render(id);
  const blocks = mathBlocks(tree);
  checkEq(id, "结构：1 个 data-block-kind=math 块", blocks.length, 1);
  check(id, "结构：块是 div.dsh-obs-md-block 且带 data-block-group",
    blocks.length === 1 && localName(blocks[0]) === "div" && hasClass(blocks[0], "dsh-obs-md-block") &&
    typeof dataOf(blocks[0], "data-block-group") === "string");
  checkEq(id, "行号：gutter 覆盖 3 行源码 [1,2,3]", gutterNums(blocks[0]), [1, 2, 3]);
  const body = bodyOf(blocks[0]);
  check(id, "结构：块有 block-body", body !== null);
  check(id, "契约：body 内不出现行号元素",
    body !== null && findAll(body, (n) => typeof dataOf(n, "data-line-no") === "string").length === 0);
  checkEq(id, "偏移：body 逐行源码带精确 src span", body ? srcSpanTexts(body) : [], ["E = mc^2"]);
  const spans = body ? srcSpanList(body) : [];
  check(id, "偏移：切片 === 公式行源码", spans.length === 1 && sliceOf(spans[0], md) === "E = mc^2",
    spans.length === 1 ? j(sliceOf(spans[0], md)) : "缺 span");
  check(id, "文本：$$ 定界符不外漏", !textOf(tree).includes("$$"), j(textOf(tree)));
}
section("M16-H 块级数学成功（stub mathElement）");
{
  const id = "math-block";
  const stub = makeMathStub();
  const tree = render(id, { mathElement: stub });
  const blocks = mathBlocks(tree);
  checkEq(id, "结构：仍 1 个 math 块", blocks.length, 1);
  checkEq(id, "入参：tex=开闭行之间内容、displayMode=true、key 为字符串",
    stub.calls.map((c) => [c.tex, c.displayMode, typeof c.key]), [["E = mc^2", true, "string"]]);
  const body = bodyOf(blocks[0]);
  check(id, "契约：成功时 body 用 client 产物、不产降级 src span",
    body !== null && srcSpanList(body).length === 0 &&
    findFirst(body, (n) => hasClass(n, "dsh-obs-md-math-block")) !== null);
  checkEq(id, "行号：成功路径 gutter 仍覆盖 [1,2,3]", gutterNums(blocks[0]), [1, 2, 3]);
}
section("M16-I 多行 aligned（math-multiline）");
{
  const id = "math-multiline";
  const tree = render(id);
  const blocks = mathBlocks(tree);
  checkEq(id, "结构：1 个 math 块、gutter 覆盖 [1..6]", [blocks.length, gutterNums(blocks[0])], [1, [1, 2, 3, 4, 5, 6]]);
  const body = bodyOf(blocks[0]);
  checkEq(id, "偏移：降级 body 逐行内容（不含 $$）",
    body ? srcSpanTexts(body) : [], ["\\begin{aligned}", "a &= b + c \\\\", "d &= e", "\\end{aligned}"]);
  const stub = makeMathStub();
  render(id, { mathElement: stub });
  checkEq(id, "成功路径：tex 为内容行按 \\n 连接",
    stub.calls.map((c) => c.tex),
    [["\\begin{aligned}", "a &= b + c \\\\", "d &= e", "\\end{aligned}"].join("\n")]);
}
section("M16-J 单行块 / 未闭合 / 与普通行顺序");
{
  const id = "math-block-trailing";
  const tree = render(id);
  checkEq(id, "防吞行：同行还有 `$$` 但行尾不是闭定界 → 不产 math 块", mathBlocks(tree).length, 0);
  check(id, "防吞行：后续行照常渲染（不吞 后面/后）",
    textOf(tree).includes("后面") && textOf(tree).includes("后"), j(textOf(tree)));
  check(id, "防吞行：行内 scanner 仍把 $$a$$ 当 display 数学（定界符不外漏）",
    findAll(tree, (n) => hasClass(n, "dsh-obs-md-math-inline")).length === 1 && !textOf(tree).includes("$$"),
    j(textOf(tree)));
}
{
  const id = "math-block-close-indent";
  const tree = render(id);
  const blocks = mathBlocks(tree);
  checkEq(id, "带缩进的闭定界行：gutter 覆盖 [1,2,3]", gutterNums(blocks[0]), [1, 2, 3]);
  checkEq(id, "带缩进的闭定界行：降级内容只有 E（闭行缩进空白不产内容行）",
    bodyOf(blocks[0]) ? srcSpanTexts(bodyOf(blocks[0])) : [], ["E"]);
}
{
  const id = "math-block-single";
  const tree = render(id);
  const blocks = mathBlocks(tree);
  checkEq(id, "单行块：gutter 覆盖 1 行", gutterNums(blocks[0]), [1]);
  checkEq(id, "单行块：降级内容 E=mc^2", bodyOf(blocks[0]) ? srcSpanTexts(bodyOf(blocks[0])) : [], ["E=mc^2"]);
  const stub = makeMathStub();
  render(id, { mathElement: stub });
  checkEq(id, "单行块：tex=E=mc^2", stub.calls.map((c) => [c.tex, c.displayMode]), [["E=mc^2", true]]);
}
{
  const id = "math-block-unclosed";
  const tree = render(id);
  const blocks = mathBlocks(tree);
  checkEq(id, "未闭合：gutter 覆盖 [1,2]", gutterNums(blocks[0]), [1, 2]);
  checkEq(id, "未闭合：降级内容 a = b", bodyOf(blocks[0]) ? srcSpanTexts(bodyOf(blocks[0])) : [], ["a = b"]);
  check(id, "未闭合：$$ 不外漏", !textOf(tree).includes("$$"), j(textOf(tree)));
}
{
  const id = "math-block-mixed";
  const tree = render(id);
  const blocks = mathBlocks(tree);
  checkEq(id, "混排：1 个 math 块、gutter 覆盖 [3,4,5]", [blocks.length, gutterNums(blocks[0])], [1, [3, 4, 5]]);
  const top = topChildren(tree);
  const blockAt = top.indexOf(blocks[0]);
  check(id, "混排：块在文档序中间（前面有第 1/2 行，后面还有行）",
    blockAt > 0 && blockAt < top.length - 1, `blockAt=${blockAt}/${top.length}`);
  check(id, "混排：前后普通文本完整", textOf(tree).includes("前") && textOf(tree).includes("后"), j(textOf(tree)));
}

// ══════════════════════════════════════════════════════════════════════════
// E. 防御与优先级
// ══════════════════════════════════════════════════════════════════════════
section("M16-K mathElement 抛错 → 降级（不冒泡）");
{
  const id = "math-inline";
  const stub = makeMathStub({ mode: "throw" });
  const tree = render(id, { mathElement: stub });
  const math = findAll(tree, (n) => hasClass(n, "dsh-obs-md-math-inline"));
  checkEq(id, "结构：抛错后仍走降级占位", math.length, 1);
  checkEq(id, "偏移：降级 span 映射公式内容", math.length > 0 ? srcSpanTexts(math[0]) : [], ["a^2+b^2=c^2"]);
}
section("M16-L 围栏内 $$ 不解析（优先级回归，math-fence-priority）");
{
  const id = "math-fence-priority";
  const tree = render(id);
  checkEq(id, "结构：代码围栏内不产 math 块", mathBlocks(tree).length, 0);
  const codeRows = findAll(tree, (n) => hasClass(n, "dsh-obs-md-code"));
  checkEq(id, "结构：5 行代码块（开围栏 + 3 内容行 + 闭围栏，含 $$ 内容行）", codeRows.length, 5);
  check(id, "文本：围栏内 $$ 按代码原文显示（合法，不算标记外漏）", textOf(tree).includes("$$"), j(textOf(tree)));
}

// ══════════════════════════════════════════════════════════════════════════
// F. M17 行内 HTML（sanitizer 集成）
// ══════════════════════════════════════════════════════════════════════════
section("M17-A 白名单行内元素 + textHandler 偏移（html-basic）");
{
  const id = "html-basic";
  const md = FIXTURES_BY_ID[id].md;
  const tree = render(id);
  check(id, "结构：b/kbd/sup/abbr 白名单元素重建",
    ["b", "kbd", "sup", "abbr"].every((t) => findFirst(tree, (n) => localName(n) === t) !== null),
    JSON.stringify(allElements(tree).map(localName)));
  checkEq(id, "结构：abbr title 保留", findFirst(tree, (n) => localName(n) === "abbr")?.props?.title, "超文本");
  checkEq(id, "文本：可见文本完整（标签原文不外漏）", visibleText(tree), "粗 Ctrl 上标 HTML 结束");
  const spans = srcSpanList(tree);
  check(id, "偏移：每个可见文本段都是精确 src span",
    spans.length > 0 && spans.every((s) => sliceOf(s, md) === textOf(s)),
    spans.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
  check(id, "偏移：'粗' 映射 <b> 之后的内容区间",
    spans.some((s) => textOf(s) === "粗" && sliceOf(s, md) === "粗"));
  check(id, "安全：无禁止元素/事件属性/dangerouslySetInnerHTML",
    forbiddenElements(tree).length === 0 && eventAttrProps(tree).length === 0 && dangerousHtmlProps(tree).length === 0,
    JSON.stringify([forbiddenElements(tree).map(localName), eventAttrProps(tree)]));
}
section("M17-B 实体解码文本不产 span（html-entity-text）+ 表格单元格内 HTML 偏移（html-table-cell）");
{
  const id = "html-entity-text";
  const tree = render(id);
  check(id, "结构：b 元素且可见文本为解码后的 a&b",
    findFirst(tree, (n) => localName(n) === "b") !== null && visibleText(tree) === "a&b", j(visibleText(tree)));
  check(id, "契约：实体解码文本（原文 != 可见文本）不产 data-obs-src",
    !srcSpanList(tree).some((s) => textOf(s) === "a&b"));
}
{
  const id = "html-table-cell";
  const md = FIXTURES_BY_ID[id].md;
  const tree = render(id);
  const b = findFirst(tree, (n) => localName(n) === "b");
  check(id, "结构：表格单元格内 b 元素渲染", b !== null, JSON.stringify(allElements(tree).map(localName)));
  const spans = b ? srcSpanList(b) : [];
  checkEq(id, "偏移：单元格内可见文本映射源码", spans.map((s) => textOf(s)), ["粗"]);
  check(id, "偏移：单元格内 span 切片精确（单元格起点算对）",
    spans.length === 1 && sliceOf(spans[0], md) === "粗",
    spans.length === 1 ? j(sliceOf(spans[0], md)) : "缺 span");
}
section("M17-C 未知标签展开文本（html-details / html-unknown-inline）");
{
  const id = "html-details";
  const tree = render(id);
  check(id, "契约：未知标签不注入元素（无 details/summary 元素）",
    findFirst(tree, (n) => ["details", "summary"].includes(localName(n))) === null,
    JSON.stringify(allElements(tree).map(localName)));
  check(id, "文本：未知标签内容展开为可见文本",
    textOf(tree).includes("展开标题") && textOf(tree).includes("隐藏内容"), j(textOf(tree)));
}
{
  const id = "html-unknown-inline";
  const tree = render(id);
  check(id, "契约：未知标签 <u2> 不产元素", findFirst(tree, (n) => localName(n) === "u2") === null);
  check(id, "文本：内容可见且标签字面量不外漏",
    textOf(tree).includes("未知") && textOf(tree).includes("尾") && !textOf(tree).includes("<u2>"), j(textOf(tree)));
}
section("M17-D XSS 语料（script/img-onerror/js-url/svg/style/iframe/dom-clobber/entity）");
{
  const cases = [
    "html-xss-script", "html-xss-img-onerror", "html-xss-js-url", "html-xss-svg",
    "html-xss-style", "html-xss-iframe", "html-xss-dom-clobber", "html-xss-entity",
    "html-xss-nested-script",
  ];
  for (const id of cases) {
    const tree = render(id);
    const bad = forbiddenElements(tree).map(localName);
    checkEq(id, "安全：无禁止元素", bad, []);
    checkEq(id, "安全：无 on* 字符串属性", eventAttrProps(tree), []);
    checkEq(id, "安全：无 javascript:/data: URL 属性", dangerousUrlProps(tree), []);
    checkEq(id, "安全：无 dangerouslySetInnerHTML", dangerousHtmlProps(tree).length, 0);
    check(id, "文本：后续文本完整（结束）", textOf(tree).includes("结束"), j(textOf(tree)));
  }
  const scriptTree = render("html-xss-script");
  check("html-xss-script", "契约：脚本内容整段丢弃（不回退原文）", !textOf(scriptTree).includes("alert"), j(textOf(scriptTree)));
  check("html-xss-style", "结构：style 丢弃但后续 <b>粗</b> 仍渲染",
    findFirst(render("html-xss-style"), (n) => localName(n) === "b") !== null);
  check("html-xss-js-url", "文本：链接文字可见（点我），不产带 javascript: 的链接元素",
    textOf(render("html-xss-js-url")).includes("点我"));
  check("html-xss-nested-script", "契约：白名单元素内嵌 script 仍整段丢弃（<b> 保留、script 无元素/无文本残留）",
    findFirst(render("html-xss-nested-script"), (n) => localName(n) === "b") !== null
      && !textOf(render("html-xss-nested-script")).includes("alert"));
  check("html-xss-entity", "文本：实体保持原文文本（不产 script 元素）",
    textOf(render("html-xss-entity")).includes("&lt;script&gt;"), j(textOf(render("html-xss-entity"))));
}
section("M17-E 属性清洗（html-attr-strip）");
{
  const id = "html-attr-strip";
  const tree = render(id);
  const b = findFirst(tree, (n) => localName(n) === "b");
  check(id, "结构：b 元素保留", b !== null);
  checkEq(id, "属性：只保留 title", b && b.props?.title, "T");
  check(id, "属性：onclick/class/style 一律丢弃",
    b !== null && b.props?.onclick === undefined && b.props?.class === undefined && b.props?.style === undefined,
    b ? j(Object.keys(b.props ?? {})) : "缺元素");
  checkEq(id, "文本：粗可见", visibleText(tree), "粗");
}
section("M17-F null / sanitize 缺失 → 原文降级（typeof 守卫）");
{
  const id = "html-basic";
  const tree = renderWithoutSanitizer(id);
  check(id, "降级：未拼 sanitize 时原文显示（<b> 不外漏成元素）",
    textOf(tree).includes("<b>粗</b>") && findFirst(tree, (n) => localName(n) === "b") === null,
    j(textOf(tree)));
  const spans = srcSpanList(tree);
  check(id, "降级：原文也带精确 src span（偏移不变量不破）",
    spans.length > 0 && spans.every((s) => sliceOf(s, FIXTURES_BY_ID[id].md) === textOf(s)));
  const noParser = render(id, { DOMParser: null });
  check(id, "降级：DOMParser 缺失 → sanitizer 返回 null → 原文",
    textOf(noParser).includes("<b>粗</b>") && findFirst(noParser, (n) => localName(n) === "b") === null,
    j(textOf(noParser)));
}
section("M17-G 单 token 50KB 上限 / 多行 block HTML 原文降级");
{
  const id = "html-long-token";
  const tree = render(id);
  check(id, "契约：超 50KB 的行内元素不 token（不产 b 元素）", findFirst(tree, (n) => localName(n) === "b") === null);
  check(id, "文本：降级为原文（<b> 字面量可见）", textOf(tree).includes("<b>"), j(textOf(tree).slice(0, 80)));
}
{
  const id = "html-block-multiline";
  const tree = render(id);
  check(id, "契约：多行 block HTML v1 不渲染（无 details/summary 元素）",
    findFirst(tree, (n) => ["details", "summary"].includes(localName(n))) === null,
    JSON.stringify(allElements(tree).map(localName)));
  check(id, "文本：块级开/闭标签原文降级（<details> 可见）",
    visibleText(tree).includes("<details>") && visibleText(tree).includes("</details>"), j(visibleText(tree)));
  check(id, "文本：行内可配对的 <summary>展开</summary> 仍展开文本（标签隐藏、内容可见）", visibleText(tree).includes("展开") && !visibleText(tree).includes("<summary>"));
}
{
  const id = "html-unclosed-tag";
  const tree = render(id);
  check(id, "契约：未闭合开标签不 token（不产 b 元素）", findFirst(tree, (n) => localName(n) === "b") === null);
  check(id, "文本：未闭合标签原文与后续文本都可见",
    textOf(tree).includes("<b>") && textOf(tree).includes("未闭合"), j(textOf(tree)));
}
section("M17-H 全部 HTML fixture 安全巡检（禁止元素/事件属性/危险 URL/dangerously）");
{
  const htmlFixtures = FIXTURES.filter((fx) => fx.id.startsWith("html-"));
  for (const fx of htmlFixtures) {
    const tree = render(fx.id);
    checkEq(fx.id, "安全巡检：无禁止元素", forbiddenElements(tree).map(localName), []);
    checkEq(fx.id, "安全巡检：无 on* 字符串属性", eventAttrProps(tree), []);
    checkEq(fx.id, "安全巡检：无危险 URL 属性", dangerousUrlProps(tree), []);
    checkEq(fx.id, "安全巡检：无 dangerouslySetInnerHTML", dangerousHtmlProps(tree).length, 0);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// G. M18 transclusion（D2 embed 块 + lineNumbers:false）
// ══════════════════════════════════════════════════════════════════════════
section("M18-A 整行 transclusion（embed-note / embed-heading / embed-block）");
{
  const cases = [
    { id: "embed-note", anchor: "" },
    { id: "embed-heading", anchor: "标题" },
    { id: "embed-block", anchor: "^blockid" },
  ];
  for (const c of cases) {
    const stub = makeEmbedStub();
    const tree = render(c.id, { embedElement: stub });
    const blocks = findAll(tree, (n) => dataOf(n, "data-block-kind") === "embed");
    checkEq(c.id, "结构：1 个 data-block-kind=embed 块", blocks.length, 1);
    checkEq(c.id, "行号：gutter 只有该源码行 1 个 glno", gutterNums(blocks[0]), [1]);
    const body = bodyOf(blocks[0]);
    check(c.id, "结构：块有 block-body 且 body 内无行号",
      body !== null && findAll(body, (n) => typeof dataOf(n, "data-line-no") === "string").length === 0);
    checkEq(c.id, "契约：body 不产外层 data-obs-src",
      body ? findAll(body, (n) => typeof n.props?.["data-obs-src"] === "string").length : -1, 0);
    checkEq(c.id, "调用：embedElement(target, anchor, key) 参数",
      stub.calls.map((x) => [x.target, x.anchor, typeof x.key]), [["笔记A", c.anchor, "string"]]);
    check(c.id, "文本：嵌入内容可见（不再显示 ![[…]] 原文）",
      textOf(tree).includes("内嵌正文内容"), j(textOf(tree)));
    check(c.id, "契约：嵌入内容不吃外层行号（整树只有 1 个行号）",
      findAll(tree, (n) => typeof dataOf(n, "data-line-no") === "string").length === 1);
  }
}
section("M18-B 行内 / 别名 / 图片 / 媒体不转块（分派边界）");
{
  const stub = makeEmbedStub();
  const inlineTree = render("embed-inline", { embedElement: stub });
  checkEq("embed-inline", "结构：行内 embed 不产 D2 块",
    findAll(inlineTree, (n) => dataOf(n, "data-block-kind") === "embed").length, 0);
  checkEq("embed-inline", "调用：不触发 transclusion", stub.calls.length, 0);
  check("embed-inline", "文本：保持 P2a 双链按钮显示",
    findFirst(inlineTree, (n) => hasClass(n, "dsh-obs-wikilink")) !== null && textOf(inlineTree).includes("笔记A"),
    j(textOf(inlineTree)));
  const aliasTree = render("embed-alias", { embedElement: stub });
  checkEq("embed-alias", "结构：带 |别名 的 embed 不转块",
    findAll(aliasTree, (n) => dataOf(n, "data-block-kind") === "embed").length, 0);
  checkEq("embed-alias", "调用：不触发 transclusion", stub.calls.length, 0);
  check("embed-alias", "文本：显示别名", textOf(aliasTree).includes("别名"), j(textOf(aliasTree)));
}
{
  const media = makeMediaStub();
  const imgTree = render("embed-image-line", { mediaKind: media.mediaKind, mediaElement: media.mediaElement });
  check("embed-image-line", "结构：图片整行仍走行内 img（不产块/媒体元素）",
    findFirst(imgTree, (n) => localName(n) === "img" && hasClass(n, "dsh-obs-md-img")) !== null
      && findAll(imgTree, (n) => dataOf(n, "data-block-kind") !== undefined).length === 0);
  checkEq("embed-image-line", "分派：图片扩展名不调用 mediaKind", media.kindCalls, []);
}
section("M18-C 无 handler → 降级卡（Node/verifier 路径）+ 异常防御");
{
  const tree = render("embed-note");
  const blocks = findAll(tree, (n) => dataOf(n, "data-block-kind") === "embed");
  checkEq("embed-note", "结构：无 handler 仍产 D2 embed 块（行号覆盖不丢）", blocks.length, 1);
  checkEq("embed-note", "行号：gutter [1]", gutterNums(blocks[0]), [1]);
  check("embed-note", "结构：降级卡 dsh-obs-md-embed-error 且可见目标名",
    findFirst(blocks[0], (n) => hasClass(n, "dsh-obs-md-embed-error")) !== null && textOf(blocks[0]).includes("笔记A"),
    j(textOf(blocks[0])));
  check("embed-media-missing", "文本：缺失媒体目标名可见（降级卡）", textOf(render("embed-media-missing")).includes("不存在.mp3"));
  check("embed-media-escape", "安全：路径逃逸不产带 .. 的 src 属性",
    findAll(render("embed-media-escape"), (n) => typeof n.props?.src === "string" && n.props.src.includes("..")).length === 0);
  const thumb = render("embed-note", { embedElement: () => { throw new Error("boom"); } });
  check("embed-note", "防御：embedElement 抛错不冒泡、降级为错误卡",
    findAll(thumb, (n) => dataOf(n, "data-block-kind") === "embed").length === 1
      && findFirst(thumb, (n) => hasClass(n, "dsh-obs-md-embed-error")) !== null);
}
section("M18-D 嵌套/循环/深度（lineNumbers:false 递归，契约 §14 深度语义）");
{
  const stub = makeEmbedStub();
  const tree = render("embed-depth", { embedElement: stub });
  checkEq("embed-depth", "结构：仅外层 1 个 D2 embed 块（嵌套不包 D2）",
    findAll(tree, (n) => dataOf(n, "data-block-kind") === "embed").length, 1);
  checkEq("embed-depth", "深度：调用深度 [0,1,2]（root 不计，A=1/B=2 渲染，第 3 层截断）",
    stub.calls.map((c) => c.depth), [0, 1, 2]);
  check("embed-depth", "文本：第 3 层显示 embedDepth、不展示最深内容",
    textOf(tree).includes("embedDepth") && !textOf(tree).includes("最深内容"), j(textOf(tree)));
  const cycleStub = makeEmbedStub();
  const cycleTree = render("embed-cycle", { embedElement: cycleStub });
  check("embed-cycle", "循环：有限展开并显示 embedCycle（不死循环）",
    textOf(cycleTree).includes("embedCycle") && cycleStub.calls.length === 3, j(cycleStub.calls.map((c) => c.target)));
  checkEq("embed-cycle", "循环：仍只有 1 个外层 D2 embed 块",
    findAll(cycleTree, (n) => dataOf(n, "data-block-kind") === "embed").length, 1);
  check("embed-cycle", "契约：嵌套内容不产外层行号/span",
    findAll(cycleTree, (n) => typeof dataOf(n, "data-line-no") === "string").length === 1
      && findAll(cycleTree, (n) => typeof n.props?.["data-obs-src"] === "string").length === 0);
}
{
  const stub = makeEmbedStub();
  const tree = renderNumbered("![[相对笔记]]", { ...HANDLERS, embedElement: stub });
  check("embed-relative-image", "结构：嵌入内相对图片仍渲染 img（路径交给 client assetUrl）",
    findFirst(tree, (n) => localName(n) === "img" && hasClass(n, "dsh-obs-md-img")) !== null,
    JSON.stringify(allElements(tree).map(localName)));
  check("embed-relative-image", "文本：嵌入内容可见", textOf(tree).includes("相对图片"), j(textOf(tree)));
}
section("M18-E `lineNumbers:false` 语义（无行号 / 无 src span / 无 D2 块）");
{
  const md = [
    "# 标题",
    "",
    "文本 **粗** 与 `code` 与 [[笔记A]]",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "$$x$$",
    "",
    "![[笔记A]]",
  ].join("\n");
  const stub = makeEmbedStub();
  const tree = renderNumbered(md, { ...HANDLERS, embedElement: stub }, { lineNumbers: false });
  checkEq("lineNumbers:false", "契约：不产任何 [data-line-no]",
    findAll(tree, (n) => typeof dataOf(n, "data-line-no") === "string").length, 0);
  checkEq("lineNumbers:false", "契约：即使传了 onText 也不产 data-obs-src",
    findAll(tree, (n) => typeof n.props?.["data-obs-src"] === "string").length, 0);
  checkEq("lineNumbers:false", "契约：不产 D2 块（嵌套嵌入/数学直接展开）",
    findAll(tree, (n) => dataOf(n, "data-block-kind") !== undefined).length, 0);
  check("lineNumbers:false", "结构：普通行仍在（只是没有行号列）",
    findAll(tree, (n) => hasClass(n, "dsh-obs-md-row")).length > 0);
  check("lineNumbers:false", "结构：表格不产 tln 且内容完整",
    findAll(tree, (n) => hasClass(n, "dsh-obs-md-tln")).length === 0 && textOf(tree).includes("1")
      && textOf(tree).includes("2"));
  check("lineNumbers:false", "文本：标题/强调/双链/公式降级/嵌入内容都可见",
    ["标题", "粗", "笔记A", "内嵌正文内容"].every((x) => textOf(tree).includes(x)), j(textOf(tree)));
  check("lineNumbers:false", "结构：嵌套 embed 展开在 dsh-obs-md-embed-nested（不包 D2）",
    findFirst(tree, (n) => hasClass(n, "dsh-obs-md-embed-nested")) !== null);
}

// ══════════════════════════════════════════════════════════════════════════
// H. M19 媒体分派（mediaKind/mediaElement；行内与整行两种）
// ══════════════════════════════════════════════════════════════════════════
section("M19-A 整行媒体（audio/video/pdf）+ 行号行保留");
{
  const media = makeMediaStub();
  const tree = render("embed-media-line", { mediaKind: media.mediaKind, mediaElement: media.mediaElement });
  const audio = findFirst(tree, (n) => localName(n) === "audio" && hasClass(n, "dsh-obs-md-audio"));
  check("embed-media-line", "结构：audio.dsh-obs-md-audio[controls]", audio !== null && audio.props?.controls === true);
  checkEq("embed-media-line", "调用：mediaElement(rel, key) 一次", media.calls.map((c) => c.rel), ["录音.mp3"]);
  checkEq("embed-media-line", "行号：普通行保留 1 个 data-line-no",
    findAll(tree, (n) => typeof dataOf(n, "data-line-no") === "string").length, 1);
  check("embed-media-line", "契约：媒体控件不产 src span", audio !== null && srcSpanList(audio).length === 0);
  checkEq("embed-media-line", "分派：媒体不触发 transclusion",
    findAll(tree, (n) => dataOf(n, "data-block-kind") !== undefined).length, 0);
}
{
  const media = makeMediaStub();
  const videoTree = renderNumbered("![[视频.mp4]]", { ...HANDLERS, mediaKind: media.mediaKind, mediaElement: media.mediaElement });
  check("embed-media-video", "结构：video.dsh-obs-md-video[controls]",
    findFirst(videoTree, (n) => localName(n) === "video" && hasClass(n, "dsh-obs-md-video")) !== null);
  const pdfTree = renderNumbered("![[文档.pdf]]", { ...HANDLERS, mediaKind: media.mediaKind, mediaElement: media.mediaElement });
  check("embed-media-pdf", "结构：pdf iframe.dsh-obs-md-pdf",
    findFirst(pdfTree, (n) => localName(n) === "iframe" && hasClass(n, "dsh-obs-md-pdf")) !== null);
  check("embed-media-pdf", "契约：PDF/视频控件不带 data-obs-src",
    findAll(pdfTree, (n) => typeof n.props?.["data-obs-src"] === "string").length === 0
      && findAll(videoTree, (n) => typeof n.props?.["data-obs-src"] === "string").length === 0);
}
section("M19-B 行内媒体（前后有文字）");
{
  const media = makeMediaStub();
  const tree = render("embed-media-inline", { mediaKind: media.mediaKind, mediaElement: media.mediaElement });
  check("embed-media-inline", "结构：行内 audio 控件出现在普通行",
    findFirst(tree, (n) => localName(n) === "audio" && hasClass(n, "dsh-obs-md-audio")) !== null);
  check("embed-media-inline", "文本：前后文字完整",
    textOf(tree).includes("前") && textOf(tree).includes("后"), j(textOf(tree)));
  checkEq("embed-media-inline", "分派：行内媒体不转块",
    findAll(tree, (n) => dataOf(n, "data-block-kind") !== undefined).length, 0);
}
section("M19-B2 表格单元格内媒体分派（不产 D2 块）");
{
  const media = makeMediaStub();
  const md = "| 列 |\n| --- |\n| ![[录音.mp3]] |";
  const tree = renderNumbered(md, { ...HANDLERS, mediaKind: media.mediaKind, mediaElement: media.mediaElement });
  check("table-media", "结构：表格单元格内渲染 audio 控件（不转 D2 块）",
    findFirst(tree, (n) => localName(n) === "audio" && hasClass(n, "dsh-obs-md-audio")) !== null
      && findAll(tree, (n) => dataOf(n, "data-block-kind") !== undefined).length === 0,
    JSON.stringify(allElements(tree).map(localName)));
  checkEq("table-media", "行号：表格行号仍是 3 个（表头/分隔/正文）",
    findAll(tree, (n) => typeof dataOf(n, "data-line-no") === "string").length, 3);
  const audio = findFirst(tree, (n) => localName(n) === "audio");
  check("table-media", "契约：单元格内媒体控件自身不产 src span（控件是生成内容）",
    audio !== null && srcSpanList(audio).length === 0);
}
section("M19-C 媒体 handler 缺失 → 回退（不丢内容）");
{
  const tree = render("embed-media-line");
  check("embed-media-line", "结构：无 mediaKind handler 时不产 audio 元素",
    findFirst(tree, (n) => localName(n) === "audio") === null);
  check("embed-media-line", "文本：目标名仍可见（降级卡/按钮）",
    textOf(tree).includes("录音.mp3"), j(textOf(tree)));
}
section("M19-D 分派顺序（图片 > 媒体 > transclusion）");
{
  const media = makeMediaStub();
  const embed = makeEmbedStub();
  const handlers = { mediaKind: media.mediaKind, mediaElement: media.mediaElement, embedElement: embed };
  const imageTree = render("embed-image-line", handlers);
  check("embed-image-line", "顺序：图片扩展名优先 → img，不调 mediaKind/embedElement",
    findFirst(imageTree, (n) => localName(n) === "img") !== null
      && media.kindCalls.length === 0 && embed.calls.length === 0);
  const mediaTree = render("embed-media-line", handlers);
  check("embed-media-line", "顺序：媒体优先于 transclusion（调 mediaElement、不调 embedElement）",
    findFirst(mediaTree, (n) => localName(n) === "audio") !== null && embed.calls.length === 0);
  const noteTree = render("embed-note", handlers);
  check("embed-note", "顺序：非图片非媒体 → transclusion（调 embedElement）",
    findAll(noteTree, (n) => dataOf(n, "data-block-kind") === "embed").length === 1 && embed.calls.length === 1);
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log("\n" + "═".repeat(76));
if (failures.length > 0) {
  console.log(`P2b 面板路径断言：共 ${checkTotal} 条，通过 ${checkPassed}，失败 ${failures.length} ✗`);
  const bySection = new Map();
  for (const f of failures) bySection.set(f.section, (bySection.get(f.section) ?? 0) + 1);
  for (const [name, count] of bySection) console.log(`  - ${name}：${count} 条失败`);
  process.exit(1);
}
console.log(`P2b 面板路径断言：共 ${checkTotal} 条，通过 ${checkPassed}，失败 0`);
console.log("全部 M16 数学 + M17 行内 HTML + M18 transclusion + M19 媒体分派面板路径断言通过 ✔");
