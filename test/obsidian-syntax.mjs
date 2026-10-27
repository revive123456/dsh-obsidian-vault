/**
 * Obsidian 语法面板路径测试（M0 护栏；方案 §3 M0、契约 §3/§6）
 *
 * 只测面板实际使用的 renderNumbered（行号预览视图），不测 renderMarkdown：
 *   - 43 个片段跑 3 条全量不变量：行号覆盖、偏移记账、P0/P1 标记不外漏；
 *   - P0（M1–M4）：引用 / 代码围栏 / 列表+任务 / 表格；
 *   - P1（M5–M7）：标题+setext+分隔线 / callout 正文块 / 双链显示。
 *
 * 运行：node test/obsidian-syntax.mjs（npm test 的 node --test test/*.mjs 也会收集本文件）
 * 调试单个片段的渲染树：DEBUG_FIXTURE=code-fence node test/obsidian-syntax.mjs
 *
 * 断言口径以《实施方案》M1–M7 验收条款 + 团队契约为准，不迁就现有实现：
 * 实现未完成时本文件应当是红的；M0–M7 全部完成后退出码必须为 0。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const code = readFileSync(join(root, "src", "markdown.js"), "utf8");

// ── stub React.createElement 收集元素树（加载方式同 test/markdown-smoke.mjs）──
const Fragment = Symbol.for("react.fragment");
function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
}
const React = { Fragment, createElement };
const { renderNumbered } = new Function("React", `${code}\nreturn { renderNumbered };`)(React);

// ── 43 个测试片段（方案附录 B；与 .scratch/audit/fixtures.mjs 一致）───────────
const FIXTURES = [
  { id: "h-headings", md: "# 一级\n\n## 二级\n\n### 三级\n\n#### 四级\n\n##### 五级\n\n###### 六级" },
  { id: "setext", md: "Setext 一级\n===\n\nSetext 二级\n---" },
  { id: "emphasis", md: "**粗体** *斜体* ***粗斜体*** __下划线粗__ _下划线斜_ **粗 *内斜* 粗**" },
  { id: "strike-highlight", md: "~~删除~~ 和 ==高亮==" },
  { id: "comment", md: "前面 %%隐藏内容%% 后面" },
  { id: "inline-code", md: "`code` 与 `` a ` b `` 与 `*不解析*`" },
  { id: "escape", md: "\\*不是斜体\\* \\# 不是标题 \\[[不是双链]]" },
  { id: "hardbreak", md: "第一行  \n第二行\n第三行（单换行）" },
  { id: "list-flat", md: "- a\n- b\n  - b1\n  - b2\n- c" },
  { id: "list-ordered", md: "1. 一\n2. 二\n   1. 二.一\n3. 三" },
  { id: "task", md: "- [ ] 未完成\n- [x] 已完成\n- [ ] 第三项" },
  { id: "quote", md: "> 引用 A\n> 引用 **B**" },
  { id: "quote-nested", md: "> 外层\n>> 内层引用" },
  { id: "callout-basic", md: "> [!warning] 注意\n> 正文 **粗体**" },
  { id: "callout-fold", md: "> [!note]- 折叠标题\n> 折叠内容" },
  { id: "callout-alias", md: "> [!hint] 提示\n> 别名 important/tip\n\n> [!summary] 摘要\n> 别名 abstract" },
  { id: "callout-unknown", md: "> [!custom] 未知类型\n> 正文" },
  { id: "callout-body-list", md: "> [!tip] 清单\n> - 项一\n> - 项二\n>\n> 收尾段落" },
  { id: "callout-title-md", md: "> [!note] **粗标题** 与 `code`\n> 正文" },
  { id: "table-basic", md: "| a | b |\n| --- | --- |\n| 1 | 2 |" },
  { id: "table-align", md: "| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |" },
  { id: "table-inline", md: "| 列 | 值 |\n| --- | --- |\n| **粗** | [[笔记A]] |" },
  { id: "code-fence", md: "```js\nconst a = 1;\n\nconst b = 2;\n```" },
  { id: "code-tilde", md: "~~~\nplain code\n~~~" },
  { id: "code-indent", md: "    indented code" },
  { id: "code-fence-meta", md: "```js title=\"示例\"\ncode\n```" },
  { id: "links-autolink", md: "[外链](https://example.com) 与 <https://example.com> 与裸链接 https://example.com" },
  { id: "wikilinks", md: "[[笔记A]] [[笔记A|显示名]] [[笔记A#标题]] [[笔记A#^blockid]]" },
  { id: "embed-note", md: "![[笔记A]] 与 ![[笔记A#标题]]" },
  { id: "embed-image", md: "![[pic.png]] ![[pic.png|200]] ![[pic.png|200x100]] ![[pic.png|替代文本]]" },
  { id: "embed-media", md: "![[录音.mp3]] ![[文档.pdf]]" },
  { id: "tags", md: "#标签 #父/子 与 `#不是标签`" },
  { id: "math-inline", md: "勾股 $a^2+b^2=c^2$ 结束" },
  { id: "math-block", md: "$$\nE = mc^2\n$$" },
  { id: "footnote", md: "正文[^1] 与再一个[^长注]\n\n[^1]: 脚注内容\n[^长注]: 第二条脚注" },
  { id: "html", md: "<b>粗</b> <kbd>Ctrl</kbd> <details><summary>展开</summary>内文</details>" },
  { id: "hr", md: "上面\n\n---\n\n下面" },
  { id: "mermaid", md: "```mermaid\ngraph TD;\nA-->B;\n```" },
  { id: "blockref", md: "段落内容 ^blockid" },
  { id: "heading-text", md: "# 标题\n紧接正文（无空行）" },
  { id: "unclosed-fence", md: "```js\nconst a = 1;" },
  { id: "frontmatter", md: "---\ntags: [a, b]\naliases: [别名一]\n---\n# 标题\n正文" },
  { id: "real-note", md: "---\ntags: [交付]\n---\n# 网络连通性与带宽\n\n> [!important] 一句话：iperf3 是两端配合的测速仪。\n\n**通过标准**\n\n| 项 | 判据 |\n| :--- | --- |\n| 吞吐 | 达标 |\n\n- 覆盖 100% 节点\n- 参考 [[集群交付概览|概览]]\n\n```bash\niperf3 -c 10.0.0.2\n```\n" },
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

// ── 序列化 / 查询 helper ────────────────────────────────────────────────────
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
/** 深度优先（文档序）遍历，visit(node, parent)。文本节点也访问。 */
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
/** 返回文档序的 [{node, parent}]（只含元素） */
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
/** 元素树 → 伪 HTML（元素名 / class / data-* / 布尔属性 / 文本），失败信息用 */
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
/** 缩进版序列化，DEBUG_FIXTURE 用 */
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

// 行 / 表格结构
function topBlocks(tree) {
  return childrenOf(tree);
}
/** 面板行序列里顶层普通行（div.dsh-obs-md-row）按行号建索引（表格整块不在其中） */
function rowMapOf(tree) {
  const map = new Map();
  for (const block of topBlocks(tree)) {
    if (!hasClass(block, "dsh-obs-md-row")) continue;
    const ln = childrenOf(block).find((c) => isElement(c) && Object.prototype.hasOwnProperty.call(c.props ?? {}, "data-line-no"));
    const num = ln ? Number(String(dataOf(ln, "data-line-no")).trim()) : NaN;
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
function tlnTextsOf(wrap) {
  return findAll(wrap, (n) => hasClass(n, "dsh-obs-md-tln")).map((n) => String(dataOf(n, "data-line-no")).trim());
}
function tableParts(wrap) {
  const table = wrap ? findAll(wrap, (n) => localName(n) === "table")[0] ?? null : null;
  const thead = table ? findAll(table, (n) => localName(n) === "thead")[0] ?? null : null;
  const tbody = table ? findAll(table, (n) => localName(n) === "tbody")[0] ?? null : null;
  const headerTr = thead ? findAll(thead, (n) => localName(n) === "tr")[0] ?? null : null;
  const headerCells = headerTr ? allCells(headerTr) : [];
  const sepRow = tbody ? findAll(tbody, (n) => hasClass(n, "dsh-obs-md-tsep"))[0] ?? null : null;
  const bodyRows = tbody ? findAll(tbody, (n) => hasClass(n, "dsh-obs-md-trow")) : [];
  return { wrap, table, thead, tbody, headerTr, headerCells, sepRow, bodyRows };
}

// data-obs-src 偏移 span
function hasSrcAttr(node) {
  return isElement(node) && node.props !== undefined &&
    Object.prototype.hasOwnProperty.call(node.props, "data-obs-src");
}
function srcSpanList(root) {
  return findAll(root, hasSrcAttr);
}
function rangeOf(node) {
  const raw = dataOf(node, "data-obs-src");
  if (typeof raw !== "string") return null;
  const m = /^(\d+),(\d+)$/.exec(raw);
  return m ? { start: Number(m[1]), end: Number(m[2]), raw } : null;
}
/** 递归收集「不在 data-obs-src 子树里」的纯文本（验证 › 分隔符等非 span 文本） */
function plainTextOutsideSrc(node) {
  let out = "";
  (function rec(n) {
    if (n === null || n === undefined) return;
    if (typeof n !== "object") {
      out += String(n);
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(rec);
      return;
    }
    if (hasSrcAttr(n)) return;
    childrenOf(n).forEach(rec);
  })(node);
  return out;
}

// ── 断言框架（失败信息带 fixture id；按里程碑分组汇总）──────────────────────
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
/** 文案：JSON 字符串化（失败提示可读） */
const j = (v) => JSON.stringify(v);

// ── 三条全量不变量（对 43 个片段全部跑，含 P2 片段）────────────────────────
/** 不变量 1（契约 §3.1）：N 行源码 → 行号 1..N 恰好各出现一次、文档序递增 */
function checkLineInvariant(id, md, tree) {
  const norm = normMd(md);
  const n = norm.split("\n").length;
  // P2 D2 前置：行号统一读 [data-line-no]，不再靠类名区分普通行/表格行
  const nodes = findNodes(tree, (node) => isElement(node) && node.props !== undefined &&
    Object.prototype.hasOwnProperty.call(node.props, "data-line-no"));
  const texts = nodes.map((x) => String(dataOf(x.node, "data-line-no")));
  check(id, `行号覆盖：${n} 行源码应有 ${n} 个行号节点（[data-line-no]）`, nodes.length === n, `${nodes.length} 个：${j(texts.slice(0, 40))}`);
  check(id, "行号覆盖：data-line-no 均为纯数字且与行号文本一致",
    nodes.length > 0 && texts.every((t, k) => /^\d+$/.test(t) && textOf(nodes[k].node).trim() === t),
    nodes.slice(0, 5).map(({ node }) => `${j(dataOf(node, "data-line-no"))}/${j(textOf(node))}`).join(", "));
  const nums = texts.map(Number);
  const expected = Array.from({ length: n }, (_, k) => k + 1);
  check(id, "行号覆盖：1..N 恰好各一次且按文档序递增", nums.length === expected.length && nums.every((v, k) => v === expected[k]), j(nums));
  const badShape = nodes.filter(({ node, parent }) => {
    if (hasClass(node, "dsh-obs-md-ln")) {
      return localName(node) !== "span" || !hasClass(parent, "dsh-obs-md-row");
    }
    if (hasClass(node, "dsh-obs-md-glno")) {
      return localName(node) !== "span" || !hasClass(parent, "dsh-obs-md-gutter");
    }
    return !["th", "td"].includes(localName(node));
  });
  check(id, "行号覆盖：普通行行号是 div.dsh-obs-md-row > span.dsh-obs-md-ln，表格行号是 th/td.dsh-obs-md-tln", badShape.length === 0, badShape.slice(0, 3).map(({ node }) => brief(node)).join(" | "));
}

/** 不变量 2（契约 §3.2）：data-obs-src 切片严格等于 span 文本，区间文档序不重叠 */
function checkOffsetInvariant(id, md, tree) {
  const norm = normMd(md);
  const spans = srcSpanList(tree);
  const badHost = spans.filter((n) => localName(n) !== "span" || !hasClass(n, "dsh-obs-src"));
  check(id, "偏移记账：data-obs-src 只出现在 span.dsh-obs-src 上", badHost.length === 0, badHost.slice(0, 3).map((n) => brief(n)).join(" | "));
  const badKids = spans.filter((n) => childrenOf(n).some((c) => typeof c === "object"));
  check(id, "偏移记账：偏移 span 内只有文本子节点（装饰不能包 data-obs-src）", badKids.length === 0, badKids.slice(0, 3).map((n) => brief(n)).join(" | "));
  const records = spans.map((span) => {
    const range = rangeOf(span);
    return { span, range, text: textOf(span) };
  });
  const badRange = records.filter((r) => r.range === null || r.range.end > norm.length);
  check(id, "偏移记账：data-obs-src 是合法区间 \"start,end\"", badRange.length === 0, badRange.slice(0, 3).map((r) => `${j(dataOf(r.span, "data-obs-src"))} 文本=${j(r.text)}`).join(" | "));
  const mismatched = records.filter((r) => r.range !== null && norm.slice(r.range.start, r.range.end) !== r.text);
  check(id, "偏移记账：md.slice(start,end) === span 文本", mismatched.length === 0,
    mismatched.slice(0, 3).map((r) => `${r.range.raw} 文本=${j(r.text)} 切片=${j(norm.slice(r.range.start, r.range.end))}`).join(" | "));
  const ordered = records.map((r) => r.range).filter((r) => r !== null).map((r) => ({ ...r }));
  const overlapAt = ordered.findIndex((r, k) => k > 0 && ordered[k - 1].end > r.start);
  check(id, "偏移记账：各偏移区间按文档序不重叠", overlapAt < 0,
    overlapAt > 0 ? `${ordered[overlapAt - 1].raw} 与 ${ordered[overlapAt].raw} 重叠/乱序` : "");
}

// 不变量 3（契约 §3.2/§6）：P0/P1 语法标记不得以原文外漏。
// 只对真正用到 P0/P1 语法的片段精确定义（P2 语法的原文保留不在本轮范围）。
const NO_RAW_LEAK = [
  { ids: ["quote", "quote-nested"], forbid: [">"], why: "M1 引用前缀应剥离" },
  { ids: ["callout-basic", "callout-fold", "callout-alias", "callout-unknown", "callout-body-list", "callout-title-md", "real-note"],
    forbid: [">", "[!"], why: "M1/M6 callout 标记应剥离" },
  { ids: ["code-fence", "code-tilde", "code-fence-meta", "unclosed-fence", "mermaid", "real-note"],
    forbid: ["```", "~~~"], why: "M2 围栏行不显示围栏符" },
  { ids: ["table-basic", "table-align", "table-inline"],
    forbid: ["|"], why: "M4 表格不应显示原文管道" },
  { ids: ["table-basic", "table-align", "table-inline"], forbid: ["---"], why: "M4 表格分隔行不显示原文" },
  { ids: ["list-flat"], forbid: ["- a", "- b", "- b1", "- b2", "- c"], why: "M3 无序列表符号应替换为 marker" },
  { ids: ["real-note"], forbid: ["- 覆盖", "- 参考"], why: "M3 无序列表符号应替换为 marker" },
  { ids: ["task"], forbid: ["[ ]", "[x]", "[X]", "- ["], why: "M3 任务标记应替换为复选框" },
  { ids: ["h-headings", "heading-text", "real-note"], forbid: ["# "], why: "M5 标题 # 标记应剥离" },
  { ids: ["setext", "hr"], forbid: ["===", "---"], why: "M5 setext 下划线/分隔线不显示原文" },
  { ids: ["wikilinks", "embed-note", "table-inline", "real-note"], forbid: ["[[", "]]"], why: "M7 双链不显示 [[ ]] 原文" },
  { ids: ["embed-note"], forbid: ["![["], why: "M7 非图片 embed 不显示原文" },
];
function leakContext(text, raw) {
  const idx = text.indexOf(raw);
  return idx < 0 ? "" : `…${text.slice(Math.max(0, idx - 25), idx + raw.length + 25)}…`;
}
function checkMarkerLeak(id, tree) {
  const text = textOf(tree);
  for (const rule of NO_RAW_LEAK) {
    if (!rule.ids.includes(id)) continue;
    for (const raw of rule.forbid) {
      check(id, `标记不外漏：不应出现原文 ${j(raw)}（${rule.why}）`, !text.includes(raw), leakContext(text, raw));
    }
  }
}

printRunHeader();
section("全量不变量 0：语料（43 片段）");
check("fixtures", "43 个片段齐全", FIXTURES.length === 43, `实测 ${FIXTURES.length} 个`);
check("fixtures", "片段 id 无重复", new Set(FIXTURES.map((f) => f.id)).size === FIXTURES.length, j(FIXTURES.map((f) => f.id)));
for (const fx of FIXTURES) {
  check(fx.id, "渲染不抛异常且返回元素树", isElement(renderFor(fx.id)), brief(renderFor(fx.id)));
}

section("全量不变量 1：行号覆盖（契约 §3.1）");
for (const fx of FIXTURES) checkLineInvariant(fx.id, fx.md, renderFor(fx.id));

section("全量不变量 2：偏移记账（契约 §3.2）");
for (const fx of FIXTURES) checkOffsetInvariant(fx.id, fx.md, renderFor(fx.id));

section("全量不变量 3：P0/P1 语法标记不外漏（契约 §3.2/§6）");
for (const fx of FIXTURES) checkMarkerLeak(fx.id, renderFor(fx.id));

// ══════════════════════════════════════════════════════════════════════════
// P0：M1 引用 / M2 代码围栏 / M3 列表+任务 / M4 表格
// ══════════════════════════════════════════════════════════════════════════

// ── M1 引用（契约 §4.1；方案 M1 验收：quote、quote-nested 每行都在、行号连续）──
section("P0-M1 引用（quote / quote-nested）");
{
  const id = "quote";
  const tree = renderFor(id);
  const r1 = rowOf(id, tree, 1);
  const r2 = rowOf(id, tree, 2);
  check(id, "结构：两行都是 .dsh-obs-md-row.dsh-obs-md-quote",
    [r1, r2].every((r) => r && hasClass(r, "dsh-obs-md-row") && hasClass(r, "dsh-obs-md-quote")),
    [r1, r2].map((r) => (r ? classList(r).join(".") : "缺行")).join(" | "));
  check(id, "结构：每行 data-quote-depth=1（引用深度）",
    [r1, r2].every((r) => r && String(dataOf(r, "data-quote-depth")) === "1"),
    [dataOf(r1, "data-quote-depth"), dataOf(r2, "data-quote-depth")].map(String).join(","));
  check(id, "文本：第 1 行去掉 > 前缀", r1 !== undefined && lcText(r1).trim() === "引用 A", r1 ? j(lcText(r1)) : "缺行");
  check(id, "文本：第 2 行去掉 > 前缀且行内 **B** 渲染为 strong",
    r2 !== undefined && lcText(r2).trim() === "引用 B" && findAll(r2, (n) => localName(n) === "strong").length === 1,
    r2 ? `${j(lcText(r2))}，strong=${findAll(r2, (n) => localName(n) === "strong").length}` : "缺行");
}
{
  const id = "quote-nested";
  const tree = renderFor(id);
  const r1 = rowOf(id, tree, 1);
  const r2 = rowOf(id, tree, 2);
  check(id, "结构：两行都是引用行", [r1, r2].every((r) => r && hasClass(r, "dsh-obs-md-quote")),
    [r1, r2].map((r) => (r ? classList(r).join(".") : "缺行")).join(" | "));
  checkEq(id, "结构：嵌套深度按行首 > 个数（第 1 行 1、第 2 行 2）",
    [dataOf(r1, "data-quote-depth"), dataOf(r2, "data-quote-depth")].map(String), ["1", "2"]);
  check(id, "文本：外层行内容", r1 !== undefined && lcText(r1).trim() === "外层", r1 ? j(lcText(r1)) : "缺行");
  check(id, "文本：内层引用行内容", r2 !== undefined && lcText(r2).trim() === "内层引用", r2 ? j(lcText(r2)) : "缺行");
}

// ── M2 代码围栏（契约 §4.2；方案 M2 验收：四片段内容完整、行号连续、无裸围栏）──
section("P0-M2 代码围栏（code-fence / code-tilde / code-fence-meta / unclosed-fence / mermaid）");

/** 校验整块行结构：全部 .dsh-obs-md-code、同 group、首行 head、末行 end */
function checkCodeFrame(id, tree, count) {
  const rows = [];
  for (let n = 1; n <= count; n++) rows.push(rowOf(id, tree, n));
  const present = rows.filter(Boolean);
  check(id, `结构：${count} 行都是代码块行（.dsh-obs-md-row.dsh-obs-md-code）`,
    present.length === count && present.every((r) => hasClass(r, "dsh-obs-md-row") && hasClass(r, "dsh-obs-md-code")),
    rows.map((r) => (r ? classList(r).join(".") : "缺行")).join(" | "));
  check(id, "结构：开围栏行有 dsh-obs-md-code-head", rows[0] !== undefined && hasClass(rows[0], "dsh-obs-md-code-head"),
    rows[0] ? brief(rows[0]) : "缺行");
  check(id, "结构：闭围栏行（未闭合时为最后一行）有 dsh-obs-md-code-end",
    rows[count - 1] !== undefined && hasClass(rows[count - 1], "dsh-obs-md-code-end"), rows[count - 1] ? brief(rows[count - 1]) : "缺行");
  const groups = [...new Set(present.map((r) => String(dataOf(r, "data-code-group"))))];
  check(id, "结构：整块共用同一个 data-code-group", present.length === count && groups.length === 1 && groups[0] !== "undefined",
    `groups=${j(groups)}`);
  return rows;
}
/** 校验开围栏行语言标签：span.dsh-obs-md-code-lang 内文本 === 语言词（映射源码） */
function checkCodeLang(id, openRow, expected) {
  const lang = openRow ? findAll(openRow, (n) => hasClass(n, "dsh-obs-md-code-lang"))[0] ?? null : null;
  check(id, "结构：开围栏行有 span.dsh-obs-md-code-lang", lang !== null, openRow ? brief(openRow) : "缺行");
  check(id, "文本：开围栏行只显示语言名（不显示围栏符）", lang !== null && textOf(lang).trim() === expected,
    lang ? j(textOf(lang)) : "无语言标签");
  if (lang !== null) {
    const hit = srcSpanList(lang).find((s) => textOf(s) === expected);
    check(id, "偏移：语言名映射到源码语言词区间", hit !== undefined, srcSpanList(lang).map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
  }
}
/** 代码正文行不得解析行内语法 */
function checkCodeBodyPlain(id, row) {
  const bad = row ? findAll(row, (n) => ["strong", "em", "a", "button", "input", "img", "code"].includes(localName(n))) : [];
  check(id, "结构：代码正文不解析行内语法（无 strong/em/link 等元素）", row !== undefined && bad.length === 0,
    row ? bad.map((n) => brief(n)).join(" | ") : "缺行");
}
{
  const id = "code-fence";
  const tree = renderFor(id);
  const rows = checkCodeFrame(id, tree, 5);
  checkCodeLang(id, rows[0], "js");
  check(id, "文本：开围栏行不显示 ```（只显示语言名）", rows[0] !== undefined && !lcText(rows[0]).includes("`"), rows[0] ? j(lcText(rows[0])) : "缺行");
  check(id, "文本：正文两行与块内空行都完整保留",
    rows[1] !== undefined && rows[2] !== undefined && rows[3] !== undefined &&
      lcText(rows[1]) === "const a = 1;" && lcText(rows[2]) === "" && lcText(rows[3]) === "const b = 2;",
    rows.map((r) => (r ? j(lcText(r)) : "缺行")).join(" | "));
  checkCodeBodyPlain(id, rows[1]);
  check(id, "文本：闭围栏行内容为空（不显示 ```）", rows[4] !== undefined && lcText(rows[4]) === "", rows[4] ? j(lcText(rows[4])) : "缺行");
}
{
  const id = "code-tilde";
  const tree = renderFor(id);
  const rows = checkCodeFrame(id, tree, 3);
  check(id, "文本：~~~ 围栏与 ``` 等价，无语言时开围栏行内容为空", rows[0] !== undefined && lcText(rows[0]) === "", rows[0] ? j(lcText(rows[0])) : "缺行");
  check(id, "文本：正文行内容完整", rows[1] !== undefined && lcText(rows[1]) === "plain code", rows[1] ? j(lcText(rows[1])) : "缺行");
  check(id, "文本：闭围栏行内容为空", rows[2] !== undefined && lcText(rows[2]) === "", rows[2] ? j(lcText(rows[2])) : "缺行");
}
{
  const id = "code-fence-meta";
  const tree = renderFor(id);
  const rows = checkCodeFrame(id, tree, 3);
  checkCodeLang(id, rows[0], "js");
  check(id, "文本：info string 取第一个词作语言、参数不外漏", !textOf(tree).includes("title="), traceText(tree));
  check(id, "文本：正文行内容完整", rows[1] !== undefined && lcText(rows[1]) === "code", rows[1] ? j(lcText(rows[1])) : "缺行");
  check(id, "文本：闭围栏行内容为空", rows[2] !== undefined && lcText(rows[2]) === "", rows[2] ? j(lcText(rows[2])) : "缺行");
}
{
  const id = "unclosed-fence";
  const tree = renderFor(id);
  const rows = checkCodeFrame(id, tree, 2);
  checkCodeLang(id, rows[0], "js");
  check(id, "文本：未闭合围栏吃到文末、正文完整", rows[1] !== undefined && lcText(rows[1]) === "const a = 1;", rows[1] ? j(lcText(rows[1])) : "缺行");
  checkCodeBodyPlain(id, rows[1]);
}
{
  // P2b M20：mermaid 围栏不再按 code 行渲染，改为 D2 块（块 + 行号竖列，契约 §3.2/§3.9）：
  // gutter 覆盖围栏开/内容/闭每一行；body 无 handler 时逐行源码降级（带精确 src span）。
  const id = "mermaid";
  const md = FIXTURES_BY_ID[id].md;
  const tree = renderFor(id);
  const blocks = findAll(tree, (n) => isElement(n) && dataOf(n, "data-block-kind") === "mermaid");
  checkEq(id, "结构：1 个 data-block-kind=mermaid 块", blocks.length, 1);
  const block = blocks[0] ?? null;
  const gutter = block ? findAll(block, (n) => hasClass(n, "dsh-obs-md-gutter"))[0] ?? null : null;
  const gutterNums = gutter
    ? findAll(gutter, (n) => isElement(n) && Object.prototype.hasOwnProperty.call(n.props ?? {}, "data-line-no"))
      .map((n) => String(dataOf(n, "data-line-no")))
    : [];
  checkEq(id, "行号：gutter 覆盖围栏 4 行 [1,2,3,4]", gutterNums, ["1", "2", "3", "4"]);
  const body = block ? findAll(block, (n) => hasClass(n, "dsh-obs-md-block-body"))[0] ?? null : null;
  check(id, "结构：块有 block-body 且 body 内不出现行号元素",
    body !== null && findAll(body, (n) => isElement(n) && Object.prototype.hasOwnProperty.call(n.props ?? {}, "data-line-no")).length === 0);
  const spans = body ? srcSpanList(body) : [];
  checkEq(id, "偏移：body 逐行源码降级带精确 src span", spans.map((n) => textOf(n)), ["graph TD;", "A-->B;"]);
  check(id, "偏移：span 切片 === 源码行（不含围栏符）",
    spans.length === 2 && sliceOfSpan(spans[0], md) === "graph TD;" && sliceOfSpan(spans[1], md) === "A-->B;",
    spans.map((n) => `${dataOf(n, "data-obs-src")}=${j(textOf(n))}`).join(","));
  check(id, "文本：围栏正文完整、围栏反引号不外漏",
    textOf(tree).includes("graph TD;") && textOf(tree).includes("A-->B;") && !textOf(tree).includes("```"),
    j(textOf(tree)));
}

// ── M3 列表 + 任务（契约 §4.3；方案 M3 验收：符号/编号/缩进/复选框正确）──────
section("P0-M3 列表 + 任务（list-flat / list-ordered / task）");

function listRowOf(id, tree, num) {
  const row = rowOf(id, tree, num);
  check(id, `结构：第 ${num} 行是 .dsh-obs-md-row.dsh-obs-md-list`, row !== undefined && hasClass(row, "dsh-obs-md-list"),
    row ? classList(row).join(".") : "缺行");
  return row;
}
function listMarkerText(row) {
  const marker = row ? findAll(row, (n) => hasClass(n, "dsh-obs-md-list-marker"))[0] ?? null : null;
  return marker === null ? null : textOf(marker);
}
function listBodyText(row) {
  const body = row ? findAll(row, (n) => hasClass(n, "dsh-obs-md-list-body"))[0] ?? null : null;
  return body === null ? null : textOf(body);
}
/** 逐行核对：kind / depth / 前导 marker 文本 / 正文文本 */
function checkListRow(id, tree, num, { kind, depth, marker, body }) {
  const row = listRowOf(id, tree, num);
  check(id, `结构：第 ${num} 行 data-list-kind=${kind}、data-list-depth=${depth}`,
    row !== undefined && String(dataOf(row, "data-list-kind")) === kind && String(dataOf(row, "data-list-depth")) === depth,
    row ? `kind=${j(String(dataOf(row, "data-list-kind")))} depth=${j(String(dataOf(row, "data-list-depth")))}` : "缺行");
  const markerText = listMarkerText(row);
  check(id, `文本：第 ${num} 行前导符号为 ${j(marker)}`, markerText !== null && markerText.trim() === marker, markerText === null ? "无 marker span" : j(markerText));
  const bodyText = listBodyText(row);
  check(id, `文本：第 ${num} 行正文为 ${j(body)}`, bodyText !== null && bodyText === body, bodyText === null ? "无 body span" : j(bodyText));
}
{
  const id = "list-flat";
  const tree = renderFor(id);
  checkListRow(id, tree, 1, { kind: "ul", depth: "0", marker: "•", body: "a" });
  checkListRow(id, tree, 2, { kind: "ul", depth: "0", marker: "•", body: "b" });
  checkListRow(id, tree, 3, { kind: "ul", depth: "1", marker: "◦", body: "b1" });
  checkListRow(id, tree, 4, { kind: "ul", depth: "1", marker: "◦", body: "b2" });
  checkListRow(id, tree, 5, { kind: "ul", depth: "0", marker: "•", body: "c" });
}
{
  const id = "list-ordered";
  const tree = renderFor(id);
  checkListRow(id, tree, 1, { kind: "ol", depth: "0", marker: "1.", body: "一" });
  checkListRow(id, tree, 2, { kind: "ol", depth: "0", marker: "2.", body: "二" });
  checkListRow(id, tree, 3, { kind: "ol", depth: "1", marker: "1.", body: "二.一" });
  checkListRow(id, tree, 4, { kind: "ol", depth: "0", marker: "3.", body: "三" });
}
{
  const id = "task";
  const tree = renderFor(id);
  const expected = [
    { num: 1, checked: "0", body: "未完成" },
    { num: 2, checked: "1", body: "已完成" },
    { num: 3, checked: "0", body: "第三项" },
  ];
  for (const item of expected) {
    const row = listRowOf(id, tree, item.num);
    check(id, `结构：第 ${item.num} 行 data-list-kind=task、depth=0、data-checked=${item.checked}`,
      row !== undefined && String(dataOf(row, "data-list-kind")) === "task" &&
        String(dataOf(row, "data-list-depth")) === "0" && String(dataOf(row, "data-checked")) === item.checked,
      row ? `kind=${j(String(dataOf(row, "data-list-kind")))} depth=${j(String(dataOf(row, "data-list-depth")))} checked=${j(String(dataOf(row, "data-checked")))}` : "缺行");
    const markerText = listMarkerText(row);
    check(id, `结构：第 ${item.num} 行有 dsh-obs-md-list-marker`, markerText !== null && markerText !== "", row ? brief(row) : "缺行");
    const bodyText = listBodyText(row);
    check(id, `文本：第 ${item.num} 行正文为 ${j(item.body)}（复选框标记不混进正文）`, bodyText !== null && bodyText === item.body, bodyText === null ? "无 body span" : j(bodyText));
    const boxes = row ? findAll(row, (n) => localName(n) === "input" && hasClass(n, "dsh-obs-md-task-check")) : [];
    const box = boxes[0] ?? null;
    check(id, `结构：第 ${item.num} 行有 1 个只读复选框 input.dsh-obs-md-task-check（type=checkbox + disabled）`,
      boxes.length === 1 && String(dataOf(box, "type")) === "checkbox" && Boolean(dataOf(box, "disabled")),
      row ? `${boxes.length} 个：${boxes.map((b) => brief(b)).join(" | ")}` : "缺行");
    check(id, `结构：第 ${item.num} 行复选框 checked 与 [x] 一致`, box !== null && Boolean(dataOf(box, "checked")) === (item.checked === "1"),
      box ? `checked=${j(String(dataOf(box, "checked")))}` : "无复选框");
  }
}

// 补充边界（契约 §4.3 明文要求，fixture 未覆盖）
section("P0-M3 补充边界：有序起始编号 / tab 缩进 / 三级符号轮换（契约 §4.3）");
{
  const id = "edge:ordered-start";
  const md = "3. 三\n4. 四";
  const tree = renderNumbered(md, HANDLERS);
  checkLineInvariant(id, md, tree);
  checkOffsetInvariant(id, md, tree);
  const r1 = rowOf(id, tree, 1);
  const r2 = rowOf(id, tree, 2);
  checkEq(id, "有序列表起始编号 3. 起头按 3、4 计数",
    [listMarkerText(r1)?.trim(), listMarkerText(r2)?.trim()], ["3.", "4."]);
}
{
  const id = "edge:tab-indent";
  const md = "- a\n\t- tab 项";
  const tree = renderNumbered(md, HANDLERS);
  checkLineInvariant(id, md, tree);
  checkOffsetInvariant(id, md, tree);
  const r2 = rowOf(id, tree, 2);
  check(id, "tab 按 4 空格折算，第二行深度 1", r2 !== undefined && String(dataOf(r2, "data-list-depth")) === "1",
    r2 ? `depth=${j(String(dataOf(r2, "data-list-depth")))}` : "缺行");
  check(id, "第三级前面的层级不误判（depth 0 行 marker •）", listMarkerText(rowOf(id, tree, 1))?.trim() === "•",
    j(listMarkerText(rowOf(id, tree, 1))));
}
{
  const id = "edge:ul-rotation";
  const md = "- a\n  - b\n    - c";
  const tree = renderNumbered(md, HANDLERS);
  checkLineInvariant(id, md, tree);
  checkOffsetInvariant(id, md, tree);
  const r3 = rowOf(id, tree, 3);
  check(id, "无序符号按层级轮换：depth 2 是 ▪", r3 !== undefined && String(dataOf(r3, "data-list-depth")) === "2" && listMarkerText(r3)?.trim() === "▪",
    r3 ? `depth=${j(String(dataOf(r3, "data-list-depth")))} marker=${j(listMarkerText(r3))}` : "缺行");
}

// ── M4 表格（契约 §4.4；方案 M4 验收：真表格/对齐/行内/行号连续/无管道原文）──
section("P0-M4 表格（table-basic / table-align / table-inline / real-note）");

function tableOf(id, tree) {
  const wraps = tablesOf(tree);
  check(id, "结构：出现 dsh-obs-md-tablewrap 整块（不拆成行）", wraps.length === 1, `实测 ${wraps.length} 个 tablewrap`);
  return wraps[0] ?? null;
}
function checkTableFrame(id, wrap) {
  const parts = wrap ? tableParts(wrap) : null;
  check(id, "结构：tablewrap > table.dsh-obs-md-table", parts?.table !== null && parts?.table !== undefined && hasClass(parts.table, "dsh-obs-md-table"),
    wrap ? brief(wrap, 200) : "无表格");
  check(id, "结构：有 thead / tbody", Boolean(parts?.thead) && Boolean(parts?.tbody), parts ? `thead=${Boolean(parts.thead)} tbody=${Boolean(parts.tbody)}` : "无表格");
  return parts;
}
function checkCellAligns(id, cells, expected, label) {
  const actual = cells.map((c) => String(dataOf(c, "data-align")));
  check(id, `结构：${label} data-align=${j(expected)}`, j(actual) === j(expected), j(actual));
}
{
  const id = "table-basic";
  const tree = renderFor(id);
  const wrap = tableOf(id, tree);
  const parts = checkTableFrame(id, wrap);
  const header = parts?.headerCells ?? [];
  check(id, "结构：表头行 = 1 个行号列 + 2 个数据列（行尾 | 不多出空列）",
    header.length === 3 && hasClass(header[0], "dsh-obs-md-tln") && localName(header[0]) === "th",
    `${header.length} 个：${header.map((c) => `${localName(c)}.${classList(c).join(".")}`).join(" | ")}`);
  check(id, "文本：表头行号列为源码第 1 行", header[0] !== undefined && textOf(header[0]).trim() === "1", header[0] ? j(textOf(header[0])) : "缺");
  check(id, "文本：表头单元格 a / b 已渲染", header.length === 3 && textOf(header[1]).trim() === "a" && textOf(header[2]).trim() === "b",
    header.map((c) => j(textOf(c))).join(","));
  checkCellAligns(id, header.slice(1), ["none", "none"], "表头列");
  const sepCells = allCells(parts?.sepRow);
  check(id, "结构：分隔行是 tr.dsh-obs-md-tsep，含行号列 + 合并空单元格",
    Boolean(parts?.sepRow) && hasClass(parts.sepRow, "dsh-obs-md-tsep") && sepCells.length === 2 &&
      hasClass(sepCells[0], "dsh-obs-md-tln") && localName(sepCells[0]) === "td" && hasClass(sepCells[1], "dsh-obs-md-tsep-cell"),
    parts?.sepRow ? brief(parts.sepRow) : "无分隔行");
  check(id, "文本：分隔行占源码第 2 行行号", sepCells[0] !== undefined && textOf(sepCells[0]).trim() === "2", sepCells[0] ? j(textOf(sepCells[0])) : "缺");
  check(id, "结构：分隔行空单元格 colspan=表头数据列数 2", sepCells[1] !== undefined && String(dataOf(sepCells[1], "colspan")) === "2" &&
    textOf(sepCells[1]) === "", sepCells[1] ? brief(sepCells[1]) : "缺");
  const bodyRows = parts?.bodyRows ?? [];
  const bodyCells = dataCells(bodyRows[0]);
  const bodyLn = allCells(bodyRows[0])[0] ?? null;
  check(id, "结构：正文行 tr.dsh-obs-md-trow = 行号列 + 2 数据列",
    bodyRows.length === 1 && allCells(bodyRows[0]).length === 3 && hasClass(bodyLn, "dsh-obs-md-tln") && localName(bodyLn) === "td" && bodyCells.length === 2,
    parts ? `bodyRows=${bodyRows.length} cells=${allCells(bodyRows[0]).map((c) => localName(c)).join(",")}` : "缺");
  check(id, "文本：正文行行号 3、单元格 1 / 2 已渲染",
    bodyLn !== null && textOf(bodyLn).trim() === "3" && bodyCells.length === 2 && textOf(bodyCells[0]).trim() === "1" && textOf(bodyCells[1]).trim() === "2",
    bodyRows[0] ? j(textOf(bodyRows[0])) : "缺");
  checkCellAligns(id, bodyCells, ["none", "none"], "正文单元格");
}
{
  const id = "table-align";
  const tree = renderFor(id);
  const parts = checkTableFrame(id, tableOf(id, tree));
  const header = parts?.headerCells ?? [];
  check(id, "文本：表头三列 左 / 中 / 右", dataCells(parts?.headerTr).length === 3 &&
    j(dataCells(parts?.headerTr).map((c) => textOf(c).trim())) === j(["左", "中", "右"]),
    j(dataCells(parts?.headerTr).map((c) => textOf(c).trim())));
  checkCellAligns(id, header.slice(1), ["left", "center", "right"], "表头列");
  const bodyRow = (parts?.bodyRows ?? [])[0] ?? null;
  const bodyCells = dataCells(bodyRow);
  check(id, "文本：正文三格 1 / 2 / 3", j(bodyCells.map((c) => textOf(c).trim())) === j(["1", "2", "3"]), j(bodyCells.map((c) => textOf(c).trim())));
  checkCellAligns(id, bodyCells, ["left", "center", "right"], "正文单元格");
}
{
  const id = "table-inline";
  const tree = renderFor(id);
  const parts = checkTableFrame(id, tableOf(id, tree));
  const bodyRow = (parts?.bodyRows ?? [])[0] ?? null;
  const bodyCells = dataCells(bodyRow);
  check(id, "文本：单元格文本 **粗** → 粗、双链目标 笔记A 在（双链显示形态归 P1-M7 断言）",
    bodyCells.length === 2 && textOf(bodyCells[0]).trim() === "粗" && textOf(bodyCells[1]).includes("笔记A"),
    j(bodyCells.map((c) => textOf(c).trim())));
  check(id, "结构：单元格内 strong 行内元素正常",
    bodyCells[0] !== undefined && findAll(bodyCells[0], (n) => localName(n) === "strong").length === 1,
    bodyCells[0] ? brief(bodyCells[0]) : "缺");
  check(id, "结构：单元格内双链按钮正常（button.dsh-obs-wikilink）",
    bodyCells[1] !== undefined && findAll(bodyCells[1], (n) => localName(n) === "button" && hasClass(n, "dsh-obs-wikilink")).length === 1,
    bodyCells[1] ? brief(bodyCells[1]) : "缺");
}
{
  const id = "real-note";
  const tree = renderFor(id);
  const parts = checkTableFrame(id, tableOf(id, tree));
  const wrap = parts?.wrap;
  check(id, "结构：表格行号列覆盖源码第 10/11/12 行（表头+分隔+正文）", j(tlnTextsOf(wrap)) === j(["10", "11", "12"]), j(tlnTextsOf(wrap)));
  check(id, "文本：表头单元格 项 / 判据", j(dataCells(parts?.headerTr).map((c) => textOf(c).trim())) === j(["项", "判据"]),
    j(dataCells(parts?.headerTr).map((c) => textOf(c).trim())));
  checkCellAligns(id, (parts?.headerCells ?? []).slice(1), ["left", "none"], "表头列（分隔行 :--- / ---）");
  const bodyCells = dataCells((parts?.bodyRows ?? [])[0]);
  check(id, "文本：正文单元格 吞吐 / 达标", j(bodyCells.map((c) => textOf(c).trim())) === j(["吞吐", "达标"]), j(bodyCells.map((c) => textOf(c).trim())));
  check(id, "文本：表格整块不再出现管道原文", !textOf(wrap).includes("|"), textOf(wrap));
}

// 补充边界（契约 §3.2/§4.4 明文要求，fixture 未覆盖）：\| 转义
section("P0-M4 补充边界：\\| 转义（契约 §3.2/§4.4）");
{
  const id = "edge:table-escape";
  const md = "| 列 | 值 |\n| --- | --- |\n| a \\| b | c |";
  const tree = renderNumbered(md, HANDLERS);
  checkLineInvariant(id, md, tree);
  checkOffsetInvariant(id, md, tree);
  const wrap = tablesOf(tree)[0] ?? null;
  const bodyRow = wrap ? (tableParts(wrap).bodyRows[0] ?? null) : null;
  const cells = dataCells(bodyRow);
  check(id, "文本：\\| 显示为 |，单元格文本 a | b", cells[0] !== undefined && textOf(cells[0]).trim() === "a | b", cells[0] ? j(textOf(cells[0])) : "缺");
  check(id, "文本：转义反斜杠不外漏", !textOf(tree).includes("\\"), textOf(tree));
  const pipeSpan = cells[0] !== undefined ? srcSpanList(cells[0]).find((s) => textOf(s) === "|") ?? null : null;
  check(id, "偏移：显示 | 的 span 映射源码里的 | 单字符（不含反斜杠）",
    pipeSpan !== null && (() => {
      const r = rangeOf(pipeSpan);
      return r !== null && normMd(md).slice(r.start, r.end) === "|" && normMd(md)[r.start - 1] === "\\";
    })(), pipeSpan ? `${dataOf(pipeSpan, "data-obs-src")}=${j(textOf(pipeSpan))}` : "无 | 映射 span");
}

// ══════════════════════════════════════════════════════════════════════════
// P1：M5 标题/setext/hr / M6 callout 正文块 / M7 双链显示
// ══════════════════════════════════════════════════════════════════════════

// ── M5 标题分级 / setext / 分隔线（契约 §4.5；方案 M5 验收：h-headings、setext、hr、heading-text）──
section("P1-M5 标题分级 + setext + 分隔线（h-headings / setext / hr / heading-text）");
{
  const id = "h-headings";
  const tree = renderFor(id);
  // 源码行：1 h1、3 h2、5 h3、7 h4、9 h5、11 h6
  const expected = [
    { num: 1, level: 1, text: "一级" },
    { num: 3, level: 2, text: "二级" },
    { num: 5, level: 3, text: "三级" },
    { num: 7, level: 4, text: "四级" },
    { num: 9, level: 5, text: "五级" },
    { num: 11, level: 6, text: "六级" },
  ];
  const headingRows = findNodes(tree, (n) => hasClass(n, "dsh-obs-md-heading")).map((x) => x.node);
  check(id, "结构：恰好 6 个标题行（dsh-obs-md-heading）", headingRows.length === 6, `实测 ${headingRows.length}：${headingRows.map((r) => classList(r).join(".")).join(" | ")}`);
  const levelClasses = headingRows.map((r) => classList(r).filter((c) => /^dsh-obs-md-h[1-6]$/.test(c)));
  check(id, "结构：六级各自带且只带一个 dsh-obs-md-h1..h6 class", levelClasses.length === 6 && levelClasses.every((c) => c.length === 1),
    j(levelClasses));
  for (const item of expected) {
    const row = rowOf(id, tree, item.num);
    check(id, `结构：第 ${item.num} 行是 h${item.level}`, row !== undefined && hasClass(row, `dsh-obs-md-h${item.level}`),
      row ? classList(row).join(".") : "缺行");
    check(id, `文本：第 ${item.num} 行内容为 ${j(item.text)}（# 标记已剥离）`, row !== undefined && lcText(row).trim() === item.text,
      row ? j(lcText(row)) : "缺行");
  }
}
{
  const id = "setext";
  const tree = renderFor(id);
  const r1 = rowOf(id, tree, 1);
  const r2 = rowOf(id, tree, 2);
  const r4 = rowOf(id, tree, 4);
  const r5 = rowOf(id, tree, 5);
  check(id, "结构：= 下划线上一行按 h1 渲染", r1 !== undefined && hasClass(r1, "dsh-obs-md-h1"), r1 ? classList(r1).join(".") : "缺行");
  check(id, "结构：- 下划线上一行按 h2 渲染", r4 !== undefined && hasClass(r4, "dsh-obs-md-h2"), r4 ? classList(r4).join(".") : "缺行");
  check(id, "结构：下划线行是 dsh-obs-md-setext-underline（不显示 === / ---）",
    r2 !== undefined && hasClass(r2, "dsh-obs-md-setext-underline") && r5 !== undefined && hasClass(r5, "dsh-obs-md-setext-underline"),
    [r2, r5].map((r) => (r ? classList(r).join(".") : "缺行")).join(" | "));
  check(id, "结构：setext 优先于分隔线（下划线行不判成 dsh-obs-md-hr）",
    r2 !== undefined && r5 !== undefined && !hasClass(r2, "dsh-obs-md-hr") && !hasClass(r5, "dsh-obs-md-hr"),
    [r2, r5].map((r) => (r ? classList(r).join(".") : "缺行")).join(" | "));
  check(id, "文本：两个 setext 标题内容正确", r1 !== undefined && r4 !== undefined &&
    lcText(r1).trim() === "Setext 一级" && lcText(r4).trim() === "Setext 二级",
    [r1, r4].map((r) => (r ? j(lcText(r)) : "缺行")).join(" | "));
  check(id, "文本：下划线行内容为空", r2 !== undefined && r5 !== undefined && lcText(r2) === "" && lcText(r5) === "",
    [r2, r5].map((r) => (r ? j(lcText(r)) : "缺行")).join(" | "));
}
{
  const id = "hr";
  const tree = renderFor(id);
  const r3 = rowOf(id, tree, 3);
  check(id, "结构：单独 --- 行是 dsh-obs-md-hr（不是 setext/列表）", r3 !== undefined && hasClass(r3, "dsh-obs-md-hr"),
    r3 ? classList(r3).join(".") : "缺行");
  const hrLine = r3 ? findAll(r3, (n) => localName(n) === "hr" && hasClass(n, "dsh-obs-md-hr-line"))[0] ?? null : null;
  check(id, "结构：lc 里放 hr.dsh-obs-md-hr-line", hrLine !== null, r3 ? brief(r3) : "缺行");
  check(id, "文本：分隔线行不显示 --- 文本", r3 !== undefined && lcText(r3) === "", r3 ? j(lcText(r3)) : "缺行");
  check(id, "文本：分隔线前后正文保留", textOf(tree).includes("上面") && textOf(tree).includes("下面"), traceText(tree));
}
{
  const id = "heading-text";
  const tree = renderFor(id);
  const r1 = rowOf(id, tree, 1);
  const r2 = rowOf(id, tree, 2);
  check(id, "结构：第 1 行是 h1", r1 !== undefined && hasClass(r1, "dsh-obs-md-h1"), r1 ? classList(r1).join(".") : "缺行");
  check(id, "结构：标题后紧跟的正文不会被吞成 setext/h2（第 2 行是普通行）",
    r2 !== undefined && !hasClass(r2, "dsh-obs-md-heading") && !hasClass(r2, "dsh-obs-md-setext-underline") && !hasClass(r2, "dsh-obs-md-h2"),
    r2 ? classList(r2).join(".") : "缺行");
  check(id, "文本：标题内容 标题 + 正文内容完整", r1 !== undefined && r2 !== undefined &&
    lcText(r1).trim() === "标题" && lcText(r2).trim() === "紧接正文（无空行）",
    [r1, r2].map((r) => (r ? j(lcText(r)) : "缺行")).join(" | "));
}
{
  const id = "real-note";
  const tree = renderFor(id);
  const r4 = rowOf(id, tree, 4);
  check(id, "结构：第 4 行 # 标题是 h1", r4 !== undefined && hasClass(r4, "dsh-obs-md-heading") && hasClass(r4, "dsh-obs-md-h1"),
    r4 ? classList(r4).join(".") : "缺行");
  check(id, "文本：标题内容 网络连通性与带宽", r4 !== undefined && lcText(r4).trim() === "网络连通性与带宽", r4 ? j(lcText(r4)) : "缺行");
}

// 补充边界（契约 §4.5 明文要求，fixture 未覆盖）：# 后多空格时内容偏移按实际匹配长度
section("P1-M5 补充边界：标题多空格内容偏移（契约 §4.5）");
{
  const id = "edge:heading-multi-space";
  const md = "#  多空格标题";
  const tree = renderNumbered(md, HANDLERS);
  checkLineInvariant(id, md, tree);
  checkOffsetInvariant(id, md, tree);
  const r1 = rowOf(id, tree, 1);
  check(id, "结构：# 后多空格仍是 h1", r1 !== undefined && hasClass(r1, "dsh-obs-md-heading") && hasClass(r1, "dsh-obs-md-h1"),
    r1 ? classList(r1).join(".") : "缺行");
  check(id, "文本：显示内容不含多余空格", r1 !== undefined && lcText(r1) === "多空格标题", r1 ? j(lcText(r1)) : "缺行");
  const spans = r1 ? srcSpanList(r1) : [];
  const hit = spans.find((s) => textOf(s) === "多空格标题");
  check(id, "偏移：标题内容 span 切到源码 多空格标题 区间", hit !== undefined && (() => {
    const r = rangeOf(hit);
    return r !== null && normMd(md).slice(r.start, r.end) === "多空格标题";
  })(), spans.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
}

// ── M6 callout 正文块（契约 §4.1/§4.6；方案 M6 验收：callout-body-list / callout-title-md / callout-basic）──
section("P1-M6 callout 正文块（callout-basic / callout-body-list / callout-title-md / callout-alias / callout-fold / callout-unknown / real-note）");

/** 校验一组行属于同一个 callout：同 gid、每行 data-callout、首行 head、其余 body、末行 end */
function checkCalloutGroup(id, tree, nums, canonical) {
  const rows = nums.map((n) => rowOf(id, tree, n));
  const present = rows.filter(Boolean);
  check(id, `结构：${nums.join("/")} 行都是引用行（dsh-obs-md-quote）`,
    present.length === nums.length && present.every((r) => hasClass(r, "dsh-obs-md-row") && hasClass(r, "dsh-obs-md-quote")),
    rows.map((r) => (r ? classList(r).join(".") : "缺行")).join(" | "));
  const gids = [...new Set(present.map((r) => String(dataOf(r, "data-callout-group"))))];
  check(id, "结构：同一 callout 各行共用 data-callout-group", present.length === nums.length && gids.length === 1 && gids[0] !== "undefined", j(gids));
  const canon = present.map((r) => String(dataOf(r, "data-callout")));
  check(id, `结构：每行 data-callout=${canonical}（canonical 类型）`, present.length === nums.length && canon.every((c) => c === canonical), j(canon));
  check(id, "结构：首行 lc 带 dsh-obs-md-callout-head", rows[0] !== undefined && hasClass(lcOf(rows[0]), "dsh-obs-md-callout-head"),
    rows[0] ? brief(rows[0]) : "缺行");
  const middle = rows.slice(1);
  check(id, "结构：其余行 lc 带 dsh-obs-md-callout-body", middle.every((r) => r !== undefined && hasClass(lcOf(r), "dsh-obs-md-callout-body")),
    middle.map((r) => (r ? classList(lcOf(r) ?? {}).join(".") : "缺行")).join(" | "));
  check(id, "结构：末行带 dsh-obs-md-callout-end", rows[nums.length - 1] !== undefined && hasClass(rows[nums.length - 1], "dsh-obs-md-callout-end"),
    rows[nums.length - 1] ? brief(rows[nums.length - 1]) : "缺行");
  return rows;
}
const countOf = (text, sub) => text.split(sub).length - 1;
{
  const id = "callout-basic";
  const tree = renderFor(id);
  const rows = checkCalloutGroup(id, tree, [1, 2], "warning");
  const text = textOf(tree);
  check(id, "文本：显式标题与默认名相同时不重复显示（注意 只出现 1 次）", countOf(text, "注意") === 1, `${countOf(text, "注意")} 次：${j(text)}`);
  // 严格口径（契约 §4.6，Lead 裁决）：有显式标题时徽标只留图标，标题文本单独显示且带源码 span
  const titleSpans = rows[0] !== undefined ? srcSpanList(rows[0]).filter((s) => textOf(s).includes("注意")) : [];
  check(id, "结构：标题文本带 data-obs-src span（映射源码 注意）", titleSpans.length >= 1 && titleSpans.some((s) => {
    const r = rangeOf(s);
    return r !== null && normMd(FIXTURES_BY_ID[id].md).slice(r.start, r.end) === "注意";
  }), titleSpans.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
  check(id, "文本：正文行内 **粗体** 正常", rows[1] !== undefined && lcText(rows[1]).includes("粗体") &&
    findAll(rows[1], (n) => localName(n) === "strong").length === 1, rows[1] ? brief(rows[1]) : "缺行");
  check(id, "文本：正文不再显示 > 前缀", rows[1] !== undefined && !lcText(rows[1]).includes(">"), rows[1] ? j(lcText(rows[1])) : "缺行");
}
{
  const id = "callout-body-list";
  const tree = renderFor(id);
  const rows = checkCalloutGroup(id, tree, [1, 2, 3, 4, 5], "tip");
  for (const [num, body] of [[2, "项一"], [3, "项二"]]) {
    const row = rows[num - 1];
    check(id, `结构：第 ${num} 行正文列表（data-list-kind=ul、data-list-depth=0）`,
      row !== undefined && String(dataOf(row, "data-list-kind")) === "ul" && String(dataOf(row, "data-list-depth")) === "0",
      row ? `kind=${j(String(dataOf(row, "data-list-kind")))} depth=${j(String(dataOf(row, "data-list-depth")))}` : "缺行");
    const markerText = listMarkerText(row);
    const bodyText = listBodyText(row);
    check(id, `文本：第 ${num} 行正文列表有符号且内容为 ${j(body)}`,
      markerText !== null && markerText.trim() === "•" && bodyText !== null && bodyText === body,
      `marker=${j(markerText)} body=${j(bodyText)}`);
  }
  check(id, "结构：第 4 行（> 空行）内容为空、行号与组样式保留", rows[3] !== undefined && lcText(rows[3]) === "",
    rows[3] ? j(lcText(rows[3])) : "缺行");
  check(id, "文本：第 5 行收尾段落正常渲染（不是列表）",
    rows[4] !== undefined && lcText(rows[4]).trim() === "收尾段落" && dataOf(rows[4], "data-list-kind") === undefined,
    rows[4] ? `${j(lcText(rows[4]))} kind=${j(String(dataOf(rows[4], "data-list-kind")))}` : "缺行");
  // 严格口径（契约 §4.6，Lead 裁决）：有显式标题（清单）时徽标只显示图标，不显示 tip 默认名「提示」
  check(id, "文本：有显式标题时不显示类型默认名 提示", countOf(textOf(tree), "提示") === 0, `${countOf(textOf(tree), "提示")} 次：${traceText(tree)}`);
}
{
  const id = "callout-title-md";
  const tree = renderFor(id);
  const rows = checkCalloutGroup(id, tree, [1, 2], "note");
  const head = rows[0];
  check(id, "结构：标题行内 **粗标题** 渲染为 strong",
    head !== undefined && findAll(head, (n) => localName(n) === "strong").length === 1,
    head ? brief(head) : "缺行");
  check(id, "文本：标题文本与行内 code 内容都在、** 不外漏",
    head !== undefined && lcText(head).includes("粗标题 与 code") && !lcText(head).includes("**"),
    head ? j(lcText(head)) : "缺行");
  // 严格口径（契约 §4.6，Lead 裁决）：显式标题 粗标题 与 code 单独显示，不出现 note 默认名「笔记」
  check(id, "文本：有显式标题时不显示类型默认名 笔记", countOf(textOf(tree), "笔记") === 0, `${countOf(textOf(tree), "笔记")} 次：${traceText(tree)}`);
  check(id, "文本：正文行内容为 正文", rows[1] !== undefined && lcText(rows[1]).trim() === "正文", rows[1] ? j(lcText(rows[1])) : "缺行");
}
{
  const id = "callout-alias";
  const tree = renderFor(id);
  const rows1 = checkCalloutGroup(id, tree, [1, 2], "tip"); // hint → tip
  const rows2 = checkCalloutGroup(id, tree, [4, 5], "abstract"); // summary → abstract
  check(id, "结构：两个 callout 用不同 data-callout-group",
    rows1[0] !== undefined && rows2[0] !== undefined && String(dataOf(rows1[0], "data-callout-group")) !== String(dataOf(rows2[0], "data-callout-group")),
    `${j(String(dataOf(rows1[0], "data-callout-group")))} vs ${j(String(dataOf(rows2[0], "data-callout-group")))}`);
  const text = textOf(tree);
  check(id, "文本：hint 标题 提示、summary 标题 摘要 各只出现 1 次（不重复）", countOf(text, "提示") === 1 && countOf(text, "摘要") === 1,
    `提示×${countOf(text, "提示")} 摘要×${countOf(text, "摘要")}：${j(text)}`);
  check(id, "文本：两组正文 别名 important/tip、别名 abstract 都在",
    text.includes("别名 important/tip") && text.includes("别名 abstract"), traceText(tree));
}
{
  const id = "callout-fold";
  const tree = renderFor(id);
  checkCalloutGroup(id, tree, [1, 2], "note");
  const text = textOf(tree);
  check(id, "文本：折叠标题与正文都在（折叠行为属 P2，本轮只要求内容不丢）",
    text.includes("折叠标题") && text.includes("折叠内容"), traceText(tree));
  // 严格口径（契约 §4.6，Lead 裁决）：有显式标题时不显示 note 默认名「笔记」
  check(id, "文本：有显式标题时不显示类型默认名 笔记", countOf(text, "笔记") === 0, `${countOf(text, "笔记")} 次：${traceText(tree)}`);
}
{
  const id = "callout-unknown";
  const tree = renderFor(id);
  const rows = [rowOf(id, tree, 1), rowOf(id, tree, 2)];
  check(id, "结构：未知类型仍按 callout 分组（引用行 + 组 id + 末行 end）",
    rows.every((r) => r !== undefined && hasClass(r, "dsh-obs-md-quote")) &&
      String(dataOf(rows[0], "data-callout-group")) === String(dataOf(rows[1], "data-callout-group")) &&
      hasClass(rows[1], "dsh-obs-md-callout-end"),
    rows.map((r) => (r ? classList(r).join(".") : "缺行")).join(" | "));
  check(id, "结构：行上 data-callout 有 canonical 值（未知类型映射属 P2，不锁定具体值）",
    typeof dataOf(rows[0], "data-callout") === "string" && dataOf(rows[0], "data-callout") !== "",
    j(String(dataOf(rows[0], "data-callout"))));
  check(id, "文本：标题 未知类型、正文 正文 都在且不显示 [!custom]", textOf(tree).includes("未知类型") && textOf(tree).includes("正文"),
    traceText(tree));
}
{
  const id = "real-note";
  const tree = renderFor(id);
  const row = rowOf(id, tree, 6);
  check(id, "结构：第 6 行 callout 行 data-callout=tip（important→tip）", row !== undefined && String(dataOf(row, "data-callout")) === "tip",
    row ? j(String(dataOf(row, "data-callout"))) : "缺行");
  check(id, "文本：callout 标题内容 一句话：iperf3 是两端配合的测速仪。", row !== undefined && lcText(row).includes("一句话：iperf3 是两端配合的测速仪。"),
    row ? j(lcText(row)) : "缺行");
  // 严格口径（契约 §4.6，Lead 裁决）：显式标题存在时不显示 tip 默认名「提示」
  check(id, "文本：有显式标题时不显示类型默认名 提示", countOf(textOf(tree), "提示") === 0, `${countOf(textOf(tree), "提示")} 次：${traceText(tree)}`);
}

// 补充边界（契约 §4.6，Lead 裁决明确两个分支）：无显式标题时才显示「图标 + 类型名」
section("P1-M6 补充边界：无显式标题 callout 显示类型名（契约 §4.6）");
{
  const id = "edge:callout-no-title";
  const md = "> [!tip]\n> 正文";
  const tree = renderNumbered(md, HANDLERS);
  checkLineInvariant(id, md, tree);
  checkOffsetInvariant(id, md, tree);
  const rows = [rowOf(id, tree, 1), rowOf(id, tree, 2)];
  check(id, "结构：无标题 callout 仍是引用行分组（首行 head、末行 end）",
    rows.every((r) => r !== undefined && hasClass(r, "dsh-obs-md-quote")) &&
      hasClass(lcOf(rows[0]), "dsh-obs-md-callout-head") && hasClass(rows[1], "dsh-obs-md-callout-end"),
    rows.map((r) => (r ? brief(r) : "缺行")).join(" | "));
  checkEq(id, "文本：无显式标题时显示类型默认名 提示（恰好 1 次）与正文",
    [countOf(textOf(tree), "提示"), lcText(rows[1]).trim()], [1, "正文"]);
}

// ── M7 双链显示（契约 §4.7；方案 M7 验收：wikilinks、embed-note）────────────────
section("P1-M7 双链显示（wikilinks / embed-note / embed-media / table-inline / real-note）");

function wikilinkButtons(tree) {
  return findAll(tree, (n) => localName(n) === "button" && hasClass(n, "dsh-obs-wikilink"));
}
function sliceOfSpan(span, md) {
  const r = rangeOf(span);
  return r === null ? null : normMd(md).slice(r.start, r.end);
}
{
  const id = "wikilinks";
  const md = FIXTURES_BY_ID[id].md;
  const clicks = [];
  const tree = renderNumbered(md, { ...HANDLERS, onWikilink: (target) => clicks.push(target) });
  const buttons = wikilinkButtons(tree);
  check(id, "结构：4 个 button.dsh-obs-wikilink", buttons.length === 4, `实测 ${buttons.length}`);
  checkEq(id, "文本：[[A]]→A、[[A|别名]]→别名、[[A#标题]]→A › 标题、[[A#^块]]→A › ^块",
    buttons.map((b) => textOf(b)), ["笔记A", "显示名", "笔记A › 标题", "笔记A › ^blockid"]);
  check(id, "文本：整树不出现 [[ / ]] 原文", !textOf(tree).includes("[[") && !textOf(tree).includes("]]"), traceText(tree));
  checkEq(id, "结构：按钮 title 保持 [[target]]", buttons.map((b) => dataOf(b, "title")),
    ["[[笔记A]]", "[[笔记A]]", "[[笔记A]]", "[[笔记A]]"]);
  for (const b of buttons) b.props.onClick();
  checkEq(id, "结构：点击参数仍是 target（笔记A ×4）", clicks, ["笔记A", "笔记A", "笔记A", "笔记A"]);
  // [[A]] / [[A|别名]]：一个 span 精确映射显示文本
  const plainSpans = buttons[0] !== undefined ? srcSpanList(buttons[0]) : [];
  check(id, "偏移：[[A]] 显示文本映射源码 A", plainSpans.length === 1 && sliceOfSpan(plainSpans[0], md) === "笔记A",
    plainSpans.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
  const aliasSpans = buttons[1] !== undefined ? srcSpanList(buttons[1]) : [];
  check(id, "偏移：[[A|别名]] 别名 span 精确映射源码 显示名", aliasSpans.length === 1 && sliceOfSpan(aliasSpans[0], md) === "显示名",
    aliasSpans.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
  // [[A#标题]]：A / 标题 两个 span，中间 › 是非 span 文本
  const sectionSpans = buttons[2] !== undefined ? srcSpanList(buttons[2]) : [];
  checkEq(id, "结构：[[A#标题]] 拆成 笔记A / 标题 两个源码 span", sectionSpans.map((s) => textOf(s)), ["笔记A", "标题"]);
  check(id, "结构：章节显示中间的 › 是非 span 文本", buttons[2] !== undefined && plainTextOutsideSrc(buttons[2]).trim() === "›",
    buttons[2] ? j(plainTextOutsideSrc(buttons[2])) : "缺按钮");
  check(id, "偏移：章节两个 span 切片分别 === 笔记A / 标题",
    sectionSpans.length === 2 && sliceOfSpan(sectionSpans[0], md) === "笔记A" && sliceOfSpan(sectionSpans[1], md) === "标题",
    sectionSpans.map((s) => `${dataOf(s, "data-obs-src")}=${j(textOf(s))}`).join(","));
  const blockSpans = buttons[3] !== undefined ? srcSpanList(buttons[3]) : [];
  checkEq(id, "结构：[[A#^块]] 拆成 笔记A / ^blockid 两个源码 span", blockSpans.map((s) => textOf(s)), ["笔记A", "^blockid"]);
}
{
  const id = "embed-note";
  const md = FIXTURES_BY_ID[id].md;
  const clicks = [];
  const tree = renderNumbered(md, { ...HANDLERS, onWikilink: (target) => clicks.push(target) });
  const buttons = wikilinkButtons(tree);
  check(id, "结构：2 个 button.dsh-obs-wikilink（非图片 embed 不做 transclusion）", buttons.length === 2, `实测 ${buttons.length}`);
  checkEq(id, "文本：![[笔记A]]→笔记A、![[笔记A#标题]]→笔记A › 标题", buttons.map((b) => textOf(b)), ["笔记A", "笔记A › 标题"]);
  check(id, "文本：整树不出现 ![[ / [[ / ]] 原文",
    !textOf(tree).includes("![[") && !textOf(tree).includes("[[") && !textOf(tree).includes("]]"), traceText(tree));
  for (const b of buttons) b.props.onClick();
  checkEq(id, "结构：点击参数仍是 target", clicks, ["笔记A", "笔记A"]);
  const sectionSpans = buttons[1] !== undefined ? srcSpanList(buttons[1]) : [];
  checkEq(id, "结构：![[A#标题]] 拆成 笔记A / 标题 两个源码 span", sectionSpans.map((s) => textOf(s)), ["笔记A", "标题"]);
}
{
  const id = "embed-media";
  const tree = renderFor(id);
  const buttons = wikilinkButtons(tree);
  checkEq(id, "文本：非图片 embed ![[录音.mp3]] / ![[文档.pdf]] 显示目标文本、不显示 ![[]]",
    buttons.map((b) => textOf(b)), ["录音.mp3", "文档.pdf"]);
}
{
  const id = "table-inline";
  const tree = renderFor(id);
  const buttons = wikilinkButtons(tree);
  check(id, "文本：表格单元格内 [[笔记A]] 显示为 笔记A（无 [[ ]]）", buttons.length === 1 && textOf(buttons[0]) === "笔记A",
    buttons.map((b) => j(textOf(b))).join(","));
}
{
  const id = "real-note";
  const md = FIXTURES_BY_ID[id].md;
  const clicks = [];
  const tree = renderNumbered(md, { ...HANDLERS, onWikilink: (target) => clicks.push(target) });
  const buttons = wikilinkButtons(tree);
  check(id, "文本：real-note 双链 [[集群交付概览|概览]] 显示 概览", buttons.length === 1 && textOf(buttons[0]) === "概览",
    buttons.map((b) => j(textOf(b))).join(","));
  check(id, "文本：M7 后整树无管道原文（表格管道 + 双链别名里的 | 都不外漏）", !textOf(tree).includes("|"), leakContext(textOf(tree), "|"));
  check(id, "结构：按钮 title 保持 [[集群交付概览]]", buttons.length === 1 && dataOf(buttons[0], "title") === "[[集群交付概览]]",
    buttons.map((b) => j(dataOf(b, "title"))).join(","));
  for (const b of buttons) b.props.onClick();
  checkEq(id, "结构：real-note 双链点击参数仍是 集群交付概览", clicks, ["集群交付概览"]);
}
{ // 回归护栏：图片 embed 行为不变（契约 §4.7：图片 embed 不变）
  const id = "embed-image";
  const tree = renderFor(id);
  const imgs = findAll(tree, (n) => localName(n) === "img");
  check(id, "结构：图片 embed 仍是 4 个 img", imgs.length === 4, `实测 ${imgs.length}`);
  checkEq(id, "结构：![[x|200]] / ![[x|200x100]] 尺寸与 alt 语义不变",
    imgs.map((i) => [i.props.width ?? null, i.props.height ?? null, i.props.alt ?? null]),
    [[null, null, "pic.png"], [200, null, "pic.png"], [200, 100, "pic.png"], [null, null, "替代文本"]]);
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
console.log(`OBSIDIAN 面板路径断言：共 ${checkTotal} 条，通过 ${checkPassed}，失败 ${failures.length}`);
if (failures.length > 0) {
  console.log("\n按里程碑统计（通过/总数）：");
  for (const name of sectionNames) {
    const stats = sectionStats.get(name) ?? { total: 0, passed: 0 };
    const items = bySection.get(name) ?? [];
    const fixtures = [...new Set(items.map((i) => i.fixtureId))];
    console.log(`  ${items.length === 0 ? "✓" : "✗"} ${name}：${stats.passed}/${stats.total} 通过${items.length > 0 ? `；失败片段：${fixtures.join(", ")}` : ""}`);
  }
  console.log("\n逐条失败信息见上方 ✗ 行（[fixture-id] 说明）。实现未完成时本文件应为红；M0 验收要求全绿。");
  process.exit(1);
}
console.log("全部面板路径语法断言通过 ✔");
if (debugId === undefined || debugId === "") {
  // 静默通过时不额外输出
}

// ── 运行头（函数声明提升，供开头打印源码指纹）──────────────────────────────
function printRunHeader() {
  const sha = createHash("sha1").update(code).digest("hex").slice(0, 10);
  console.log("Obsidian 语法面板路径测试（M0 护栏，只测 renderNumbered）");
  console.log(`src/markdown.js sha1:${sha}，片段数：${FIXTURES.length}（方案附录 B）`);
  console.log("命令：node test/obsidian-syntax.mjs；单片段调试：DEBUG_FIXTURE=<id> node test/obsidian-syntax.mjs");
}
/** 失败信息里的文本快照（截断） */
function traceText(tree, max = 240) {
  const t = textOf(tree);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
