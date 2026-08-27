# dsh-obsidian-vault

DeepSeek Harness Web 的 Obsidian 风格笔记面板插件：不依赖安装 Obsidian，直接读写本地文件夹中的笔记。

## 功能

- **侧边栏会话与笔记并存**：常驻接管工作区区域，会话列表与「📚 笔记」树同级展示、互不顶替。
- **笔记树与搜索**：懒加载目录树、只显示 `.md` 笔记，支持标题/正文搜索，以及新建文件夹、新建/重命名/删除笔记与文件夹。
- **右侧笔记面板（Dock）**：预览（Markdown 渲染 + `[[双链]]` 点击跳转）、编辑、保存（Ctrl/Cmd+S），可拖拽、可调宽。
- **引用到对话**：一键把 `@绝对路径` 注入对话输入框；Vault 被外部改动后 Dock 自动刷新。
- **选中片段提问**：选中文本后一键提问/解释，按「`@路径` + 行数 + `>` 选中内容 + `【问题】`」组装 prompt。
- **Vault 目录可配置**：目录选择器或粘贴绝对路径，可持久化。

## 前置要求

- **Node.js ≥ 20**
- **pnpm**：`dsh plugin` 会把命令转发给 pnpm，没有它会在 `add` 时直接报 `pnpm not found on PATH`。安装：`npm i -g pnpm`，或先 `corepack enable`。

## 安装

从 GitHub 克隆到本地，构建后注册到 DSH Web：

```bash
# 1) 克隆
git clone https://github.com/revive123456/dsh-obsidian-vault.git
cd dsh-obsidian-vault

# 2) 安装依赖：仓库不含构建产物 lib/client.js；npm i 会通过 prepare 自动构建，无需再单独 build
npm i

# 3) 用克隆下来的本地绝对路径注册插件
#    "$PWD" = 当前目录的绝对路径（PowerShell 内置变量），即刚克隆下来的 dsh-obsidian-vault 路径；
dsh plugin --profile web add "$PWD"
```

`$PWD` 是 PowerShell 的当前工作目录变量，展开后就是刚 `cd` 进入的克隆目录的绝对路径，`dsh plugin` 用这个绝对路径来注册插件；如果你的 shell 是 bash/zsh，把 `"$PWD"` 改成 `"$(pwd)"` 即可。

> 本插件的 `package.json` 只声明了 `dsh.client`（客户端插件），没有 `dsh.bundle`，所以 `add` 会打印一条 `no dsh.bundle — installed as a plain dependency, not a profile layer` 的警告。这是正常的，插件由下面的 patch 行激活。

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 注入（`~` 取决于运行 `dsh web` 的用户，例如以 root 运行就是 `/var/root/.dsh`；把文件里的 `[]` 替换为）：

```yaml
- insert:
    - id: dsh-obsidian-vault
      name: dsh-obsidian-vault
```

重启（或依赖 profile patch 热重载）`dsh web` 后生效；client 端改动刷新页面即可。若热重载未立即生效，`touch ~/.dsh/profiles/web/cordis.patch.yml` 或重启 `dsh web`。

> 运行时 patch 里的 `id` 只是 Loader 条目标签；客户端插件的路由 id 采用包名（`/plugins/dsh-obsidian-vault/client.js`），与 `id` 无关。
