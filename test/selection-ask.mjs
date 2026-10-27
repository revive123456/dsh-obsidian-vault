/**
 * 「选中片段提问」核心不变量无头验证。
 *
 * A. 预览 CRLF 规范化 + 选区映射（P2 M14 缺陷 2；直接读 src，不依赖构建产物）
 *    外部同步进来的笔记可能是 CRLF 换行，而 renderNumbered 内部按 LF 拆行渲染。
 *    所以 client 预览的渲染、行数、选区映射必须统一用规范化后的内容，否则
 *    DOM 里 data-obs-src 的偏移（LF 口径）拿原文 CRLF 去切片会整体错位，
 *    选中提问的「第 X 行 / > 原文」都会错。这里验证：
 *      1) normalizePreviewContent 只把 CRLF 变 LF（LF 输入原样、幂等）；
 *      2) CRLF 原文渲染出的 DOM 里，每个 data-obs-src 与规范化内容严格一致；
 *      3) DOM 选区 → spanFromSelection 回读的偏移/文本与规范化内容一致（含跨行）；
 *      4) 注入 prompt 的行数/原文取自规范化内容；
 *      5) 接线回归：预览入口、选区、提问内容都走 previewContent（防回退）。
 *    加载方式同 test/paste-helper.mjs：从 src 用平衡花括号扫描提取纯函数；
 *    DOM 用 jsdom，渲染树用 src/markdown.js 的 renderNumbered（与面板同一条路径）。
 *
 * B. 原型回归（prototype/selection-ask.html）
 *    原型/ 为开发原型，不纳入仓库；缺失时本段跳过，只跑 A。原有 4 组断言：
 *      1) 渲染器：每个文本节点的 __src=[start,end) 满足 MD.slice(start,end) === textContent
 *      2) 双向映射：按源码偏移反选（selectByOffsets）后 getSelectionSpan 能精确回读同样的偏移与文本
 *      3) 注入 prompt：@路径 / 行数 / > 选中内容 / 【问题】，无多余空行；长片段转行号提示
 *      4) 浮层在聚焦输入框清空选区后不消失；点「发送」注入并收起
 *
 * 运行：node test/selection-ask.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

/** 从源码提取函数定义（平衡花括号扫描；同 test/paste-helper.mjs） */
function extractFn(code, name) {
  const start = code.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/client.js`);
  const open = code.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) break; }
  }
  return code.slice(start, i + 1);
}

// ═════════════════════════ A. 预览 CRLF 规范化 + 选区映射 ═════════════════════
const clientSrc = readFileSync(join(root, "src", "client.js"), "utf8");
const markdownSrc = readFileSync(join(root, "src", "markdown.js"), "utf8");

console.log("A1) 预览内容规范化（CRLF→LF，与 renderNumbered 同口径）");
const CRLF_MD = [
  "# 标题行",
  "",
  "第一段 **粗体** 文本",
  "第二行普通文本",
  "",
  "- 列表项甲",
  "- 列表项乙",
  "",
  "> 引用行文本",
  "",
  "| 列A | 列B |",
  "| --- | --- |",
  "| 值一 | 值二 |",
].join("\r\n") + "\r\n";                       // 行尾也带 CRLF：真实外部文件常见
const LF_MD = CRLF_MD.replace(/\r\n/g, "\n");

const normalizePreviewContent = new Function(`return (${extractFn(clientSrc, "normalizePreviewContent")})`)();

assert(normalizePreviewContent(CRLF_MD) === LF_MD, "CRLF 内容规范化为 LF（末尾 CRLF 一并归一）");
assert(CRLF_MD.includes("\r\n") && !LF_MD.includes("\r"), "夹具确实是 CRLF 原文 / 期望是纯 LF");
assert(normalizePreviewContent(LF_MD) === LF_MD, "LF 内容原样返回（不二次改动）");
assert(normalizePreviewContent(normalizePreviewContent(CRLF_MD)) === LF_MD, "规范化幂等");
assert(normalizePreviewContent("") === "" && normalizePreviewContent(undefined) === "", "空/缺失内容安全返回空串");

console.log("A2) CRLF 原文渲染后的偏移记账（DOM 与规范化内容一一对应）");
const stubReact = {
  Fragment: Symbol.for("react.fragment"),
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
  },
};
const { renderNumbered } = new Function("React", `${markdownSrc}\nreturn { renderNumbered };`)(stubReact);

const jsdomDom = new JSDOM("<!doctype html><html><body></body></html>");
const doc = jsdomDom.window.document;

/** stub React 树 → jsdom DOM（只需要结构/文本/属性，事件属性跳过） */
function mount(parent, node) {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) { for (const child of node) mount(parent, child); return; }
  if (typeof node === "string" || typeof node === "number") {
    parent.appendChild(doc.createTextNode(String(node)));
    return;
  }
  const { type, props = {} } = node;
  if (type === stubReact.Fragment) { mount(parent, props.children); return; }
  if (typeof type !== "string") throw new Error(`无法挂载组件节点：${String(type)}`);
  const el = doc.createElement(type);
  for (const [name, value] of Object.entries(props)) {
    if (name === "children" || name === "key" || value === undefined || value === null) continue;
    if (typeof value === "function" || typeof value === "object") continue;
    if (name === "className") el.setAttribute("class", String(value));
    else el.setAttribute(name, value === true ? "" : String(value));
  }
  const kids = Array.isArray(props.children) ? props.children : [props.children];
  for (const child of kids) mount(el, child);
  parent.appendChild(el);
}

const container = doc.createElement("div");
container.className = "dsh-obs-md";
mount(container, renderNumbered(CRLF_MD, { onText: () => {} }));
doc.body.appendChild(container);

const computeLeafSpans = new Function("document", "NodeFilter", `return (${extractFn(clientSrc, "computeLeafSpans")})`)(doc, jsdomDom.window.NodeFilter);
const posToOffset = new Function("Node", `return (${extractFn(clientSrc, "posToOffset")})`)(jsdomDom.window.Node);
const leaves = computeLeafSpans(container);
assert(leaves.length > 10, `渲染出 ${leaves.length} 个偏移文本节点`);

let firstBadLeaf = null;
for (const leaf of leaves) {
  const want = LF_MD.slice(leaf.start, leaf.end);
  if (want !== leaf.node.textContent) { firstBadLeaf = { start: leaf.start, end: leaf.end, want, got: leaf.node.textContent }; break; }
}
assert(firstBadLeaf === null, `每个 [data-obs-src] 满足「规范化内容.slice === 文本」${firstBadLeaf ? `（首个不一致: ${JSON.stringify(firstBadLeaf)}）` : ""}`);
assert(leaves.every((leaf, i) => i === 0 || leaves[i - 1].end <= leaf.start), "节点区间按文档序单调不重叠");

const afterFirstNewline = leaves.filter((leaf) => leaf.start > LF_MD.indexOf("\n"));
assert(afterFirstNewline.length > 0
  && afterFirstNewline.every((leaf) => CRLF_MD.slice(leaf.start, leaf.end) !== leaf.node.textContent),
  "（反证）拿 CRLF 原文按 DOM 偏移切片会错位 —— 这正是必须规范化的原因");

console.log("A3) DOM 选区 → 源码偏移回读（区间切片 === 选中文本）");
let currentSelection = null;
const fakeWindow = { getSelection: () => currentSelection };
const spanFromSelection = new Function("window", "posToOffset", `return (${extractFn(clientSrc, "spanFromSelection")})`)(fakeWindow, posToOffset);

function leafContaining(needle) {
  const leaf = leaves.find((item) => item.node.textContent.includes(needle));
  if (!leaf) throw new Error(`DOM 叶子中没有找到「${needle}」`);
  return leaf;
}
function selectInLeaf(leaf, needle) {
  const rel = leaf.node.textContent.indexOf(needle);
  const range = doc.createRange();
  range.setStart(leaf.node, rel);
  range.setEnd(leaf.node, rel + needle.length);
  currentSelection = { rangeCount: 1, getRangeAt: () => range };
}
function selectAcross(startLeaf, startNeedle, endLeaf, endNeedle) {
  const range = doc.createRange();
  range.setStart(startLeaf.node, startLeaf.node.textContent.indexOf(startNeedle));
  range.setEnd(endLeaf.node, endLeaf.node.textContent.indexOf(endNeedle) + endNeedle.length);
  currentSelection = { rangeCount: 1, getRangeAt: () => range };
}

// 单行（单叶子）选区：粗体 / 普通行 / 引用 / 表格单元格 / 列表项
for (const needle of ["粗体", "第二行普通文本", "引用行文本", "值二", "列表项乙"]) {
  const start = LF_MD.indexOf(needle);
  selectInLeaf(leafContaining(needle), needle);
  const span = spanFromSelection(container, leaves, LF_MD);
  const ok = span !== null
    && span.start === start && span.end === start + needle.length
    && span.text === needle && span.mode === "preview"
    && LF_MD.slice(span.start, span.end) === span.text;
  assert(ok, `「${needle}」→ [${start}, ${start + needle.length}) 回读一致${ok ? "" : `（实得 ${JSON.stringify(span)}）`}`);
}

// 跨行选区：第 3 行 → 第 4 行，必须连带中间的换行
{
  const wantStart = LF_MD.indexOf("第一段");
  const wantEnd = LF_MD.indexOf("第二行普通文本") + "第二行普通文本".length;
  selectAcross(leafContaining("第一段"), "第一段", leafContaining("第二行普通文本"), "第二行普通文本");
  const span = spanFromSelection(container, leaves, LF_MD);
  assert(span !== null && span.start === wantStart && span.end === wantEnd
    && span.text === LF_MD.slice(wantStart, wantEnd)
    && span.text.includes("\n") && !span.text.includes("\r"),
    `跨行选区 → [${wantStart}, ${wantEnd}) 回读一致（含换行、不含 CR）`);
}

// 反证：如果映射仍拿 CRLF 原文（修复前的写法），回读文本会错位
{
  selectInLeaf(leafContaining("第二行普通文本"), "第二行普通文本");
  const buggy = spanFromSelection(container, leaves, CRLF_MD);
  assert(buggy === null || buggy.text !== "第二行普通文本",
    "（反证）选区映射若用 CRLF 原文，回读文本错位 —— 即本次修复点");
}

console.log("A4) 注入 prompt 的行数/原文取自规范化内容");
const offsetToLine = new Function(`return (${extractFn(clientSrc, "offsetToLine")})`)();
const selLimitMatch = /const SEL_CHAR_LIMIT = (\d+);/.exec(clientSrc);
if (!selLimitMatch) throw new Error("const SEL_CHAR_LIMIT not found in src/client.js");
const buildPrompt = new Function("offsetToLine", "SEL_CHAR_LIMIT", `return (${extractFn(clientSrc, "buildPrompt")})`)(offsetToLine, Number(selLimitMatch[1]));

{
  selectInLeaf(leafContaining("粗体"), "粗体");
  const span = spanFromSelection(container, leaves, LF_MD);
  const lines = buildPrompt("D:\\vault\\a.md", LF_MD, span, "这是什么？").split("\n");
  assert(lines[0] === "@D:\\vault\\a.md", "第一行：@绝对路径");
  assert(lines[1] === "第 3 行", `第二行：行号按规范化内容计（实得「${lines[1]}」）`);
  assert(lines[2] === "> 粗体", `第三行：选中原文（实得「${lines[2]}」）`);
  assert(!lines.join("\n").includes("\r"), "prompt 不含 CR");
}

console.log("A5) 接线回归：预览渲染/选区/提问都走规范化内容");
assert(/function normalizePreviewContent\(content\)/.test(clientSrc), "client 提供 normalizePreviewContent 纯函数");
assert(clientSrc.includes("normalizePreviewContent(note.content)"), "Dock 由 note.content 生成 previewContent");
assert(clientSrc.includes("renderNumbered(previewContent"), "预览入口 renderNumbered 接收 previewContent");
assert(clientSrc.includes("spanFromSelection(previewRef.current, leavesRef.current, previewContent)"), "预览选区映射用 previewContent");
assert(clientSrc.includes("content: previewContent"), "选中提问的 content 用 previewContent");
assert(!clientSrc.includes("renderNumbered(note.content")
  && !clientSrc.includes("spanFromSelection(previewRef.current, leavesRef.current, note.content)"),
  "没有残留用原始 note.content 做预览渲染/选区映射的路径（防回退）");

// ═════════════════════════ B. 原型回归（本地有 prototype/ 才跑）════════════════════
const protoHtmlPath = join(root, "prototype", "selection-ask.html");
if (!existsSync(protoHtmlPath)) {
  console.log("B) 原型回归跳过：prototype/selection-ask.html 不存在（原型不随仓库分发）");
} else {
  const html = readFileSync(protoHtmlPath, "utf8");
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
  const { window } = dom;
  const proto = window.__selectionAskProto;

  console.log("原型 1) 渲染器偏移记账（源码 ↔ 内容一致性）");
  const protoLeaves = proto.leaves;
  assert(protoLeaves.length > 10, `渲染出 ${protoLeaves.length} 个文本节点`);
  let allConsistent = true;
  let bad = null;
  for (const leaf of protoLeaves) {
    const [s, e] = leaf.__src;
    const srcSlice = proto.MD.slice(s, e);
    if (srcSlice !== leaf.textContent) { allConsistent = false; bad = { s, e, src: srcSlice, got: leaf.textContent }; break; }
  }
  assert(allConsistent, `每个节点 __src 切片 === textContent${bad ? `（首个不一致: ${JSON.stringify(bad)}）` : ""}`);
  const sorted = protoLeaves.every((leaf, i) => i === 0 || protoLeaves[i - 1].__src[1] <= leaf.__src[0]);
  assert(sorted, "节点区间文档序单调不重叠");

  console.log("原型 2) 双向映射：源码偏移 → 反选 → 回读");
  const TESTS = [
    ["标题片段", "交互方案.md"],
    ["半截行内", "片段提问"],
    ["跨行段落", "渲染时给每个文本节点记录"],
    ["代码内文本", "@D:\\obsidian"],
    ["表格单元格", "DOM Range"],
    ["引用+粗体", "只填充、不自动发送"],
    ["列表项", "第一项"],
    ["双链", "双链跳转"],
    ["跨块大选区", "对照表\n\n| 环节 | 预览态"],
  ];
  let allRoundtrip = true;
  for (const [name, needle] of TESTS) {
    const idx = proto.MD.indexOf(needle);
    if (idx === -1) { console.error(`  ✗ ${name}: 源中未找到「${needle}」`); failed++; allRoundtrip = false; continue; }
    const ok = proto.selectByOffsets(idx, idx + needle.length);
    if (!ok) { console.error(`  ✗ ${name}: 反选失败（起止点落在语法符区?）`); failed++; allRoundtrip = false; continue; }
    const span = proto.getSelectionSpan();
    const pass = span && span.start === idx && span.end === idx + needle.length && span.text === needle && span.mode === "preview";
    if (pass) { passed++; console.log(`  ✓ ${name}: [${idx}, ${idx + needle.length}) → 回读一致`); }
    else { failed++; allRoundtrip = false; console.error(`  ✗ ${name}: 回读=${span ? JSON.stringify({ start: span.start, end: span.end, text: JSON.stringify(span.text) }) : "null"}，期望 [${idx}, ${idx + needle.length})「${JSON.stringify(needle)}」`); }
  }
  assert(allRoundtrip, "9 组用例全部回读一致");

  console.log("原型 3) 注入内容生成（第一行@文件名 / 第二行行数 / 第三行选中内容 / 末行问题，无空行）");
  const short = { text: "片段提问", start: proto.MD.indexOf("片段提问"), end: proto.MD.indexOf("片段提问") + "片段提问".length };
  const inj = proto.buildInjection(short, "这是什么？");
  const L = inj.split("\n");
  assert(L[0] === `@${"D:\\obsidian_vault\\产品设计\\交互方案.md"}` && !inj.includes("文件名："), "第一行：@绝对路径（文件名不重复提及）");
  assert(/^第 \d+ 行$/.test(L[1]), "第二行：行数（第 X 行）");
  assert(L[2] === "> 片段提问", "第三行：选中内容（> 引用）");
  assert(L[L.length - 1] === "【问题】这是什么？", "末行：用户问题");
  assert(!inj.includes("\n\n"), "无多余空行");
  const injExplain = proto.buildInjection(short, "");
  assert(injExplain.split("\n").pop() === "【问题】请解释这段内容", "解释场景：用默认问题");
  const long = { text: "x".repeat(proto.CHAR_LIMIT + 100), start: 0, end: proto.CHAR_LIMIT + 100 };
  const inj2 = proto.buildInjection(long, "解释一下");
  const L2 = inj2.split("\n");
  assert(/^第 \d+–\d+ 行$/.test(L2[1]) && L2[2].includes("（片段较长") && !inj2.includes("x".repeat(200)), "长片段：行数 + 不贴原文");
  assert(L2[L2.length - 1] === "【问题】解释一下" && !inj2.includes("\n\n"), "长片段：末行问题 + 无空行");

  console.log("原型 4) 浮层在「聚焦输入框清空选区后」不消失（修复一闪即逝）");
  const popInput = window.document.getElementById("pop-input");
  const popActions = window.document.getElementById("pop-actions");
  // 首次显示：走 !inputOpen 分支，从 selection 计算 currentSpan/currentRect
  const idx = proto.MD.indexOf("片段提问");
  proto.selectByOffsets(idx, idx + 4);
  proto.showPop();
  assert(popActions.classList.contains("show"), "首次选中：浮现「💬 提问」工具条");
  // 模拟点击「💬 提问」→ 进入输入态并聚焦 input（浏览器聚焦会清空 document selection）
  window.document.getElementById("btn-ask").click();
  assert(popInput.classList.contains("show"), "点击提问：进入输入框");
  assert(!popActions.classList.contains("show"), "工具条收起，输入框展开");
  // 模拟聚焦 input 后 selection 被清空（rangeCount=0），再触发 mouseup 的 showPop
  window.getSelection().removeAllRanges();
  proto.showPop();
  assert(popInput.classList.contains("show"), "selection 清空后再 showPop：输入框保持显示（不再消失）");
  // 点「发送」按钮：应提交并注入到对话输入框、收起浮层
  const q = window.document.getElementById("pop-question");
  q.value = "你好测试";
  window.document.getElementById("pop-send").click();
  const composer = window.document.getElementById("composer");
  assert(composer.value.includes("你好测试") && composer.value.includes("交互方案.md"), "点「发送」按钮：注入内容到对话输入框（含问题）");
  assert(!popInput.classList.contains("show"), "发送后：提问浮层收起");
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
