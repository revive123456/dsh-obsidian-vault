/** 插入截图（方案 B）渲染端验证：embed 分支 + resolveSrc + 相对路径 img。 */
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
const mod = new Function("React", `${code}\nreturn { renderMarkdown, renderNumbered };`)(React);
const { renderMarkdown, renderNumbered } = mod;

const failures = [];
function check(name, cond, extra = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures.push(name);
}
function findAll(node, pred, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out; }
  if (typeof node !== "object") return out;
  if (pred(node.props ?? {}, node)) out.push(node);
  const kids = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
  for (const k of kids) findAll(k, pred, out);
  return out;
}

const assetUrl = (rel) => `/obsidian/file?path=${encodeURIComponent(rel)}`;
const handlers = { onWikilink: () => {}, assetUrl };

// 1. 图片 embed → <img src=/obsidian/file?path=...>
{
  const tree = renderMarkdown("正文前 ![[attachments/图1.png]] 正文后", handlers);
  const imgs = findAll(tree, (p) => typeof p.src === "string");
  // assetUrl 会用 encodeURIComponent 编码相对路径（中文 → %XX）
  const wantSrc = "/obsidian/file?path=" + encodeURIComponent("attachments/图1.png");
  check("embed png → img", imgs.length === 1 && imgs[0].props.src === wantSrc, JSON.stringify(imgs.map((i) => i.props)));
  check("embed img alt=basename", imgs[0] && imgs[0].props.alt === "图1.png");
  // 不应生成 wikilink 按钮
  const btns = findAll(tree, (p) => typeof p.title === "string" && p.title.startsWith("[["));
  check("embed image does not become button", btns.length === 0);
}
// 2. 非图片 embed → 退回双链按钮，且回调拿到目标
{
  const targets = [];
  const tree = renderMarkdown("![[另一篇笔记]]", { onWikilink: (x) => targets.push(x), assetUrl });
  const btns = findAll(tree, (p) => typeof p.title === "string" && p.title.startsWith("[["));
  check("embed note → wikilink button", btns.length === 1 && btns[0].props.title === "[[另一篇笔记]]");
  btns[0].props.onClick();
  check("embed note onClick target", targets.includes("另一篇笔记"), JSON.stringify(targets));
}
// 3. 相对路径 ![alt](attachments/x.png) → 走 assetUrl（前端能预览本地相对图）
{
  const tree = renderMarkdown("![截图](attachments/a.png)", handlers);
  const imgs = findAll(tree, (p) => typeof p.src === "string");
  check("relative img → assetUrl", imgs.length === 1 && imgs[0].props.src === "/obsidian/file?path=attachments%2Fa.png" && imgs[0].props.alt === "截图");
}
// 4. 外部/https 图片仍直用，不经过 assetUrl
{
  const tree = renderMarkdown("![x](https://e.com/i.png)", handlers);
  const imgs = findAll(tree, (p) => typeof p.src === "string");
  check("https img src direct", imgs.length === 1 && imgs[0].props.src === "https://e.com/i.png");
}
// 5. 未传 assetUrl 时 embed/相对 img 退化为文本（安全兜底）
{
  const noHandlers = { onWikilink: () => {} };
  const tree = renderMarkdown("![[attachments/a.png]] ![b](attachments/b.png)", noHandlers);
  const imgs = findAll(tree, (p) => typeof p.src === "string");
  check("no assetUrl → no img rendered", imgs.length === 0);
}
// 6. 真实 Obsidian 双链仍是按钮（[[x]] 不被 embed 误吞）
{
  const tree = renderMarkdown("[[双链]]", handlers);
  const btns = findAll(tree, (p) => typeof p.title === "string" && p.title.startsWith("[["));
  check("plain wikilink still button", btns.length === 1 && btns[0].props.title === "[[双链]]");
}
// 7. 尺寸别名 ![[x.png|200]] 本次不做 → 退回按钮
{
  const tree = renderMarkdown("![[a.png|200]]", handlers);
  const imgs = findAll(tree, (p) => typeof p.src === "string");
  check("embed size-alias not rendered as img", imgs.length === 0);
}
// 8. renderNumbered（Dock 预览路径）同样渲染图片 embed
{
  const rows = renderNumbered("![[attachments/图2.png]]", handlers);
  const imgs = findAll(rows, (p) => typeof p.src === "string");
  const wantSrc2 = "/obsidian/file?path=" + encodeURIComponent("attachments/图2.png");
  check("renderNumbered embed → img", imgs.length === 1 && imgs[0].props.src === wantSrc2, JSON.stringify(imgs.map((i) => i.props)));
}
// 9. 偏移记账不因 embed 崩溃，且 embed 段落在源码中可精确反查
{
  const spans = [];
  (function walk(n) {
    if (n === null || n === undefined) return;
    if (Array.isArray(n)) { for (const k of n) walk(k); return; }
    if (typeof n !== "object") return;
    if (n.props && typeof n.props["data-obs-src"] === "string" && n.props.className === "dsh-obs-src") {
      spans.push({ src: n.props["data-obs-src"], text: textOf(n) });
    }
    const kids = Array.isArray(n.props.children) ? n.props.children : [n.props.children];
    for (const k of kids) walk(k);
  })(renderMarkdown("前 ![[attachments/x.png]] 中 ![[笔记]] 后", { onText: () => {}, assetUrl }));
  const md = "前 ![[attachments/x.png]] 中 ![[笔记]] 后";
  const allExact = spans.every((s) => { const [a, b] = s.src.split(",").map(Number); return md.slice(a, b) === s.text; });
  check("embed offset accounting exact", spans.length >= 3 && allExact, `spans=${spans.length}`);
}

function textOf(node, out = "") {
  if (node === null || node === undefined) return out;
  if (typeof node !== "object") return out + String(node);
  const kids = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
  return kids.reduce((acc, k) => textOf(k, acc), out);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} markdown-embed check(s) FAILED`);
  process.exit(1);
}
console.log("\nall markdown-embed checks passed ✔");
