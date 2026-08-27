/**
 * markdown 偏移记账测试（对 src/markdown.js 的 onText 路径）：
 *  1) 每个文本片段 span 的 data-obs-src 区间切片 === 该 span 文本
 *     （即 MD.slice(start,end) === textContent，源码↔内容精确一致）
 *  2) 各区间按文档序单调不重叠
 *  覆盖标题/段落（含行内语法）/行内代码/链接/wikilink/代码块/引用/列表/表格/多行段落。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const code = readFileSync(join(root, "src", "markdown.js"), "utf8");

const Fragment = Symbol.for("react.fragment");
function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
}
const React = { Fragment, createElement };
const renderMarkdown = new Function("React", `${code}\nreturn renderMarkdown;`)(React);

const MD = [
  "# 标题一",
  "",
  "普通段落 **加粗** 和 *斜体* 与 `code` 还有 [[双链A]]。",
  "",
  "这是第二行内容的段落，**跨行**测试。",
  "它延续到下一行。",
  "",
  "> 引用：**强调** 与 [[引用链]]。",
  "",
  "- 列表项 **一**",
  "- 列表项 二",
  "",
  "```js",
  "const x = 1; // 注释",
  "```",
  "",
  "| 列A | 列B |",
  "| --- | --- |",
  "| 单元格1 | 单元格2 |",
  "",
  "[链接文字](https://example.com) 与 ![图](https://example.com/a.png)",
].join("\n");

// 收集所有带 data-obs-src 的 span 文本与偏移
const spans = [];
(function walk(node) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const n of node) walk(n); return; }
  if (typeof node !== "object") return;
  if (node.props && typeof node.props["data-obs-src"] === "string" && node.props.className === "dsh-obs-src") {
    spans.push({ src: node.props["data-obs-src"], text: textOf(node) });
  }
  const kids = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
  for (const k of kids) walk(k);
})(renderMarkdown(MD, { onText: () => {} }));

function textOf(node, out = "") {
  if (node === null || node === undefined) return out;
  if (typeof node !== "object") return out + String(node);
  const kids = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
  return kids.reduce((acc, k) => textOf(k, acc), out);
}

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

console.log(`1) 偏移记账（${spans.length} 个文本片段）`);
assert(spans.length > 10, `渲染出 ${spans.length} 个带偏移的文本片段`);
let allExact = true, bad = null;
for (const s of spans) {
  const [a, b] = s.src.split(",").map(Number);
  const slice = MD.slice(a, b);
  if (slice !== s.text || !(Number.isInteger(a) && Number.isInteger(b) && b >= a)) { allExact = false; bad = { a, b, slice, text: s.text }; break; }
}
assert(allExact, `每个片段 data-obs-src 切片 === 文本${bad ? `（首个不一致: ${JSON.stringify(bad)}）` : ""}`);

const ranges = spans.map((s) => s.src.split(",").map(Number));
const sorted = ranges.every((r, i) => i === 0 || ranges[i - 1][1] <= r[0]);
assert(sorted, "各偏移区间文档序单调不重叠");

console.log("2) 关键区块存在且可反查");
// 反查：在源码里选一段（起止落在可见文本节点内），应能由相邻 span 区间覆盖
function roundtrip(start, end, label) {
  const covered = ranges.some((r) => r[0] <= start && end <= r[1]);
  assert(covered, `范围 [${start},${end}) 落在某个片段内 ` + label);
}
roundtrip(MD.indexOf("加粗"), MD.indexOf("加粗") + "加粗".length, "(粗体)");
roundtrip(MD.indexOf("双链A"), MD.indexOf("双链A") + "双链A".length, "(wikilink)");
roundtrip(MD.indexOf("单元格2"), MD.indexOf("单元格2") + "单元格2".length, "(表格)");
roundtrip(MD.indexOf("const x = 1;"), MD.indexOf("const x = 1;") + "const x = 1;".length, "(代码块)");

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
