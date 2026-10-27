/**
 * sanitizer（P2 M17）单元测试 + XSS 安全语料。
 * 运行：node test/sanitize.mjs
 *
 * 被测模块：src/sanitize.js（浏览器/Node 双端、零依赖）。
 * Node 侧用 jsdom 的 DOMParser（devDependency，模块内不 import 任何包）模拟浏览器；
 * 浏览器真实 DOMParser 的一致性由 verifier 在 GUI 侧抽查，方法：
 *   1) 在 DSH 笔记面板预览附录 B 的 html-basic / html-xss-* 片段；
 *   2) DevTools 检查预览 DOM：<script>/<iframe>/<svg>/on* 属性绝不出现，
 *      <b>/<kbd>/<sup> 正常渲染，&lt;script&gt; 只显示为文本；
 *   3) 对同一笔记反复切换编辑/预览：无脚本执行、无异常网络请求；
 *   4) 控制台执行 `new DOMParser().parseFromString(片段, "text/html")` 与
 *      test/sanitize.mjs 的 jsdom 结果对照（serialize 输出逐字符比较）。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const code = readFileSync(join(root, "src", "sanitize.js"), "utf8");

// ── stub React（与其它测试一致的收集式 createElement）───────────────────────
const Fragment = Symbol.for("react.fragment");
function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
}
const React = { Fragment, createElement };

const factory = new Function("React", `${code}\nreturn sanitizeModule;`);
const { parseHtmlToReact, sanitizeSvgToReact, sanitizeUrl } = factory(React);

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
const DOMParser = window.DOMParser;
const parse = (html, options = {}) => parseHtmlToReact(html, React, { DOMParser, ...options });
const parseSvg = (svg, options = {}) => sanitizeSvgToReact(svg, React, { DOMParser, idPrefix: "t-", ...options });

// ── 断言工具 ────────────────────────────────────────────────────────────────
let checkTotal = 0;
let checkPassed = 0;
const failures = [];
function check(name, cond, extra) {
  checkTotal += 1;
  if (cond) {
    checkPassed += 1;
    console.log(`✓ ${name}`);
    return true;
  }
  failures.push(name);
  const detail = extra === undefined || extra === null || extra === "" ? "" : `\n    实测: ${extra}`;
  console.log(`✗ ${name}${detail}`);
  return false;
}
const j = (v) => JSON.stringify(v);
function section(title) {
  console.log(`\n── ${title} ──`);
}

// ── React 树工具 ────────────────────────────────────────────────────────────
const isElement = (n) => n !== null && typeof n === "object" && !Array.isArray(n);
function childList(node) {
  if (!isElement(node)) return [];
  const c = node.props === undefined ? undefined : node.props.children;
  if (c === undefined || c === null) return [];
  return Array.isArray(c) ? c : [c];
}
/** 深度优先收集元素（文档序） */
function allElements(tree) {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isElement(node)) return;
    out.push(node);
    for (const child of childList(node)) walk(child);
  };
  walk(tree);
  return out;
}
function textOf(tree) {
  if (tree === null || tree === undefined) return "";
  if (typeof tree !== "object") return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join("");
  return childList(tree).map(textOf).join("");
}
function tagOf(node) {
  if (!isElement(node)) return "#text";
  return typeof node.type === "string" ? node.type : "#fragment";
}
/** 元素树 → 伪 HTML（不含 key；失败信息用） */
function serialize(tree) {
  if (tree === null || tree === undefined) return "";
  if (typeof tree !== "object") return String(tree);
  if (Array.isArray(tree)) return tree.map(serialize).join("");
  const tag = tagOf(tree);
  const attrs = [];
  for (const [k, v] of Object.entries(tree.props ?? {})) {
    if (k === "children" || k === "key" || v === undefined) continue;
    if (typeof v === "object" && v !== null) attrs.push(` ${k}=${j(v)}`);
    else attrs.push(` ${k}="${String(v)}"`);
  }
  const kids = childList(tree);
  const open = `<${tag}${attrs.length > 0 ? attrs.join("") : ""}`;
  if (kids.length === 0) return `${open}>`;
  return `${open}>${kids.map(serialize).join("")}</${tag}>`;
}
function findElements(tree, pred) {
  return allElements(tree).filter((el) => pred(el, tagOf(el)));
}

// ── 白名单常量（测试侧独立抄一遍，防止模块常量被改坏）──────────────────────
const INLINE_WHITELIST = new Set([
  "b", "strong", "i", "em", "u", "s", "del", "mark", "code", "kbd",
  "br", "sup", "sub", "span", "small", "abbr",
]);
const INLINE_FORBIDDEN = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "param",
  "link", "meta", "base", "title", "head", "template", "noscript", "svg", "math",
  "form", "input", "button", "select", "option", "optgroup", "textarea",
  "audio", "video", "source", "track", "canvas", "plaintext", "xmp",
]);
const SVG_WHITELIST = new Set([
  "svg", "g", "defs", "symbol", "marker", "clipPath", "mask", "pattern",
  "linearGradient", "radialGradient", "stop", "path", "rect", "circle", "ellipse",
  "line", "polyline", "polygon", "text", "tspan", "textPath", "title", "desc", "use",
]);
const SVG_ALLOWED_PROPS = new Set([
  "id", "className", "role", "xmlns", "xmlnsXlink", "version", "viewBox", "preserveAspectRatio",
  "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy",
  "d", "points", "dx", "dy", "rotate", "transform", "pathLength", "textLength", "lengthAdjust",
  "fill", "fillOpacity", "fillRule", "stroke", "strokeWidth", "strokeOpacity", "strokeLinecap",
  "strokeLinejoin", "strokeMiterlimit", "strokeDasharray", "strokeDashoffset", "opacity", "color",
  "display", "visibility", "paintOrder", "shapeRendering", "vectorEffect", "colorInterpolation",
  "clipPath", "clipRule", "mask", "filter", "markerStart", "markerMid", "markerEnd",
  "markerWidth", "markerHeight", "markerUnits", "refX", "refY", "orient", "offset",
  "stopColor", "stopOpacity", "gradientUnits", "gradientTransform", "spreadMethod",
  "patternUnits", "patternContentUnits", "patternTransform", "clipPathUnits",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "letterSpacing",
  "wordSpacing", "textAnchor", "dominantBaseline", "alignmentBaseline", "textDecoration",
  "href", "xlinkHref", "style", "key",
]);

/**
 * 遍历输出树做安全断言：只允许白名单元素 + 文本；属性只允许 key/title。
 * @returns {string[]} 违规描述
 */
function validateInlineTree(tree, options = {}) {
  const allowFragment = options.allowFragment === true;
  const problems = [];
  const walk = (node, path) => {
    if (node === null || node === undefined) {
      problems.push(`${path}: null/undefined 节点`);
      return;
    }
    if (typeof node !== "object") {
      if (typeof node !== "string" && typeof node !== "number") problems.push(`${path}: 非法文本节点`);
      return;
    }
    if (Array.isArray(node)) {
      problems.push(`${path}: 嵌套数组（输出应扁平）`);
      for (let i = 0; i < node.length; i += 1) walk(node[i], `${path}[${i}]`);
      return;
    }
    const tag = tagOf(node);
    if (tag === "#fragment") {
      if (!allowFragment) problems.push(`${path}: 不应出现的 Fragment`);
    } else if (!INLINE_WHITELIST.has(tag)) {
      problems.push(`${path}: 非白名单元素 <${tag}>`);
    }
    for (const key of Object.keys(node.props ?? {})) {
      if (key === "children" || key === "key") continue;
      if (tag === "#fragment") {
        problems.push(`${path}: Fragment 上出现额外属性 ${key}`);
        continue;
      }
      if (key !== "title") problems.push(`${path}: 非白名单属性 ${key}（<${tag}>）`);
    }
    const kids = childList(node);
    for (let i = 0; i < kids.length; i += 1) walk(kids[i], `${path}/${tag}[${i}]`);
  };
  if (Array.isArray(tree)) {
    for (let i = 0; i < tree.length; i += 1) walk(tree[i], `[${i}]`);
  } else {
    walk(tree, "root");
  }
  return problems;
}

function validateSvgTree(tree, options = {}) {
  const problems = [];
  if (!isElement(tree) || tagOf(tree) !== "svg") {
    problems.push(`根节点不是 svg：${tagOf(tree)}`);
    return problems;
  }
  const walk = (node, path) => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, path);
      return;
    }
    const tag = tagOf(node);
    if (!SVG_WHITELIST.has(tag)) {
      problems.push(`${path}: 非白名单 SVG 元素 <${tag}>`);
      return;
    }
    for (const key of Object.keys(node.props ?? {})) {
      if (key === "children" || key === "key") continue;
      if (!SVG_ALLOWED_PROPS.has(key)) problems.push(`${path}: 非白名单 SVG 属性 ${key}（<${tag}>）`);
      if (/^on/i.test(key)) problems.push(`${path}: 事件属性 ${key}`);
    }
    if (node.props.href !== undefined && !/^#/.test(String(node.props.href))) {
      problems.push(`${path}: href 不是内部引用 ${j(node.props.href)}`);
    }
    if (node.props.xlinkHref !== undefined && !/^#/.test(String(node.props.xlinkHref))) {
      problems.push(`${path}: xlinkHref 不是内部引用 ${j(node.props.xlinkHref)}`);
    }
    if (options.idPrefix !== undefined && node.props.id !== undefined && !String(node.props.id).startsWith(options.idPrefix)) {
      problems.push(`${path}: id 未加前缀 ${j(node.props.id)}`);
    }
    for (const child of childList(node)) walk(child, `${path}/${tag}`);
  };
  walk(tree, "svg");
  return problems;
}

console.log(`sanitizer 测试：src/sanitize.js（${code.length} 字符）`);

// ────────────────────────────────────────────────────────────────────────────
section("0) 模块形状与信任边界");
check("导出 parseHtmlToReact", typeof parseHtmlToReact === "function");
check("导出 sanitizeSvgToReact", typeof sanitizeSvgToReact === "function");
check("导出 sanitizeUrl", typeof sanitizeUrl === "function");
const codeNoComments = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
check("模块内不使用 dangerouslySetInnerHTML（代码层，注释除外）", !codeNoComments.includes("dangerouslySetInnerHTML"));
check("模块内没有 import（零依赖，不做运行时 npm 依赖）", !/^\s*import\s/m.test(codeNoComments) && !/\brequire\s*\(/.test(codeNoComments));
check("模块内不直接 require/import jsdom", !/\bjsdom\b/.test(codeNoComments));

// ────────────────────────────────────────────────────────────────────────────
section("1) 白名单正向：元素/属性/title");
{
  const out = parse("<b>粗</b> <kbd>Ctrl</kbd> <sup>2</sup>");
  check("b/kbd/sup 结构正确", serialize(out) === "<b>粗</b> <kbd>Ctrl</kbd> <sup>2</sup>", serialize(out));
  check("输出只含白名单元素与文本", validateInlineTree(out).length === 0, validateInlineTree(out).join("; "));

  for (const tag of INLINE_WHITELIST) {
    if (tag === "br") continue;
    const one = parse(`<${tag}>x</${tag}>`);
    check(`白名单标签 <${tag}> 渲染为元素`, findElements(one, (el) => tagOf(el) === tag).length === 1, serialize(one));
  }
  const br = parse("<br>");
  check("br 渲染为 br 元素（空元素）", findElements(br, (el) => tagOf(el) === "br").length === 1, serialize(br));

  const abbr = parse('<abbr title="提示信息">ABBR</abbr>');
  const abbrEl = findElements(abbr, (el) => tagOf(el) === "abbr")[0];
  check("abbr 的 title 属性保留", abbrEl !== undefined && abbrEl.props.title === "提示信息", serialize(abbr));
  const entityTitle = parse('<abbr title="a&quot;b &amp; c">t</abbr>');
  const entityAbbr = findElements(entityTitle, (el) => tagOf(el) === "abbr")[0];
  check("title 中的实体解码后按原字符串保留", entityAbbr !== undefined && entityAbbr.props.title === 'a"b & c', serialize(entityTitle));

  const attrs = parse('<b onclick="alert(1)" class="dsh-obs-src" id="x" style="color:red" href="javascript:alert(1)" data-x="1" title="T">t</b>');
  const b = findElements(attrs, (el) => tagOf(el) === "b")[0];
  check("属性只保留 title，其余（on*/class/id/style/href/data-*）全部丢弃", b !== undefined && Object.keys(b.props).sort().join(",") === "children,key,title", serialize(attrs));
  check("非白名单属性不进入输出树", validateInlineTree(attrs).length === 0, validateInlineTree(attrs).join("; "));
  check("title 之外的属性没有注入元素/事件", serialize(attrs) === '<b title="T">t</b>', serialize(attrs));
}

// ────────────────────────────────────────────────────────────────────────────
section("2) 未知标签：不注入元素，纯文本降级");
{
  const details = parse("<details><summary>展开</summary>内文</details>");
  check("details/summary 不产元素", findElements(details, (el) => ["details", "summary"].includes(tagOf(el))).length === 0, serialize(details));
  check("未知标签的可见文本保留", textOf(details) === "展开内文", j(textOf(details)));
  check("未知标签输出只含白名单元素/文本", validateInlineTree(details).length === 0, validateInlineTree(details).join("; "));

  const div = parse("<div>包裹<b>粗</b></div>");
  check("div 包裹的未知标签展开、内部白名单标签保留", serialize(div) === "包裹<b>粗</b>", serialize(div));

  const a = parse('<a href="https://example.com" target="_blank">链接</a>');
  check("a 未在白名单 v1：不产 a 元素、无 href（只留文本）", textOf(a) === "链接" && findElements(a, (el) => tagOf(el) === "a").length === 0, serialize(a));

  const img = parse('<img src="x" onerror="alert(1)" alt="图">');
  check("img 未在白名单：不产元素、不产网络请求节点", Array.isArray(img) && img.length === 0, serialize(img));
}

// ────────────────────────────────────────────────────────────────────────────
section("3) 禁止标签与 XSS 语料");
{
  const scriptOnly = parse("<script>alert(1)</script>");
  check("html-xss-script：<script> 绝不成为元素（整段丢弃）", Array.isArray(scriptOnly) && scriptOnly.length === 0 && !serialize(scriptOnly).includes("script"), serialize(scriptOnly));
  const scriptAround = parse("<b>x</b><script>alert(1)</script>y");
  check("script 两侧内容保留、脚本文本不显示", serialize(scriptAround) === "<b>x</b>y", serialize(scriptAround));

  const styleOnly = parse("<style>body{display:none}</style>x");
  check("html-xss-style：<style> 整段丢弃", serialize(styleOnly) === "x", serialize(styleOnly));
  const styleAttr = parse('<b style="background:url(javascript:alert(1))">x</b>');
  check("style 属性（CSS 注入）被清除", serialize(styleAttr) === "<b>x</b>", serialize(styleAttr));

  const iframe = parse('<iframe src="javascript:alert(1)"></iframe>');
  check("html-xss-iframe：<iframe> 整段丢弃", Array.isArray(iframe) && iframe.length === 0, serialize(iframe));

  for (const bad of [
    '<object data="javascript:alert(1)"></object>',
    '<embed src="javascript:alert(1)">',
    '<link rel="stylesheet" href="javascript:alert(1)">',
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    '<base href="javascript:alert(1)">',
  ]) {
    check(`禁止标签整段丢弃：${bad.slice(0, 38)}…`, (() => {
      const out = parse(bad);
      return Array.isArray(out) && out.length === 0;
    })(), serialize(parse(bad)));
  }

  const onclick = parse('<b onclick="alert(1)" onmouseover="alert(2)">x</b>');
  check("html-xss-b-onclick：事件属性全部清除", serialize(onclick) === "<b>x</b>" && !serialize(onclick).includes("on"), serialize(onclick));

  const imgXss = parse('<img src=x onerror=alert(1)>');
  check("html-xss-img-onerror：不产 img、不产生 onerror", Array.isArray(imgXss) && imgXss.length === 0, serialize(imgXss));

  const svgXss = parse('<svg onload="alert(1)"><circle r="1"></circle></svg>z');
  check("html-xss-svg：行内 svg 整段丢弃（SVG 只走 mermaid 专用接口）", serialize(svgXss) === "z", serialize(svgXss));

  const jsUrl = parse('<a href="javascript:alert(1)">点击</a>');
  check("html-xss-js-url：javascript: 链接不产 a/href", textOf(jsUrl) === "点击" && findElements(jsUrl, (el) => tagOf(el) === "a").length === 0, serialize(jsUrl));
  const jsUrlEntity = parse('<a href="jav&#x61;script:alert(1)">x</a>');
  check("js-url 实体绕过（jav&#x61;script:）同样不产 href", serialize(jsUrlEntity) === "x", serialize(jsUrlEntity));
  const dataUrl = parse('<b data-x="data:text/html,<script>alert(1)</script>">x</b>');
  check("data: 与内嵌 <script> 文本不产元素", serialize(dataUrl) === "<b>x</b>", serialize(dataUrl));

  const entityBypass = parse("&lt;script&gt;alert(1)&lt;/script&gt;");
  check("html-xss-entity：&lt;script&gt; 只显示为文本", textOf(entityBypass) === "<script>alert(1)</script>" && findElements(entityBypass, (el) => tagOf(el) === "script").length === 0, serialize(entityBypass));
  const numericEntity = parse("&#60;script&#62;alert(1)&#60;/script&#62;");
  check("数字实体绕过（&#60;script&#62;）只显示为文本", textOf(numericEntity) === "<script>alert(1)</script>", serialize(numericEntity));
  const ampEntity = parse("a&amp;b &copy; &#x41;");
  check("普通实体按文本解码（&amp;/&copy;/&#x41;）", textOf(ampEntity) === "a&b © A", j(textOf(ampEntity)));

  const comment = parse("a<!-- <script>alert(1)</script> -->b");
  check("注释 <!-- --> 不产节点（注释里的 script 也不执行）", serialize(comment) === "ab", serialize(comment));

  const template = parse("<template><b>tpl</b><script>alert(1)</script></template>x");
  check("禁止 <template>：内容整段丢弃", serialize(template) === "x", serialize(template));

  const noscriptMid = parse("<i>a</i><noscript><b>x</b></noscript>y");
  check("禁止 <noscript>：不产 noscript 元素（内容由解析器决定，不注入元素）",
    findElements(noscriptMid, (el) => tagOf(el) === "noscript").length === 0 && !serialize(noscriptMid).includes("<b>x</b>"),
    serialize(noscriptMid));

  const math = parse("<math><mtext><script>alert(1)</script></mtext></math>x");
  check("禁止 <math>：整段丢弃", serialize(math) === "x", serialize(math));

  const malformed = parse("<b><i>x</b>y</i>");
  check("畸形嵌套不抛异常、输出只含白名单元素", validateInlineTree(malformed).length === 0, validateInlineTree(malformed).join("; "));
  check("畸形嵌套的可见文本不丢（x + y）", textOf(malformed) === "xy", j(textOf(malformed)));

  const nestedForbidden = parse("<b><script>alert(1)</script>粗</b>");
  check("白名单标签内嵌 script：只丢 script", serialize(nestedForbidden) === "<b>粗</b>", serialize(nestedForbidden));

  const rawText = parse("<plaintext><b>x</b>");
  check("禁止 <plaintext>：整段丢弃", Array.isArray(rawText) && rawText.length === 0, serialize(rawText));

  const ltText = parse("a < b & c > d");
  check("非标签的 < > 按文本保留", textOf(ltText) === "a < b & c > d", j(textOf(ltText)));

  const titleEl = parse("<title>x</title>y");
  check("禁止 <title>（head 元素）：不产元素，正文保留", textOf(titleEl) === "y", serialize(titleEl));
}

// ────────────────────────────────────────────────────────────────────────────
section("4) DOM clobbering / 表单类标签");
{
  const clobber = parse('<form id="getElementById" name="x"><input name="y"><button>go</button></form><span id="s" name="n">t</span>');
  const elements = allElements(clobber);
  check("form/input/button 不产元素", elements.every((el) => !["form", "input", "button"].includes(tagOf(el))), serialize(clobber));
  check("输出树里没有任何 id/name 属性（防 DOM clobbering）", elements.every((el) => el.props.id === undefined && el.props.name === undefined && el.props.className === undefined), serialize(clobber));
  check("被拒绝的元素外的白名单文本保留", textOf(clobber) === "t", j(textOf(clobber)));

  const named = parse('<img name="location"><a id="location" name="location">x</a>');
  check("img/a 的 id/name 不会进入 DOM", allElements(named).every((el) => el.props.id === undefined && el.props.name === undefined), serialize(named));
}

// ────────────────────────────────────────────────────────────────────────────
section("5) textHandler：源码偏移映射");
{
  const html = "<b>a</b> <kbd>Ctrl</kbd>";
  const calls = [];
  const out = parse(html, { textHandler: (text, localStart) => { calls.push([text, localStart]); return createElement("span", {}, text); } });
  check("textHandler 按文档序收到 3 段可见文本", calls.length === 3 && calls.map((c) => c[0]).join("|") === "a| |Ctrl", j(calls));
  check("localStart 精确指向原文（html.slice === text）", calls.every(([t, s]) => html.slice(s, s + t.length) === t), j(calls));
  check("textHandler 返回的节点被包进带 key 的 Fragment", findElements(out, (el) => tagOf(el) === "#fragment").length === 3, serialize(out));
  check("textHandler 节点的文本与结构保留", serialize(out) === "<b><#fragment><span>a</span></#fragment></b><#fragment><span> </span></#fragment><kbd><#fragment><span>Ctrl</span></#fragment></kbd>", serialize(out));
  check("带 textHandler 的输出仍只含白名单元素（Fragment 允许）", validateInlineTree(out, { allowFragment: true }).length === 0, validateInlineTree(out, { allowFragment: true }).join("; "));

  const nestedHtml = "<b>x<i>y</i>z</b>";
  const nestedCalls = [];
  parse(nestedHtml, { textHandler: (text, localStart) => { nestedCalls.push([text, localStart]); return text; } });
  check("嵌套标签的偏移仍按文档序精确", nestedCalls.map((c) => c.join("@")).join("|") === "x@3|y@7|z@12", j(nestedCalls));
  check("嵌套标签偏移切片一致", nestedCalls.every(([t, s]) => nestedHtml.slice(s, s + t.length) === t), j(nestedCalls));

  const entity = parse("a&amp;b", { textHandler: () => { throw new Error("不应被调用"); } });
  check("实体解码文本不回调 textHandler（md.slice 无法等于可见文本）", textOf(entity) === "a&b", serialize(entity));

  const mixedHtml = "<b>a&amp;b</b>c";
  const mixedCalls = [];
  const mixed = parse(mixedHtml, { textHandler: (text, localStart) => { mixedCalls.push([text, localStart]); return text; } });
  check("实体文本跳过、后续文本偏移不漂移", mixedCalls.length === 1 && mixedCalls[0][0] === "c" && mixedCalls[0][1] === 14, j(mixedCalls));
  check("实体文本作为普通文本渲染", textOf(mixed) === "a&bc", j(textOf(mixed)));

  const quoteHtml = '<b title="x>y">z</b>';
  const quoteCalls = [];
  parse(quoteHtml, { textHandler: (text, localStart) => { quoteCalls.push([text, localStart]); return text; } });
  check("属性值里的 > 不影响偏移扫描", quoteCalls.length === 1 && quoteCalls[0][0] === "z" && quoteHtml.slice(quoteCalls[0][1], quoteCalls[0][1] + 1) === "z", j(quoteCalls));

  const divHtml = "<div>x</div>";
  const divCalls = [];
  parse(divHtml, { textHandler: (text, localStart) => { divCalls.push([text, localStart]); return text; } });
  check("未知标签内文本的偏移正确（x@5）", divCalls.length === 1 && divCalls[0][1] === 5, j(divCalls));

  const allCalls = [];
  const realHtml = "<b>粗</b> <kbd>Ctrl</kbd> <details><summary>展开</summary>内文</details>";
  parse(realHtml, { textHandler: (text, localStart) => { allCalls.push([text, localStart]); return text; } });
  check("真实片段所有映射都满足 html.slice === text", allCalls.length > 0 && allCalls.every(([t, s]) => realHtml.slice(s, s + t.length) === t), j(allCalls));

  const unclosed = '<b title="未闭合>文本';
  const unclosedCalls = [];
  let unclosedThrew = false;
  let unclosedOut = null;
  try {
    unclosedOut = parse(unclosed, { textHandler: (text, localStart) => { unclosedCalls.push([text, localStart]); return text; } });
  } catch (err) {
    unclosedThrew = true;
  }
  check("扫描器口径不一致（未闭合属性）时不抛异常、不冒险映射", unclosedThrew === false && unclosedCalls.length === 0 && unclosedOut !== null, j(unclosedCalls));

  const throwing = parse("<b>x</b>", { textHandler: () => { throw new Error("boom"); } });
  check("textHandler 抛异常时降级为普通文本、不向上抛", serialize(throwing) === "<b>x</b>", serialize(throwing));
  const nulled = parse("<b>x</b>", { textHandler: () => null });
  check("textHandler 返回 null 时降级为普通文本", serialize(nulled) === "<b>x</b>", serialize(nulled));

  const plain = parse("<b>x</b>");
  check("未传 textHandler 时不产生 Fragment 包装", findElements(plain, (el) => tagOf(el) === "#fragment").length === 0, serialize(plain));
}

// ────────────────────────────────────────────────────────────────────────────
section("6) 入参健壮性 / 失败降级");
{
  check("空字符串 → null", parse("") === null);
  check("非字符串入参 → null 不抛异常", parse(null) === null && parse(undefined) === null && parse(123) === null && parse({}) === null);
  check("React 缺失 → null", parseHtmlToReact("<b>x</b>", null, { DOMParser }) === null);
  check("DOMParser 缺失 → null（Node 无全局 DOMParser 时调用方降级原文）", parseHtmlToReact("<b>x</b>", React) === null);
  check("DOMParser 显式传 null → null", parseHtmlToReact("<b>x</b>", React, { DOMParser: null }) === null);
  check("DOMParser 抛异常 → fail-closed 返回 null", parseHtmlToReact("<b>x</b>", React, {
    DOMParser: class {
      parseFromString() {
        throw new Error("parser boom");
      }
    },
  }) === null);
  const inlineFalse = parse("<b>x</b>", { inline: false });
  check("inline:false 参数被接受（v1 行为不变）", serialize(inlineFalse) === "<b>x</b>", serialize(inlineFalse));
  const overLimit = parse("a".repeat(1000001));
  check("超过输入上限 → null（防滥用）", overLimit === null);

  let deepThrew = false;
  let deepOut = null;
  try {
    deepOut = parse("<b>".repeat(300) + "x" + "</b>".repeat(300));
  } catch (err) {
    deepThrew = true;
  }
  check("300 层嵌套不抛异常、深度按预算截断（不产出超深树）", deepThrew === false && deepOut !== null && allElements(deepOut).length <= 102, `depth=${deepOut === null ? "null" : allElements(deepOut).length}`);

  const keyed = parse("<b>x</b>", { keyPrefix: "tok7-" });
  const keyed2 = parse("<b>x</b>", { keyPrefix: "tok7-" });
  defs: {
    const el = findElements(keyed, (e) => tagOf(e) === "b")[0];
    const el2 = findElements(keyed2, (e) => tagOf(e) === "b")[0];
    check("keyPrefix 生效且相同输入产生稳定 key", el !== undefined && el.props.key === "tok7-0" && el2 !== undefined && el2.props.key === "tok7-0", `${el && el.props.key} / ${el2 && el2.props.key}`);
    check("相同输入的输出树稳定（同 key）", serialize(keyed) === serialize(keyed2));
  }
}

// ────────────────────────────────────────────────────────────────────────────
section("7) sanitizeUrl：协议白名单");
{
  const allowed = ["https://example.com/a?b=1#c", "http://example.com", "HTTPS://EXAMPLE.COM", "mailto:a@b.c", "#anchor", "#"];
  check("允许 http/https/mailto/#", allowed.every((u) => sanitizeUrl(u) !== null), j(allowed.map((u) => [u, sanitizeUrl(u)])));
  const first = sanitizeUrl("  https://example.com  ");
  check("允许的 URL 去掉首尾空白后返回", first === "https://example.com", j(first));
  const rejected = [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "\tjava\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>", "data:image/svg+xml;base64,AA", "vbscript:msgbox(1)",
    "file:///etc/passwd", "//evil.example.com", "/relative/path", "./relative", "", "  ",
  ];
  check("拒绝 javascript:/data:/vbscript:/file:/相对路径/空串（含控制字符绕过）", rejected.every((u) => sanitizeUrl(u) === null), j(rejected.map((u) => [u, sanitizeUrl(u)])));
  check("非字符串入参 → null", sanitizeUrl(null) === null && sanitizeUrl(undefined) === null && sanitizeUrl(1) === null);
}

// ────────────────────────────────────────────────────────────────────────────
section("8) SVG 白名单（mermaid 复用）正向");
{
  const svg = [
    '<svg id="m" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">',
    '<style>.node{fill:red}</style>',
    '<defs><marker id="a" markerWidth="8" refX="5" orient="auto"><polygon points="0 0, 5 5"></polygon></marker></defs>',
    '<g class="node"><path d="M0 0L5 5" marker-end="url(#a)" stroke-width="2"></path>',
    '<text x="1" font-size="12" text-anchor="middle">A</text></g>',
    '<use href="#a"></use></svg>',
  ].join("");
  const out = parseSvg(svg);
  check("根节点是 svg 元素", isElement(out) && tagOf(out) === "svg", tagOf(out));
  check("根属性：viewBox/id 前缀/xmlns 保留", out !== null && out.props.viewBox === "0 0 10 10" && out.props.id === "t-m" && out.props.xmlns === "http://www.w3.org/2000/svg", serialize(out));
  check("SVG 内 <style> 元素丢弃（不开放内联 CSS）", findElements(out, (el) => tagOf(el) === "style").length === 0, serialize(out));
  const marker = findElements(out, (el) => tagOf(el) === "marker")[0];
  check("marker 属性（markerWidth/refX）与 id 前缀保留", marker !== undefined && marker.props.markerWidth === "8" && marker.props.refX === "5" && marker.props.id === "t-a", marker && serialize(marker));
  const path = findElements(out, (el) => tagOf(el) === "path")[0];
  check("path 的 d/strokeWidth 属性保留（DOM 名→React prop 名）", path !== undefined && path.props.d === "M0 0L5 5" && path.props.strokeWidth === "2", path && serialize(path));
  check("marker-end 的 url(#id) 重写为加前缀的内部引用", path !== undefined && path.props.markerEnd === "url(#t-a)", path && j(path.props.markerEnd));
  const textEl = findElements(out, (el) => tagOf(el) === "text")[0];
  check("text 元素文本与表现属性保留", textEl !== undefined && textOf(textEl) === "A" && textEl.props.fontSize === "12" && textEl.props.textAnchor === "middle", serialize(out));
  const use = findElements(out, (el) => tagOf(el) === "use")[0];
  check("use 的 href 重写为加前缀的内部引用", use !== undefined && use.props.href === "#t-a", use && serialize(use));
  const g = findElements(out, (el) => tagOf(el) === "g")[0];
  check("g 的 class 转为 className 保留", g !== undefined && g.props.className === "node", g && serialize(g));
  check("SVG 输出只含白名单元素/属性", validateSvgTree(out, { idPrefix: "t-" }).length === 0, validateSvgTree(out, { idPrefix: "t-" }).join("; "));
  check("根节点不自带 key（放置位置由调用方决定）", out !== null && out.props.key === undefined);

  const auto1 = sanitizeSvgToReact(svg, React, { DOMParser });
  const auto2 = sanitizeSvgToReact(svg, React, { DOMParser });
  check("未传 idPrefix 时自动生成唯一前缀（两个图 id 不冲突）",
    auto1 !== null && auto2 !== null && /^dsh-obs-svg-\d+-m$/.test(String(auto1.props.id)) && auto1.props.id !== auto2.props.id,
    `${auto1 && auto1.props.id} / ${auto2 && auto2.props.id}`);
}

// ────────────────────────────────────────────────────────────────────────────
section("9) SVG XSS / 危险属性");
{
  const xss = parseSvg([
    '<svg onload="alert(1)">',
    '<script>alert(1)</script>',
    '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(1)></body></foreignObject>',
    '<image href="https://evil.example.com/x.png"></image>',
    '<a xlink:href="javascript:alert(1)"><text>link</text></a>',
    '<use href="javascript:alert(1)"></use>',
    '<use href="data:image/svg+xml;base64,AA"></use>',
    '<animate attributeName="href" values="javascript:alert(1)"></animate>',
    '<set attributeName="onload" to="alert(1)"></set>',
    '<path d="M0 0" onclick="alert(1)" style="fill:red"></path>',
    '<rect width="1" height="1" fill="url(https://evil.example.com/x.svg#p)"></rect>',
    '<circle r="1" fill="javascript:alert(1)"></circle>',
    '</svg>',
  ].join(""));
  check("SVG XSS 语料不抛异常、根仍是 svg", isElement(xss) && tagOf(xss) === "svg", tagOf(xss));
  check("SVG 输出只含白名单元素/属性", validateSvgTree(xss, { idPrefix: "t-" }).length === 0, validateSvgTree(xss, { idPrefix: "t-" }).join("; "));
  check("script/foreignObject/image/a/animate/set 全部丢弃（子树）",
    findElements(xss, (el) => ["script", "foreignObject", "image", "a", "animate", "set"].includes(tagOf(el))).length === 0,
    serialize(xss));
  check("onload/onclick 等事件属性全部丢弃", allElements(xss).every((el) => Object.keys(el.props).every((k) => !/^on/i.test(k))), serialize(xss));
  const xssUse = findElements(xss, (el) => tagOf(el) === "use")[0];
  check("use 的 javascript:/data: href 被丢弃", xssUse !== undefined && xssUse.props.href === undefined && xssUse.props.xlinkHref === undefined, xssUse && serialize(xssUse));
  const xssRect = findElements(xss, (el) => tagOf(el) === "rect")[0];
  check("fill 的外部 url() 引用被丢弃（防外链资源）", xssRect !== undefined && xssRect.props.fill === undefined, xssRect && serialize(xssRect));
  const xssCircle = findElements(xss, (el) => tagOf(el) === "circle")[0];
  check("fill 的 javascript: 取值被丢弃", xssCircle !== undefined && xssCircle.props.fill === undefined, xssCircle && serialize(xssCircle));
  const xssPath = findElements(xss, (el) => tagOf(el) === "path")[0];
  check("style 属性默认不保留（allowStyleAttributes 未开）", xssPath !== undefined && xssPath.props.style === undefined, xssPath && serialize(xssPath));

  const styleOn = parseSvg('<svg><path d="M0 0" style="fill:red;stroke:url(#g);background:url(http://evil/x);position:fixed;font-size:12px;fill:blue!important"></path></svg>', { allowStyleAttributes: true });
  const stylePath = findElements(styleOn, (el) => tagOf(el) === "path")[0];
  check("allowStyleAttributes：style 转为 React 样式对象", stylePath !== undefined && typeof stylePath.props.style === "object" && stylePath.props.style !== null, stylePath && serialize(stylePath));
  check("allowStyleAttributes：只保留 SVG 表现属性（fill/stroke/fontSize）",
    stylePath !== undefined && stylePath.props.style.fill === "red" && stylePath.props.style.stroke === "url(#t-g)" && stylePath.props.style.fontSize === "12px",
    stylePath && j(stylePath.props.style));
  check("allowStyleAttributes：background/position 被过滤",
    stylePath !== undefined && stylePath.props.style.background === undefined && stylePath.props.style.position === undefined,
    stylePath && j(stylePath.props.style));

  const important = parseSvg('<svg><rect width="1" height="1" style="fill:#ECECFF !important;stroke:#9370DB !important"></rect></svg>', { allowStyleAttributes: true });
  const importantRect = findElements(important, (el) => tagOf(el) === "rect")[0];
  check("allowStyleAttributes：mermaid 常见的 !important 去掉后保留颜色声明",
    importantRect !== undefined && importantRect.props.style.fill === "#ECECFF" && importantRect.props.style.stroke === "#9370DB",
    importantRect && j(importantRect.props.style));

  const badId = parseSvg('<svg id="__proto__"><use id="constructor" href="#x"></use></svg>');
  const badIds = allElements(badId).map((el) => el.props.id).filter(Boolean);
  check("id 统一加前缀（__proto__/constructor 不能作为裸 id 进入 DOM）", badIds.length > 0 && badIds.every((id) => id.startsWith("t-")), j(badIds));
  const weirdId = parseSvg('<svg><g id="a b&quot;c"></g></svg>');
  const weirdG = findElements(weirdId, (el) => tagOf(el) === "g")[0];
  check("非法 id 字符被丢弃", weirdG !== undefined && weirdG.props.id === undefined, weirdG && serialize(weirdG));

  check("无 <svg> 的字符串 → null", sanitizeSvgToReact("hello", React, { DOMParser }) === null);
  check("空字符串 → null", sanitizeSvgToReact("", React, { DOMParser }) === null);
  check("非字符串 → null", sanitizeSvgToReact(null, React, { DOMParser }) === null && sanitizeSvgToReact(123, React, { DOMParser }) === null);
  check("DOMParser 缺失 → null", sanitizeSvgToReact("<svg></svg>", React) === null);

  let svgThrew = false;
  let truncated = null;
  try {
    truncated = sanitizeSvgToReact("<svg>" + "<g>".repeat(300) + "<path d=\"M0 0\"></path>" + "</g>".repeat(300) + "</svg>", React, { DOMParser, idPrefix: "t-", maxNodes: 20 });
  } catch (err) {
    svgThrew = true;
  }
  check("节点预算截断不抛异常", svgThrew === false && isElement(truncated) && allElements(truncated).length <= 25, truncated === null ? "null" : `nodes=${allElements(truncated).length}`);

  let deepSvgThrew = false;
  try {
    sanitizeSvgToReact("<svg>" + "<g>".repeat(300) + "</g>".repeat(300) + "</svg>", React, { DOMParser, idPrefix: "t-" });
  } catch (err) {
    deepSvgThrew = true;
  }
  check("300 层 SVG 嵌套不抛异常（深度预算兜底）", deepSvgThrew === false);
}

// ────────────────────────────────────────────────────────────────────────────
section("10) fuzz：随机标签/属性/实体/嵌套");
{
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function rng() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rng = mulberry32(0xc0ffee);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const randomOf = (n) => Math.floor(rng() * n);

  const HTML_TOKENS = [
    "<b>", "</b>", "<strong>", "</strong>", "<i>", "</i>", "<span>", "</span>", "<sup>", "</sup>",
    "<br>", "<abbr title=\"t\">", "</abbr>", "<code>", "</code>", "<mark>", "</mark>",
    "<script>", "</script>", "<style>", "</style>", "<iframe>", "</iframe>", "<object>", "</object>",
    "<embed src=javascript:1>", "<svg>", "</svg>", "<math>", "</math>", "<form id=f>", "</form>",
    "<input name=x>", "<button>", "</button>", "<template>", "</template>", "<noscript>", "</noscript>",
    "<plaintext>", "<xmp>", "</xmp>", "<title>", "</title>", "<a href=\"javascript:alert(1)\">", "</a>",
    "<img src=x onerror=alert(1)>", "<div>", "</div>", "<details>", "</details>",
    "<b onclick=alert(1)>", "<b class=\"c\">", "<b style=\"background:url(javascript:1)\">",
    "<b title=\"a>b\">", "<table>", "</table>", "<tr>", "</tr>", "<td>", "</td>",
    "&lt;", "&gt;", "&amp;", "&#x41;", "&#60;", "&nbsp;", "&copy;", "&quot;", "&#x1F600;",
    "<!--", "-->", "<", ">", "\"", "'", "=", "text", "中文", " ", "\n", "\t", "]]>", "<![CDATA[x]]>",
  ];
  const randomHtml = () => {
    const n = 1 + randomOf(9);
    let out = "";
    for (let i = 0; i < n; i += 1) out += pick(HTML_TOKENS);
    return out;
  };

  let htmlThrew = 0;
  let htmlNotArrayOrNull = 0;
  let htmlWhitelistBad = 0;
  let sliceBad = 0;
  let firstBad = "";
  for (let i = 0; i < 1000; i += 1) {
    const html = randomHtml();
    let out;
    try {
      out = parse(html);
    } catch (err) {
      htmlThrew += 1;
      continue;
    }
    if (out !== null && !Array.isArray(out)) {
      htmlNotArrayOrNull += 1;
      continue;
    }
    if (out !== null) {
      const problems = validateInlineTree(out);
      if (problems.length > 0) {
        htmlWhitelistBad += 1;
        if (firstBad === "") firstBad = `${j(html)} → ${problems[0]}`;
      }
    }
    // 每 5 例抽查一次偏移映射（textHandler 回调必须满足源码切片 === 文本）
    if (i % 5 === 0) {
      try {
        parse(html, {
          textHandler: (text, localStart) => {
            if (html.slice(localStart, localStart + text.length) !== text) {
              sliceBad += 1;
              if (firstBad === "") firstBad = `${j(html)} → localStart=${localStart} text=${j(text)}`;
            }
            return text;
          },
        });
      } catch (err) {
        htmlThrew += 1;
      }
    }
  }
  check("fuzz 1000 例不抛异常", htmlThrew === 0, `throw=${htmlThrew}`);
  check("fuzz 输出是数组或 null", htmlNotArrayOrNull === 0, `bad=${htmlNotArrayOrNull}`);
  check("fuzz 输出只含白名单元素/文本节点/属性", htmlWhitelistBad === 0, firstBad);
  check("fuzz 下 textHandler 偏移始终满足 html.slice === text", sliceBad === 0, firstBad);

  const SVG_TOKENS = [
    "<svg>", "</svg>", "<g>", "</g>", "<defs>", "</defs>", "<marker id=\"m\">", "</marker>",
    "<path d=\"M0 0\">", "</path>", "<rect width=\"1\">", "</rect>", "<circle r=\"1\">", "</circle>",
    "<text>", "</text>", "<tspan>", "</tspan>", "<use href=\"#m\">", "<script>", "</script>",
    "<style>", "</style>", "<foreignObject>", "</foreignObject>", "<image href=\"https://e/x\">",
    "<a xlink:href=\"javascript:1\">", "</a>", "<animate attributeName=\"href\">", "</animate>",
    "<polygon points=\"0 0\">", "<lineargradient id=\"g\">", "</lineargradient>", "<stop offset=\"0\">",
    "<path onload=alert(1)>", "<path style=\"fill:red\">", "<path fill=\"url(#g)\">",
    "<path fill=\"url(https://e)\">", "<g class=\"c\">", "<g id=\"x y\">",
    "&lt;", "&amp;", "&#x41;", "<!--", "-->", "<", ">", "\"", "'", "text", "中文", " ", "]]>",
  ];
  const randomSvg = () => {
    const n = 1 + randomOf(10);
    let out = "";
    for (let i = 0; i < n; i += 1) out += pick(SVG_TOKENS);
    return out;
  };
  let svgThrew = 0;
  let svgShapeBad = 0;
  let svgWhitelistBad = 0;
  let svgFirstBad = "";
  for (let i = 0; i < 300; i += 1) {
    const svg = randomSvg();
    let out;
    try {
      out = sanitizeSvgToReact(svg, React, { DOMParser, idPrefix: "fz-" });
    } catch (err) {
      svgThrew += 1;
      continue;
    }
    if (out === null) continue;
    if (!isElement(out) || tagOf(out) !== "svg") {
      svgShapeBad += 1;
      continue;
    }
    const problems = validateSvgTree(out, { idPrefix: "fz-" });
    if (problems.length > 0) {
      svgWhitelistBad += 1;
      if (svgFirstBad === "") svgFirstBad = `${j(svg)} → ${problems[0]}`;
    }
  }
  check("SVG fuzz 300 例不抛异常", svgThrew === 0, `throw=${svgThrew}`);
  check("SVG fuzz 结果要么 null 要么 svg 根", svgShapeBad === 0, `bad=${svgShapeBad}`);
  check("SVG fuzz 输出只含白名单元素/属性、内部 href、加前缀 id", svgWhitelistBad === 0, svgFirstBad);

  let determinismBad = 0;
  for (let i = 0; i < 20; i += 1) {
    const html = randomHtml();
    const a = parse(html);
    const b = parse(html);
    if (serialize(a) !== serialize(b)) determinismBad += 1;
  }
  check("相同输入 20 例渲染结果稳定", determinismBad === 0, `bad=${determinismBad}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log(`\n共 ${checkTotal} 条断言：通过 ${checkPassed}，失败 ${failures.length}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} 条 sanitizer 断言 FAILED：`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exit(1);
}
console.log("全部 sanitizer 安全断言通过 ✔");
