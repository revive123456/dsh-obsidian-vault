/**
 * 零依赖构建：host 半边直接使用 src/index.js（ESM，无需打包）；
 * client 半边把 src/markdown.js + src/client.js 拼接进
 * window.__ModuleLoader__.load 的 factory 闭包，产出 lib/client.js。
 *
 * module id 必须等于 package.json 的 name：DSH 的 client module system 按
 * boot 图的 row id（= 包名）等 factory 注册，id 不一致时页面启动会直接报
 * `bundle ... loaded without registering "<包名>"`。这里从 package.json 读取
 * 包名而不是写死，包名迁移时不会漏改（test/bundle-manifest.mjs 会断言产物）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(root, "lib"), { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const moduleId = pkg.name;
if (typeof moduleId !== "string" || moduleId.length === 0) {
  throw new Error("build: package.json has no package name to stamp the client module id");
}

const markdown = readFileSync(join(root, "src", "markdown.js"), "utf8");
const client = readFileSync(join(root, "src", "client.js"), "utf8");

const lines = [
  `window.__ModuleLoader__.load({`,
  `\tid: ${JSON.stringify(moduleId)},`,
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
console.log(`${moduleId}: lib/client.js assembled (host entry = src/index.js)`);
