# 排障

本插件由 bundle 层 + host/client 模块组成：有的问题刷新页面即可，有的必须重启 host，
下面每一条都写清了属于哪一种。`$DSH_HOME` 缺省为 `~/.dsh`（桌面版使用应用自己的数据目录）。

## 安装后看不到插件

1. **重启 host。** `dsh.bundle` 包只在启动时装配，刷新页面不会加载。桌面版：退出后重新打开；
   CLI：停掉再启动 `dsh web`。
2. **确认 bundle 层写进去了。** profile 清单
   `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles` 里应有
   `dsh-obsidian-notes`（依赖里也有）。`dsh plugin --profile web add …` 会同时写这两处。
3. **pnpm 必须在 PATH 上。** `dsh plugin` 把命令转发给 pnpm，缺 pnpm 会报
   `pnpm not found on PATH`。装好（`npm i -g pnpm` 或 `corepack enable`）后重跑安装。
4. **旧装法残留。** 如果以前手工往 `$DSH_HOME/profiles/web/cordis.patch.yml` 注入过行，
   删掉它，改用 `dsh plugin --profile web add dsh-obsidian-notes`。两层同时插入同一个插件不被支持。
   见 [legacy-install.md](legacy-install.md)。
5. 侧边栏入口是底部的 **📚 笔记**。如果侧边栏折叠成图标轨道，点 **📚** 图标展开。

刷新页面后 UI 即为最新；**插件升级**后必须重启 host —— host 半边（`/obsidian/*` 路由）
只在启动时替换。

## 点「引用到对话」提示「未找到对话输入框」

`⤴ 引用到对话` 与「提问/解释」按三层尝试注入，前一层成功就不再往下走：

| 层 | 手段 | 适用 |
| --- | --- | --- |
| 1 | 官方输入动作面 `inputActions.insertText(...)`（session 作用域的 `conversation.composer.dock` 槽位桥接） | DSH 0.2+，正常路径 |
| 2 | DOM：`[data-input-scroll] > [data-composer-input]` contenteditable（或旧版 textarea），`execCommand("insertText")`，失败再合成 `beforeinput` | 槽位未挂载、旧版或外来构建 |
| 3 | 复制到剪贴板并提示 | 找不到输入框 |

每次都落到第 3 层，说明输入框确实不可达：先打开一个会话（或选工作区新建会话）让输入框渲染出来，
再重试。兜底是刻意设计的 —— 引用永远不会丢。

「选中片段提问」注入的 prompt 形如：

```text
@/绝对/路径/笔记.md
第 12–13 行
> 选中原文
【问题】你的问题
```

包装词（`第 … 行`、`【问题】`）目前不随界面语言切换、固定中文；路径、行号、原文是对的。
选区超过 1500 字符时不会全文引用，而是让模型去读该文件的行号区间。

## 删过的会话刷新后又出现

`dsh web` 的会话列表优先用进程内存里的会话，所以日志已从磁盘删掉、但进程仍持有内存副本的会话，
会一直列在侧边栏里，直到进程退出。本插件有三层保护：

1. 列表快照就绪（`phase: "ready"`）之前不动本地「已删墓碑」，刷新不会让已删行复活；
2. 重删一条磁盘上本就没有日志的记录，按「已移除失效记录」隐藏该行，不再报「没有找到可删除的会话」；
3. 侧边栏只读地向 Host 探测 `/obsidian/session-state`（`sessionQuery.listSessions()` 的
   `persisted` / `live` 标记），把「列表里仍在、磁盘上无日志、且不在运行」的行隐藏。
   服务缺失或判不准时保持原样（fail soft）—— 绝不误隐藏真实会话。

内存副本要等进程退出才释放：本次 `dsh web` 运行期间这些行靠上述隐藏保证不再出现，
**重启 `dsh web`（桌面版：退出后重新打开）后彻底消失**。

## 彻底删除后聊天框还显示已删记录 / 批量按钮不消失

- **聊天框还显示已删记录**：删掉的若是当前正在查看的会话，主视图会切到最近一个还存在的会话；
  一个都不剩就清空到空态。不会把日志已删除的对话继续留在聊天框里，也不会擅自新建会话。
- **批量按钮不消失**：批量归档/彻底删除只要至少成功一条就退出批量模式；工作区批量删除在全部成功时退出，
  部分失败时保留工具条与未删中的勾选以便重试。一条都没成功时保留勾选，可直接重试。
- 这些主要都是客户端改动：刷新页面即可生效；宿主 `/obsidian/*` 路由有改动时才需要重启 `dsh web`。

## Windows / Linux / macOS 上 `@路径` 解析不到

注入的 `@路径` 分隔符跟随 Vault 根目录形态：Windows 用 `\`，Linux/macOS 用 `/`。
旧版本写死 `\`，导致 Linux 上的引用（如 `/home/me/vault/note\笔记.md`）解析不到 —— 当前版本已修。

## 删除笔记 / 文件夹不进回收站

删除笔记/文件夹是永久操作（文件夹递归），会先确认。唯一可恢复的操作是会话**归档**，
而且归档是单向的：DSH 没有「已归档」视图，恢复需要在 `dsh web` 停止时，
从 `$DSH_HOME/storages/workspace.json` 的 `global.archivedSessionIds` 里移除该 id。
若只是想读已删会话的内容，可对它的 `.jsonl.zstd` 日志用 `zstd -dc` 解压（前提是磁盘上还有副本）。

## 编辑器里看不到 frontmatter

这是设计如此。编辑器只编辑正文；host 解析开头的 YAML 块，保存时把原文拼回去
（外部编辑器在此期间改了 YAML 也一样保留）。要改 YAML 请用外部编辑器，插件不会覆盖它。

## 磁盘上改了笔记，预览不更新

预览在打开且非编辑状态下每 3 秒探测一次文件 mtime 并刷新；目录树不轮询，
点笔记工具栏的 **⟳** 重新读取目录（每次展开目录也会重新拉取该目录）。

## 改附件目录会发生什么

把附件目录从旧位置改到新位置时：旧目录下的截图移动到新目录（同名冲突自动加 ` (n)` 后缀），
全库笔记里指向它们的 `![[…]]` 引用同步改写，旧目录仅在为空且不是 Vault 根时删除。
自动删除孤儿附件默认**关闭**：只有显式开启后，某条引用在本次保存中被移除、且没有其它笔记引用该文件，
对应附件才会被删。

## 「选中片段提问」发送的中文包装词

已知限制，见上文「点『引用到对话』提示…」。路径、行号与原文引用是正确的，只有固定包装词暂为中文。

## 设置都在哪

- 插件设置：`$DSH_HOME/dsh-obsidian-vault.json`（Vault 根与附件选项）。
- profile / bundle 接线：`$DSH_HOME/profiles/web/package.json` 与 `cordis.patch.yml`。
- 会话日志：`$DSH_HOME/sessions/`。
