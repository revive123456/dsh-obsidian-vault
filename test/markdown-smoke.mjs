/** Markdown 渲染器冒烟测试（stub React.createElement 收集结构树）。 */
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

const factory = new Function("React", `${code}\nreturn renderMarkdown;`);
const renderMarkdown = factory(React);

const md = [
  "# 标题一",
  "",
  "普通段落 **加粗** 和 *斜体* 与 `code` 还有 [[双链A]]。",
  "",
  "## 标题二",
  "",
  "- 列表项 1",
  "- 列表项 2",
  "",
  "> 引用块",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "---",
  "",
  "[链接](https://example.com) 与图片 ![alt](https://example.com/x.png)",
].join("\n");

const tree = renderMarkdown(md, { onWikilink: () => { } });

const failures = [];
function check(name, cond) {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failures.push(name);
}
function collect(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node !== "object") { out.push(`text:${String(node)}`); return out; }
  if (Array.isArray(node)) { for (const n of node) collect(n, out); return out; }
  out.push(`<${String(node.type)}>`);
  if (node.props && node.props.children !== undefined) collect(node.props.children, out);
  return out;
}

const flat = collect(tree);
const text = JSON.stringify(flat);
check("h3 heading", flat.includes("<h3>"));
check("h4 heading", flat.includes("<h4>"));
check("strong", flat.includes("<strong>"));
check("em", flat.includes("<em>"));
check("inline code", flat.includes("<code>"));
check("wikilink button", flat.includes("<button>") && text.includes("[[双链A]]"));
check("ul list", flat.includes("<ul>"));
check("blockquote", flat.includes("<blockquote>"));
check("fenced code pre", flat.includes("<pre>"));
check("table", flat.includes("<table>"));
check("hr", flat.includes("<hr>"));
check("link a", flat.includes("<a>"));
check("img", flat.includes("<img>"));

// ── 语法补充 ────────────────────────────────────────────────────────────────
function findAll(node, pred, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out; }
  if (typeof node !== "object") return out;
  if (pred(node.props ?? {}, node)) out.push(node);
  const kids = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
  for (const k of kids) findAll(k, pred, out);
  return out;
}
function textOf(node, out = "") {
  if (node === null || node === undefined) return out;
  if (typeof node !== "object") return out + String(node);
  const kids = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
  return kids.reduce((acc, k) => textOf(k, acc), out);
}

// 标题降级：### → h5、#### → h6
{
  const t5 = renderMarkdown("### 五级", {});
  const t6 = renderMarkdown("#### 六级", {});
  check("h5 heading", collect(t5).includes("<h5>"));
  check("h6 heading", collect(t6).includes("<h6>"));
}
// 有序列表 + __粗体__ 变体
{
  const ol = renderMarkdown("1. first\n2. second", {});
  const olFlat = collect(ol);
  check("ol list", olFlat.includes("<ol>") && olFlat.filter((x) => x === "<li>").length === 2);
  const b = renderMarkdown("__强调__", {});
  check("bold with __", collect(b).includes("<strong>"));
}
// 双链别名/章节 + onWikilink 回调参数
{
  const targets = [];
  const t = renderMarkdown("[[别名|显示]] 与 [[章节#片段]]", { onWikilink: (x) => targets.push(x) });
  const buttons = findAll(t, (p) => typeof p.title === "string" && p.title.startsWith("[["));
  check("wikilink 2 buttons", buttons.length === 2, `n=${buttons.length}`);
  for (const b of buttons) b.props.onClick();
  check("wikilink alias target", targets.includes("别名"), JSON.stringify(targets));
  check("wikilink section target", targets.includes("章节"), JSON.stringify(targets));
}
// 链接/图片属性 + 危险协议过滤
{
  const a = findAll(renderMarkdown("[x](https://e.com)", {}), (p) => p.href !== undefined);
  check("link href prop", a.length === 1 && a[0].props.href === "https://e.com");
  const img = findAll(renderMarkdown("![alt](https://e.com/i.png)", {}), (p) => typeof p.src === "string");
  check("img src/alt props", img.length === 1 && img[0].props.src === "https://e.com/i.png" && img[0].props.alt === "alt");
  const js = renderMarkdown("[x](javascript:alert(1))", {});
  const jsFlat = collect(js);
  check("javascript: link not anchor", !jsFlat.includes("<a>") && JSON.stringify(jsFlat).includes("javascript"), JSON.stringify(jsFlat));
  const jsImg = renderMarkdown("![a](javascript:alert(1))", {});
  check("javascript: img not element", !collect(jsImg).includes("<img>"));
}
// 表格结构（thead/th 存在）
{
  const tb = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |", {});
  const tbFlat = collect(tb);
  check("table thead/th", tbFlat.includes("<thead>") && tbFlat.includes("<th>") && tbFlat.includes("<tbody>"));
}
// 围栏代码内容保留
{
  const pre = findAll(renderMarkdown("```js\nconst x = 1;\n```", {}), (p) => typeof p.className === "string" && p.className === "dsh-obs-code");
  check("fenced code content", pre.length === 1 && textOf(pre[0]).includes("const x = 1;"));
}

// 安全：<script> 只能以文本节点出现，绝不能成为元素节点（React 文本子节点天然转义）
const evil = renderMarkdown("<script>alert(1)</script>", {});
const evilFlat = collect(evil);
check("html not element", !evilFlat.includes("<script>") && !evilFlat.includes("<img>"));
check("html kept as text", JSON.stringify(evilFlat).includes("<script>alert(1)</script>"));

// 空笔记
const empty = renderMarkdown("", {});
check("empty note", empty !== null);

if (failures.length > 0) {
  console.error(`\n${failures.length} markdown check(s) FAILED`);
  process.exit(1);
}
console.log("\nall markdown smoke checks passed ✔");
