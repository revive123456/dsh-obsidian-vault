/**
 * 「选中片段提问」核心不变量无头验证（从交互原型提炼，逻辑可复用于插件实现）：
 *  1) 渲染器：每个文本节点的 __src=[start,end) 满足 MD.slice(start,end) === textContent（源码↔内容一致）
 *  2) 双向映射：按源码偏移反选（selectByOffsets）后 getSelectionSpan 能精确回读同样的偏移与文本
 *  3) 注入 prompt：@路径 / 行数 / > 选中内容 / 【问题】，无多余空行；长片段转行号提示
 *  4) 浮层在聚焦输入框清空选区后不消失；点「发送」注入并收起
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const protoHtmlPath = join(root, "prototype", "selection-ask.html");
// prototype/ 为开发原型，不纳入仓库；缺失时本测试（仅验证原型标记逻辑）直接跳过，
// 避免干净克隆跑测试套件时因缺少原型而失败。
if (!existsSync(protoHtmlPath)) {
  console.log("selection-ask.mjs skipped: prototype/selection-ask.html 不存在（原型不随仓库分发）。如需跑此测试，请本地保留该文件。");
  process.exit(0);
}
const html = readFileSync(protoHtmlPath, "utf8");
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
const { window } = dom;
const proto = window.__selectionAskProto;

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

console.log("1) 渲染器偏移记账（源码 ↔ 内容一致性）");
const leaves = proto.leaves;
assert(leaves.length > 10, `渲染出 ${leaves.length} 个文本节点`);
let allConsistent = true;
let bad = null;
for (const leaf of leaves) {
  const [s, e] = leaf.__src;
  const srcSlice = proto.MD.slice(s, e);
  if (srcSlice !== leaf.textContent) { allConsistent = false; bad = { s, e, src: srcSlice, got: leaf.textContent }; break; }
}
assert(allConsistent, `每个节点 __src 切片 === textContent${bad ? `（首个不一致: ${JSON.stringify(bad)}）` : ""}`);
const sorted = leaves.every((l, i) => i === 0 || leaves[i - 1].__src[1] <= l.__src[0]);
assert(sorted, "节点区间文档序单调不重叠");

console.log("2) 双向映射：源码偏移 → 反选 → 回读");
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

console.log("3) 注入内容生成（第一行@文件名 / 第二行行数 / 第三行选中内容 / 末行问题，无空行）");
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

console.log("4) 浮层在「聚焦输入框清空选区后」不消失（修复一闪即逝）");
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

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
