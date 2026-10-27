/**
 * Obsidian P2a 面板路径测试（M14：P1 遗留小修 + data-line-no 前置）
 *
 * 只测面板实际使用的 renderNumbered；加载方式同 test/obsidian-syntax.mjs
 * （读 src/markdown.js，new Function("React", ...)，stub createElement 收树）。
 *
 * 覆盖（方案 §4 M14 + task-1）：
 *   A. data-line-no 前置：所有行号元素带 data-line-no，且与行号文本一致；
 *   B1. 4 空格缩进代码块（块起始开启、多行、tab、EOF、遇普通行结束、不抢占列表）；
 *   B2. `* * *` / `- - -` 带空格水平线；
 *   B3. 表格 `[[A\|B]]`：口径以真机 Oracle 为准 → target=A、显示 B（方案原文 target=A|B 作废）；
 *   B4. setext 前导空格：真机 Oracle 不支持 → 不做，fixture 断言「不识别」作回归护栏。
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
check("fixtures", "M14 fixtures 齐全（≥5 个）", FIXTURES.length >= 5, `实测 ${FIXTURES.length} 个`);
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
  console.log("\n逐条失败信息见上方 ✗ 行（[fixture-id] 说明）。实现未完成时本文件应为红；M14 验收要求全绿。");
  process.exit(1);
}
console.log("全部 P2a（M14）面板路径断言通过 ✔");

function printRunHeader() {
  const sha = createHash("sha1").update(code).digest("hex").slice(0, 10);
  console.log("Obsidian P2a 面板路径测试（M14，只测 renderNumbered）");
  console.log(`src/markdown.js sha1:${sha}，片段数：${FIXTURES.length}`);
  console.log("命令：node test/obsidian-p2a.mjs；单片段调试：DEBUG_FIXTURE=<id> node test/obsidian-p2a.mjs");
}
