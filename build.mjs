/**
 * 零依赖构建：host 半边直接使用 src/index.js（ESM，无需打包）；
 * client 半边把 src/markdown.js + src/client.js 拼接进
 * window.__ModuleLoader__.load 的 factory 闭包，产出 lib/client.js。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(root, "lib"), { recursive: true });

const markdown = readFileSync(join(root, "src", "markdown.js"), "utf8");
const client = readFileSync(join(root, "src", "client.js"), "utf8");

const lines = [
  `window.__ModuleLoader__.load({`,
  `\tid: "dsh-obsidian-vault",`,
  `\tfactory: (require) => {`,
  `\t\tvar module = { exports: {} };`,
  `\t\tvar exports = module.exports;`,
  `\t\tconst React = require("react");`,
  `\t\tvoid require("react/jsx-runtime");`,
];

for (const body of [markdown, client]) {
  for (const line of body.split("\n")) {
    lines.push(line === "" ? "" : `\t\t${line}`);
  }
}

lines.push(`\t\treturn module.exports;`);
lines.push(`\t}`, `});`, ``);

writeFileSync(join(root, "lib", "client.js"), lines.join("\n"), "utf8");
console.log("dsh-obsidian-vault: lib/client.js assembled (host entry = src/index.js)");
