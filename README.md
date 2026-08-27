# dsh-obsidian-vault

DeepSeek Harness Web 的 Obsidian 风格笔记面板插件：不依赖安装 Obsidian，直接读写本地文件夹中的笔记。

## 功能

- **侧边栏会话与笔记并存**：常驻接管工作区区域，会话列表与「📚 笔记」树同级展示、互不顶替。
- **笔记树与搜索**：懒加载目录树、只显示 `.md` 笔记，支持标题/正文搜索，以及新建文件夹、新建/重命名/删除笔记与文件夹。
- **右侧笔记面板（Dock）**：预览（Markdown 渲染 + `[[双链]]` 点击跳转）、编辑、保存（Ctrl/Cmd+S），可拖拽、可调宽。
- **引用到对话**：一键把 `@绝对路径` 注入对话输入框；Vault 被外部改动后 Dock 自动刷新。
- **选中片段提问**：选中文本后一键提问/解释，按「`@路径` + 行数 + `>` 选中内容 + `【问题】`」组装 prompt。
- **Vault 目录可配置**：目录选择器或粘贴绝对路径，可持久化。

## 安装

从 GitHub 克隆到本地，构建后注册到 DSH Web：

```bash
# 1) 克隆
git clone https://github.com/revive123456/dsh-obsidian-vault.git
cd dsh-obsidian-vault

# 2) 安装依赖并构建（仓库不含构建产物 lib/client.js；npm i 会触发 prepare 自动构建，也可手动 build）
npm i
npm run build

# 3) 用克隆下来的本地绝对路径注册插件
#    "$PWD" = 当前目录的绝对路径（PowerShell 内置变量），即刚克隆下来的 dsh-obsidian-vault 路径；
dsh plugin --profile web add "$PWD"
```

`$PWD` 是 PowerShell 的当前工作目录变量，展开后就是刚 `cd` 进入的克隆目录的绝对路径，`dsh plugin` 用这个绝对路径来注册插件；如果你的 shell 是 bash/zsh，把 `"$PWD"` 改成 `"$(pwd)"` 即可。

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 注入：

```yaml
- insert:
    - id: obsidian-vault
      name: dsh-obsidian-vault
```

重启（或依赖 profile patch 热重载）`dsh web` 后生效；client 端改动刷新页面即可。
