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

const factory = new Function("React", `${code}\nreturn { renderMarkdown, renderNumbered };`);
const { renderMarkdown, renderNumbered } = factory(React);

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
// M7：按钮显示目标名（去掉 [[ ]] 原文），按钮仍在（块渲染器同样走 renderInline）
check("wikilink button 显示目标名", flat.includes("<button>") && text.includes("双链A") && !text.includes("[[双链A]]"));
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
// 双链别名/章节：显示文本 + title + onWikilink 回调参数（M7）
{
  const targets = [];
  const t = renderMarkdown("[[别名|显示]] 与 [[章节#片段]]", { onWikilink: (x) => targets.push(x) });
  const buttons = findAll(t, (p) => typeof p.title === "string" && p.title.startsWith("[["));
  check("wikilink 2 buttons", buttons.length === 2, `n=${buttons.length}`);
  const buttonTexts = buttons.map((b) => textOf(b));
  check("wikilink 显示别名", buttonTexts[0] === "显示", JSON.stringify(buttonTexts));
  check("wikilink 显示 target › 章节", buttonTexts[1] === "章节 › 片段", JSON.stringify(buttonTexts));
  check("wikilink 显示无 [[ ]] 原文", !textOf(t).includes("[[") && !textOf(t).includes("]]"), JSON.stringify(textOf(t)));
  check("wikilink title 保持 [[target]]",
    buttons.length === 2 && buttons[0].props.title === "[[别名]]" && buttons[1].props.title === "[[章节]]",
    JSON.stringify(buttons.map((b) => b.props.title)));
  for (const b of buttons) b.props.onClick();
  check("wikilink alias target", targets.includes("别名"), JSON.stringify(targets));
  check("wikilink section target", targets.includes("章节"), JSON.stringify(targets));
  check("wikilink 回调只传 target", JSON.stringify(targets) === JSON.stringify(["别名", "章节"]), JSON.stringify(targets));
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

// callout：`> [!type] 标题` 应渲染成 .dsh-obs-callout（而不是普通 blockquote）
{
  const t = renderMarkdown("> [!important] 一句话总结\n> 可控交付 = 明确对象 + 完整证据。", {});
  const roots = findAll(t, (p) => p.className === "dsh-obs-callout");
  check("callout root", roots.length === 1, `n=${roots.length}`);
  check("callout 类型别名 important→tip", roots[0]?.props["data-callout"] === "tip", String(roots[0]?.props["data-callout"]));
  const text = textOf(t);
  check("callout 标题与正文", text.includes("一句话总结") && text.includes("可控交付"), JSON.stringify(text));
  // 严格口径（契约 §4.6，Lead 裁决）：有显式标题时不显示类型默认名「提示」（important→tip）
  check("callout 有显式标题时不显示类型默认名", !text.includes("提示"), JSON.stringify(text));
  check("callout 不再输出裸 [!important]", !text.includes("[!important]"), JSON.stringify(text));
  // 整块只剩一个 callout，说明被吸收进了 callout 而不是又渲染一个 blockquote
  check("callout 不重复渲染引用块", collect(t).filter((x) => x === "<blockquote>").length === 0, JSON.stringify(collect(t)));
  // 无标题时回落到类型名
  const noTitle = renderMarkdown("> [!warning]\n> 注意电压。", {});
  check("callout 无标题回落", textOf(noTitle).includes("注意"), JSON.stringify(textOf(noTitle)));
  // 普通引用不受影响
  const plain = renderMarkdown("> 普通引用", {});
  check("普通引用仍是 blockquote", collect(plain).includes("<blockquote>") && collect(plain).filter((x) => x === "<div>").length === 0);
}
// callout：行号预览态逐行加组内样式（这是笔记面板实际使用的渲染路径）
{
  const t = renderNumbered("> [!warning] 风险\n> A/B 路不得同源。\n\n普通行", {});
  const rows = findAll(t, (p) => typeof p.className === "string" && p.className.includes("dsh-obs-md-row"));
  const head = rows.filter((r) => (r.props.children?.[1]?.props?.className ?? "").includes("dsh-obs-md-callout-head"));
  const end = rows.filter((r) => r.props.className.includes("dsh-obs-md-callout-end"));
  check("numbered callout 首行", head.length === 1, `n=${head.length}`);
  check("numbered callout 末行", end.length === 1, `n=${end.length}`);
  // 严格口径（契约 §4.6，Lead 裁决）：有显式标题「风险」时徽标只显示图标、标题单独显示，不出现类型默认名「注意」
  check("numbered callout 显式标题", rows.some((r) => textOf(r).includes("风险")), JSON.stringify(rows.map(textOf)));
  check("numbered callout 不显示类型默认名", !textOf(t).includes("注意"), textOf(t));
  check("numbered callout 去掉了裸标记", !textOf(t).includes("[!warning]"), textOf(t));
  check("numbered 普通行不分组", rows.some((r) => r.props["data-callout-group"] === undefined && textOf(r).includes("普通行")));
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
