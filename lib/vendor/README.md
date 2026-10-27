# lib/vendor：第三方静态资源（P2b）

这些文件是**固定版本的第三方产物**，经 `/obsidian/vendor/<name>/<file>` 路由懒加载，
不参与 `build.mjs` 拼接、不进 `lib/client.js`、不作为 npm 运行时依赖。

| 名称 | 版本 | 许可 | 上游 | 本目录内容 |
| --- | --- | --- | --- | --- |
| KaTeX | 0.19.1 | MIT（Copyright (c) 2013-2020 Khan Academy and other contributors） | `https://registry.npmjs.org/katex/-/katex-0.19.1.tgz` 的 `dist/` | `katex/katex.min.js`、`katex/katex.min.css`、`katex/fonts/*.woff2`（20 个）、`LICENSE`、`VERSION` |
| mermaid | 12.2.0 | MIT（Copyright (c) 2014 - 2022 Knut Sveidqvist） | `https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.min.js` | `mermaid/mermaid.min.js`、`LICENSE`、`VERSION` |

## 体积（2026-10-27 下载实测）

| 文件/目录 | 字节 | 说明 |
| --- | ---: | --- |
| `katex/katex.min.js` | 273,081 | UMD，classic `<script>` 加载后 `window.katex` 就绪 |
| `katex/katex.min.css` | 24,793 | `@font-face` 的 `src` 顺序 woff2 → woff → ttf；现代浏览器只取 woff2 |
| `katex/fonts/*.woff2` | 259,792 | 只带 woff2（20 个）；tarball 里的 woff/ttf 不带 |
| **KaTeX 合计** | **557,666** | |
| `mermaid/mermaid.min.js` | 5,494,801 | esbuild IIFE，classic `<script>` 加载后 `globalThis.mermaid` 就绪 |
| **vendor 合计** | **6,052,467** | 磁盘约 5.8MiB；git 压缩后估 +~2.3MB |

gzip 后实际传输（DSH webserver 已开 gzip，阈值 1024B）：`katex.min.js` ≈ 88.9KB、
`katex.min.css` ≈ 4.2KB、`mermaid.min.js` ≈ 1.80MB；woff2 本身已压缩，不再二次压缩。
mermaid 只在首次遇到 mermaid 围栏时加载，KaTeX 只在首次遇到数学时加载（懒加载）。

## 下载/更新方式

- 下载脚本：工作区 `.scratch/p2-download-vendor.mjs`（**不进 git**，仓库只放产物）。
- 脚本幂等：重跑会清空 `lib/vendor/{katex,mermaid}` 后重下；下载结果的字节数与
  2026-10-27 验证基线不符会直接报错（防止上游悄悄替换版本）。
- 更新版本时：改脚本里的 `KATEX_VERSION`/`MERMAID_VERSION` + `EXPECT` 体积基线 → 重跑
  → 同步 client 侧版本常量（`KATEX_VERSION`/`MERMAID_VERSION`，懒加载 URL 的 `?v=`）
  → 跑 `node --test test/host-p2.mjs` → 记录 README 本表与版本说明。
- mermaid 为什么不用 npm tarball：本机下载 npm 整包两次超时/HTTP2 流错误（解包 122MB），
  改从 jsDelivr 直下 `dist/mermaid.min.js` 稳定成功；KaTeX tarball 下载正常。

## 路由与缓存约定（`src/index.js` 的 `/obsidian/vendor`）

- URL：`/obsidian/vendor/<name>/<相对本目录的路径>`，例
  `/obsidian/vendor/katex/katex.min.js`、`/obsidian/vendor/katex/fonts/KaTeX_Main-Regular.woff2`。
- **client 懒加载必须带 `?v=<版本>`**（如 `?v=0.19.1`）：带版本走
  `cache-control: public, max-age=31536000, immutable`；不带版本回退 `no-cache` + `ETag`
  重校验，避免升级后拿到一年前的旧脚本。
- 只服务 `.js`/`.css`/`.woff2` 三种扩展名（**不服务 svg/html**，无 XSS 面）；只允许
  `katex`/`mermaid` 两个目录；只读本目录，路径段拒绝 `..`/`.`/反斜杠/NUL 并做 resolve 包含性校验。
- GET 免 `x-dsh-obsidian` 头（浏览器子资源请求带不了自定义头）；非 GET 一律 405。
- `Content-Type`：js `text/javascript; charset=utf-8`、css `text/css; charset=utf-8`、
  woff2 `font/woff2`，并带 `x-content-type-options: nosniff`。**不要**自己设
  `content-encoding`，gzip 由 DSH webserver 按 content-type 自动处理。

## 安全与残余风险

- 宿主无 CSP 是 **DSH 0.2.1-rc.2 当前版本**的结论（见 `.scratch/p2-math-spike.md` §2.1）；
  DSH 升级后必须回归 `node --test test/host-p2.mjs` + 真机 Network/Console 检查。
- host 侧 `src/index.js` 改动不热重载（`dsh-hmr` 默认 `root: []`），真机验证 vendor 路由
  需要重启 DSH 宿主；客户端改动只需 `npm run build` + 刷新页面。
- 只带 woff2 对现代浏览器无影响；若浏览器不支持 woff2 会退化成系统字体（DSH 面向现代浏览器）。
- KaTeX 输出由 M16 渲染侧按「可信第三方渲染」例外处理（固定版本、MIT），不在本目录做 sanitize；
  mermaid 输出 SVG 必须走 M17 sanitizer（M20 定）。
