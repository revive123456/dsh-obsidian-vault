/**
 * 分发清单离线断言（零依赖、零网络、可被 `node --test test/*.mjs` 收集）。
 *
 * 本插件能被 DSH「一条命令安装」并被 awesome-dsh-plugin / dsh-market 收录，
 * 靠的是 package.json 里几行纯文本声明；它们写错不会在运行时自然报错（装不上
 * 或启动后才炸），所以在测试里钉死：
 *
 *   1. dsh.bundle.patch 已声明，且指向的文件真实存在、不越出包根；
 *   2. cordis.patch.yml 是一条合法的 `- insert:` 层，row 的 id 与 name 都等于
 *      npm 包名（name 是 Node 解析用的模块标识符）；
 *   3. files 白名单包含 cordis.patch.yml、host 入口、client 产物与 README，
 *      否则 `npm pack` 发出去的包装不上（DSH 读不到 patch 或 client bundle）；
 *   4. exports["./client"] 指向的文件存在；
 *   5. lib/client.js 注册的 module id 等于包名 —— DSH 的 client module system
 *      按 boot 图 row id（= package.json name）等 factory，id 不一致时页面
 *      启动即报 `bundle ... loaded without registering "<包名>"`；
 *   6. package-lock.json 根包的 name/version 与 package.json 同步（npm ci 的
 *      一致性前提）。
 *
 * 单独运行：node --test test/bundle-manifest.mjs（或 npm run check:bundle）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** 校验一个包内相对路径：存在、是文件、且不越出包根（防 `../` / 绝对路径）。 */
function assertPackageFile(relPath, label) {
  assert.equal(typeof relPath, "string", `${label} must be a string`);
  assert.ok(relPath.length > 0, `${label} must not be empty`);
  assert.ok(!relPath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(relPath), `${label} must be package-relative: ${relPath}`);
  const absolute = resolve(root, relPath);
  assert.ok(absolute === root || absolute.startsWith(root + sep), `${label} escapes the package root: ${relPath}`);
  assert.ok(existsSync(absolute), `${label} does not exist: ${relPath}`);
  assert.ok(statSync(absolute).isFile(), `${label} is not a file: ${relPath}`);
  return absolute;
}

/**
 * 只解析本仓库需要的 patch 子集（顶层 YAML 数组 + `- insert:` 行组），
 * 不引入 YAML 依赖。注释与空行会先剥掉；`key: value` 值只支持裸标量与引号
 * 标量（本文件不需要块标量）。
 */
function parseInsertRows(source) {
  const rows = [];
  let inInsert = false;
  let current;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, "").trimEnd();
    if (line.trim() === "") continue;
    if (/^-\s*insert:\s*$/.test(line)) {
      inInsert = true;
      continue;
    }
    // 另一个顶层 patch 操作（- id: / - remove: ...）结束 insert 段。
    if (/^-\s/.test(line)) {
      inInsert = false;
      current = undefined;
      continue;
    }
    if (!inInsert) continue;
    const rowStart = /^\s*-\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (rowStart) {
      current = { [rowStart[1]]: unquoteYaml(rowStart[2]) };
      rows.push(current);
      continue;
    }
    const keyValue = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (keyValue) {
      assert.ok(current !== undefined, `patch row field without a row start: ${JSON.stringify(line)}`);
      current[keyValue[1]] = unquoteYaml(keyValue[2]);
      continue;
    }
    assert.fail(`unsupported patch line: ${JSON.stringify(line)}`);
  }
  return rows;
}

function unquoteYaml(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

test("package.json: 发布所需的基本元数据", () => {
  assert.equal(manifest.name, "dsh-obsidian-notes");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.equal(manifest.license, "MIT");
  assert.equal(typeof manifest.description, "string");
  assert.ok(manifest.description.trim().length > 0);
  assert.equal(typeof manifest.engines?.node, "string");
  // 发现入口依赖这组关键字（awesome-dsh-plugin / dsh-market 都按 dsh-plugin 等筛）。
  assert.ok(manifest.keywords.includes("dsh-plugin"), "keywords must include dsh-plugin");
  assert.ok(manifest.keywords.includes("deepseek-harness"), "keywords must include deepseek-harness");
  // 包名迁移后仓库地址仍指向 GitHub 仓库名（仓库名不改）。
  assert.match(manifest.repository?.url ?? "", /github\.com\/revive123456\/dsh-obsidian-notes\.git$/);
  assert.match(manifest.homepage ?? "", /^https:\/\//);
  assert.match(manifest.bugs?.url ?? "", /^https:\/\//);
});

test("dsh.bundle.patch 已声明且指向包内真实文件", () => {
  const declaration = manifest.dsh?.bundle;
  assert.equal(typeof declaration, "object", "package.json must declare dsh.bundle");
  const patchPath = declaration.patch;
  assert.ok(patchPath.startsWith("./"), `dsh.bundle.patch must be a ./-prefixed relative path: ${JSON.stringify(patchPath)}`);
  assertPackageFile(patchPath, "dsh.bundle.patch");
});

test("dsh.client 保留（host+client 双半边）且 exports ./client 文件存在", () => {
  assert.equal(manifest.dsh?.client?.platform, "web");
  assert.ok(Array.isArray(manifest.dsh?.client?.inject));
  const clientExport = manifest.exports?.["./client"];
  const clientRel = typeof clientExport === "string" ? clientExport : clientExport?.default;
  assert.equal(typeof clientRel, "string", 'exports["./client"] must resolve to a string');
  assertPackageFile(clientRel, 'exports["./client"]');
  // host 入口同样必须存在，否则 bundle 层 name 解析到空模块。
  const mainRel = manifest.exports?.["."]?.default ?? manifest.main;
  assertPackageFile(mainRel, "host entry");
});

test("cordis.patch.yml: 单条 insert 层，row id/name 等于包名", () => {
  const patchPath = manifest.dsh.bundle.patch;
  const source = readFileSync(join(root, patchPath), "utf8");
  const rows = parseInsertRows(source);
  assert.equal(rows.length, 1, `expected exactly one inserted row, got ${rows.length}`);
  const [row] = rows;
  assert.equal(row.id, manifest.name, "insert row id must equal the npm package name");
  assert.equal(row.name, manifest.name, "insert row name must equal the npm package name");
  // 硬性规则：组合层里不允许本机绝对路径 / link 依赖（仓库必须可独立分发）。
  assert.doesNotMatch(source, /link:|file:|\/Users\/|\/home\/|[A-Za-z]:\\/);
});

test("files 白名单包含运行时与分发必需文件", () => {
  const files = manifest.files;
  assert.ok(Array.isArray(files), "package.json must declare files");
  for (const required of ["src", "lib", "cordis.patch.yml", "README.md"]) {
    assert.ok(files.includes(required), `files must include ${required}`);
  }
});

test("lib/client.js: module id 与包名同步（DSH 按包名等 factory）", () => {
  const bundlePath = join(root, "lib", "client.js");
  assert.ok(existsSync(bundlePath), "lib/client.js is missing; run `npm run build` (npm ci runs prepare)");
  const code = readFileSync(bundlePath, "utf8");
  const match = /window\.__ModuleLoader__\.load\(\{\s*id:\s*("(?:[^"\\]|\\.)*")/.exec(code);
  assert.ok(match !== null, "lib/client.js does not call window.__ModuleLoader__.load({ id, factory })");
  assert.equal(JSON.parse(match[1]), manifest.name, "client module id must equal the package name");
  assert.match(code, /factory:\s*\(require\)\s*=>/, "lib/client.js must register a factory");
});

test("package-lock.json 根包 name/version 与 package.json 同步", () => {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  assert.equal(lock.name, manifest.name, "package-lock.json name is stale");
  assert.equal(lock.version, manifest.version, "package-lock.json version is stale");
  assert.equal(lock.packages?.[""]?.name, manifest.name, "package-lock.json packages[\"\"].name is stale");
  assert.equal(lock.packages?.[""]?.version, manifest.version, "package-lock.json packages[\"\"].version is stale");
});
