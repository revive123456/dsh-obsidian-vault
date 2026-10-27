/**
 * Obsidian P2a 面板路径测试（M14：P1 遗留小修 + data-line-no；M10：行内 scanner 重写）
 *
 * 只测面板实际使用的 renderNumbered；加载方式同 test/obsidian-syntax.mjs
 * （读 src/markdown.js，new Function("React", ...)，stub createElement 收树）。
 *
 * 覆盖（方案 §4 M14/M10 + P2 契约 §3.7/§12）：
 *   M14-A data-line-no 前置：所有行号元素带 data-line-no，且与行号文本一致；
 *   M14-B1 4 空格缩进代码块（块起始开启、多行、tab、EOF、遇普通行结束、不抢占列表）；
 *   M14-B2 `* * *` / `- - -` 带空格水平线；
 *   M14-B3 表格 `[[A\|B]]`：口径以真机 Oracle 为准 → target=A、显示 B（方案原文作废）；
 *   M14-B4 setext 前导空格：真机 Oracle 不支持 → 不做，fixture 断言「不识别」作回归护栏；
 *   M10-A 转义（\X / \\ / 不可转义字符）；
 *   M10-B 单/双/三反引号行内代码（去定界符 + 纯文本 span，不产 code 元素）；
 *   M10-C 嵌套强调（CommonMark flanking）与词中下划线（修 P1 吞字符）；
 *   M10-D 删除线 ~~ / 高亮 ==；
 *   M10-E 自动链接 <https://…> / mailto 与裸 URL（尾随标点剥离）；
 *   M10-F 标签 #tag（纯数字不算、代码内不算）；
 *   M10-F2 注释 %%…%%（Oracle：仅单行内隐藏，跨行不隐藏）；
 *   M10-J 块注释（行首 `%%` 开始 → 整段隐藏、行号照常；未闭合隐藏到文末；>3 空格/tab 不识别；\n *         闭合行 `%%` 之后的同行文本可见，`%%%%` 行按行内空注释对处理）；
 *   M10-G 硬换行（行尾两空格 / 反斜杠）；
 *   M10-H/M10-I 双链转义管道（Oracle 口径 target=A/显示 B）与 onClick(target, anchor)。
 *
 * 每个 fixture 至少「结构 + 文本/偏移」两类断言；所有 fixture 再跑两条全量不变量
 * （行号覆盖、偏移记账，均按 P2 契约 §5 口径）。断言失败信息带 fixture id。
 *
 * 运行：DEBUG_FIXTURE=<id> node test/obsidian-p2a.mjs 可打印该片段渲染树。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const code = readFileSync(join(root, "src", "markdown.js"), "utf8");

// ── stub React.createElement 收集元素树（同 test/obsidian-syntax.mjs）──
const Fragment = Symbol.for("react.fragment");
function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
}
const React = { Fragment, createElement };
const { renderNumbered } = new Function("React", `${code}\nreturn { renderNumbered };`)(React);

// ── M14 fixtures（方案附录 B「小修」清单 + Oracle 结论）────────────────────
const FIXTURES = [
  // 单行缩进代码块，吃到 EOF
  { id: "indented-code", md: "    indented code" },
  // 多行：空格/tab 混用、代码内不解析行内、遇普通行结束、前面有空行才开启
  {
    id: "indented-code-mixed",
    md: "前文\n\n    const a = 1;\n    **不是粗体**\n\ttab 缩进\n普通行（结束）",
  },
  // 段落下一行的 4 空格缩进保持段落（CommonMark 缩进代码不能打断段落；Oracle 同）
  { id: "indented-code-after-paragraph", md: "段落\n    still paragraph" },
  // 带空格的水平线：* * * / - - -（Oracle 均为 hr）
  { id: "hr-spaced", md: "上\n\n* * *\n\n中\n\n- - -\n\n下" },
  // 表格里的转义管道：Oracle 下 `[[A\|B]]` 是「target=A、显示 B」；另带普通单元格 `a \| b`
  { id: "table-escape-wikilink", md: "| 列 | 值 |\n| --- | --- |\n| [[A\\|B]] | c |\n| a \\| b | d |" },
  // setext 前导空格：Oracle 不支持（`  ===` 是普通文本、`   ---` 是 hr），断言不识别
  { id: "setext-leading-space", md: "Setext 一级\n  ===\n\nSetext 二级\n   ---" },

  // ── P2 inline（M10 行内 scanner，方案附录 B / 契约 §3.7）──────────────────
  { id: "escape", md: "\\*不是斜体\\* \\# 不是标题 \\[\\[不是双链]]" },
  { id: "escape-backslash", md: "两条反斜杠：\\\\ 与转义星号 \\* 与不转义 \\a" },
  { id: "code-double-backtick", md: "`code` 与 `` a ` b `` 与 `*不解析*`" },
  { id: "code-triple", md: "三反引号 ```x`` y``` 结束" },
  { id: "nested-em", md: "***粗斜体*** 和 **粗 *内斜* 粗** 和 __x__ 和 _x_" },
  { id: "underscore-words", md: "LINK_TYPE_P1=2 和 ib_send_lat 和 a_b_c 和 _x_ 和 __y__" },
  { id: "strike", md: "~~删除~~ 和 ~~删除 **粗**~~" },
  { id: "highlight", md: "==高亮== 和 ==高亮 `code`==" },
  { id: "autolink", md: "<https://example.com> 与 [外链](https://example.com) 与 <mailto:a@b.c>" },
  { id: "bare-url", md: "见 https://example.com/a, 然后 https://example.com/b. 再来 https://example.com/c。 结束" },
  { id: "tags", md: "#标签 #父/子 #tag-name #123 与 `#不是标签`" },
  { id: "comment-inline", md: "前面 %%隐藏内容%% 后面" },
  { id: "comment-multiline", md: "前 %%多行\n注释%% 后" },
  // 块注释（P2 M10 补丁，真机 Oracle 口径）：行首 `%%` 开始 → 整段隐藏、每行照常占号
  { id: "comment-block", md: "前\n%%\n隐藏块注释\n%%\n后" },
  { id: "comment-block-unclosed", md: "前\n%%\n后面没有结束行" },
  { id: "comment-block-indent", md: "前\n  %%\n  hidden\n  %%\n后" },
  { id: "comment-block-indent4", md: "前\n    %%\n    hidden\n    %%\n后" },
  { id: "comment-block-delim-text", md: "%% 开始\nhidden\n%% 结束" },
  { id: "comment-percent-only", md: "前\n%%\n后" },
  { id: "comment-block-quad", md: "前\n%%%%\nhidden\n%%%%\n后" },
  { id: "comment-block-in-list", md: "- 项一\n  %%\n  隐藏\n  %%\n- 项二" },
  { id: "comment-block-in-callout", md: "> [!note] 标题\n> %%\n> 隐藏\n> %%" },
  { id: "comment-block-content-md", md: "前\n%%\n# 不是标题\n```\n不是围栏\n```\n%%\n后" },
  { id: "comment-block-tab", md: "前\n\t%%\n\thidden\n\t%%\n后" },
  { id: "hardbreak", md: "第一行  \n第二行\\\n第三行" },
  { id: "wikilink-escaped-pipe", md: "段落里 [[A\\|B]] 结束" },
  { id: "wikilink-anchor", md: "[[笔记A#标题]] 与 [[笔记A]] 与 [[#标题]]" },
];
const FIXTURES_BY_ID = Object.fromEntries(FIXTURES.map((f) => [f.id, f]));
const normMd = (md) => md.replace(/\r\n/g, "\n");

// 面板真实传参（src/client.js：renderNumbered(note.content, { onWikilink, onText, assetUrl })）
const HANDLERS = {
  onText: () => {},
  onWikilink: () => {},
  assetUrl: (rel) => `/obsidian/file?path=${encodeURIComponent(rel)}`,
};
const renderCache = new Map();
function renderFor(id) {
  if (!renderCache.has(id)) renderCache.set(id, renderNumbered(FIXTURES_BY_ID[id].md, HANDLERS));
  return renderCache.get(id);
}

// ── 序列化 / 查询 helper（与 obsidian-syntax.mjs 同口径的极简副本）──────────
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
function walk(node, visit, parent = null) {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit, parent);
    return;
  }
  if (typeof node !== "object") {
    visit(node, parent);
    return;
  }
  visit(node, parent);
  for (const c of childrenOf(node)) walk(c, visit, node);
}
function findNodes(root, pred) {
  const out = [];
  walk(root, (node, parent) => {
    if (isElement(node) && pred(node, parent)) out.push({ node, parent });
  });
  return out;
}
function findAll(root, pred) {
  return findNodes(root, pred).map((x) => x.node);
}
function attrsText(props) {
  const parts = [];
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === "children" || k === "key" || typeof v === "function" || v === undefined) continue;
    if (v === true) parts.push(k);
    else if (typeof v === "string" || typeof v === "number") parts.push(`${k}="${v}"`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}
function serialize(node) {
  if (node === null || node === undefined) return "";
  if (typeof node !== "object") return String(node);
  const name = localName(node);
  const kids = childrenOf(node);
  const open = `<${name}${attrsText(node.props)}>`;
  if (kids.length === 0) return open.slice(0, -1) + " />";
  return `${open}${kids.map((k) => serialize(k)).join("")}</${name}>`;
}
function brief(node, max = 320) {
  const s = serialize(node);
  return s.length > max ? `${s.slice(0, max)}…（共 ${s.length} 字符）` : s;
}
function treeDump(node, depth = 0) {
  const pad = "  ".repeat(depth);
  if (node === null || node === undefined) return "";
  if (typeof node !== "object") return `${pad}${String(node)}\n`;
  const name = localName(node);
  const kids = childrenOf(node);
  if (kids.length === 0) return `${pad}<${name}${attrsText(node.props)} />\n`;
  return `${pad}<${name}${attrsText(node.props)}>\n${kids.map((k) => treeDump(k, depth + 1)).join("")}${pad}</${name}>\n`;
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
function hasClass(node, cls) {
  return isElement(node) && classList(node).includes(cls);
}
function dataOf(node, name) {
  return isElement(node) ? node.props?.[name] : undefined;
}
const countOf = (text, sub) => text.split(sub).length - 1;

function topBlocks(tree) {
  return childrenOf(tree);
}
function rowNumOf(block) {
  if (!isElement(block) || !hasClass(block, "dsh-obs-md-row")) return NaN;
  const ln = childrenOf(block).find((c) => isElement(c) && Object.prototype.hasOwnProperty.call(c.props ?? {}, "data-line-no"));
  const num = ln ? Number(String(dataOf(ln, "data-line-no"))) : NaN;
  return Number.isInteger(num) ? num : NaN;
}
function rowMapOf(tree) {
  const map = new Map();
  for (const block of topBlocks(tree)) {
    const num = rowNumOf(block);
    if (Number.isInteger(num)) map.set(num, block);
  }
  return map;
}
function rowOf(id, tree, num) {
  const row = rowMapOf(tree).get(num);
  if (!row) {
    const nums = [...rowMapOf(tree).keys()];
    check(id, `第 ${num} 行有行号行（不吞行）`, false, `第 ${num} 行没渲染出来；已有行号：${nums.length > 0 ? nums.join(",") : "（无）"}`);
  }
  return row;
}
function lcOf(row) {
  const kids = childrenOf(row);
  return kids.find((c) => hasClass(c, "dsh-obs-md-lc")) ?? null;
}
function lcText(row) {
  const lc = lcOf(row);
  return lc === null ? "" : textOf(lc);
}
function tablesOf(tree) {
  return findAll(tree, (n) => hasClass(n, "dsh-obs-md-tablewrap"));
}
function allCells(tr) {
  return tr ? childrenOf(tr).filter(isElement) : [];
}
function dataCells(tr) {
  return allCells(tr).filter((c) => !hasClass(c, "dsh-obs-md-tln") && !hasClass(c, "dsh-obs-md-tsep-cell"));
}
function tableParts(wrap) {
  const table = wrap ? findAll(wrap, (n) => localName(n) === "table")[0] ?? null : null;
  const thead = table ? findAll(table, (n) => localName(n) === "thead")[0] ?? null : null;
  const tbody = table ? findAll(table, (n) => localName(n) === "tbody")[0] ?? null : null;
  const headerTr = thead ? findAll(thead, (n) => localName(n) === "tr")[0] ?? null : null;
  const bodyRows = tbody ? findAll(tbody, (n) => hasClass(n, "dsh-obs-md-trow")) : [];
  return { wrap, table, thead, tbody, headerTr, bodyRows };
}
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
function sliceOfSpan(span, md) {
  const r = rangeOf(span);
  return r === null ? null : normMd(md).slice(r.start, r.end);
}
function wikilinkButtons(tree) {
  return findAll(tree, (n) => localName(n) === "button" && hasClass(n, "dsh-obs-wikilink"));
}

// ── 断言框架（失败信息带 fixture id）────────────────────────────────────────
const failures = [];
let checkTotal = 0;
let checkPassed = 0;
let currentSection = "（未分组）";
const sectionNames = [];
const sectionStats = new Map();

function section(name) {
  currentSection = name;
  sectionNames.push(name);
  sectionStats.set(name, { total: 0, passed: 0 });
  console.log(`\n── ${name} ──`);
}
function check(fixtureId, label, cond, detail) {
  checkTotal += 1;
  const stats = sectionStats.get(currentSection);
  if (stats) stats.total += 1;
  if (cond) {
    checkPassed += 1;
    if (stats) stats.passed += 1;
    return true;
  }
  failures.push({ section: currentSection, fixtureId, label, detail });
  const d = detail === undefined || detail === null || detail === "" ? "" : `\n      实测: ${detail}`;
  console.log(`  ✗ [${fixtureId}] ${label}${d}`);
  return false;
}
function checkEq(fixtureId, label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  return check(fixtureId, label, ok, `期望 ${JSON.stringify(expected)}；实测 ${JSON.stringify(actual)}`);
}
const j = (v) => JSON.stringify(v);

// ── 两条全量不变量（P2 契约 §5；行号统一读 [data-line-no]）──────────────────
function checkLineInvariant(id, md, tree) {
  const norm = normMd(md);
  const n = norm.split("\n").length;
  const nodes = findNodes(tree, (node) => isElement(node) && node.props !== undefined &&
    Object.prototype.hasOwnProperty.call(node.props, "data-line-no"));
  const texts = nodes.map((x) => String(dataOf(x.node, "data-line-no")));
  check(id, `行号覆盖：${n} 行源码应有 ${n} 个行号节点（[data-line-no]）`, nodes.length === n,
    `${nodes.length} 个：${j(texts.slice(0, 40))}`);
  check(id, "行号覆盖：data-line-no 均为纯数字且与行号文本一致",
    nodes.length > 0 && texts.every((t, k) => /^\d+$/.test(t) && textOf(nodes[k].node).trim() === t),
    nodes.slice(0, 5).map(({ node }) => `${j(dataOf(node, "data-line-no"))}/${j(textOf(node))}`).join(", "));
  const nums = texts.map(Number);
  const expected = Array.from({ length: n }, (_, k) => k + 1);
  check(id, "行号覆盖：1..N 恰好各一次且按文档序递增",
    nums.length === expected.length && nums.every((v, k) => v === expected[k]), j(nums));
}
function checkOffsetInvariant(id, md, tree) {
  const norm = normMd(md);
  const spans = srcSpanList(tree);
  const badHost = spans.filter((n) => localName(n) !== "span" || !hasClass(n, "dsh-obs-src"));
  check(id, "偏移记账：data-obs-src 只出现在 span.dsh-obs-src 上", badHost.length === 0,
    badHost.slice(0, 3).map((n) => brief(n)).join(" | "));
  const badKids = spans.filter((n) => childrenOf(n).some((c) => typeof c === "object"));
  check(id, "偏移记账：偏移 span 内只有文本子节点", badKids.length === 0,
    badKids.slice(0, 3).map((n) => brief(n)).join(" | "));
  const records = spans.map((span) => ({ span, range: rangeOf(span), text: textOf(span) }));
  const badRange = records.filter((r) => r.range === null || r.range.end > norm.length);
  check(id, "偏移记账：data-obs-src 是合法区间", badRange.length === 0,
    badRange.slice(0, 3).map((r) => j(r.range?.raw)).join(", "));
  const mismatched = records.filter((r) => r.range !== null && norm.slice(r.range.start, r.range.end) !== r.text);
  check(id, "偏移记账：md.slice(start,end) === span 文本", mismatched.length === 0,
    mismatched.slice(0, 3).map((r) => `${r.range.raw} 文本=${j(r.text)} 切片=${j(norm.slice(r.range.start, r.range.end))}`).join(" | "));
  const ordered = records.map((r) => r.range).filter((r) => r !== null);
  const overlapAt = ordered.findIndex((r, k) => k > 0 && ordered[k - 1].end > r.start);
  check(id, "偏移记账：各偏移区间按文档序不重叠", overlapAt < 0,
    overlapAt > 0 ? `${ordered[overlapAt - 1].raw} 与 ${ordered[overlapAt].raw} 重叠/乱序` : "");
}

printRunHeader();
section("全量不变量 0：语料");
check("fixtures", "P2a fixtures 齐全（M14 + M10，≥5 个）", FIXTURES.length >= 5, `实测 ${FIXTURES.length} 个`);
check("fixtures", "片段 id 无重复", new Set(FIXTURES.map((f) => f.id)).size === FIXTURES.length, j(FIXTURES.map((f) => f.id)));
for (const fx of FIXTURES) check(fx.id, "渲染不抛异常且返回元素树", isElement(renderFor(fx.id)), brief(renderFor(fx.id)));

section("全量不变量 1：行号覆盖（P2 契约 §3.1，读 [data-line-no]）");
for (const fx of FIXTURES) checkLineInvariant(fx.id, fx.md, renderFor(fx.id));

section("全量不变量 2：偏移记账（P2 契约 §4，md.slice === 文本）");
for (const fx of FIXTURES) checkOffsetInvariant(fx.id, fx.md, renderFor(fx.id));

// ══════════════════════════════════════════════════════════════════════════
// A. data-line-no 前置（P2 D2）：所有行号元素带属性，文本与属性一致
// ══════════════════════════════════════════════════════════════════════════
section("M14-A data-line-no 前置（普通行 / 表格行）");
{
  const id = "table-escape-wikilink";
  const tree = renderFor(id);
  const lnNodes = findAll(tree, (n) => isElement(n) && Object.prototype.hasOwnProperty.call(n.props ?? {}, "data-line-no"));
  check(id, "结构：行号节点统一带 data-line-no（普通行 + 表格行）", lnNodes.length === normMd(FIXTURES_BY_ID[id].md).split("\n").length,
    `${lnNodes.length} 个：${lnNodes.map((n) => `${localName(n)}.${classList(n).join(".")}`).join(" | ")}`);
  check(id, "结构：普通行行号 span 与表格行号 th/td 都带 data-line-no",
    lnNodes.every((n) => (hasClass(n, "dsh-obs-md-ln") ? localName(n) === "span" : ["th", "td"].includes(localName(n)) && hasClass(n, "dsh-obs-md-tln"))),
    lnNodes.map((n) => `${localName(n)}.${classList(n).join(".")}`).join(" | "));
  check(id, "文本：data-line-no 与行号文本一致", lnNodes.every((n) => String(dataOf(n, "data-line-no")) === textOf(n).trim()),
    lnNodes.map((n) => `${dataOf(n, "data-line-no")}/${textOf(n)}`).join(","));
}

// ══════════════════════════════════════════════════════════════════════════
// B1. 4 空格缩进代码块（Oracle：文首/空行后开启；段落下一行仍是段落）
// ══════════════════════════════════════════════════════════════════════════
section("M14-B1 缩进代码块（indented-code / indented-code-mixed / indented-code-after-paragraph）");
{
  const id = "indented-code";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  const row = rowOf(id, tree, 1);
  check(id, "结构：第 1 行是代码行（dsh-obs-md-code）且单行块同时是 head + end",
    row !== undefined && hasClass(row, "dsh-obs-md-code") && hasClass(row, "dsh-obs-md-code-head") && hasClass(row, "dsh-obs-md-code-end"),
    row ? classList(row).join(".") : "缺行");
  check(id, "文本：去掉 4 空格缩进后显示 indented code", row !== undefined && lcText(row) === "indented code",
    row ? j(lcText(row)) : "缺行");
  const span = row ? srcSpanList(row)[0] ?? null : null;
  check(id, "偏移：内容 span 从第 5 个字符（去掉 4 空格）起、切片严格相等",
    span !== null && dataOf(span, "data-obs-src") === "4,17" && sliceOfSpan(span, md) === "indented code",
    span ? `${dataOf(span, "data-obs-src")}=${j(textOf(span))}` : "无 span");
  check(id, "结构：整块有 data-code-group", row !== undefined && typeof dataOf(row, "data-code-group") === "string" && dataOf(row, "data-code-group") !== "",
    row ? j(String(dataOf(row, "data-code-group"))) : "缺行");
}
{
  const id = "indented-code-mixed";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  const r1 = rowOf(id, tree, 1);
  const r2 = rowOf(id, tree, 2);
  const rows = [3, 4, 5].map((n) => rowOf(id, tree, n));
  const r6 = rowOf(id, tree, 6);
  check(id, "结构：空行后的 3/4/5 行都是代码行（dsh-obs-md-code）",
    rows.every((r) => r !== undefined && hasClass(r, "dsh-obs-md-code")),
    rows.map((r) => (r ? classList(r).join(".") : "缺行")).join(" | "));
  check(id, "结构：首行 head、末行 end，整块共用 data-code-group",
    rows[0] !== undefined && hasClass(rows[0], "dsh-obs-md-code-head") &&
      rows[2] !== undefined && hasClass(rows[2], "dsh-obs-md-code-end") &&
      new Set(rows.map((r) => String(dataOf(r, "data-code-group")))).size === 1,
    rows.map((r) => (r ? `${classList(r).join(".")}/${dataOf(r, "data-code-group")}` : "缺行")).join(" | "));
  checkEq(id, "文本：空格缩进行去掉 4 空格、tab 缩进行去掉 1 tab",
    [lcText(rows[0]), lcText(rows[1]), lcText(rows[2])], ["const a = 1;", "**不是粗体**", "tab 缩进"]);
  check(id, "结构：代码正文不解析行内语法（**不是粗体** 仍是纯文本）",
    rows[1] !== undefined && findAll(rows[1], (n) => localName(n) === "strong").length === 0,
    rows[1] ? brief(rows[1]) : "缺行");
  const spans = rows.map((r) => (r ? srcSpanList(r) : []));
  check(id, "偏移：三行内容 span 切片分别严格等于显示文本",
    spans.every((list, k) => list.length === 1 && sliceOfSpan(list[0], md) === [lcText(rows[0]), lcText(rows[1]), lcText(rows[2])][k]),
    spans.map((list) => list.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(",")).join(" | "));
  check(id, "结构：遇普通行结束代码块（第 6 行不是代码行），第 1/2 行不是代码行",
    r6 !== undefined && !hasClass(r6, "dsh-obs-md-code") && r1 !== undefined && !hasClass(r1, "dsh-obs-md-code") && r2 !== undefined && !hasClass(r2, "dsh-obs-md-code"),
    [r1, r2, r6].map((r) => (r ? classList(r).join(".") : "缺行")).join(" | "));
}
{
  const id = "indented-code-after-paragraph";
  const tree = renderFor(id);
  const r2 = rowOf(id, tree, 2);
  check(id, "结构：段落下一行的缩进行不开启代码块（CommonMark：不能打断段落；Oracle 同）",
    r2 !== undefined && !hasClass(r2, "dsh-obs-md-code"), r2 ? classList(r2).join(".") : "缺行");
  check(id, "文本：该行仍按普通行内文本显示", r2 !== undefined && lcText(r2).trim() === "still paragraph",
    r2 ? j(lcText(r2)) : "缺行");
}

// ══════════════════════════════════════════════════════════════════════════
// B2. 带空格水平线（Oracle：`* * *` / `- - -` 都是 hr）
// ══════════════════════════════════════════════════════════════════════════
section("M14-B2 带空格水平线（hr-spaced）");
{
  const id = "hr-spaced";
  const tree = renderFor(id);
  for (const num of [3, 7]) {
    const row = rowOf(id, tree, num);
    check(id, `结构：第 ${num} 行是水平线（dsh-obs-md-hr，不是列表）`,
      row !== undefined && hasClass(row, "dsh-obs-md-hr") && !hasClass(row, "dsh-obs-md-list") && dataOf(row, "data-list-kind") === undefined,
      row ? classList(row).join(".") : "缺行");
    const hrLine = row ? findAll(row, (n) => localName(n) === "hr" && hasClass(n, "dsh-obs-md-hr-line"))[0] ?? null : null;
    check(id, `结构：第 ${num} 行 lc 里有 hr.dsh-obs-md-hr-line`, hrLine !== null, row ? brief(row) : "缺行");
    check(id, `文本：第 ${num} 行不显示 * * * / - - - 原文`, row !== undefined && lcText(row) === "", row ? j(lcText(row)) : "缺行");
  }
  check(id, "文本：前后正文保留、整树无 * * * / - - - 原文",
    textOf(tree).includes("上") && textOf(tree).includes("中") && textOf(tree).includes("下") &&
      !textOf(tree).includes("* * *") && !textOf(tree).includes("- - -"), j(textOf(tree)));
}

// ══════════════════════════════════════════════════════════════════════════
// B3. 表格 `[[A\|B]]`（口径以真机 Oracle 为准：target=A、显示 B）
// ══════════════════════════════════════════════════════════════════════════
section("M14-B3 表格转义管道 + 双链（table-escape-wikilink，Oracle 口径 target=A/显示 B）");
{
  const id = "table-escape-wikilink";
  const md = FIXTURES_BY_ID[id].md;
  const clicks = [];
  const tree = renderNumbered(md, { ...HANDLERS, onWikilink: (t) => clicks.push(t) });
  const wraps = tablesOf(tree);
  check(id, "结构：出现 1 个 dsh-obs-md-tablewrap 整块表格", wraps.length === 1, `实测 ${wraps.length} 个`);
  const parts = tableParts(wraps[0]);
  const bodyRows = parts.bodyRows ?? [];
  check(id, "结构：表格 2 个正文行", bodyRows.length === 2, `实测 ${bodyRows.length}`);
  const linkCell = dataCells(bodyRows[0])[0] ?? null;
  const buttons = linkCell ? wikilinkButtons(linkCell) : [];
  check(id, "结构：第 1 个正文行单元格里是 button.dsh-obs-wikilink", buttons.length === 1, linkCell ? brief(linkCell) : "缺单元格");
  checkEq(id, "文本：`[[A\\|B]]` 显示 B（Oracle：转义管道是别名分隔符，方案原文 target=A|B 作废）",
    buttons.map((b) => textOf(b)), ["B"]);
  checkEq(id, "结构：双链 title 为 [[A]]（target 为 A）", buttons.map((b) => dataOf(b, "title")), ["[[A]]"]);
  for (const b of buttons) b.props.onClick();
  checkEq(id, "结构：点击参数 target=A", clicks, ["A"]);
  const linkSpans = buttons[0] ? srcSpanList(buttons[0]) : [];
  check(id, "偏移：可见文本只映射 B 的源码（A、[[、\\| 都不产 span）",
    linkSpans.length === 1 && sliceOfSpan(linkSpans[0], md) === "B",
    linkSpans.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
  // 普通单元格转义：a \| b → a | b，管道单独成 span、映射源码 `|`
  const plainCell = dataCells(bodyRows[1])[0] ?? null;
  check(id, "文本：普通单元格 `a \\| b` 显示 a | b、反斜杠不外漏",
    plainCell !== null && textOf(plainCell).trim() === "a | b", plainCell ? j(textOf(plainCell)) : "缺单元格");
  const pipeSpan = plainCell ? srcSpanList(plainCell).find((s) => textOf(s) === "|") ?? null : null;
  check(id, "偏移：显示 | 的 span 只映射源码里的 |（不含反斜杠）",
    pipeSpan !== null && sliceOfSpan(pipeSpan, md) === "|" && normMd(md)[rangeOf(pipeSpan).start - 1] === "\\",
    pipeSpan ? `${dataOf(pipeSpan, "data-obs-src")}=${j(textOf(pipeSpan))}` : "无 | 映射 span");
  check(id, "文本：表格整树不出现反斜杠与 [[ ]] 原文",
    !textOf(tree).includes("\\") && !textOf(tree).includes("[["), j(textOf(tree)));
}

// ══════════════════════════════════════════════════════════════════════════
// B4. setext 前导空格（Oracle：不支持 → 不做，断言「不识别」留回归护栏）
// ══════════════════════════════════════════════════════════════════════════
section("M14-B4 setext 前导空格（setext-leading-space，Oracle 不支持）");
{
  const id = "setext-leading-space";
  const tree = renderFor(id);
  const r1 = rowOf(id, tree, 1);
  const r2 = rowOf(id, tree, 2);
  const r4 = rowOf(id, tree, 4);
  const r5 = rowOf(id, tree, 5);
  check(id, "结构：`  ===` 不把上一行变成 setext 标题（第 1 行不是标题）",
    r1 !== undefined && !hasClass(r1, "dsh-obs-md-heading"), r1 ? classList(r1).join(".") : "缺行");
  check(id, "结构：第 2 行不是 setext 下划线行（不识别前导空格）",
    r2 !== undefined && !hasClass(r2, "dsh-obs-md-setext-underline"), r2 ? classList(r2).join(".") : "缺行");
  check(id, "文本：`==` 下划线原文可见（Oracle：普通段落文本，不吞标记）",
    r2 !== undefined && textOf(r2).includes("==="), r2 ? j(lcText(r2)) : "缺行");
  check(id, "结构：`   ---` 不把上一行变成 setext 标题（第 4 行不是标题）",
    r4 !== undefined && !hasClass(r4, "dsh-obs-md-heading"), r4 ? classList(r4).join(".") : "缺行");
  check(id, "结构：`   ---` 是水平线而不是 setext 下划线（Oracle 同）",
    r5 !== undefined && hasClass(r5, "dsh-obs-md-hr") && !hasClass(r5, "dsh-obs-md-setext-underline"),
    r5 ? classList(r5).join(".") : "缺行");
}

// ══════════════════════════════════════════════════════════════════════════
// M10 行内 scanner（方案 D1/D13，契约 §3.7）：结构 + 文本 + 偏移
// ══════════════════════════════════════════════════════════════════════════
const countElems = (tree, name) => findAll(tree, (n) => localName(n) === name).length;
const spansWithText = (root, text) => srcSpanList(root).filter((s) => textOf(s) === text);

section("M10-A 转义（escape / escape-backslash）");
{
  const id = "escape";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  checkEq(id, "文本：转义字符还原为字面量、反斜杠不外漏", lcText(rowOf(id, tree, 1) ?? {}), "*不是斜体* # 不是标题 [[不是双链]]");
  check(id, "结构：转义后的 * 不解析成强调、[[ 不解析成双链（无 em/strong/button）",
    countElems(tree, "em") === 0 && countElems(tree, "strong") === 0 && countElems(tree, "button") === 0,
    j([countElems(tree, "em"), countElems(tree, "strong"), countElems(tree, "button")]));
  const stars = spansWithText(tree, "*");
  check(id, "结构：两个 \\* 各产一个 span", stars.length === 2, `实测 ${stars.length}`);
  check(id, "偏移：转义 span 只映射被转义字符（切片 === 字符、前一字符是反斜杠、反斜杠不产 span）",
    stars.every((s) => sliceOfSpan(s, md) === "*" && normMd(md)[rangeOf(s).start - 1] === "\\"),
    stars.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
  const brackets = spansWithText(tree, "[");
  check(id, "偏移：\\[\\[ 的两个 [ 各自映射源码单字符", brackets.length === 2 && brackets.every((s) => sliceOfSpan(s, md) === "["),
    brackets.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
}
{
  const id = "escape-backslash";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  checkEq(id, "文本：\\\\ → 单反斜杠、\\* → *、\\a（不可转义）保持 \\a", lcText(rowOf(id, tree, 1) ?? {}),
    "两条反斜杠：\\ 与转义星号 * 与不转义 \\a");
  const backslashes = spansWithText(tree, "\\");
  check(id, "偏移：\\\\ 产出的反斜杠 span 只映射第二个反斜杠", backslashes.length === 1 && sliceOfSpan(backslashes[0], md) === "\\",
    backslashes.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
  const star = spansWithText(tree, "*");
  check(id, "偏移：转义星号 span 映射源码 * 单字符", star.length === 1 && sliceOfSpan(star[0], md) === "*",
    star.map((s) => dataOf(s, "data-obs-src")).join(","));
  check(id, "结构：\\a 不是转义（反斜杠保留在文本里）", textOf(tree).includes("\\a"), j(textOf(tree)));
}

section("M10-B 行内代码（code-double-backtick）");
{
  const id = "code-double-backtick";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  checkEq(id, "文本：单/双反引号代码都显示去定界符内容（双反引号内容含一个 `）", lcText(rowOf(id, tree, 1) ?? {}),
    "code 与 a ` b 与 *不解析*");
  check(id, "结构：代码内容不解析行内（无 em/strong/code 元素，沿用 P1 口径纯文本 + span）",
    countElems(tree, "em") === 0 && countElems(tree, "strong") === 0 && countElems(tree, "code") === 0,
    j([countElems(tree, "em"), countElems(tree, "strong"), countElems(tree, "code")]));
  const content = spansWithText(tree, "a ` b");
  check(id, "偏移：双反引号代码 span 映射去定界符内容", content.length === 1 && sliceOfSpan(content[0], md) === "a ` b",
    content.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
  const starContent = spansWithText(tree, "*不解析*");
  check(id, "偏移：代码里的 * 原样显示并精确映射", starContent.length === 1 && sliceOfSpan(starContent[0], md) === "*不解析*",
    starContent.map((s) => dataOf(s, "data-obs-src")).join(","));
}
{
  const id = "code-triple";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  checkEq(id, "文本：三反引号代码显示去定界符内容（内容里的双反引号保留）", lcText(rowOf(id, tree, 1) ?? {}),
    "三反引号 x`` y 结束");
  check(id, "结构：三反引号代码不产 code/em 元素、三反引号不外漏", countElems(tree, "code") === 0 && countElems(tree, "em") === 0 &&
    !textOf(tree).includes("```"), j(textOf(tree)));
  const content = spansWithText(tree, "x`` y");
  check(id, "偏移：三反引号代码 span 映射去定界符内容", content.length === 1 && sliceOfSpan(content[0], md) === "x`` y",
    content.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
}

section("M10-C 嵌套强调 / 下划线词（nested-em / underscore-words）");
{
  const id = "nested-em";
  const tree = renderFor(id);
  checkEq(id, "文本：强调标记不外漏（***、**、__、_ 都剥掉）", lcText(rowOf(id, tree, 1) ?? {}),
    "粗斜体 和 粗 内斜 粗 和 x 和 x");
  check(id, "结构：***x*** 同时产 strong 与 em（嵌套）", countElems(tree, "strong") >= 1 && countElems(tree, "em") >= 1,
    j({ strong: countElems(tree, "strong"), em: countElems(tree, "em") }));
  const mixed = findAll(tree, (n) => localName(n) === "strong" && textOf(n) === "粗 内斜 粗");
  check(id, "结构：**粗 *内斜* 粗** 是 strong 内嵌 em", mixed.length === 1 && findAll(mixed[0], (n) => localName(n) === "em").length === 1,
    mixed.map((n) => brief(n)).join(" | "));
  const underscoreStrong = findAll(tree, (n) => localName(n) === "strong" && textOf(n) === "x");
  const underscoreEm = findAll(tree, (n) => localName(n) === "em" && textOf(n) === "x");
  check(id, "结构：__x__ → strong、_x_ → em", underscoreStrong.length === 1 && underscoreEm.length === 1,
    `strong=${underscoreStrong.length} em=${underscoreEm.length}`);
}
{
  const id = "underscore-words";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  checkEq(id, "文本：词中下划线完整保留（修 P1 `_` 吞字符缺陷）", lcText(rowOf(id, tree, 1) ?? {}),
    "LINK_TYPE_P1=2 和 ib_send_lat 和 a_b_c 和 x 和 y");
  check(id, "结构：词中下划线不产生强调（只有 _x_ / __y__ 两个强调元素）",
    countElems(tree, "em") === 1 && countElems(tree, "strong") === 1,
    j({ em: countElems(tree, "em"), strong: countElems(tree, "strong") }));
  const visibleBySpans = srcSpanList(tree).map((s) => sliceOfSpan(s, md));
  check(id, "偏移：各 span 切片按序拼起来 === 可见文本（字符未被吞、下划线仍映射源码）",
    visibleBySpans.join("") === lcText(rowOf(id, tree, 1) ?? {}),
    j(visibleBySpans.join("")));
  check(id, "文本：ib_send_lat / a_b_c 原样出现", textOf(tree).includes("ib_send_lat") && textOf(tree).includes("a_b_c"), j(textOf(tree)));
}

section("M10-D 删除线 / 高亮（strike / highlight）");
{
  const id = "strike";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  checkEq(id, "文本：~~ 删除线标记不外漏", lcText(rowOf(id, tree, 1) ?? {}), "删除 和 删除 粗");
  const strikes = findAll(tree, (n) => hasClass(n, "dsh-obs-md-strike"));
  check(id, "结构：2 个 span.dsh-obs-md-strike", strikes.length === 2, `实测 ${strikes.length}`);
  checkEq(id, "结构：第一段删除线内容是 删除", strikes.map((s) => textOf(s)), ["删除", "删除 粗"]);
  check(id, "结构：删除线内可嵌套 strong", strikes[1] !== undefined && findAll(strikes[1], (n) => localName(n) === "strong").length === 1,
    strikes[1] ? brief(strikes[1]) : "缺");
  const spans = strikes[0] ? srcSpanList(strikes[0]) : [];
  check(id, "偏移：删除线内容 span 映射 删除 两字（不含 ~~）", spans.length === 1 && sliceOfSpan(spans[0], md) === "删除",
    spans.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
}
{
  const id = "highlight";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  checkEq(id, "文本：== 高亮标记不外漏", lcText(rowOf(id, tree, 1) ?? {}), "高亮 和 高亮 code");
  const marks = findAll(tree, (n) => hasClass(n, "dsh-obs-md-highlight"));
  check(id, "结构：2 个 span.dsh-obs-md-highlight", marks.length === 2, `实测 ${marks.length}`);
  checkEq(id, "结构：高亮内容是 高亮 / 高亮 code（行内代码沿用纯文本）", marks.map((m) => textOf(m)), ["高亮", "高亮 code"]);
  const spans = marks[1] ? srcSpanList(marks[1]) : [];
  check(id, "偏移：高亮内 code 去定界符后精确映射", spans.some((s) => sliceOfSpan(s, md) === "code"),
    spans.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
}

section("M10-E 自动链接 / 裸 URL（autolink / bare-url）");
{
  const id = "autolink";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  const anchors = findAll(tree, (n) => localName(n) === "a");
  checkEq(id, "结构：3 个 a（自动链接 ×2 + 普通链接 ×1）", anchors.map((a) => dataOf(a, "href")),
    ["https://example.com", "https://example.com", "mailto:a@b.c"]);
  checkEq(id, "结构：两个自动链接带 dsh-obs-md-autolink、普通链接不带",
    anchors.map((a) => hasClass(a, "dsh-obs-md-autolink")), [true, false, true]);
  checkEq(id, "文本：尖括号/ mailto: 不外漏", anchors.map((a) => textOf(a)), ["https://example.com", "外链", "a@b.c"]);
  check(id, "文本：整行可见文本无尖括号", !textOf(tree).includes("<") && !textOf(tree).includes(">"), j(textOf(tree)));
  const spans = anchors[0] ? srcSpanList(anchors[0]) : [];
  check(id, "偏移：自动链接只映射 URL 文本（尖括号不产 span）", spans.length === 1 && sliceOfSpan(spans[0], md) === "https://example.com",
    spans.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
  const mailSpans = anchors[2] ? srcSpanList(anchors[2]) : [];
  check(id, "偏移：mailto 显示文本去掉前缀且只映射地址", mailSpans.length === 1 && sliceOfSpan(mailSpans[0], md) === "a@b.c",
    mailSpans.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
}
{
  const id = "bare-url";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  const anchors = findAll(tree, (n) => localName(n) === "a");
  checkEq(id, "结构：3 个裸 URL 锚点、尾随标点（, . 。）被剥离出 href",
    anchors.map((a) => dataOf(a, "href")),
    ["https://example.com/a", "https://example.com/b", "https://example.com/c"]);
  checkEq(id, "结构：锚点带 dsh-obs-md-autolink class", anchors.map((a) => hasClass(a, "dsh-obs-md-autolink")), [true, true, true]);
  checkEq(id, "文本：尾随标点仍是可见文本、URL 内外不漏标点", lcText(rowOf(id, tree, 1) ?? {}),
    "见 https://example.com/a, 然后 https://example.com/b. 再来 https://example.com/c。 结束");
  const spans = anchors[2] ? srcSpanList(anchors[2]) : [];
  check(id, "偏移：锚点只映射 URL 本身（不含尾随 。）", spans.length === 1 && sliceOfSpan(spans[0], md) === "https://example.com/c",
    spans.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
}

section("M10-F 标签（tags）");
{
  const id = "tags";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  const tagEls = findAll(tree, (n) => hasClass(n, "dsh-obs-md-tag"));
  checkEq(id, "结构：3 个 span.dsh-obs-md-tag", tagEls.map((t) => textOf(t)), ["#标签", "#父/子", "#tag-name"]);
  check(id, "文本：纯数字 #123 不是标签、代码里的 #不是标签 不是标签",
    tagEls.every((t) => !textOf(t).includes("123") && !textOf(t).includes("不是标签")),
    j(tagEls.map((t) => textOf(t))));
  const tagSpans = tagEls.map((t) => srcSpanList(t));
  check(id, "偏移：每个标签一个 src span、映射整段 #tag（含 #）、切片严格相等",
    tagSpans.every((list) => list.length === 1 && sliceOfSpan(list[0], md) === textOf(list[0])),
    tagSpans.map((l) => l.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(",")).join(" | "));
  checkEq(id, "文本：整行可见文本（标签 + 普通文本 + 代码内容）", lcText(rowOf(id, tree, 1) ?? {}),
    "#标签 #父/子 #tag-name #123 与 #不是标签");
}

section("M10-F2 注释（comment-inline / comment-multiline，口径以真机 Oracle 为准）");
{
  const id = "comment-inline";
  const tree = renderFor(id);
  checkEq(id, "文本：%%…%% 完全隐藏（两侧空格保留）", lcText(rowOf(id, tree, 1) ?? {}), "前面  后面");
  check(id, "文本：整树不出现 %% 与注释内容", !textOf(tree).includes("%%") && !textOf(tree).includes("隐藏内容"), j(textOf(tree)));
  check(id, "偏移：注释不产 span（2 个文本 span）", srcSpanList(tree).length === 2, `实测 ${srcSpanList(tree).length}`);
  check(id, "结构：行仍占号（行号 1 存在）", rowOf(id, tree, 1) !== undefined);
}
{
  const id = "comment-multiline";
  const tree = renderFor(id);
  // Oracle 1.14.4 实测：注释不跨行隐藏（单行内才吃 %%…%%），原样显示
  check(id, "文本：跨行 %% 不隐藏（与真机 Oracle 一致），第 1 行原文保留",
    lcText(rowOf(id, tree, 1) ?? {}) === "前 %%多行", j(lcText(rowOf(id, tree, 1) ?? {})));
  check(id, "文本：第 2 行原文保留", lcText(rowOf(id, tree, 2) ?? {}) === "注释%% 后", j(lcText(rowOf(id, tree, 2) ?? {})));
  check(id, "结构：两行都占号、无行号缺失", rowOf(id, tree, 1) !== undefined && rowOf(id, tree, 2) !== undefined);
}

section("M10-G 硬换行（hardbreak）");
{
  const id = "hardbreak";
  const tree = renderFor(id);
  const r1 = rowOf(id, tree, 1);
  const r2 = rowOf(id, tree, 2);
  const r3 = rowOf(id, tree, 3);
  checkEq(id, "文本：行尾两空格被吃掉、行内文本完整",
    [lcText(r1 ?? {}), lcText(r2 ?? {}), lcText(r3 ?? {})], ["第一行", "第二行", "第三行"]);
  check(id, "结构：两空格/反斜杠行尾各产一个 <br>（生成节点，无 src span）",
    r1 !== undefined && findAll(r1, (n) => localName(n) === "br").length === 1 &&
      r2 !== undefined && findAll(r2, (n) => localName(n) === "br").length === 1,
    [r1, r2].map((r) => (r ? String(findAll(r, (n) => localName(n) === "br").length) : "缺")).join(","));
  check(id, "结构：普通行（第三行）没有 <br>", r3 !== undefined && findAll(r3, (n) => localName(n) === "br").length === 0);
  check(id, "偏移：行尾空格/反斜杠不产 span（所有 span 不以空格或反斜杠结尾）",
    srcSpanList(tree).every((s) => !/[\s\\]$/.test(textOf(s))),
    srcSpanList(tree).map((s) => j(textOf(s))).join(","));
}

section("M10-H 双链里的转义管道（wikilink-escaped-pipe，非表格上下文也按 Oracle 口径）");
{
  const id = "wikilink-escaped-pipe";
  const md = FIXTURES_BY_ID[id].md;
  const clicks = [];
  const tree = renderNumbered(md, { ...HANDLERS, onWikilink: (t) => clicks.push(t) });
  const buttons = wikilinkButtons(tree);
  checkEq(id, "文本：[[A\\|B]] 在普通段落里也显示别名 B（Oracle 同表格口径）", buttons.map((b) => textOf(b)), ["B"]);
  checkEq(id, "结构：title 为 [[A]]（target 解码为 A）", buttons.map((b) => dataOf(b, "title")), ["[[A]]"]);
  for (const b of buttons) b.props.onClick();
  checkEq(id, "结构：点击参数 target=A", clicks, ["A"]);
  const spans = buttons[0] ? srcSpanList(buttons[0]) : [];
  check(id, "偏移：可见文本只映射 B（A、\\、| 不产 span）", spans.length === 1 && sliceOfSpan(spans[0], md) === "B",
    spans.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
  check(id, "文本：整行无 [[ ]] 与反斜杠原文", !textOf(tree).includes("\\") && !textOf(tree).includes("[["), j(textOf(tree)));
}

section("M10-I 双链 onClick 第二参 anchor（M13 约定，P2 契约 §12）");
{
  const id = "wikilink-anchor";
  const md = FIXTURES_BY_ID[id].md;
  const clicks = [];
  const tree = renderNumbered(md, { ...HANDLERS, onWikilink: (target, anchor) => clicks.push([target, anchor]) });
  const buttons = wikilinkButtons(tree);
  checkEq(id, "结构：3 个双链按钮（A#章节 / A / #章节）", buttons.length, 3);
  checkEq(id, "文本：显示 target › 章节、target、章节（空 target 不显示 › ）",
    buttons.map((b) => textOf(b)), ["笔记A › 标题", "笔记A", "标题"]);
  for (const b of buttons) b.props.onClick();
  checkEq(id, "结构：onClick(target, anchor)——anchor=章节文本，无 section 时 undefined，同篇空 target 传空串",
    clicks, [["笔记A", "标题"], ["笔记A", undefined], ["", "标题"]]);
  checkEq(id, "结构：title 保持 P1 target-only 口径（[[A#章节]] → [[A]]）",
    buttons.slice(0, 2).map((b) => dataOf(b, "title")), ["[[笔记A]]", "[[笔记A]]"]);
}

section("M10-J 块注释（行首 `%%` 开始，真机 Oracle 口径；整数行照常占号）");
const hiddenCommentRow = (row) => row !== undefined && hasClass(row, "dsh-obs-md-comment") &&
  String(dataOf(row, "data-comment-block")) === "1" && lcText(row) === "";
const visibleRowTexts = (id, tree) => rowMapOf(tree).size > 0
  ? [...rowMapOf(tree).entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => lcText(row)).join("")
  : "";
{
  const id = "comment-block";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  check(id, "结构：夹在两行正文之间的 3 行块注释都是 comment 行（class + data-comment-block，lc 空）",
    [2, 3, 4].every((n) => hiddenCommentRow(rowOf(id, tree, n))),
    [2, 3, 4].map((n) => { const r = rowOf(id, tree, n); return r ? `${classList(r).join(".")}/${dataOf(r, "data-comment-block")}` : "缺行"; }).join(" | "));
  checkEq(id, "文本：块注释整段隐藏，只可见 前 / 后",
    [lcText(rowOf(id, tree, 1) ?? {}), lcText(rowOf(id, tree, 5) ?? {})], ["前", "后"]);
  check(id, "文本：整树不出现 %% 与隐藏内容", !textOf(tree).includes("%%") && !textOf(tree).includes("隐藏块注释"), j(textOf(tree)));
  check(id, "偏移：隐藏行不产 span（只有 前/后 两个文本 span，切片严格相等）",
    srcSpanList(tree).length === 2 && srcSpanList(tree).every((sp) => sliceOfSpan(sp, md) === textOf(sp)),
    srcSpanList(tree).map((sp) => `${dataOf(sp, "data-obs-src")}=${j(textOf(sp))}`).join(","));
  checkEq(id, "结构：5 行源码行号 1..5 全部保留（含两条定界行与内容行）",
    [...rowMapOf(tree).keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
}
{
  const id = "comment-block-unclosed";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  check(id, "结构：未闭合块注释从开定界行隐藏到文末（2/3 行都是 comment 行，行号保留）",
    hiddenCommentRow(rowOf(id, tree, 2)) && hiddenCommentRow(rowOf(id, tree, 3)) && rowMapOf(tree).size === 3,
    `rows=${rowMapOf(tree).size}`);
  checkEq(id, "文本：只可见开定界行之前的 前（后面的行也隐藏）", lcText(rowOf(id, tree, 1) ?? {}), "前");
  check(id, "文本：整树不出现 %% 与未闭合后的文本",
    !textOf(tree).includes("%%") && !textOf(tree).includes("后面没有结束行"), j(textOf(tree)));
}
{
  const id = "comment-block-indent";
  const tree = renderFor(id);
  check(id, "结构：2 空格缩进的 %% 定界行仍识别为块注释（≤3 空格，Oracle 同）",
    [2, 3, 4].every((n) => hiddenCommentRow(rowOf(id, tree, n))),
    [2, 3, 4].map((n) => { const r = rowOf(id, tree, n); return r ? classList(r).join(".") : "缺行"; }).join(" | "));
  checkEq(id, "文本：只可见 前 / 后", visibleRowTexts(id, tree), "前后");
}
{
  const id = "comment-block-indent4";
  const tree = renderFor(id);
  // 回归护栏：4 空格缩进不识别为块注释（缩进代码/段落续行优先），原文可见
  check(id, "结构：4 空格缩进不识别为块注释（第 2-4 行不是 comment 行）",
    [2, 3, 4].every((n) => !hasClass(rowOf(id, tree, n) ?? {}, "dsh-obs-md-comment")),
    [2, 3, 4].map((n) => { const r = rowOf(id, tree, n); return r ? classList(r).join(".") : "缺行"; }).join(" | "));
  check(id, "文本：缩进行原文可见（%% 与 hidden 都不隐藏）",
    textOf(tree).includes("%%") && textOf(tree).includes("hidden"), j(textOf(tree)));
  check(id, "偏移：缩进行仍是普通源码 span，切片严格相等",
    srcSpanList(tree).length >= 4 && srcSpanList(tree).every((sp) => sliceOfSpan(sp, FIXTURES_BY_ID[id].md) === textOf(sp)),
    srcSpanList(tree).map((sp) => j(textOf(sp))).join(","));
}
{
  const id = "comment-block-delim-text";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  check(id, "结构：开定界行与内容行隐藏（1/2 行 comment 行）",
    hiddenCommentRow(rowOf(id, tree, 1)) && hiddenCommentRow(rowOf(id, tree, 2)),
    [1, 2].map((n) => { const r = rowOf(id, tree, n); return r ? classList(r).join(".") : "缺行"; }).join(" | "));
  checkEq(id, "文本：闭合行 %% 之后的同行文本可见（「 结束」），开定界行的「开始」被隐藏",
    lcText(rowOf(id, tree, 3) ?? {}), " 结束");
  check(id, "文本：整树不出现 %% / 开始 / hidden",
    !textOf(tree).includes("%%") && !textOf(tree).includes("开始") && !textOf(tree).includes("hidden"), j(textOf(tree)));
  check(id, "偏移：闭合行可见文本 span 精确映射源码（从 %% 之后算）",
    srcSpanList(tree).length === 1 && sliceOfSpan(srcSpanList(tree)[0], md) === " 结束",
    srcSpanList(tree).map((sp) => `${dataOf(sp, "data-obs-src")}=${j(textOf(sp))}`).join(","));
}
{
  const id = "comment-percent-only";
  const tree = renderFor(id);
  check(id, "结构：单个 %% 行 = 未闭合块注释（隐藏到文末，2/3 行 comment）",
    hiddenCommentRow(rowOf(id, tree, 2)) && hiddenCommentRow(rowOf(id, tree, 3)), "");
  checkEq(id, "文本：只可见开定界行之前的 前（「后」也被隐藏，Oracle 同）",
    visibleRowTexts(id, tree), "前");
  check(id, "文本：整树不出现 %%", !textOf(tree).includes("%%"), j(textOf(tree)));
}
{
  const id = "comment-block-quad";
  const tree = renderFor(id);
  checkEq(id, "文本：%%%% 是行内空注释对（两行都变空行），中间的 hidden 可见",
    [lcText(rowOf(id, tree, 2) ?? {}), lcText(rowOf(id, tree, 3) ?? {}), lcText(rowOf(id, tree, 4) ?? {})],
    ["", "hidden", ""]);
  check(id, "结构：%%%% 行不算块注释（无 comment class / data-comment-block）",
    ![2, 4].some((n) => hasClass(rowOf(id, tree, n) ?? {}, "dsh-obs-md-comment") || dataOf(rowOf(id, tree, n) ?? {}, "data-comment-block") !== undefined),
    [2, 4].map((n) => { const r = rowOf(id, tree, n); return r ? classList(r).join(".") : "缺行"; }).join(" | "));
}
{
  const id = "comment-block-in-list";
  const tree = renderFor(id);
  check(id, "结构：列表项之间的块注释隐藏，不影响两个列表项（第 1/5 行仍是 ul 列表行）",
    hasClass(rowOf(id, tree, 1) ?? {}, "dsh-obs-md-list") && hasClass(rowOf(id, tree, 5) ?? {}, "dsh-obs-md-list") &&
      [2, 3, 4].every((n) => hiddenCommentRow(rowOf(id, tree, n))),
    [1, 5].map((n) => { const r = rowOf(id, tree, n); return r ? classList(r).join(".") : "缺行"; }).join(" | "));
  checkEq(id, "文本：两个列表项正文与符号保留、注释内容不外漏",
    [lcText(rowOf(id, tree, 1) ?? {}), lcText(rowOf(id, tree, 5) ?? {})], ["•项一", "•项二"]);
  check(id, "文本：整树不出现 隐藏 与 %%", !textOf(tree).includes("隐藏") && !textOf(tree).includes("%%"), j(textOf(tree)));
}
{
  const id = "comment-block-in-callout";
  const tree = renderFor(id);
  check(id, "结构：callout 标题行正常、> %% 起的正文全部是 quote comment 隐藏行（行号保留）",
    hasClass(rowOf(id, tree, 1) ?? {}, "dsh-obs-md-quote") && String(dataOf(rowOf(id, tree, 1) ?? {}, "data-callout")) === "note" &&
      [2, 3, 4].every((n) => hiddenCommentRow(rowOf(id, tree, n)) && hasClass(rowOf(id, tree, n) ?? {}, "dsh-obs-md-quote")),
    [1, 2, 3, 4].map((n) => { const r = rowOf(id, tree, n); return r ? `${classList(r).join(".")}/${dataOf(r, "data-comment-block")}` : "缺行"; }).join(" | "));
  check(id, "文本：callout 标题可见、注释内容不可见", textOf(tree).includes("标题") && !textOf(tree).includes("隐藏"), j(textOf(tree)));
  checkEq(id, "结构：block-in-callout 4 行行号 1..4 保留", [...rowMapOf(tree).keys()].sort((a, b) => a - b), [1, 2, 3, 4]);
}
{
  const id = "comment-block-tab";
  const tree = renderFor(id);
  check(id, "结构：tab 缩进不识别为块注释（Oracle：缩进/段落续行优先）",
    [2, 3, 4].every((n) => !hasClass(rowOf(id, tree, n) ?? {}, "dsh-obs-md-comment")),
    [2, 3, 4].map((n) => { const r = rowOf(id, tree, n); return r ? classList(r).join(".") : "缺行"; }).join(" | "));
  check(id, "文本：tab 缩进行原文可见（%% 与 hidden 都不隐藏）",
    textOf(tree).includes("%%") && textOf(tree).includes("hidden"), j(textOf(tree)));
}
{
  const id = "comment-block-content-md";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  check(id, "结构：块注释内的标题/围栏标记全部隐藏（8 行都占号，中间 6 行是 comment 行）",
    [2, 3, 4, 5, 6, 7].every((n) => hiddenCommentRow(rowOf(id, tree, n))) && rowMapOf(tree).size === 8,
    `rows=${rowMapOf(tree).size}`);
  checkEq(id, "文本：只可见块注释前后的 前 / 后", [lcText(rowOf(id, tree, 1) ?? {}), lcText(rowOf(id, tree, 8) ?? {})], ["前", "后"]);
  check(id, "文本：块内 Markdown 标记不外漏（# / ``` / %%）",
    !textOf(tree).includes("#") && !textOf(tree).includes("```") && !textOf(tree).includes("%%"), j(textOf(tree)));
  check(id, "偏移：隐藏块不产 span", srcSpanList(tree).length === 2, `实测 ${srcSpanList(tree).length}`);
}

// ══════════════════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════════════════
const debugId = process.env.DEBUG_FIXTURE;
if (debugId !== undefined && debugId !== "") {
  const fx = FIXTURES_BY_ID[debugId];
  console.log(`\n── DEBUG_FIXTURE=${debugId} 渲染树 ──`);
  if (!fx) console.log(`（没有这个片段；可选：${FIXTURES.map((f) => f.id).join(", ")}）`);
  else console.log(treeDump(renderFor(debugId)));
}

console.log("\n" + "═".repeat(72));
const bySection = new Map();
for (const f of failures) {
  if (!bySection.has(f.section)) bySection.set(f.section, []);
  bySection.get(f.section).push(f);
}
console.log(`OBSIDIAN P2a 面板路径断言：共 ${checkTotal} 条，通过 ${checkPassed}，失败 ${failures.length}`);
if (failures.length > 0) {
  console.log("\n按里程碑统计（通过/总数）：");
  for (const name of sectionNames) {
    const stats = sectionStats.get(name) ?? { total: 0, passed: 0 };
    const items = bySection.get(name) ?? [];
    const fixtures = [...new Set(items.map((i) => i.fixtureId))];
    console.log(`  ${items.length === 0 ? "✓" : "✗"} ${name}：${stats.passed}/${stats.total} 通过${items.length > 0 ? `；失败片段：${fixtures.join(", ")}` : ""}`);
  }
  console.log("\n逐条失败信息见上方 ✗ 行（[fixture-id] 说明）。实现未完成时本文件应为红；M14/M10 验收要求全绿。");
  process.exit(1);
}
console.log("全部 P2a（M14 + M10）面板路径断言通过 ✔");

function printRunHeader() {
  const sha = createHash("sha1").update(code).digest("hex").slice(0, 10);
  console.log("Obsidian P2a 面板路径测试（M14，只测 renderNumbered）");
  console.log(`src/markdown.js sha1:${sha}，片段数：${FIXTURES.length}`);
  console.log("命令：node test/obsidian-p2a.mjs；单片段调试：DEBUG_FIXTURE=<id> node test/obsidian-p2a.mjs");
}
