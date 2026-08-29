/**
 * 粘贴插入（client 端）单元级验证：直接从 src/client.js 提取两个纯函数：
 *   insertEmbedAtSelection  —— 在光标/选区处插入 ![[...]] embed 的新字符串拼接；
 *   fileToDataUrl           —— 读剪贴板图片 File 为 base64 dataURL。
 * 同时校验 lib/client.js 已包含 attach/setAttachDir/assetUrl 及 onPaste 接线。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "client.js"), "utf8");

// 用平衡花括号扫描提取源码里的函数定义
function extractFn(code, name) {
  const start = code.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const open = code.indexOf("{", start);
  let depth = 0, i = open;
  for (; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) break; }
  }
  return code.slice(start, i + 1);
}

const insertEmbedAtSelection = new Function(`return (${extractFn(src, "insertEmbedAtSelection")})`)();
const fileToDataUrl = new Function(`return (${extractFn(src, "fileToDataUrl")})`)();

const failures = [];
function check(name, cond, extra = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures.push(name);
}

// insertEmbedAtSelection：光标处插入
{
  const draft = "第一行\n第二行\n";
  const pos = draft.indexOf("第二行");
  const out = insertEmbedAtSelection(draft, pos, pos, "![[attachments/x.png]]");
  const want = "第一行\n![[attachments/x.png]]第二行\n";
  check("insert at cursor (empty selection)", out === want, JSON.stringify(out));
}
// 覆盖选区：选中一段后插入替换
{
  const out = insertEmbedAtSelection("abcDEFghi", 3, 6, "![[y.png]]");
  check("insert over selection replaces", out === "abc![[y.png]]ghi", JSON.stringify(out));
}
// 边界：越界 start/end 夹紧，不崩溃
{
  const out = insertEmbedAtSelection("abc", -5, 99, "![[z.png]]");
  check("clamps out-of-range (insert at 0, replace all)", out === "![[z.png]]", JSON.stringify(out));
}
// 插入后文本长度与光标恢复位置（start + embed.length）语义一致
{
  const draft = "hello world";
  const pos = 5;
  const embed = "![[attachments/图.png]]";
  const out = insertEmbedAtSelection(draft, pos, pos, embed);
  check("embed length & splice", out === `hello![[attachments/图.png]] world` && out.length === draft.length + embed.length);
}

// fileToDataUrl：用假 FileReader 读回 base64 dataURL
{
  const fakeFile = { name: "snip.png" };
  const data = "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const fakeWin = {
    FileReader: class {
      readAsDataURL() { const self = this; setTimeout(() => { if (self.onload) self.onload(); }, 0); this.result = data; }
    },
  };
  const p = fileToDataUrl(fakeFile, fakeWin);
  const out = await p.then((v) => v).catch((e) => `ERR:${e.message}`);
  check("fileToDataUrl returns dataURL", out === data, String(out));
}

// bundle 已接线：onPaste / assetUrl / attach 路由字符串存在
{
  const lib = readFileSync(join(root, "lib", "client.js"), "utf8");
  check("bundle wires onPaste", lib.includes("onPaste") && lib.includes("onPasteImage"));
  check("bundle wires assetUrl", lib.includes("assetUrl:"));
  check("bundle wires attach treeApi", lib.includes("/attach") && lib.includes("/attach-dir"));
  check("bundle embeds embed renderer", lib.includes("resolveSrc") && lib.includes('"embed"'));
}

if (failures.length > 0) {
  console.error(`\n${failures.length} paste-helper check(s) FAILED`);
  process.exit(1);
}
console.log("\nall paste-helper checks passed ✔");
