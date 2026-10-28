/**
 * dsh-obsidian-vault client 半边（侧边栏重构版）：
 *  - 常驻接管 sidebar.workspaces（priority:-100 阴影官方 WorkspaceBrowser）：
 *      · 核心会话浏览器：工作区分组 + 展开/收起 + 打开会话 + 新建会话 + 会话搜索
 *      · 「📚 笔记」顶级行（与工作区目录并列）+ 行下展开的笔记树（复用 TreeView）
 *  - 右侧可拖拽/调宽笔记 Dock（shell.overlay），预览 + 编辑 + 保存
 *  - 「引用到对话」按钮：把 @绝对路径 注入对话输入框（兜底：复制到剪贴板）
 *  - Vault 目录选择（ctx.uiWorkspace.pickDirectory + 粘贴绝对路径）
 * 注意：新建会话 / 选择目录由官方 ui-workspace 插件注册的 ctx.uiWorkspace
 * 提供，纯控制器 ctx.workspaces（IWorkspaces）上没有 startSession /
 * pickDirectory（见 navigationFacade 注释）。
 * 依赖工厂闭包内的 React、renderMarkdown / renderNumbered（由 build 拼接在同一 factory 内）。
 */
(() => {
  const { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore } = React;
  const createElement = React.createElement;
  const Fragment = React.Fragment;

  // ── 本地化 ─────────────────────────────────────────────────────────────────
  const NS = "dsh-obsidian";
  const zh = {
    wsSection: "工作区",
    addWorkspace: "添加工作区",
    searchSessions: "搜索会话",
    sessionSearchPlaceholder: "搜索会话…",
    newSession: "新建会话",
    ungrouped: "未分组",
    noSessions: "暂无会话",
    renameWorkspacePrompt: "工作区新名称",
    deleteWorkspaceConfirm: "删除工作区「{name}」？目录与文件保留。",
    deleteWorkspaceSessionsConfirm: "删除工作区「{name}」？目录与文件保留，但其中的 {n} 个会话将一并彻底删除（含子代理会话，日志从磁盘删除，不可恢复）。",
    renameSessionPrompt: "会话新标题",
    deleteSession: "彻底删除会话",
    deleteSessionConfirm: "彻底删除会话「{name}」？将从磁盘删除其日志{caveat}，不可恢复。想保留历史请改用「归档」。",
    deleteSessionMore: "，以及它的 {n} 个子代理会话",
    archiveSession: "归档会话",
    archiveSessionConfirm: "归档会话「{name}」？仅从列表移除，日志保留在磁盘上。",
    archiveUngrouped: "归档全部未分组会话",
    archiveUngroupedConfirm: "归档「{name}」中的 {n} 个会话？仅从列表移除，日志保留。",
    deleteUngrouped: "彻底删除全部未分组会话",
    deleteUngroupedConfirm: "彻底删除「{name}」中的 {n} 个会话？将从磁盘删除日志，不可恢复。",
    archived: "已归档",
    deletedPermanently: "已彻底删除 {n} 个会话",
    deletedPermanentlyPartial: "已彻底删除 {n} 个会话，{m} 个失败",
    deletedPermanentlyStickySuffix: "；其中 {m} 个仍被 DSH 进程持有内存副本，已从列表隐藏，重启 DSH 后彻底消失",
    deletedPermanentlyMissingSuffix: "；另有 {m} 个日志本就不在磁盘上，已一并从列表移除",
    deletedPermanentlyFailedSuffix: "；{m} 个删除失败",
    staleSessionsRemoved: "已从列表移除 {n} 条日志已不存在的会话记录",
    sessionDeleteUnavailable: "删除接口未生效：请重启 DSH（桌面版：退出后重新打开）再重试",
    sessionRunning: "该会话正在运行（含正在运行的子代理），无法彻底删除：请等它结束后重试",
    sessionLivenessUnavailable: "无法确认该会话是否在运行，已拒绝删除：请重启 DSH 后重试",
    nothingDeleted: "没有找到可删除的会话",
    openUnavailable: "当前环境无法打开会话：DSH 侧没有 uiWorkspace.openSession（版本过旧或服务缺失）",
    subagentsRunning: "{n} 个子代理运行中",
    renamed: "已重命名",
    deleted: "已删除",
    // ── 批量操作（工作区 / 会话）──────────────────────────────────────────────
    // 标题行按钮只批量工作区（勾选后删除）；工作区行按钮只批量该工作区的会话
    // （归档 / 彻底删除）。两者互斥，工具条不提供其它动作。
    batchWorkspaces: "批量操作工作区",
    batchSessions: "批量操作会话",
    batchWorkspacesLabel: "已选 {n} 个工作区",
    batchSessionsLabel: "已选 {n} 个会话",
    batchSelectAll: "全选",
    batchInvert: "反选",
    batchClear: "清空勾选",
    batchExit: "取消批量",
    batchPickWorkspace: "选择该工作区",
    batchPickSession: "选择该会话",
    batchArchiveShort: "归档",
    batchDeleteShort: "彻底删除",
    batchDeleteWsShort: "删除工作区",
    archivePicked: "归档选中会话",
    archivePickedConfirm: "归档选中的 {n} 个会话？仅从列表移除，日志保留在磁盘上。",
    archivedPicked: "已归档 {n} 个会话",
    archivedPickedPartial: "已归档 {n} 个会话，{m} 个失败",
    deletePicked: "彻底删除选中会话",
    deletePickedConfirm: "彻底删除选中的 {n} 个会话？（含其子代理会话）将从磁盘删除日志，不可恢复。",
    deletePickedWorkspaces: "删除选中工作区",
    deletePickedWorkspacesConfirm: "删除选中的 {n} 个工作区？目录与文件保留，但其中的 {m} 个会话将一并彻底删除（含子代理会话，日志从磁盘删除，不可恢复）。",
    deletePickedWorkspacesConfirmNoSessions: "删除选中的 {n} 个工作区？目录与文件保留。",
    deletedWorkspaceWithSessions: "已删除工作区「{name}」，并彻底删除 {n} 个会话",
    deletedWorkspaces: "已删除 {n} 个工作区",
    deletedWorkspacesWithSessions: "已删除 {n} 个工作区，并彻底删除 {m} 个会话",
    deletedWorkspacesPartial: "已删除 {n} 个工作区，{m} 个未删除；已彻底删除 {k} 个会话",
    deleteWorkspaceSessionsFailed: "工作区未删除：其中的会话未能全部彻底删除（可能正在运行），请稍后重试",
    confirm: "确定",
    collapse: "收起",
    "time.justNow": "刚刚",
    "time.minutes": "{n}分钟",
    "time.hours": "{n}小时",
    "time.days": "{n}天",
    notes: "笔记",
    vaultRoot: "Vault 目录",
    pickVault: "选择 Vault 目录",
    pickVaultTitle: "选择文件路径",
    pasteVault: "粘贴路径",
    pasteVaultTitle: "直接粘贴绝对路径",
    newNote: "新建笔记",
    newFolder: "新建文件夹",
    newFolderPrompt: "文件夹名称",
    refresh: "刷新",
    search: "搜索笔记",
    searchPlaceholder: "搜索标题或正文…",
    close: "关闭",
    noVault: "Vault 目录不存在，请先选择目录",
    empty: "暂无笔记",
    loading: "加载中…",
    edit: "编辑",
    save: "保存",
    saving: "保存中…",
    cancel: "取消",
    discard: "放弃未保存的修改？",
    cite: "引用到对话",
    cited: "已引用到对话",
    copied: "已复制引用，可粘贴到输入框",
    noInput: "未找到对话输入框，引用已复制到剪贴板",
    citeFail: "引用失败",
    ask: "提问",
    explain: "解释",
    askSend: "发送",
    askCancel: "Esc 取消",
    askCap: "针对选中内容提问…（{n} 字符）",
    rename: "重命名",
    delete: "删除",
    deleteConfirm: "确认删除该笔记？此操作不可恢复。",
    deleteNoteConfirm: "确认删除笔记「{name}」？此操作不可恢复。",
    deleteFolderConfirm: "确认删除文件夹「{name}」及其中的所有内容？此操作不可恢复。",
    resize: "拖动调整宽度",
    move: "拖动移动窗口",
    noteNamePrompt: "笔记名称（.md）",
    renamePrompt: "新名称（.md）",
    wikilinkNotFound: "未找到笔记",
    footnoteMissing: "未找到脚注定义",
    matchedAlias: "命中别名",
    vendorLoadFailed: "加载第三方渲染库「{name}」失败，已降级显示源码",
    mediaOpen: "在浏览器打开",
    embedLoading: "正在读取嵌入笔记…",
    embedMissing: "嵌入失败：找不到笔记「{name}」",
    embedCycle: "嵌入失败：检测到循环嵌入",
    embedDepth: "嵌入失败：超过最大嵌套深度",
    embedAnchorMissing: "嵌入失败：找不到片段「{anchor}」",
    embedTooLong: "内容过长（{lines} 行），点击打开",
    embedOpen: "打开笔记",
    mermaidLoading: "正在渲染图表…",
    mermaidError: "mermaid 渲染失败",
    mermaidUnavailable: "mermaid 不可用（第三方库未就绪）",
    error: "出错了",
    imageInserted: "已插入图片",
    attachDir: "附件目录",
    attachDirPick: "选择附件目录（Vault 内）",
    attachDirEdit: "手写附件目录",
    attachDirClear: "清空（回到 Vault 根）",
    attachDirPlaceholder: "Vault 相对路径，如 docs/images",
    imageRemoved: "已同步删除未引用的图片",
    attachDirConfirm: "更改截图落盘目录：{from} → {to}。会**自动把原目录下的截图移动到新目录**、删除原目录（若空），并同步更新笔记里的引用路径。确认更改？",
    attachSettings: "附件设置（位置 / 显示 / 清理）",
    attachLocation: "附件位置",
    attachMode_root: "Vault 根",
    attachMode_fixed: "固定目录",
    attachMode_note: "与笔记同目录",
    attachMode_sub: "笔记目录下子目录",
    attachSubfolder: "子目录名（如 attachments）",
    attachHideDir: "隐藏图片目录（只含图片、没有笔记的目录）",
    attachDeleteOrphans: "保存笔记时自动删除无用附件（默认关）",
    migrated: "迁移 {n} 张截图，更新 {m} 篇笔记",
  };
  const en = {
    wsSection: "Workspaces",
    addWorkspace: "Add workspace",
    searchSessions: "Search sessions",
    sessionSearchPlaceholder: "Search sessions…",
    newSession: "New session",
    ungrouped: "Ungrouped",
    noSessions: "No sessions",
    renameWorkspacePrompt: "New workspace title",
    deleteWorkspaceConfirm: "Delete workspace “{name}”? The directory and files stay.",
    deleteWorkspaceSessionsConfirm: "Delete workspace “{name}”? The directory and files stay, but its {n} session(s) will be permanently deleted too (including subagent sessions; their logs are erased from disk and cannot be recovered).",
    renameSessionPrompt: "New session title",
    deleteSession: "Delete session permanently",
    deleteSessionConfirm: "Permanently delete session “{name}”? Its log{caveat} will be erased from disk and cannot be recovered. Use Archive to keep the history.",
    deleteSessionMore: " and its {n} subagent sessions",
    archiveSession: "Archive session",
    archiveSessionConfirm: "Archive session “{name}”? It leaves the list; the log stays on disk.",
    archiveUngrouped: "Archive all ungrouped sessions",
    archiveUngroupedConfirm: "Archive all {n} sessions in “{name}”? They leave the list; logs are kept.",
    deleteUngrouped: "Permanently delete all ungrouped sessions",
    deleteUngroupedConfirm: "Permanently delete all {n} sessions in “{name}”? Their logs will be erased from disk and cannot be recovered.",
    archived: "Archived",
    deletedPermanently: "Permanently deleted {n} session(s)",
    deletedPermanentlyPartial: "Permanently deleted {n} session(s), {m} failed",
    deletedPermanentlyStickySuffix: "; {m} still cached in the running DSH process — hidden from the list now, gone for good after a DSH restart",
    deletedPermanentlyMissingSuffix: "; {m} more had no log left on disk and were removed from the list",
    deletedPermanentlyFailedSuffix: "; {m} failed",
    staleSessionsRemoved: "Removed {n} session record(s) whose logs no longer exist",
    sessionDeleteUnavailable: "Delete endpoint unavailable: restart DSH (desktop: quit and reopen) and retry",
    sessionRunning: "This session is running (including any running subagent), so it cannot be deleted: wait for it to finish and retry",
    sessionLivenessUnavailable: "Could not determine whether this session is running, so deletion was refused: restart DSH and retry",
    nothingDeleted: "No session found to delete",
    openUnavailable: "This DSH build cannot open sessions: uiWorkspace.openSession is unavailable",
    subagentsRunning: "{n} subagent(s) running",
    renamed: "Renamed",
    deleted: "Deleted",
    batchWorkspaces: "Batch workspaces",
    batchSessions: "Batch sessions",
    batchWorkspacesLabel: "{n} workspace(s) selected",
    batchSessionsLabel: "{n} session(s) selected",
    batchSelectAll: "Select all",
    batchInvert: "Invert",
    batchClear: "Clear selection",
    batchExit: "Exit batch",
    batchPickWorkspace: "Select this workspace",
    batchPickSession: "Select this session",
    batchArchiveShort: "Archive",
    batchDeleteShort: "Delete",
    batchDeleteWsShort: "Delete workspaces",
    archivePicked: "Archive selected sessions",
    archivePickedConfirm: "Archive the {n} selected session(s)? They leave the list; logs stay on disk.",
    archivedPicked: "Archived {n} session(s)",
    archivedPickedPartial: "Archived {n} session(s), {m} failed",
    deletePicked: "Permanently delete selected sessions",
    deletePickedConfirm: "Permanently delete the {n} selected session(s) (including their subagent sessions)? Their logs will be erased from disk and cannot be recovered.",
    deletePickedWorkspaces: "Delete selected workspaces",
    deletePickedWorkspacesConfirm: "Delete the {n} selected workspace(s)? The directories and files stay, but their {m} session(s) will be permanently deleted too (including subagent sessions; their logs are erased from disk and cannot be recovered).",
    deletePickedWorkspacesConfirmNoSessions: "Delete the {n} selected workspace(s)? The directories and files stay.",
    deletedWorkspaceWithSessions: "Deleted workspace “{name}” and permanently deleted {n} session(s)",
    deletedWorkspaces: "Deleted {n} workspace(s)",
    deletedWorkspacesWithSessions: "Deleted {n} workspace(s) and permanently deleted {m} session(s)",
    deletedWorkspacesPartial: "Deleted {n} workspace(s), {m} not deleted; permanently deleted {k} session(s)",
    deleteWorkspaceSessionsFailed: "Workspace not deleted: its sessions could not all be permanently deleted (they may be running) — retry later",
    confirm: "OK",
    collapse: "Collapse",
    "time.justNow": "now",
    "time.minutes": "{n}m",
    "time.hours": "{n}h",
    "time.days": "{n}d",
    notes: "Notes",
    vaultRoot: "Vault root",
    pickVault: "Choose vault directory",
    pickVaultTitle: "Choose a folder path",
    pasteVault: "Paste path",
    pasteVaultTitle: "Paste an absolute path directly",
    newNote: "New note",
    newFolder: "New folder",
    newFolderPrompt: "Folder name",
    refresh: "Refresh",
    search: "Search notes",
    searchPlaceholder: "Search titles or content…",
    close: "Close",
    noVault: "Vault directory does not exist — choose a directory first",
    empty: "No notes yet",
    loading: "Loading…",
    edit: "Edit",
    save: "Save",
    saving: "Saving…",
    cancel: "Cancel",
    discard: "Discard unsaved changes?",
    cite: "Cite to chat",
    cited: "Cited to chat",
    copied: "Reference copied — paste it into the input",
    noInput: "No chat input found — reference copied to clipboard",
    citeFail: "Cite failed",
    ask: "Ask",
    explain: "Explain",
    askSend: "Send",
    askCancel: "Esc to cancel",
    askCap: "Ask about the selection…（{n} chars）",
    rename: "Rename",
    delete: "Delete",
    deleteConfirm: "Delete this note? This cannot be undone.",
    deleteNoteConfirm: "Delete note “{name}”? This cannot be undone.",
    deleteFolderConfirm: "Delete folder “{name}” and everything inside it? This cannot be undone.",
    resize: "Drag to resize",
    move: "Drag to move",
    noteNamePrompt: "Note name (.md)",
    renamePrompt: "New name (.md)",
    wikilinkNotFound: "Note not found",
    footnoteMissing: "Footnote definition not found",
    matchedAlias: "matched alias",
    vendorLoadFailed: "Failed to load “{name}” rendering library — showing source instead",
    mediaOpen: "Open in browser",
    embedLoading: "Loading embedded note…",
    embedMissing: "Embed failed: note “{name}” not found",
    embedCycle: "Embed failed: circular embed detected",
    embedDepth: "Embed failed: nesting depth exceeded",
    embedAnchorMissing: "Embed failed: section “{anchor}” not found",
    embedTooLong: "Content too long ({lines} lines) — click to open",
    embedOpen: "Open note",
    mermaidLoading: "Rendering diagram…",
    mermaidError: "mermaid rendering failed",
    mermaidUnavailable: "mermaid unavailable (vendor not ready)",
    error: "Error",
    imageInserted: "Image inserted",
    attachDir: "Attachment dir",
    attachDirPick: "Choose attachment dir (inside vault)",
    attachDirEdit: "Type an attachment dir",
    attachDirClear: "Clear (back to vault root)",
    attachDirPlaceholder: "Vault-relative path, e.g. docs/images",
    imageRemoved: "Deleted unreferenced image(s)",
    attachDirConfirm: "Change screenshot dir: {from} → {to}. This will automatically move existing screenshots to the new dir, remove the old dir (if empty), and update note references. Continue?",
    attachSettings: "Attachment settings (location / visibility / cleanup)",
    attachLocation: "Attachment location",
    attachMode_root: "Vault root",
    attachMode_fixed: "Fixed folder",
    attachMode_note: "Same folder as note",
    attachMode_sub: "Subfolder under note",
    attachSubfolder: "Subfolder name (e.g. attachments)",
    attachHideDir: "Hide image folders (folders without any notes)",
    attachDeleteOrphans: "Auto-delete orphaned attachments on save (off by default)",
    migrated: "moved {n} image(s), updated {m} note(s)",
  };

  // ── 共享外部 store（跨槽位：侧边栏 / Dock / Toast）──────────────────────────
  const LS_NOTES_OPEN = "dsh-obsidian:notesOpen";
  const LS_DOCK_WIDTH = "dsh-obsidian:dockWidth";

  function readNotesOpen() {
    try {
      return localStorage.getItem(LS_NOTES_OPEN) === "1";
    } catch {
      return false;
    }
  }

  let shared = { notesOpen: readNotesOpen(), openNote: null, vaultRev: 0, vendorRev: 0, toast: null, noteCount: 0, prompt: null };
  const sharedListeners = new Set();

  function patchShared(patch) {
    shared = { ...shared, ...patch };
    try {
      if (patch.notesOpen !== undefined) localStorage.setItem(LS_NOTES_OPEN, patch.notesOpen ? "1" : "0");
    } catch { /* ignore */ }
    for (const fn of sharedListeners) fn();
  }

  function subscribeShared(fn) {
    sharedListeners.add(fn);
    return () => {
      sharedListeners.delete(fn);
    };
  }

  function useShared() {
    return useSyncExternalStore(subscribeShared, () => shared);
  }

  let toastSeq = 0;
  function showToast(message) {
    // 用序号而不是文案判归属：同一条提示连着弹两次（如两次重命名成功）时，
    // 旧写法会让第一条的定时器提前把第二条清掉。
    const seq = ++toastSeq;
    patchShared({ toast: message });
    window.setTimeout(() => {
      if (toastSeq === seq) patchShared({ toast: null });
    }, 2600);
  }

  /**
   * 应用内单行文本输入（`window.prompt` 的替代）。
   *
   * **桌面版硬约束**：Electron 的 renderer 把 `window.prompt` 实现成
   * `throw new Error("prompt() is not supported.")`，所以桌面版里任何
   * `window.prompt(...)` 都会直接抛异常 —— 表现为「点 ✎ / ＋ / 📁 / 📋 毫无
   * 反应」。这里统一走 shell.overlay 里的输入卡片，web 与桌面版行为一致。
   * @param title - 输入框上方的标题（同时也是输入框 placeholder）。
   * @param initial - 初始值。
   * @returns 确认时返回输入文本，取消/关闭返回 null。
   */
  function askText(title, initial = "") {
    // 同一时刻只留一个输入卡片：上一个未决的按「取消」收尾，避免 Promise 悬挂。
    if (shared.prompt) shared.prompt.resolve(null);
    return new Promise((resolve) => {
      patchShared({ prompt: { title, initial, resolve } });
    });
  }

  /** 关闭输入卡片并把结果交回 {@link askText} 的 Promise。 */
  function closePrompt(value) {
    const current = shared.prompt;
    patchShared({ prompt: null });
    if (current) current.resolve(value);
  }

  // ── HTTP 封装 ─────────────────────────────────────────────────────────────
  async function api(path, init) {
    const res = await fetch(`/obsidian${path}`, {
      ...init,
      headers: { "x-dsh-obsidian": "1", ...(init && init.headers ? init.headers : {}) },
    });
    let json = {};
    try {
      json = await res.json();
    } catch { /* ignore */ }
    if (!res.ok) {
      const err = new Error(json && json.error ? json.error : `HTTP ${res.status}`);
      // 保留状态码：调用方需要区分「接口不存在」（host 未重启）与业务失败，
      // 否则两者会一起被当成「没找到会话」这类正常空结果。
      err.status = res.status;
      throw err;
    }
    return json;
  }

  function mentionFor(absPath) {
    return /[\s"]/.test(absPath) ? `@"${absPath}"` : `@${absPath}`;
  }

  // ── 注入对话输入框 ─────────────────────────────────────────────────────────
  /**
   * 当前会话的官方输入动作面（`InputActions`），由 session 作用域的
   * `conversation.composer.dock` 桥接组件（{@link ComposerBridge}）捕获。
   *
   * DSH 0.2.0 起 composer 由 textarea 换成 Lexical contenteditable
   * （`div[data-input-scroll] > [data-composer-input]`）：只查 textarea 必然落空，
   * 表现为点「引用到对话」/「提问·发送」却提示「未找到对话输入框，引用已复制到剪贴板」。
   * 官方给每个 session 槽位组件发的 `inputActions.insertText(text, captureInsertion())`
   * 才是稳定入口（官方语音输入插件同款）；DOM 注入降级为拿不到动作面时的兜底。
   */
  let composerActions = null;

  /** 无渲染桥接：把所在会话的 inputActions 记到模块作用域，供 Dock 按钮取用。 */
  function ComposerBridge(props) {
    const actions = props ? props.inputActions : null;
    useEffect(() => {
      if (!actions) return undefined;
      composerActions = actions;
      // 切换会话时旧桥先卸载：只有仍指向自己时才清空，避免清掉新会话的动作面。
      return () => { if (composerActions === actions) composerActions = null; };
    }, [actions]);
    return null;
  }

  /**
   * 找对话输入框：0.2+ 为 Lexical contenteditable，0.1.x 为 textarea。
   * @returns {{el: object, kind: "textarea"|"editable"}|null}
   */
  function findComposer() {
    if (typeof document === "undefined") return null;
    const scroll = document.querySelector("div[data-input-scroll]");
    if (!scroll) return null;
    const textarea = scroll.querySelector("textarea");
    if (textarea && !textarea.disabled && !textarea.readOnly) return { el: textarea, kind: "textarea" };
    const editable = scroll.querySelector("[data-composer-input]") || scroll.querySelector('[contenteditable="true"]');
    if (!editable || editable.isContentEditable === false) return null;
    return { el: editable, kind: "editable" };
  }

  /** 输入框里是否已有内容需要隔开（已有内容且不以换行结尾才补一个换行）。 */
  function composerNeedsSeparator(target) {
    const el = target ? target.el : null;
    if (!el) return false;
    if (target.kind === "textarea") {
      return typeof el.value === "string" && el.value !== "" && !el.value.endsWith("\n");
    }
    return typeof el.textContent === "string" && el.textContent.trim() !== "";
  }

  /** 官方 inputActions 注入；draftRev CAS 失败会返回 false，重取一次 span 再试。 */
  function injectViaActions(text) {
    const actions = composerActions;
    if (!actions || typeof actions.insertText !== "function" || typeof actions.captureInsertion !== "function") return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (actions.insertText(text, actions.captureInsertion()) === true) return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** contenteditable（Lexical）兜底：focus → 光标移到末尾 → 原生 insertText。 */
  function insertIntoEditable(el, text) {
    const doc = el.ownerDocument || (typeof document === "undefined" ? null : document);
    if (!doc) return false;
    const before = typeof el.textContent === "string" ? el.textContent : "";
    try { el.focus(); } catch { /* 忽略：拿不到焦点也要继续尝试插入 */ }
    try {
      const selection = typeof window !== "undefined" && typeof window.getSelection === "function" ? window.getSelection() : null;
      if (selection && typeof doc.createRange === "function") {
        const range = doc.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } catch { /* 选区不可用时交给 execCommand 的默认插入点 */ }
    let applied = false;
    try {
      applied = typeof doc.execCommand === "function" && doc.execCommand("insertText", false, text) === true;
    } catch {
      applied = false;
    }
    if (!applied) {
      // 合成 beforeinput：Lexical 的插入路径只认事件（不校验 isTrusted），
      // 拿不到 execCommand 时仍能走它自己的编辑事务。
      try {
        const Ctor = typeof window === "undefined" ? null : window.InputEvent;
        if (Ctor) el.dispatchEvent(new Ctor("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
      } catch { /* 事件构造失败即放弃 DOM 路径 */ }
    }
    const after = typeof el.textContent === "string" ? el.textContent : "";
    return applied || after !== before;
  }

  /** 写入 textarea（DSH 0.1.x 及更早）：React 受控 textarea 的 native setter + input 事件。 */
  function insertIntoTextarea(textarea, text) {
    const next = `${textarea.value}${text}`;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    try {
      if (setter) setter.call(textarea, next);
      else textarea.value = next;
    } catch {
      return false;
    }
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    const end = next.length;
    textarea.setSelectionRange(end, end);
    textarea.focus();
    return true;
  }

  /**
   * 把文本注入对话输入框（前面补换行、末尾留换行，便于继续输入）。
   * 顺序：官方 inputActions → DOM（Lexical contenteditable / textarea）。
   * @param text - 要注入的纯文本。
   * @returns 是否注入成功。
   */
  function injectComposerText(text) {
    if (typeof text !== "string" || text === "") return false;
    const target = findComposer();
    const sep = composerNeedsSeparator(target) ? "\n" : "";
    const payload = `${sep}${text}\n`;
    if (injectViaActions(payload)) return true;
    if (!target) return false;
    return target.kind === "textarea" ? insertIntoTextarea(target.el, payload) : insertIntoEditable(target.el, payload);
  }

  /** 把 @路径 注入对话输入框。 */
  function insertIntoComposer(absPath) {
    return injectComposerText(mentionFor(absPath));
  }

  async function citeToChat(absPath, t) {
    const mention = mentionFor(absPath);
    try {
      if (insertIntoComposer(absPath)) {
        showToast(`${t("cited")}：${mention}`);
        return;
      }
      try {
        await navigator.clipboard.writeText(mention);
        showToast(t("noInput"));
      } catch {
        showToast(`${t("citeFail")}：${mention}`);
      }
    } catch {
      showToast(t("citeFail"));
    }
  }

  // ── 「选中片段提问」通用工具（预览态 / 编辑态共用）──────────────────────────
  const SEL_CHAR_LIMIT = 1500;

  /**
   * 预览内容规范化（M14 缺陷 2）：renderNumbered 内部按 `replace(/\r\n/g,"\n")`
   * 拆行渲染，DOM 里 data-obs-src 的偏移都是「LF 口径」。client 侧的选区映射
   * （computeLeafSpans / posToOffset / spanFromSelection）必须用同一份规范化内容，
   * 否则外部同步进来的 CRLF 笔记行号对、原文切片却错位。规范化口径必须与
   * renderNumbered 严格一致，只替换 CRLF。
   */
  function normalizePreviewContent(content) {
    return typeof content === "string" ? content.replace(/\r\n/g, "\n") : "";
  }

  /**
   * 编辑态选区（textarea）→ span：textarea 的 API value 会按规范把 CRLF 归一成
   * LF，selectionStart/End 也是 LF 口径，所以切片必须基于编辑器当前值（ed.value），
   * 不能拿 note.content（可能是 CRLF）切；否则外部同步进来的 CRLF 笔记在编辑态
   * 选中提问的偏移/原文会错位。返回的 content 供 buildPrompt 计行号与拼原文。
   */
  function editorSelectionSpan(editorValue, start, end) {
    const content = typeof editorValue === "string" ? editorValue : "";
    return { span: { text: content.slice(start, end), start, end, mode: "edit" }, content };
  }

  /**
   * 标题锚点文本规范化（M13 / P2 契约 §12 C6）：渲染器在标题行写
   * `data-heading-anchor="<标题原文 trim>"`；client 匹配时再 trim、去尾部 `#`，
   * 大小写敏感（与 Obsidian 行为一致）。
   */
  function normalizeHeadingAnchor(text) {
    return String(text === null || text === undefined ? "" : text).trim().replace(/\s+#+\s*$/, "").trim();
  }

  /** 内容长度阈值内的换行计数（仅用于行号展示） */
  function offsetToLine(content, off) {
    let line = 1;
    const limit = Math.max(0, Math.min(off, content.length));
    for (let i = 0; i < limit; i++) if (content.charCodeAt(i) === 10) line++;
    return line;
  }

  /** 生成「@路径 + 行数 + > 选中内容 + 【问题】」的注入 prompt（无多余空行） */
  function buildPrompt(absPath, content, span, question) {
    const lineA = offsetToLine(content, span.start);
    const lineB = offsetToLine(content, span.end - 1);
    const range = lineA === lineB ? `第 ${lineA} 行` : `第 ${lineA}–${lineB} 行`;
    const q = (question || "").trim() || "请解释这段内容";
    const lines = [`@${absPath}`, range];
    if (span.text.length <= SEL_CHAR_LIMIT) {
      for (const l of span.text.split("\n")) lines.push(`> ${l}`);
    } else {
      lines.push(`> （片段较长，共 ${span.text.length} 字符，请阅读 @文件 第 ${lineA}–${lineB} 行）`);
    }
    lines.push(`【问题】${q}`);
    return lines.join("\n");
  }

  /** 预览容器中收集带偏移的可见 span（.dsh-obs-src），返回 [{node,start,end}] */
  function computeLeafSpans(container) {
    if (!container || typeof document === "undefined" || typeof document.createTreeWalker !== "function") return [];
    const leaves = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (el.nodeType === 1 && el.firstChild && el.firstChild.nodeType === 3) {
        const cls = el.getAttribute ? el.getAttribute("class") || "" : "";
        if (cls.split(/\s+/).includes("dsh-obs-src")) {
          const src = el.getAttribute("data-obs-src");
          if (src) {
            const parts = src.split(",").map(Number);
            if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
              leaves.push({ node: el.firstChild, start: parts[0], end: parts[1] });
            }
          }
        }
      }
    }
    return leaves;
  }

  /** DOM 位置 (node, offset) → 源码绝对偏移 */
  function posToOffset(leaves, node, offset) {
    if (node.nodeType === 3) {
      for (const leaf of leaves) if (leaf.node === node) return Math.max(0, Math.min(leaf.start + offset, leaf.end));
      return null;
    }
    if (node.nodeType === 1) {
      let after = null;
      for (const leaf of leaves) {
        const rel = leaf.node.compareDocumentPosition ? leaf.node.compareDocumentPosition(node) : 0;
        if (rel & Node.DOCUMENT_POSITION_FOLLOWING) { after = leaf; break; }
      }
      return after ? after.start : (leaves.length ? leaves[leaves.length - 1].end : null);
    }
    return null;
  }

  /** 预览态：当前 DOM 选区 → {text,start,end,mode} 或 null */
  function spanFromSelection(container, leaves, content) {
    if (typeof window === "undefined" || typeof window.getSelection !== "function") return null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return null;
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;
    const start = posToOffset(leaves, range.startContainer, range.startOffset);
    const end = posToOffset(leaves, range.endContainer, range.endOffset);
    if (start === null || end === null || end <= start || end > content.length) return null;
    return { text: content.slice(start, end), start, end, mode: "preview" };
  }

  /** 当前选区包围盒（浮层定位用） */
  function selRect() {
    if (typeof window === "undefined" || typeof window.getSelection !== "function") return null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return null;
    const r = range.getBoundingClientRect ? range.getBoundingClientRect() : null;
    return r ? { top: r.top, bottom: r.bottom, left: r.left } : null;
  }

  /** 把任意文本（不只 @路径）注入对话输入框：与「引用到对话」同一条链路。 */
  function injectPrompt(text) {
    return injectComposerText(text);
  }

  // ── 样式 ───────────────────────────────────────────────────────────────────
  const CSS = [
    // WorkspaceSidebar：常驻 sidebar.workspaces 的整体接管
    `.dsh-obs-sidebar{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-ws-head{display:flex;align-items:center;gap:4px;padding:8px 10px 4px}`,
    `.dsh-obs-ws-head-label{flex:none;font-size:13px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}`,
    `.dsh-obs-head-btn{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 6px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1}`,
    `.dsh-obs-head-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
    `.dsh-obs-head-btn.dsh-obs-on{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-brand-primary)}`,
    `.dsh-obs-search{display:flex;gap:4px;padding:4px 10px 6px}`,
    `.dsh-obs-search input{flex:1;min-width:0;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;outline:none}`,
    `.dsh-obs-search input:focus{border-color:var(--dsw-alias-brand-primary)}`,
    `.dsh-obs-ws-body{flex:1;min-height:0;overflow:auto;padding:2px 6px 10px}`,
    // 工作区组行
    `.dsh-obs-ws-row{display:flex;align-items:center;gap:6px;height:32px;padding:0 8px;border-radius:8px;cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-primary);user-select:none}`,
    `.dsh-obs-ws-row:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
    `.dsh-obs-chev{width:12px;flex:none;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:10px}`,
    `.dsh-obs-ws-icon{flex:none;color:var(--dsw-alias-label-secondary)}`,
    `.dsh-obs-ws-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:500}`,
    `.dsh-obs-mini{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1;flex:none}`,
    `.dsh-obs-mini:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}`,
    // 行尾管理动作（工作区/会话 的 重命名 / 删除，常显）
    `.dsh-obs-actions{display:flex;align-items:center;gap:2px;flex:none}`,
    `.dsh-obs-actions button{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;line-height:1}`,
    `.dsh-obs-actions button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}`,
    // 破坏性动作（彻底删除）：悬停转为危险色，与同排的「归档」明确区分
    `.dsh-obs-actions button.dsh-obs-danger:hover{color:#e5484d}`,
    // ── 批量操作（工作区 / 会话）─────────────────────────────────────────────
    // 勾选框：工作区行与目标工作区的会话行在批量模式下出现
    `.dsh-obs-check{flex:none;width:14px;height:14px;margin:0 2px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}`,
    // 批量工具条：两行（说明 + 动作），窄侧边栏里自动换行
    `.dsh-obs-batchbar{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:4px 10px 6px;border-bottom:1px solid var(--dsw-alias-border-l1)}`,
    `.dsh-obs-batchbar-info{flex:1 0 100%;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
    `.dsh-obs-batchbar button{display:inline-flex;align-items:center;justify-content:center;height:22px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;line-height:1;white-space:nowrap}`,
    `.dsh-obs-batchbar button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-batchbar button:disabled{opacity:.45;cursor:default}`,
    `.dsh-obs-batchbar button.dsh-obs-danger{color:#e5484d;border-color:rgba(229,72,77,.45)}`,
    `.dsh-obs-batchbar button.dsh-obs-danger:hover:not(:disabled){background:rgba(229,72,77,.12);color:#e5484d}`,
    // 已勾选的行 / 当前会话批量的目标工作区行
    `.dsh-obs-ws-row.dsh-obs-picked,.dsh-obs-session.dsh-obs-picked{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-ws-row.dsh-obs-batch-target{box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}`,
    // 会话行（缩进子项）
    `.dsh-obs-session{display:flex;align-items:center;gap:6px;height:30px;margin:1px 0 1px 20px;padding:0 8px;border-radius:8px;cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-secondary)}`,
    `.dsh-obs-session:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
    `.dsh-obs-session.dsh-obs-selected{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-dot{width:10px;flex:none;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:11px}`,
    // 有子代理在跑时的状态点（对应官方会话行的「N 个子代理运行中」状态）
    `.dsh-obs-dot-subs{color:var(--dsw-alias-brand-primary)}`,
    `.dsh-obs-session-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}`,
    `.dsh-obs-time{flex:none;color:var(--dsw-alias-label-dimmed);font-size:11px}`,
    `.dsh-obs-ws-empty{padding:4px 8px 4px 34px;color:var(--dsw-alias-label-tertiary);font-size:12px}`,
    // 「📚 笔记」顶级行（与工作区目录并列）
    `.dsh-obs-notes-row{display:flex;align-items:center;gap:6px;height:32px;margin-top:6px;padding:0 8px;border-radius:8px;cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-primary);user-select:none}`,
    `.dsh-obs-notes-row:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
    `.dsh-obs-notes-row.dsh-obs-notes-row-on{background:var(--dsw-alias-interactive-bg-hover-accent)}`,
    `.dsh-obs-notes-icon{flex:none;color:var(--dsw-alias-brand-primary)}`,
    `.dsh-obs-notes-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:500}`,
    `.dsh-obs-notes-count{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}`,
    `.dsh-obs-notes-pane{margin-left:20px;padding:2px 0 6px}`,
    // 折叠轨道（wide=false）
    `.dsh-obs-rail{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding-top:8px}`,
    `.dsh-obs-rail button{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px}`,
    `.dsh-obs-rail button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}`,
    // 行下笔记树（TreeView，嵌入侧边栏滚动区内）
    `.dsh-obs-tree{display:block;font-size:13px;color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-tree-head{display:flex;align-items:center;gap:2px;padding:2px 4px 6px}`,
    `.dsh-obs-tree-head button{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 6px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1}`,
    `.dsh-obs-tree-head button:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
    `.dsh-obs-tree-head button.dsh-obs-on{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-brand-primary)}`,
    `.dsh-obs-attachcfg{display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:2px 6px 6px}`,
    `.dsh-obs-attachcfg input:not([type=checkbox]){flex:1;min-width:110px;height:24px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px}`,
    `.dsh-obs-cfgline{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}`,
    `.dsh-obs-root-row{display:flex;align-items:center;gap:6px;padding:4px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary)}`,
    `.dsh-obs-root-row .dsh-obs-root-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `.dsh-obs-root-row .dsh-obs-mini,.dsh-obs-row .dsh-obs-mini{flex:none;width:22px;height:22px}`,
    `.dsh-obs-body{overflow:visible;padding:2px 0}`,
    `.dsh-obs-row{display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:7px;cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-secondary)}`,
    `.dsh-obs-row:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
    `.dsh-obs-row.dsh-obs-selected{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-row .dsh-obs-chev{width:12px;flex:none;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:10px}`,
    `.dsh-obs-row .dsh-obs-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}`,
    `.dsh-obs-row .dsh-obs-size{flex:none;color:var(--dsw-alias-label-dimmed);font-size:11px}`,
    `.dsh-obs-snippet{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `.dsh-obs-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:16px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}`,
    `.dsh-obs-empty button{margin-top:4px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px}`,
    `.dsh-obs-empty button:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
    // 右侧 Dock
    `.dsh-obs-dock{pointer-events:auto;position:fixed;z-index:32;display:flex;flex-direction:column;min-width:380px;max-width:92vw;min-height:280px;max-height:88vh;overflow:hidden;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);box-shadow:0 16px 48px rgba(0,0,0,0.35);background:var(--dsw-alias-bg-overlay);font-size:13px;color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-dock[hidden]{display:none}`,
    `.dsh-obs-dock-head{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:grab;user-select:none}`,
    `.dsh-obs-dock-head:active{cursor:grabbing}`,
    `.dsh-obs-dock-head .dsh-obs-dock-title{flex:1;min-width:0;display:flex;align-items:center;gap:6px;font-weight:600;overflow:hidden}`,
    `.dsh-obs-dock-head .dsh-obs-dock-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `.dsh-obs-dock-head button{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:26px;padding:0 8px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1}`,
    `.dsh-obs-dock-head button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-dock-head button.dsh-obs-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}`,
    `.dsh-obs-dock-head button.dsh-obs-primary:hover{background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-foreground)}`,
    `.dsh-obs-dock-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-tertiary)}`,
    `.dsh-obs-tag{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px}`,
    `.dsh-obs-dock-body{flex:1;min-height:0;overflow:auto;padding:12px 16px}`,
    `.dsh-obs-dock-body .dsh-obs-md{line-height:1.7;color:var(--dsw-alias-label-primary);font-size:13.5px}`,
    // 预览态「每行一个行号」：每个源码行为一行（行号在行首，内容可自然折行）
    `.dsh-obs-md-row{display:flex;align-items:flex-start;gap:10px}`,
    `.dsh-obs-md-ln{flex:none;min-width:2ch;text-align:right;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.7;user-select:none;-webkit-user-select:none}`,
    `.dsh-obs-md-lc{flex:1;min-width:0}`,
    `.dsh-obs-dock-body .dsh-obs-md-row .dsh-obs-md-lc p,.dsh-obs-dock-body .dsh-obs-md-row .dsh-obs-md-lc h1,.dsh-obs-dock-body .dsh-obs-md-row .dsh-obs-md-lc h2,.dsh-obs-dock-body .dsh-obs-md-row .dsh-obs-md-lc h3,.dsh-obs-dock-body .dsh-obs-md-row .dsh-obs-md-lc h4,.dsh-obs-dock-body .dsh-obs-md-row .dsh-obs-md-lc h5,.dsh-obs-dock-body .dsh-obs-md-row .dsh-obs-md-lc h6,.dsh-obs-dock-body .dsh-obs-md-row .dsh-obs-md-lc blockquote{margin:0;padding:0}`,
    `.dsh-obs-md-row.dsh-obs-md-heading .dsh-obs-md-lc{font-weight:600}`,
    `.dsh-obs-md-row.dsh-obs-md-quote .dsh-obs-md-lc{border-left:3px solid var(--dsw-alias-brand-primary);padding-left:10px;color:var(--dsw-alias-label-secondary)}`,
    // ── Obsidian callout（`> [!type] 标题`）配色：类型在根节点上带 data-callout ──
    `[data-callout="note"]{--dsh-obs-callout-color:#448aff}`,
    `[data-callout="abstract"]{--dsh-obs-callout-color:#00b8d4}`,
    `[data-callout="info"]{--dsh-obs-callout-color:#00b8d4}`,
    `[data-callout="todo"]{--dsh-obs-callout-color:#448aff}`,
    `[data-callout="tip"]{--dsh-obs-callout-color:#00bfa5}`,
    `[data-callout="success"]{--dsh-obs-callout-color:#00c853}`,
    `[data-callout="question"]{--dsh-obs-callout-color:#ffab00}`,
    `[data-callout="warning"]{--dsh-obs-callout-color:#ff9100}`,
    `[data-callout="failure"]{--dsh-obs-callout-color:#ff5252}`,
    `[data-callout="danger"]{--dsh-obs-callout-color:#ff1744}`,
    `[data-callout="bug"]{--dsh-obs-callout-color:#f50057}`,
    `[data-callout="example"]{--dsh-obs-callout-color:#7c4dff}`,
    `[data-callout="quote"]{--dsh-obs-callout-color:#9e9e9e}`,
    // 行号预览态：callout 连续行共用竖线与底色，首/末行在 .dsh-obs-md-lc 上收圆角
    `.dsh-obs-md-row.dsh-obs-md-quote .dsh-obs-md-lc.dsh-obs-md-callout-head,.dsh-obs-md-row.dsh-obs-md-quote .dsh-obs-md-lc.dsh-obs-md-callout-body{border-left:3px solid var(--dsh-obs-callout-color,var(--dsw-alias-brand-primary));background:color-mix(in srgb,var(--dsh-obs-callout-color,var(--dsw-alias-brand-primary)) 12%,transparent);padding:2px 10px;color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-md-row.dsh-obs-md-quote .dsh-obs-md-lc.dsh-obs-md-callout-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-radius:6px 6px 0 0;padding-top:5px}`,
    `.dsh-obs-md-row.dsh-obs-md-quote.dsh-obs-md-callout-end .dsh-obs-md-lc{border-radius:0 0 6px 6px;padding-bottom:5px}`,
    `.dsh-obs-md-callout-badge{display:inline-flex;align-items:center;gap:3px;flex:none;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--dsh-obs-callout-color,var(--dsw-alias-brand-primary)) 22%,transparent);color:var(--dsw-alias-label-primary);font-size:11px;font-weight:600;line-height:16px}`,
    `.dsh-obs-md-callout-ico{font-size:11px}`,
    `.dsh-obs-md-callout-label{font-size:11px;line-height:16px;white-space:nowrap}`,
    `.dsh-obs-md-callout-title{font-weight:600}`,
    `.dsh-obs-md-row.dsh-obs-md-list .dsh-obs-md-lc{list-style:none}`,
    `.dsh-obs-md-row.dsh-obs-md-code .dsh-obs-md-lc{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:var(--dsw-alias-interactive-bg-hover);border-radius:4px;padding:1px 5px}`,

    `.dsh-obs-md h3,.dsh-obs-md h4,.dsh-obs-md h5,.dsh-obs-md h6{margin:14px 0 6px;line-height:1.4}`,
    `.dsh-obs-md p{margin:8px 0}`,
    `.dsh-obs-md ul,.dsh-obs-md ol{margin:8px 0;padding-left:22px}`,
    `.dsh-obs-md li{margin:3px 0}`,
    `.dsh-obs-md blockquote{margin:8px 0;padding:4px 12px;border-left:3px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-radius:0 6px 6px 0}`,
    // callout（块渲染路径）
    `.dsh-obs-callout{margin:10px 0;border-left:3px solid var(--dsh-obs-callout-color,var(--dsw-alias-brand-primary));background:color-mix(in srgb,var(--dsh-obs-callout-color,var(--dsw-alias-brand-primary)) 12%,transparent);border-radius:0 6px 6px 0;padding:6px 12px}`,
    `.dsh-obs-callout-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:600;margin-bottom:2px}`,
    `.dsh-obs-callout-icon{flex:none;font-size:13px;line-height:1}`,
    `.dsh-obs-callout-title{color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-callout-body{color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-callout-body p{margin:2px 0}`,
    `.dsh-obs-callout-body ul,.dsh-obs-callout-body ol{margin:2px 0;padding-left:20px}`,
    `.dsh-obs-md code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:var(--dsw-alias-interactive-bg-hover);padding:1px 5px;border-radius:4px}`,
    `.dsh-obs-code{margin:8px 0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6}`,
    `.dsh-obs-md table{border-collapse:collapse;margin:8px 0}`,
    `.dsh-obs-md th,.dsh-obs-md td{border:1px solid var(--dsw-alias-border-l2);padding:4px 10px;font-size:12.5px}`,
    `.dsh-obs-md hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:12px 0}`,
    `.dsh-obs-md img{max-width:100%;border-radius:8px}`,
    `.dsh-obs-md a{color:var(--dsw-alias-brand-primary)}`,
    `.dsh-obs-wikilink{display:inline;padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font-size:inherit;text-decoration:underline;text-decoration-style:dotted}`,
    `.dsh-obs-wikilink:hover{color:var(--dsw-alias-label-primary)}`,
    // ── 行号预览的新块级语法（M1–M7）：标题分级 / 嵌套引用 / 围栏代码 / 列表+任务 / 表格 / 分隔线 / setext / 双链分隔 ──
    // 标题：字号按级递减；行号与标题首行按基线对齐，否则大字号会让行号漂在文字上方
    `.dsh-obs-md-row:is(.dsh-obs-md-heading,.dsh-obs-md-h1,.dsh-obs-md-h2,.dsh-obs-md-h3,.dsh-obs-md-h4,.dsh-obs-md-h5,.dsh-obs-md-h6){align-items:baseline}`,
    `.dsh-obs-md-row.dsh-obs-md-h1 .dsh-obs-md-lc{font-size:20px;font-weight:700;line-height:1.45}`,
    `.dsh-obs-md-row.dsh-obs-md-h2 .dsh-obs-md-lc{font-size:18px;font-weight:700;line-height:1.45}`,
    `.dsh-obs-md-row.dsh-obs-md-h3 .dsh-obs-md-lc{font-size:16px;font-weight:600;line-height:1.5}`,
    `.dsh-obs-md-row.dsh-obs-md-h4 .dsh-obs-md-lc{font-size:14.5px;font-weight:600;line-height:1.55}`,
    `.dsh-obs-md-row.dsh-obs-md-h5 .dsh-obs-md-lc{font-size:13.5px;font-weight:600;line-height:1.6}`,
    `.dsh-obs-md-row.dsh-obs-md-h6 .dsh-obs-md-lc{font-size:13px;font-weight:600;line-height:1.6;color:var(--dsw-alias-label-secondary)}`,
    // 标题里的行内代码跟着标题字号缩，别在 20px 的标题里留一块 12px 的小方块
    `.dsh-obs-md-row:is(.dsh-obs-md-heading,.dsh-obs-md-h1,.dsh-obs-md-h2,.dsh-obs-md-h3,.dsh-obs-md-h4,.dsh-obs-md-h5,.dsh-obs-md-h6) .dsh-obs-md-lc code{font-size:.75em}`,
    // 引用：按 data-quote-depth 逐层右移（1 起）；callout 行不缩进，避免和分组竖线打架
    // 空的引用/正文行也要把竖线、底色拉满整行高度，否则 callout 中间会漏出一段缺口
    `.dsh-obs-md-row.dsh-obs-md-quote .dsh-obs-md-lc{align-self:stretch}`,
    `.dsh-obs-md-row.dsh-obs-md-quote[data-quote-depth]:not([data-callout-group]) .dsh-obs-md-lc{border-left-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}`,
    `.dsh-obs-md-row.dsh-obs-md-quote[data-quote-depth="2"]:not([data-callout-group]) .dsh-obs-md-lc{margin-left:16px}`,
    `.dsh-obs-md-row.dsh-obs-md-quote[data-quote-depth="3"]:not([data-callout-group]) .dsh-obs-md-lc{margin-left:32px}`,
    `.dsh-obs-md-row.dsh-obs-md-quote[data-quote-depth="4"]:not([data-callout-group]) .dsh-obs-md-lc{margin-left:48px}`,
    // 围栏代码：同一 data-code-group 的连续行拼成一整块底色，首尾行收圆角；长行换行，不按行横滚
    `.dsh-obs-md-row.dsh-obs-md-code{background:var(--dsw-alias-interactive-bg-hover)}`,
    `.dsh-obs-md-row.dsh-obs-md-code .dsh-obs-md-lc{background:transparent;border-radius:0;padding:1px 10px 1px 0;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4;color:var(--dsw-alias-label-secondary)}`,
    `.dsh-obs-md-row.dsh-obs-md-code-head{border-radius:7px 7px 0 0}`,
    `.dsh-obs-md-row.dsh-obs-md-code-end{border-radius:0 0 7px 7px}`,
    // 单行代码块（开闭围栏是同一行）没有正文，四角都收
    `.dsh-obs-md-row.dsh-obs-md-code-head.dsh-obs-md-code-end{border-radius:7px}`,
    // 开围栏行只显示语言名（无语言时这一行只剩行号与块底色）
    `.dsh-obs-md-code-lang{display:inline-block;padding:0 6px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px;letter-spacing:.02em}`,
    // 列表：行号列不动；缩进由行上的 data-list-depth 折算成 --dsh-obs-list-indent，marker 定宽右对齐、正文悬挂缩进
    `.dsh-obs-md-row.dsh-obs-md-list .dsh-obs-md-lc{display:flex;align-items:flex-start;gap:6px;padding-left:var(--dsh-obs-list-indent,0px)}`,
    `.dsh-obs-md-row.dsh-obs-md-list[data-list-depth="1"]{--dsh-obs-list-indent:16px}`,
    `.dsh-obs-md-row.dsh-obs-md-list[data-list-depth="2"]{--dsh-obs-list-indent:32px}`,
    `.dsh-obs-md-row.dsh-obs-md-list[data-list-depth="3"]{--dsh-obs-list-indent:48px}`,
    `.dsh-obs-md-row.dsh-obs-md-list[data-list-depth="4"]{--dsh-obs-list-indent:64px}`,
    `.dsh-obs-md-row.dsh-obs-md-list[data-list-depth="5"]{--dsh-obs-list-indent:80px}`,
    `.dsh-obs-md-list-marker{flex:none;min-width:2em;text-align:right;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;user-select:none;-webkit-user-select:none}`,
    `.dsh-obs-md-list-body{flex:1;min-width:0}`,
    // 任务列表：复选框替代符号（marker 隐藏），只读；已完成项正文弱化
    `.dsh-obs-md-row.dsh-obs-md-list[data-list-kind="task"] .dsh-obs-md-list-marker{display:none}`,
    `.dsh-obs-md-task-check{flex:none;width:13px;height:13px;margin:5px 0 0 calc(2em - 13px);accent-color:var(--dsw-alias-brand-primary);cursor:default}`,
    `.dsh-obs-md-row.dsh-obs-md-list[data-checked="1"] .dsh-obs-md-list-body{color:var(--dsw-alias-label-tertiary)}`,
    // callout 正文里的列表：callout 自己已有 10px 内边距，列表缩进要叠上去（写在 callout 规则之后才能覆盖 padding-left）
    `.dsh-obs-md-row.dsh-obs-md-list .dsh-obs-md-lc.dsh-obs-md-callout-body{padding-left:calc(10px + var(--dsh-obs-list-indent,0px))}`,
    // 表格：整块横向滚动（最窄 380px 也不撑裂面板）；行号列 sticky 在左，配不透明底色挡住滚动内容
    `.dsh-obs-md-tablewrap{max-width:100%;margin:8px 0;overflow-x:auto;overflow-y:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:7px}`,
    `.dsh-obs-md .dsh-obs-md-table{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%;font-size:12.5px;line-height:1.55}`,
    `.dsh-obs-md-table th,.dsh-obs-md-table td{padding:4px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);border-right:1px solid var(--dsw-alias-border-l1);vertical-align:top}`,
    `.dsh-obs-md-table tr>*:last-child{border-right:0}`,
    `.dsh-obs-md-table thead th{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,var(--dsw-alias-bg-overlay));font-weight:600;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-l2)}`,
    `.dsh-obs-md-table tbody tr:last-child>*{border-bottom:0}`,
    // 正文行（.dsh-obs-md-trow）悬停高亮只铺数据列，行号列保持不透明，横向滚动时不透字
    `.dsh-obs-md-table tr.dsh-obs-md-trow:hover>td:not(.dsh-obs-md-tln){background:var(--dsw-alias-interactive-bg-hover)}`,
    `.dsh-obs-md-table tr.dsh-obs-md-trow>td:not(.dsh-obs-md-tln){background:transparent}`,
    `.dsh-obs-md-table .dsh-obs-md-tln{position:sticky;left:0;z-index:1;width:2ch;min-width:2ch;padding:4px 10px 4px 0;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;user-select:none;-webkit-user-select:none}`,
    `.dsh-obs-md-table thead .dsh-obs-md-tln{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,var(--dsw-alias-bg-overlay))}`,
    `.dsh-obs-md-table [data-align="center"]{text-align:center}`,
    `.dsh-obs-md-table [data-align="right"]{text-align:right}`,
    // 分隔行（源码的 |---|---|）视觉上折叠进表头行号格：对照原生 Markdown/Obsidian（表格=表头+正文，没有分隔行），
    // 行本身压成 1px 透明行（line-height:0 让 10px 行号不占布局高度），行号 38 用 transform 上移 7px 提到表头行号格 37 下方；
    // 分隔线沿用表头 th 既有的 border-bottom，不再单独画线；sticky 仍继承通用 tln 规则，横滚时 37/38 一起固定在左侧
    `.dsh-obs-md-table tr.dsh-obs-md-tsep td{height:1px;padding:0;border:0;background:transparent;line-height:0}`,
    `.dsh-obs-md-table tr.dsh-obs-md-tsep td.dsh-obs-md-tsep-cell{height:1px;background:transparent}`,
    `.dsh-obs-md-table tr.dsh-obs-md-tsep td.dsh-obs-md-tln{height:1px;padding:0 10px 0 0;background:transparent;font-size:10px;line-height:0;color:var(--dsw-alias-label-tertiary);transform:translateY(-7px)}`,
    `.dsh-obs-md-table code{font-size:11px;padding:0 4px;border-radius:4px}`,
    `.dsh-obs-md-tablewrap::-webkit-scrollbar{height:8px}`,
    `.dsh-obs-md-tablewrap::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:4px}`,
    // 分隔线：行号保留，横线在内容区垂直居中
    `.dsh-obs-md-row.dsh-obs-md-hr{align-items:center;padding:7px 0}`,
    `.dsh-obs-md-row .dsh-obs-md-hr-line{display:block;width:100%;height:0;margin:0;border:0;border-top:1px solid var(--dsw-alias-border-l2)}`,
    // setext 下划线行（=== / ---）不显示原文：保留正常行高与正常行号（不再压透明度，浅/深主题下都别让人误以为跳行）
    `.dsh-obs-md-row.dsh-obs-md-setext-underline .dsh-obs-md-lc{display:none}`,
    // 双链：可见文本用品牌色，` › ` 是按钮里的非 span 文本，继承按钮的次要色，和两侧文字区分开
    `.dsh-obs-wikilink{color:var(--dsw-alias-label-tertiary)}`,
    `.dsh-obs-wikilink [data-obs-src]{color:var(--dsw-alias-brand-primary)}`,
    `.dsh-obs-wikilink:hover [data-obs-src]{color:var(--dsw-alias-label-primary)}`,
    // ── P2 新语法样式地基（M10–M20 的 DOM 契约见团队 P2 契约 §3）──────────────
    // 行内：删除线 / 高亮 / 标签 pill / 自动链接（M10）
    `.dsh-obs-md-strike{text-decoration:line-through;text-decoration-thickness:1.5px;color:var(--dsw-alias-label-secondary)}`,
    `.dsh-obs-md-highlight{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-label-primary);padding:0 2px;border-radius:3px}`,
    `.dsh-obs-md-tag{display:inline-flex;align-items:center;padding:0 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary);font-size:11.5px;line-height:17px;white-space:nowrap}`,
    `.dsh-obs-md-tag [data-obs-src]{color:inherit}`,
    `.dsh-obs-md-autolink{color:var(--dsw-alias-brand-primary);text-decoration:underline;text-decoration-style:dotted;overflow-wrap:anywhere}`,
    `.dsh-obs-md-autolink:hover{color:var(--dsw-alias-label-primary)}`,
    // 块 + 行号竖列（D2：数学块 / mermaid / transclusion 输出）：竖列口径与普通行号列一致，
    // 块内不横滚（mermaid 的图单独允许横向滚动，见下方规则）
    `.dsh-obs-md-block{display:flex;align-items:flex-start;gap:10px;max-width:100%;margin:8px 0}`,
    `.dsh-obs-md-gutter{flex:none;display:flex;flex-direction:column;min-width:2ch;text-align:right;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.7;user-select:none;-webkit-user-select:none}`,
    `.dsh-obs-md-glno{display:block;text-align:right;font-variant-numeric:tabular-nums}`,
    `.dsh-obs-md-block-body{flex:1;min-width:0;overflow-wrap:anywhere}`,
    // callout 进阶（M11）：折叠按钮 / 未知类型默认色 / 嵌套缩进
    `.dsh-obs-md-callout-toggle{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;line-height:1;flex:none;user-select:none;-webkit-user-select:none}`,
    `.dsh-obs-md-callout-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-md-callout-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}`,
    `.dsh-obs-md-callout-default{--dsh-obs-callout-color:var(--dsw-alias-label-tertiary,#9e9e9e)}`,
    `.dsh-obs-md-row.dsh-obs-md-callout-nested .dsh-obs-md-lc{margin-left:14px}`,
    `.dsh-obs-md-row.dsh-obs-md-callout-nested[data-callout-depth="2"] .dsh-obs-md-lc{margin-left:28px}`,
    // 折叠态：body 行 DOM 照常生成（保行号覆盖），只由 CSS 隐藏；header 行不带该属性。
    // callout 里的 D2 块（math/mermaid/embed，行上带 data-callout）同样随父折叠隐藏。
    `.dsh-obs-md-row[data-callout-collapsed="1"]{display:none}`,
    `.dsh-obs-md-block[data-callout-collapsed="1"]{display:none}`,
    // callout 内的 D2 块：不再叠一层边框/底色（callout body 的竖线与底色负责连续），只去掉
    // 上下的块间距，避免把 callout 的连续底色切开
    `.dsh-obs-md-block[data-callout]{margin:2px 0;background:transparent}`,
    `.dsh-obs-md-block[data-callout] .dsh-obs-md-gutter{padding-left:2px}`,
    // 脚注（M12，原地渲染）：定义行 / 引用上标 / 点击后的目标高亮
    `.dsh-obs-md-footnote-def .dsh-obs-md-lc{font-size:12.5px;color:var(--dsw-alias-label-secondary)}`,
    `.dsh-obs-md-footnote-label{display:inline-block;margin-right:6px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}`,
    `.dsh-obs-md-fnref{display:inline;padding:0 2px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font:inherit;font-size:.75em;line-height:1;vertical-align:super}`,
    `.dsh-obs-md-fnref:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-md-fn-target .dsh-obs-md-lc{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);border-radius:4px}`,
    // 媒体嵌入（M19）：音频 / 视频 / PDF（CSP 拦 iframe 时降级为 .dsh-obs-md-pdf-open 按钮）
    `.dsh-obs-md-audio{display:block;width:100%;max-width:420px;margin:4px 0}`,
    `.dsh-obs-md-video{display:block;width:100%;max-width:100%;max-height:320px;margin:4px 0;border-radius:6px;background:#000}`,
    `.dsh-obs-md-pdf{display:block;box-sizing:border-box;width:100%;height:420px;margin:4px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-overlay,#fff)}`,
    `.dsh-obs-md-pdf-open{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;text-decoration:none;cursor:pointer}`,
    `.dsh-obs-md-pdf-open:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
    // transclusion 输出（M18）：嵌入内容是缩进块（Obsidian 阅读视图同款），左侧竖线与内边距
    // 区分于外层正文；嵌入内容本身不产外层行号
    `.dsh-obs-md-embed{display:block;min-width:0;margin:4px 0;padding:2px 0 2px 10px;border-left:2px solid var(--dsw-alias-border-l2);border-radius:0 6px 6px 0}`,
    `.dsh-obs-md-embed .dsh-obs-md-row{gap:0}`,
    `.dsh-obs-md-embed .dsh-obs-md-lc{padding-left:0}`,
    // 整篇嵌入的标题栏（Obsidian 同款）：小字、底部分隔线；不继承全局 button 外观
    `.dsh-obs-md-embed-title{display:block;box-sizing:border-box;width:100%;margin:0 0 4px;padding:2px 0 4px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:0;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:1.5;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}`,
    `.dsh-obs-md-embed-title:hover{background:none;color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-md-embed-error{display:flex;align-items:flex-start;gap:6px;padding:6px 10px;margin:4px 0;border-left:3px solid var(--dsw-alias-state-error-primary);border-radius:0 6px 6px 0;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px}`,
    `.dsh-obs-md-embed-loading{padding:2px 0;color:var(--dsw-alias-label-tertiary);font-size:12px}`,
    `.dsh-obs-md-embed-open{display:inline-flex;align-items:center;gap:4px;margin-top:4px;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}`,
    `.dsh-obs-md-embed-open:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
    // 数学（M16）与 mermaid（M20）占位：渲染产物由懒加载模块填充；mermaid 图允许块内横滚
    `.dsh-obs-md-math-inline{color:inherit;font-size:1.02em}`,
    `.dsh-obs-md-math-block{display:block;max-width:100%;overflow-x:auto;text-align:center;color:inherit}`,
    `.dsh-obs-md-math-inline .katex,.dsh-obs-md-math-block .katex{color:inherit;font-size:inherit}`,
    `.dsh-obs-md-mermaid{display:block;max-width:100%;overflow-x:auto;margin:4px 0}`,
    `.dsh-obs-md-mermaid svg{display:block;max-width:100%;height:auto}`,
    `.dsh-obs-editor{flex:1;display:flex;min-height:0}`,
    `.dsh-obs-editor-gutter{flex:none;box-sizing:content-box;min-width:2ch;padding:12px 8px 12px 10px;text-align:right;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.7;white-space:pre;overflow:hidden;user-select:none;-webkit-user-select:none;border-right:1px solid var(--dsw-alias-border-l1);background:transparent}`,
    `.dsh-obs-editor textarea{flex:1;resize:none;border:0;outline:none;padding:12px 16px 12px 12px;background:transparent;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.7;white-space:pre;overflow:auto}`,
    `.dsh-obs-error{padding:8px 12px;font-size:12px;color:var(--dsw-alias-state-error-primary);border-top:1px solid var(--dsw-alias-border-l1)}`,
    `.dsh-obs-handle{position:absolute;left:-6px;top:14px;bottom:14px;width:12px;cursor:col-resize;border-radius:6px;z-index:2}`,
    `.dsh-obs-handle:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
    `body.dsh-obs-resizing{user-select:none;cursor:col-resize}`,
    // Toast
    // Toast：必须用 DSH 主题里**真实存在**的 toast 变量（--dsw-alias-toast-bg /
    // -toast-label，浅色与深色主题都是深底白字）。旧写法用的是主题里根本没定义的
    // --dsw-alias-bg-inverted：background 整条声明失效变透明，文字色却是
    // --dsw-alias-label-primary-foreground（浅色主题=白）—— 结果只剩一个
    // 「底部白框、没有文字」，删除成功/失败的所有提示都是看不见的。
    // 位置同时改成顶部居中，与官方 toast 一致，不再压住输入框与权限选择器。
    `.dsh-obs-toast{pointer-events:none;position:fixed;left:50%;top:40px;transform:translateX(-50%);z-index:60;width:max-content;max-width:min(640px,calc(100vw - 48px));padding:10px 16px;border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-toast-bg,#353638);color:var(--dsw-alias-toast-label,#fff);font-size:13px;line-height:20px;box-shadow:0 8px 24px rgba(0,0,0,0.3)}`,
    // 文本输入卡片（window.prompt 的替代；Electron 桌面版没有 prompt）
    `.dsh-obs-prompt-layer{position:fixed;inset:0;z-index:58;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.28)}`,
    `.dsh-obs-prompt{display:flex;flex-direction:column;gap:8px;width:320px;max-width:calc(100vw - 32px);padding:12px 14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 16px 48px rgba(0,0,0,0.35)}`,
    `.dsh-obs-prompt-title{font-size:12.5px;color:var(--dsw-alias-label-secondary)}`,
    `.dsh-obs-prompt-input{width:100%;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;outline:none}`,
    `.dsh-obs-prompt-input:focus{border-color:var(--dsw-alias-brand-primary)}`,
    `.dsh-obs-prompt-cancel{flex:none;height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12.5px}`,
    `.dsh-obs-prompt-cancel:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
    `.dsh-obs-ws-body::-webkit-scrollbar,.dsh-obs-dock-body::-webkit-scrollbar,.dsh-obs-editor textarea::-webkit-scrollbar{width:10px}`,
    `.dsh-obs-ws-body::-webkit-scrollbar-thumb,.dsh-obs-dock-body::-webkit-scrollbar-thumb,.dsh-obs-editor textarea::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:5px}`,
    // 「选中片段提问」浮层
    `.dsh-obs-askpop, .dsh-obs-askpop *{-webkit-box-sizing:border-box;box-sizing:border-box}`,
    `.dsh-obs-askpop{position:fixed;z-index:41;pointer-events:auto;display:flex}`,
    `.dsh-obs-askbar{display:flex;align-items:center;gap:2px;padding:3px;background:#202024;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.35)}`,
    `.dsh-obs-askbar button{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:#fff;cursor:pointer;font-size:12.5px;white-space:nowrap}`,
    `.dsh-obs-askbar button:hover{background:rgba(255,255,255,0.16);color:#fff}`,
    `.dsh-obs-askbar .dsh-obs-asklen{padding:0 8px;font-size:11px;color:rgba(255,255,255,0.75)}`,
    `.dsh-obs-askinput{flex-direction:column;width:300px;max-width:calc(100vw - 32px);padding:8px 10px;gap:6px;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,0.35);color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-askcap{font-size:11px;color:var(--dsw-alias-label-tertiary)}`,
    `.dsh-obs-askta{width:100%;min-height:50px;max-height:132px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;resize:vertical;font-size:12.5px;line-height:1.5;background:transparent;color:var(--dsw-alias-label-primary,#18181b);font-family:inherit}`,
    `.dsh-obs-askta:focus{border-color:var(--dsw-alias-brand-primary)}`,
    `.dsh-obs-askrow{display:flex;align-items:center;gap:8px}`,
    `.dsh-obs-askhint{flex:1;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}`,
    `.dsh-obs-asksend{flex:none;height:30px;padding:0 14px;border:0;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);cursor:pointer;font-size:12.5px}`,
    `.dsh-obs-asksend:hover{background:var(--dsw-alias-button-primary-hover)}`,
  ].join("\n");

  function injectCss() {
    if (typeof document === "undefined") return;
    if (document.querySelector('style[data-plugin-css="dsh-obsidian-vault/core.css"]')) return;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-obsidian-vault";
    tag.dataset.pluginCss = "dsh-obsidian-vault/core.css";
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  // ── 通用工具 ───────────────────────────────────────────────────────────────
  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  /** 相对时间（zh/en 随 t）：刚刚 / N分钟 / N小时 / N天 / 日期。 */
  function formatRelativeTime(ts, t) {
    const now = Date.now();
    const delta = Math.max(0, now - (typeof ts === "number" ? ts : 0));
    const minutes = Math.floor(delta / 60000);
    if (minutes < 1) return t("time.justNow");
    if (minutes < 60) return t("time.minutes", { n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t("time.hours", { n: hours });
    const days = Math.floor(hours / 24);
    if (days < 7) return t("time.days", { n: days });
    const d = new Date(ts);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  }

  /**
   * 一个会话及其全部子代理后代（闭包，含自身）。
   * 删父会话必须连子代理日志一起删：父级日志消失后，子会话会变成无法归属的
   * 悬空记录（列表里不再有父行可以承载它的血缘与状态）。
   * @param sid - 根会话 id。
   * @param byId - 会话 id → 会话记录。
   * @returns 需要一并删除的 id 集合。
   */
  function sessionClosure(sid, byId) {
    const childrenOf = new Map();
    for (const s of Object.values(byId ?? {})) {
      if (!s || s.parentId === undefined || s.parentId === null) continue;
      const kids = childrenOf.get(s.parentId);
      if (kids === undefined) childrenOf.set(s.parentId, [s.id]);
      else kids.push(s.id);
    }
    const out = new Set();
    const queue = [sid];
    while (queue.length > 0) {
      const id = queue.pop();
      if (out.has(id)) continue;
      out.add(id);
      for (const child of childrenOf.get(id) ?? []) queue.push(child);
    }
    return out;
  }

  /**
   * 「已彻底删除」墓碑：日志已从磁盘删掉、但 DSH 进程仍持有该会话的内存副本时，
   * Host 的会话列表依然会列出它（列表优先用内存里的会话），直到 DSH 重启。
   * 只靠 `sessions.refresh()` 无法让行消失，用户会看到「删了还在」，与「彻底
   * 删除」矛盾。所以前端自己记住这些 id 并隐藏对应行，等 Host 不再列出它们
   * （重启后内存副本随进程消失）再摘掉墓碑。
   *
   * 落在 localStorage：页面刷新不该让删掉的行复活 —— 磁盘上已经没有任何东西了。
   * 存储不可用（隐私模式/配额）时退化为「本次页面会话内隐藏」，不影响删除本身。
   */
  const PURGED_IDS_KEY = "dsh-obsidian-vault:purged-sessions";

  function readPurgedIds() {
    try {
      const raw = (typeof localStorage !== "undefined" && localStorage) ? localStorage.getItem(PURGED_IDS_KEY) : null;
      if (!raw) return new Set();
      const list = JSON.parse(raw);
      return new Set(Array.isArray(list) ? list.filter((id) => typeof id === "string") : []);
    } catch {
      return new Set();
    }
  }

  function writePurgedIds(ids) {
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        localStorage.setItem(PURGED_IDS_KEY, JSON.stringify([...ids]));
      }
    } catch { /* 存储不可用：退化为本次页面会话内隐藏，删除结果本身不受影响 */ }
  }

  const treeApi = {
    tree: (path = "") => api(`/tree?path=${encodeURIComponent(path)}`),
    search: (q) => api(`/search?q=${encodeURIComponent(q)}`),
    root: () => api("/root"),
    setRoot: (root) => api("/root", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root }),
    }),
    // 上传粘贴的图片（base64）→ { path }（Obsidian 风格的链接目标）。
    // 带 `note`：位置模式为 note/sub 时要落到「当前笔记目录」下。
    attach: (data, note) => api("/attach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(note ? { data, note } : { data }),
    }),
    // 设置固定附件目录（POSIX 相对路径；"" = Vault 根）——会把位置模式切到 fixed/root
    setAttachDir: (dir) => api("/attach-dir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir }),
    }),
    // 附件位置模式 / 子目录名 / 隐藏目录 / 自动清理孤儿
    setAttachSettings: (patch) => api("/attach-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
    // embed/相对路径 → 图片字节流地址（预览用）。
    // 必须带上 `from`（引用它的笔记路径）：图片目标要按 Obsidian 语义解析
    // （精确路径 → 笔记相对 → 后缀/文件名匹配），否则子目录笔记里的
    // `![[附件/a.png]]` 会被当成 Vault 根下的 `附件/a.png` → 403 → 只剩断图。
    assetUrl: (rel, from) => `/obsidian/file?path=${encodeURIComponent(rel)}`
      + (from ? `&from=${encodeURIComponent(from)}` : ""),
    note: (rel) => api(`/note?path=${encodeURIComponent(rel)}`),
    save: (rel, content) => api("/note", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: rel, content }),
    }),
    newNote: (dirRel, name) => api("/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "new", path: dirRel, name }),
    }),
    newFolder: (dirRel, name) => api("/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "mkdir", path: dirRel, name }),
    }),
    renameNote: (rel, newName) => api("/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rename", path: rel, newName }),
    }),
    deleteNote: (rel) => api("/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", path: rel }),
    }),
    // 彻底删除会话日志（host 侧带外维护：DSH 持久化层没有删除接口）。
    // 必须一次把「父会话 + 全部子代理会话」的 id 一起送过去。
    deleteSessions: (ids) => api("/session-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    }),
    // 只读探测：Host 权威判定这些 id 在磁盘上还有没有 durable 日志（`persisted`）、
    // 内存里有没有副本（`live`）、是不是在跑。用于隐藏「日志早就不在了、只剩内存
    // 副本」的僵死行 —— 这类历史删除没有本地墓碑可查（见 readPurgedIds）。
    sessionState: (ids) => api("/session-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    }),
    /**
     * 拼接绝对路径（用于 `@路径` 引用与提问 prompt）。
     *
     * 分隔符必须跟随 root 的形态：写死 `\` 会让 Linux/macOS 上的
     * `@/home/…\笔记.md` 变成混合分隔符，DSH 解析不到该引用。
     * @param rel - Vault 相对路径（内部统一用 `/`）。
     * @param root - Vault 根目录（可能以分隔符结尾）。
     * @returns 绝对路径。
     */
    absPath: (rel, root) => {
      const parts = rel.split("/").filter((p) => p !== "");
      const windows = /^[a-zA-Z]:/.test(root) || (root.includes("\\") && !root.includes("/"));
      if (windows) return [root, ...parts].join("\\").replace(/^([a-zA-Z]):\\\\/, "$1:\\");
      return [root.replace(/\/+$/, ""), ...parts].join("/");
    },
  };

  function joinRel(dir, name) {
    return dir === "" ? name : `${dir}/${name}`;
  }

  /** 在源码 draft 的 [start,end) 处插入 embed，返回新 draft（粘贴与测试共用）。 */
  function insertEmbedAtSelection(draft, start, end, embed) {
    const len = draft.length;
    const s = Math.max(0, Math.min(typeof start === "number" ? start : len, len));
    const e = Math.max(s, Math.min(typeof end === "number" ? end : s, len));
    return draft.slice(0, s) + embed + draft.slice(e);
  }

  /** 读剪贴板图片 File 为 dataURL（base64）。 */
  function fileToDataUrl(file, W) {
    const win = W || (typeof window !== "undefined" ? window : null);
    return new Promise((resolve, reject) => {
      if (!win || !win.FileReader) { reject(new Error("FileReader unavailable")); return; }
      const fr = new win.FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(new Error("read image failed"));
      fr.readAsDataURL(file);
    });
  }

  // ── 笔记树视图（「📚 笔记」行下展开，嵌入侧边栏滚动区）──────────────────────
  function TreeView({ t, uiWorkspace }) {
    const { openNote, vaultRev } = useShared();
    const [rootInfo, setRootInfo] = useState(null);
    const [dirs, setDirs] = useState({});
    const [expanded, setExpanded] = useState(() => new Set());
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [searchOpen, setSearchOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const searchTimer = useRef(null);
    // 「附件目录」设置（POSIX 相对路径，"" = Vault 根；初始 null 表示尚未加载）
    const [attachDir, setAttachDirState] = useState(null);
    const [attachOpen, setAttachOpen] = useState(false);
    const [attachInput, setAttachInput] = useState("");
    // 附件位置模式 / 子目录 / 两个开关（对齐 Obsidian 的附件位置设置）
    const [attachCfg, setAttachCfg] = useState(null);

    // 已展开目录的镜像：loadRoot 的 useCallback 依赖要保持稳定（否则每次展开都会
    // 重建整棵树），刷新时又要读到最新的展开集合，故用 ref 传递。
    const expandedRef = useRef(expanded);
    expandedRef.current = expanded;

    const loadRoot = useCallback(async () => {
      setLoading(true);
      setError("");
      try {
        const info = await treeApi.root();
        setRootInfo(info);
        setAttachDirState(typeof info.attachmentDir === "string" ? info.attachmentDir : "attachments");
        setAttachCfg({
          mode: typeof info.attachmentMode === "string" ? info.attachmentMode : "fixed",
          subfolder: typeof info.attachmentSubfolder === "string" ? info.attachmentSubfolder : "attachments",
          hideDir: info.hideAttachmentDir !== false,
          deleteOrphans: info.deleteOrphanAttachments === true,
        });
        if (!info.exists) {
          setDirs({});
          setExpanded(new Set());
          return;
        }
        const list = await treeApi.tree("");
        const next = { "": list.entries };
        // 刷新（⟳ / vaultRev）保留展开状态：把展开中的目录一并重取，否则每次刷新都
        // 把整棵树折叠回去，而已展开目录里显示的仍是刷新前的旧内容。
        const open = [...expandedRef.current];
        await Promise.all(open.map(async (rel) => {
          try {
            next[rel] = (await treeApi.tree(rel)).entries;
          } catch { /* 目录已消失：下面从展开集合里剔除 */ }
        }));
        setDirs(next);
        setExpanded(new Set(open.filter((rel) => next[rel] !== undefined)));
      } catch (e) {
        setError(String(e && e.message ? e.message : e));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      void loadRoot();
    }, [loadRoot, vaultRev]);

    const toggleDir = useCallback(async (rel) => {
      const willOpen = !expanded.has(rel);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) next.delete(rel);
        else next.add(rel);
        return next;
      });
      // 展开时一律重新拉取：目录内容可能被外部改动（DSH/代理写入、外部编辑器、
      // 同步工具）。只按 `dirs[rel] === undefined` 判缓存会漏掉一个要命的等价类 ——
      // **空数组也不算 undefined**，于是「曾经展开过一次的空目录」被永久钉死，
      // 之后再怎么折叠/展开都不再请求，新写进来的笔记永远不显示。
      if (willOpen) {
        try {
          const list = await treeApi.tree(rel);
          setDirs((d) => ({ ...d, [rel]: list.entries }));
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        }
      }
    }, [expanded]);

    const openNoteByRel = useCallback((rel, name) => {
      patchShared({ openNote: { rel, name } });
    }, []);

    // 「📚 笔记」行的笔记数徽标：统计已加载目录中的笔记
    useEffect(() => {
      let n = 0;
      for (const entries of Object.values(dirs)) {
        for (const entry of entries) {
          if (entry.type === "note") n += 1;
        }
      }
      if (n !== shared.noteCount) patchShared({ noteCount: n });
    }, [dirs]);

    useEffect(() => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
      const q = query.trim();
      if (q === "") {
        setResults([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      searchTimer.current = window.setTimeout(async () => {
        try {
          const r = await treeApi.search(q);
          setResults(r.results);
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setSearching(false);
        }
      }, 250);
    }, [query]);

    // 改附件位置/开关：写回设置后重载 root（重载会保留展开状态）
    const applyAttachSettings = useCallback(async (patch) => {
      try {
        await treeApi.setAttachSettings(patch);
        await loadRoot();
      } catch (e) {
        setError(String(e && e.message ? e.message : e));
      }
    }, [loadRoot]);

    const chooseVault = useCallback(async () => {
      if (!uiWorkspace || typeof uiWorkspace.pickDirectory !== "function") return;
      try {
        const picked = await uiWorkspace.pickDirectory();
        if (picked === null) return;
        await treeApi.setRoot(picked);
        patchShared({ vaultRev: shared.vaultRev + 1, openNote: null });
        showToast(`${t("vaultRoot")} → ${picked}`);
      } catch (e) {
        setError(String(e && e.message ? e.message : e));
      }
    }, [uiWorkspace, t]);

    const pasteVault = useCallback(async () => {
      const value = await askText(t("pasteVaultTitle"));
      if (value === null) return;
      try {
        await treeApi.setRoot(value.trim());
        patchShared({ vaultRev: shared.vaultRev + 1, openNote: null });
        showToast(`${t("vaultRoot")} → ${value.trim()}`);
      } catch (e) {
        setError(String(e && e.message ? e.message : e));
      }
    }, [t]);

    // 附件目录：手填相对路径 / 目录选择器（Vault 内，交由 host 换算）/ 清空回根
    const applyAttachDir = useCallback(async (value) => {
      const v = (value ?? "").trim();
      const current = typeof attachDir === "string" ? attachDir : "attachments";
      // 变更目录会迁移已有截图并更新笔记引用：确认后才执行
      if (v !== current) {
        const from = current === "" ? t("vaultRoot") : current;
        const to = v === "" ? t("vaultRoot") : v;
        if (!window.confirm(t("attachDirConfirm", { from, to }))) return;
      }
      try {
        const r = await treeApi.setAttachDir(v);
        setAttachDirState(typeof r.attachmentDir === "string" ? r.attachmentDir : "");
        setAttachOpen(false);
        patchShared({ vaultRev: shared.vaultRev + 1 });
        const moved = Array.isArray(r.moved) ? r.moved.length : 0;
        const notes = Array.isArray(r.notesUpdated) ? r.notesUpdated.length : 0;
        showToast(moved > 0 || notes > 0
          ? `${t("attachDir")} → ${(r.attachmentDir || "") === "" ? t("vaultRoot") : r.attachmentDir}（${t("migrated", { n: moved, m: notes })}）`
          : `${t("attachDir")} → ${(r.attachmentDir || "") === "" ? t("vaultRoot") : r.attachmentDir}`);
      } catch (e) {
        setError(String(e && e.message ? e.message : e));
      }
    }, [t, attachDir]);

    const pickAttachDir = useCallback(async () => {
      if (!uiWorkspace || typeof uiWorkspace.pickDirectory !== "function") return;
      try {
        const picked = await uiWorkspace.pickDirectory();
        if (picked === null) return;
        await applyAttachDir(picked);   // host 会做 Vault 内包含性校验并换算相对路径
      } catch (e) {
        setError(String(e && e.message ? e.message : e));
      }
    }, [uiWorkspace, applyAttachDir]);

    const newNote = useCallback(async (dirRel) => {
      const name = await askText(t("noteNamePrompt"));
      if (name === null || name.trim() === "") return;
      try {
        const created = await treeApi.newNote(dirRel, name.trim());
        patchShared({ vaultRev: shared.vaultRev + 1 });
        openNoteByRel(created.path, created.path.split("/").pop() ?? created.path);
      } catch (e) {
        setError(String(e && e.message ? e.message : e));
      }
    }, [t, openNoteByRel]);

    const newFolder = useCallback(async () => {
      const name = await askText(t("newFolderPrompt"));
      if (name === null || name.trim() === "") return;
      try {
        await treeApi.newFolder("", name.trim());
        patchShared({ vaultRev: shared.vaultRev + 1 });
      } catch (e) {
        setError(String(e && e.message ? e.message : e));
      }
    }, [t]);

    const deleteEntry = useCallback(async (rel, name, kind) => {
      const ok = kind === "dir"
        ? window.confirm(t("deleteFolderConfirm", { name }))
        : window.confirm(t("deleteNoteConfirm", { name }));
      if (!ok) return;
      try {
        await treeApi.deleteNote(rel);
        if (openNote && (openNote.rel === rel || openNote.rel.startsWith(rel + "/"))) patchShared({ openNote: null });
        patchShared({ vaultRev: shared.vaultRev + 1 });
        showToast(t("deleted"));
      } catch (e) {
        setError(String(e && e.message ? e.message : e));
      }
    }, [t, openNote]);

    // 附件位置的一行摘要（Obsidian 的四种位置模式）
    const attachLocationLabel = (cfg, dir, tt) => {
      if (cfg === null) return dir === "" ? tt("vaultRoot") : dir;
      if (cfg.mode === "root") return tt("attachMode_root");
      if (cfg.mode === "note") return tt("attachMode_note");
      if (cfg.mode === "sub") return `${tt("attachMode_note")} / ${cfg.subfolder}`;
      return dir === "" ? tt("vaultRoot") : dir;
    };

    const renderEntries = (rel, depth) => {
      const entries = dirs[rel] ?? [];
      return entries.map((entry) => {
        const childRel = joinRel(rel, entry.name);
        if (entry.type === "dir") {
          const isOpen = expanded.has(childRel);
          return createElement(Fragment, { key: childRel },
            createElement("div", {
              className: "dsh-obs-row",
              style: { paddingLeft: `${6 + depth * 14}px` },
              onClick: () => void toggleDir(childRel),
            },
              createElement("span", { className: "dsh-obs-chev" }, isOpen ? "▾" : "▸"),
              createElement("span", { className: "dsh-obs-name", style: { flex: "none" } }, isOpen ? "📂" : "📁"),
              createElement("span", { className: "dsh-obs-name" }, entry.name),
              createElement("button", {
                className: "dsh-obs-mini",
                title: t("newNote"),
                onClick: (e) => { e.stopPropagation(); void newNote(childRel); },
              }, "＋"),
              createElement("button", {
                className: "dsh-obs-mini",
                title: t("delete"),
                onClick: (e) => { e.stopPropagation(); void deleteEntry(childRel, entry.name, "dir"); },
              }, "🗑"),
            ),
            isOpen && createElement("div", null, renderEntries(childRel, depth + 1)),
          );
        }
        const selected = openNote && openNote.rel === childRel;
        return createElement("div", {
          key: childRel,
          className: `dsh-obs-row${selected ? " dsh-obs-selected" : ""}`,
          style: { paddingLeft: `${6 + depth * 14}px` },
          onClick: () => openNoteByRel(childRel, entry.name),
        },
          createElement("span", { className: "dsh-obs-chev" }, "📝"),
          createElement("span", { className: "dsh-obs-name" }, entry.name),
          createElement("span", { className: "dsh-obs-size" }, formatSize(entry.size)),
          createElement("button", {
            className: "dsh-obs-mini",
            title: t("delete"),
            onClick: (e) => { e.stopPropagation(); void deleteEntry(childRel, entry.name, "note"); },
          }, "🗑"),
        );
      });
    };

    let body;
    if (rootInfo === null) {
      body = createElement("div", { className: "dsh-obs-empty" }, t("loading"));
    } else if (!rootInfo.exists) {
      body = createElement("div", { className: "dsh-obs-empty" },
        createElement("div", null, t("noVault")),
        createElement("div", { style: { fontSize: 11 } }, rootInfo.root),
        createElement("button", { onClick: () => void chooseVault() }, t("pickVault")),
      );
    } else if (query.trim() !== "") {
      body = searching
        ? createElement("div", { className: "dsh-obs-empty" }, t("loading"))
        : results.length === 0
          ? createElement("div", { className: "dsh-obs-empty" }, t("empty"))
          : createElement("div", { className: "dsh-obs-body" },
            results.map((r) => createElement("div", {
              key: r.path,
              className: "dsh-obs-row",
              onClick: () => openNoteByRel(r.path, r.name),
            },
              createElement("span", { className: "dsh-obs-chev" }, "📝"),
              createElement("div", { style: { flex: 1, minWidth: 0 } },
                createElement("div", { className: "dsh-obs-name" }, r.name),
                r.matchedAlias !== undefined && r.matchedAlias !== null && r.matchedAlias !== ""
                  && createElement("div", { className: "dsh-obs-snippet" }, `${t("matchedAlias")}：${r.matchedAlias}`),
                r.snippet !== "" && createElement("div", { className: "dsh-obs-snippet" }, r.snippet),
              ),
            )),
          );
    } else if (Object.keys(dirs).length === 0) {
      body = createElement("div", { className: "dsh-obs-empty" }, loading ? t("loading") : t("empty"));
    } else {
      body = createElement("div", { className: "dsh-obs-body" },
        (dirs[""] ?? []).length === 0 && createElement("div", { className: "dsh-obs-empty" }, t("empty")),
        renderEntries("", 0),
      );
    }

    return createElement("div", { className: "dsh-obs-tree" },
      createElement("div", { className: "dsh-obs-tree-head" },
        // 目录选择器由 uiWorkspace 提供：ctx.workspaces 上没有 pickDirectory
        uiWorkspace && createElement("button", { title: t("pickVaultTitle"), onClick: () => void chooseVault() }, "📂"),
        uiWorkspace && createElement("button", { title: t("pasteVaultTitle"), onClick: () => void pasteVault() }, "📋"),
        createElement("button", { title: t("newFolder"), onClick: () => void newFolder() }, "📁"),
        createElement("button", { title: t("refresh"), onClick: () => void loadRoot() }, "⟳"),
        createElement("button", {
          title: t("search"),
          className: searchOpen ? "dsh-obs-on" : "",
          onClick: () => { setSearchOpen((v) => !v); setQuery(""); },
        }, "🔍"),
        createElement("button", { title: t("collapse"), onClick: () => patchShared({ notesOpen: false }) }, "✕"),
      ),
      searchOpen && createElement("div", { className: "dsh-obs-search" },
        createElement("input", {
          autoFocus: true,
          placeholder: t("searchPlaceholder"),
          value: query,
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Escape") { setSearchOpen(false); setQuery(""); }
          },
        }),
      ),
      rootInfo && rootInfo.exists && createElement("div", { className: "dsh-obs-root-row", title: rootInfo.root },
        createElement("span", { className: "dsh-obs-root-path" }, rootInfo.root),
        createElement("button", {
          className: "dsh-obs-mini",
          title: t("newNote"),
          onClick: (e) => { e.stopPropagation(); void newNote(""); },
        }, "＋"),
      ),
      rootInfo && rootInfo.exists && attachDir !== null && createElement("div", { className: "dsh-obs-root-row", title: t("attachSettings") },
        createElement("span", { className: "dsh-obs-root-path" },
          `📎 ${t("attachLocation")}: ${attachLocationLabel(attachCfg, attachDir, t)}`),
        attachCfg !== null && attachCfg.mode === "fixed" && createElement("button", {
          className: "dsh-obs-mini",
          title: t("attachDirPick"),
          onClick: (e) => { e.stopPropagation(); void pickAttachDir(); },
        }, "📂"),
        attachCfg !== null && attachCfg.mode === "fixed" && createElement("button", {
          className: "dsh-obs-mini",
          title: t("attachDirEdit"),
          onClick: (e) => { e.stopPropagation(); setAttachInput(attachDir); setAttachOpen((v) => !v); },
        }, "✎"),
        createElement("button", {
          className: "dsh-obs-mini",
          title: t("attachSettings"),
          onClick: (e) => { e.stopPropagation(); setAttachOpen((v) => !v); },
        }, "⚙"),
      ),
      // 附件设置面板：位置模式（Obsidian 的四种）+ 子目录名 + 两个开关
      attachOpen && rootInfo && rootInfo.exists && attachCfg !== null && createElement("div", { className: "dsh-obs-attachcfg" },
        ...["root", "fixed", "note", "sub"].map((m) => createElement("button", {
          key: m,
          className: `dsh-obs-mini${attachCfg.mode === m ? " dsh-obs-on" : ""}`,
          title: t(`attachMode_${m}`),
          onClick: (e) => { e.stopPropagation(); void applyAttachSettings({ mode: m }); },
        }, t(`attachMode_${m}`))),
        attachCfg.mode === "fixed" && createElement("input", {
          autoFocus: true,
          placeholder: t("attachDirPlaceholder"),
          value: attachInput,
          onChange: (e) => setAttachInput(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter") void applyAttachDir(attachInput);
            if (e.key === "Escape") setAttachOpen(false);
          },
        }),
        attachCfg.mode === "sub" && createElement("input", {
          placeholder: t("attachSubfolder"),
          defaultValue: attachCfg.subfolder,
          onKeyDown: (e) => { if (e.key === "Enter") void applyAttachSettings({ subfolder: e.target.value }); },
        }),
        createElement("label", { className: "dsh-obs-cfgline" },
          createElement("input", {
            type: "checkbox",
            checked: attachCfg.hideDir,
            onChange: (e) => { e.stopPropagation(); void applyAttachSettings({ hideAttachmentDir: e.target.checked === true }); },
          }),
          t("attachHideDir"),
        ),
        createElement("label", { className: "dsh-obs-cfgline" },
          createElement("input", {
            type: "checkbox",
            checked: attachCfg.deleteOrphans,
            onChange: (e) => { e.stopPropagation(); void applyAttachSettings({ deleteOrphanAttachments: e.target.checked === true }); },
          }),
          t("attachDeleteOrphans"),
        ),
      ),
      body,
      error !== "" && createElement("div", { className: "dsh-obs-error" }, error),
    );
  }

  // ── 常驻 WorkspaceSidebar（sidebar.workspaces 接管）─────────────────────────
  // `phase: "pending"` 必须与真实 Store 的初始快照一致（`@deepseek-ai/
  // dsh-api-session-controller` 的 `createSnapshotStore({ ids: [], byId: {},
  // phase: "pending" })`）：这就是「列表还没到」的判据，墓碑 GC 靠它避免把
  // 「还没有数据」误读成「Host 不再列出这些会话」。
  const EMPTY_SESSIONS = { ids: [], byId: {}, current: undefined, phase: "pending" };
  const EMPTY_WORKSPACES = { items: [], archivedSessionIds: [], state: "ready", phase: "ready", error: null, baselinesReady: true, recentWorkspaceId: undefined };
  const UNGROUPED_KEY = "";

  function WorkspaceSidebar({ wide, expandSidebar, useSessions, useWorkspaces, workspaces, sessions, uiWorkspace, t }) {
    const { notesOpen, noteCount } = useShared();
    const sessionsState = typeof useSessions === "function" ? useSessions((s) => s) : EMPTY_SESSIONS;
    const wsState = typeof useWorkspaces === "function" ? useWorkspaces((s) => s) : EMPTY_WORKSPACES;

    const items = wsState.items ?? [];
    const archived = useMemo(() => new Set(wsState.archivedSessionIds ?? []), [wsState.archivedSessionIds]);
    const byId = sessionsState.byId ?? {};
    const ids = sessionsState.ids ?? [];
    // 当前会话：DSH 0.1.7 起列表快照**不再有 `current`**（0.1.5 有）。
    // 新版判据同官方 `mainSessionId(list)`：被主视图持有的那一行
    // （`retainedBy.mainView > 0`）。缺了它，选中高亮、跟随当前会话展开分组
    // 都会失效。
    const current = sessionsState.current
      ?? Object.values(byId).find((s) => (s.retainedBy?.mainView ?? 0) > 0)?.id;

    // 已彻底删除、但 Host 进程仍持有内存副本的会话 id（见 readPurgedIds）。
    const [purged, setPurged] = useState(readPurgedIds);

    // 会话列表快照是否「可作证据」。
    //
    // **墓碑 GC 的前置条件**：DSH 的 ClientSessions 初始快照就是
    // `{ ids: [], byId: {}, phase: "pending" }`（见 @deepseek-ai/
    // dsh-api-session-controller 的 createSnapshotStore）。页面刷新时组件先挂载、
    // 列表后到；若此时跑 GC，`byId` 是空的，每个墓碑都会被判成「Host 不再列出」
    // 而被清掉 —— 而 Host 进程里的内存副本还在，列表一到，已删的行立刻复活：
    // 「不重启 dsh web，只刷新页面，删过的记录又出现了」。所以列表没到位之前
    // 一律不动墓碑。
    //
    // 除了 `phase === "ready"`，还要求快照里**至少有一行**：Host 的第一次成功
    // 拉取本身可能就是空列表（phase 已到 "ready" 但确实一行都没有），空快照同样
    // 不能用来证明「Host 不再列出某个 id」。代价只是「一个会话都没有」时墓碑多留
    // 一会儿（那会儿本来也没有行可显示），而它换来的是刷新后不复活。
    const sessionsReady = ids.length > 0
      && (sessionsState.phase === "ready" || sessionsState.phase === undefined);

    // Host 不再列出某个 id（重启后内存副本随进程消失，或它本来就是冷会话）→ 摘掉
    // 墓碑，避免无限增长。已删会话若仍被列出，正是「内存副本还在」，继续隐藏。
    useEffect(() => {
      if (!sessionsReady) return;
      setPurged((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set();
        for (const id of prev) if (byId[id] !== undefined) next.add(id);
        if (next.size === prev.size) return prev;
        writePurgedIds(next);
        return next;
      });
    }, [byId, sessionsReady]);

    const visibleSession = (sid) => {
      const s = byId[sid];
      if (!s || archived.has(sid)) return false;
      // 已彻底删除：日志没了，Host 只是还持有内存副本。必须自己隐藏，否则用户
      // 看到「提示删除成功、行还在」。
      if (purged.has(sid)) return false;
      // 子代理会话不列入列表：与官方 @deepseek-ai/dsh-client-ui-workspace 的
      // sessionVisible 一致（`session.origin !== "subagent"`）。子代理不是用户
      // 会话，官方只把它们呈现在父会话行的「N 个子代理运行中」状态与正文
      // 血缘面包屑里；列成顶层会话会让人误以为是自己的对话。
      if (s.origin === "subagent") return false;
      // 空白会话不列入列表（新建会话的占位：host 侧 title 为工作区 basename，
      // 直接显示会像一条与工作区同名的「会话记录」）；有内容后才显示。
      // 当前空白会话同样不列出 —— 新建会话的可见反馈由主区的新会话空态页
      // （「探索未至之境」）承担，侧边栏保持干净。
      if (s.blank) return false;
      return true;
    };

    // 分组：工作区 sessionIds 账户为主，cwd === path 兜底；其余入「未分组」
    const groups = useMemo(() => {
      const accounted = new Set();
      const list = [];
      for (const w of items) {
        const wsIds = [];
        for (const sid of (w.sessionIds ?? [])) {
          if (!visibleSession(sid)) continue;
          wsIds.push(sid);
          accounted.add(sid);
        }
        for (const sid of ids) {
          if (accounted.has(sid)) continue;
          const s = byId[sid];
          if (s && s.cwd === w.path && visibleSession(sid)) {
            wsIds.push(sid);
            accounted.add(sid);
          }
        }
        list.push({ key: w.workspaceId, workspace: w, sessionIds: wsIds });
      }
      const ungrouped = ids
        .filter((sid) => !accounted.has(sid) && visibleSession(sid))
        .sort((a, b) => (byId[b].updatedAt ?? 0) - (byId[a].updatedAt ?? 0));
      return { list, ungrouped };
    }, [items, ids, byId, archived, current, purged]); // eslint-disable-line react-hooks/exhaustive-deps

    // 运行中的子代理计数（同官方 subagent-lineage 的 indexSubagentDescendants）：
    // 沿 parentId 链把每个运行中的子代理累加到它的每一级祖先，父会话行据此
    // 显示「N 个子代理运行中」—— 子代理不单独成行，活动状态挂在父行上。
    const runningSubagents = useMemo(() => {
      const counts = new Map();
      for (const s of Object.values(byId)) {
        if (s.origin !== "subagent" || s.running !== true) continue;
        const seen = new Set();
        let node = s;
        while (node && node.origin === "subagent" && node.parentId !== undefined && !seen.has(node.id)) {
          seen.add(node.id);
          counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1);
          node = byId[node.parentId];
        }
      }
      return counts;
    }, [byId]);

    // 展开状态：默认展开当前会话所在工作区（未分组时展开未分组组），其余收起
    const [expanded, setExpanded] = useState(() => {
      const initial = new Set();
      if (current !== undefined && byId[current] !== undefined) {
        const w = items.find((x) => (x.sessionIds ?? []).includes(current) || byId[current].cwd === x.path);
        if (w) initial.add(w.workspaceId);
        else initial.add(UNGROUPED_KEY);
      }
      return initial;
    });

    useEffect(() => {
      if (current === undefined || byId[current] === undefined) return;
      const w = items.find((x) => (x.sessionIds ?? []).includes(current) || byId[current].cwd === x.path);
      const key = w ? w.workspaceId : UNGROUPED_KEY;
      setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    }, [current, items]); // eslint-disable-line react-hooks/exhaustive-deps

    const toggleGroup = useCallback((key) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    }, []);

    // 会话搜索（前端过滤 displayTitle/title）
    const [searchOpen, setSearchOpen] = useState(false);
    const [query, setQuery] = useState("");
    const q = query.trim().toLowerCase();
    const matched = useMemo(() => {
      if (q === "") return [];
      return ids
        .filter((sid) => {
          if (!visibleSession(sid)) return false;
          const s = byId[sid];
          const title = (s.title ?? "").toLowerCase();
          const display = (s.displayTitle ?? "").toLowerCase();
          return title.includes(q) || display.includes(q);
        })
        .sort((a, b) => (byId[b].updatedAt ?? 0) - (byId[a].updatedAt ?? 0));
    }, [ids, byId, archived, q, current, purged]);

    // ── 批量操作 ──────────────────────────────────────────────────────────────
    // 两种互斥的批量模式，范围由产品约定钉死：
    //   { kind: "workspaces" }      标题行按钮进入：勾选多个工作区 → 批量删除
    //   { kind: "sessions", key }   工作区行按钮进入：只勾选该工作区的会话 →
    //                               批量归档 / 批量彻底删除
    // 批量模式与搜索互斥（进入批量时收起搜索），避免搜索结果里出现没有勾选框的行。
    const [batch, setBatch] = useState(null);
    const [picked, setPicked] = useState(() => new Set());
    // 可勾选对象：工作区模式=真实工作区（「未分组」不是工作区，不可删）；
    // 会话模式=目标工作区当前可见的会话（分组结果已过滤归档/子代理/空白）。
    const batchCandidates = batch === null
      ? []
      : batch.kind === "workspaces"
        ? items.map((w) => w.workspaceId)
        : (groups.list.find((g) => g.key === batch.key) ?? { sessionIds: [] }).sessionIds;
    // 每帧按当前候选集过滤勾选：被归档/删除/移出分组的行不会留下幽灵勾选。
    const pickedList = batchCandidates.filter((id) => picked.has(id));

    const addWorkspace = useCallback(async () => {
      if (!workspaces || typeof workspaces.create !== "function") return;
      try {
        const picked = typeof uiWorkspace.pickDirectory === "function" ? await uiWorkspace.pickDirectory() : null;
        if (picked === null || picked === "") return;
        const view = await workspaces.create({ path: picked });
        if (view && view.workspaceId !== undefined) {
          setExpanded((prev) => (prev.has(view.workspaceId) ? prev : new Set(prev).add(view.workspaceId)));
          uiWorkspace.startSession(view.workspaceId, (e) => {
            showToast(`${t("error")}：${e && e.message ? e.message : e}`);
          });
        }
      } catch (e) {
        showToast(`${t("error")}：${e && e.message ? e.message : e}`);
      }
    }, [workspaces, uiWorkspace, t]);

    // 工作区行的「＋」：新建（或复用该工作区的空白）会话并打开。
    // 必须走 ctx.uiWorkspace —— ctx.workspaces 上没有 startSession，
    // 早期版本用 typeof 守卫直接 return，表现为「点＋毫无反应」。
    const startSession = useCallback((workspaceId) => {
      setExpanded((prev) => (prev.has(workspaceId) ? prev : new Set(prev).add(workspaceId)));
      uiWorkspace.startSession(workspaceId, (e) => {
        showToast(`${t("error")}：${e && e.message ? e.message : e}`);
      });
    }, [uiWorkspace, t]);

    // 打开会话：必须走 ctx.uiWorkspace.openSession（0.1.7+），
    // `ctx.sessions.open` 只在对旧版（0.1.5 及更早）兜底时才有意义。
    const openSession = useCallback((sid) => {
      // 没有可用通路、或官方因陈旧 id 抛错时都必须报出来：
      // 静默 no-op 正是这次桌面版事故的形态。
      uiWorkspace.openSession(sid, (error) => {
        showToast(`${t("error")}：${error && error.message ? error.message : t("openUnavailable")}`);
      });
    }, [uiWorkspace, t]);

    // ── 重命名 ────────────────────────────────────────────────────────────────
    // Electron（桌面版）的 window.prompt 直接抛 `prompt() is not supported.`，
    // 所以两个重命名都走应用内输入卡片（askText），web / 桌面版行为一致。
    const renameWorkspace = useCallback(async (workspaceId, currentTitle) => {
      if (!workspaces || typeof workspaces.rename !== "function") return;
      const name = await askText(t("renameWorkspacePrompt"), currentTitle);
      if (name === null || name.trim() === "" || name.trim() === currentTitle) return;
      try {
        await workspaces.rename(workspaceId, name.trim());
        showToast(t("renamed"));
      } catch (e) {
        showToast(`${t("error")}：${e && e.message ? e.message : e}`);
      }
    }, [workspaces, t]);

    const renameSession = useCallback(async (sid, currentTitle) => {
      if (!sessions || typeof sessions.binding !== "function") return;
      const binding = sessions.binding(sid);
      if (!binding || !binding.session || typeof binding.session.rename !== "function") {
        showToast(`${t("error")}：${t("noSessions")}`);
        return;
      }
      const name = await askText(t("renameSessionPrompt"), currentTitle);
      if (name === null || name.trim() === "" || name.trim() === currentTitle) return;
      try {
        const result = await binding.session.rename(name.trim());
        if (!result.ok) throw new Error(result && result.error && result.error.message ? result.error.message : "rename failed");
        showToast(t("renamed"));
      } catch (e) {
        showToast(`${t("error")}：${e && e.message ? e.message : e}`);
      }
    }, [sessions, t]);

    // 删除成功后必须让 Host 重新下发权威会话列表（ctx.sessions.refresh）。
    // 不刷新的话被删的会话仍留在前端列表里，甚至还能从客户端缓存打开它的
    // 记录 —— 表现为「删了还在、而且还有聊天记录」，与「彻底删除」矛盾。
    const refreshSessions = useCallback(async () => {
      if (sessions && typeof sessions.refresh === "function") {
        try {
          await sessions.refresh();
        } catch {
          // 列表刷新失败不影响删除本身的结果，下次刷新会自然纠正。
        }
      }
    }, [sessions]);

    // 把彻底删除的失败原因翻成用户可行动的提示：接口不存在 ≠ 会话不存在。
    const reportDeleteFailure = useCallback((error) => {
      const status = error && error.status;
      if (status === 404 || status === 405 || status === 501) {
        showToast(t("sessionDeleteUnavailable"));
        return;
      }
      if (status === 409) {
        showToast(t("sessionRunning"));
        return;
      }
      if (status === 503) {
        showToast(t("sessionLivenessUnavailable"));
        return;
      }
      showToast(`${t("error")}：${error && error.message ? error.message : error}`);
    }, [t]);

    // 记录「已彻底删除」：隐藏对应行（Host 可能仍持有内存副本，列表不会自己去掉），
    // 并在删掉的是当前正在查看的会话时把主视图切走 —— 否则用户还盯着一条日志已经
    // 不存在的会话。
    const forgetDeleted = useCallback((deletedIds) => {
      if (deletedIds.length === 0) return;
      setPurged((prev) => {
        const next = new Set(prev);
        for (const id of deletedIds) next.add(id);
        writePurgedIds(next);
        return next;
      });
    }, []);

    /**
     * 成功删掉当前会话后换一个会话打开。
     * 只换到「还在的、可见的」最近一个会话；一个都不剩时不强开新会话（新建会话是
     * 用户的决定，不是删除的副作用）。
     * @param gone - 本次删掉的 id。
     */
    const leaveDeletedCurrent = useCallback((gone) => {
      if (current === undefined || !gone.has(current)) return;
      const next = ids.find((id) => !gone.has(id) && visibleSession(id));
      if (next !== undefined) uiWorkspace.openSession(next);
    }, [current, ids, byId, purged, archived, uiWorkspace]); // eslint-disable-line react-hooks/exhaustive-deps

    /**
     * 删除成功后的统一收尾：隐藏已删行、必要时切走主视图、报出结果。
     *
     * 先反馈再刷新：刷新是「让列表跟上」，不是删除成功的前提 —— 反过来的话，
     * 一次挂起/失败的 refresh 会让用户看不到任何成功反馈，而日志其实已经删了。
     *
     * `missing`（Host 报「磁盘上本来就没有这个会话目录」）必须与 `deleted` 同等
     * 对待：两者都证明这条会话在磁盘上已经不存在，行只可能靠 Host 进程里的内存
     * 副本撑着。只把 `deleted` 当成功，用户重删一条历史遗留记录时看到的就是
     * 「行还在 → 点删除 → 没有找到可删除的会话 → 行还在」的死循环。
     * @param result - host 响应（用 `attached` 说明哪些仍被进程持有内存副本）。
     * @param deleted - 确认从磁盘删掉的 id。
     * @param missing - Host 报「磁盘上本就没有日志」的 id（同样隐藏）。
     * @param failed - host 报失败的条目。
     */
    const reportDeleteSuccess = useCallback((result, deleted, missing, failed) => {
      const attached = result && Array.isArray(result.attached) ? result.attached : [];
      const gone = [...deleted, ...missing];
      forgetDeleted(gone);
      leaveDeletedCurrent(new Set(gone));
      let message = deleted.length > 0
        ? (failed.length > 0
          ? t("deletedPermanentlyPartial", { n: deleted.length, m: failed.length })
          : t("deletedPermanently", { n: deleted.length }))
        // 一条都没删掉、但 Host 确认磁盘上早就没有日志：报「已移除失效记录」，
        // 不报「已彻底删除 0 个」，更不能报「没有找到可删除的会话」。
        : t("staleSessionsRemoved", { n: missing.length });
      if (deleted.length > 0 && missing.length > 0) {
        message += t("deletedPermanentlyMissingSuffix", { m: missing.length });
      }
      if (deleted.length === 0 && failed.length > 0) {
        message += t("deletedPermanentlyFailedSuffix", { m: failed.length });
      }
      if (attached.length > 0) message += t("deletedPermanentlyStickySuffix", { m: attached.length });
      showToast(message);
    }, [forgetDeleted, leaveDeletedCurrent, t]);

    /**
     * 只读僵死行探测的缓存：`answered` 记「已拿到 Host 权威答复（且不在跑）」的 id，
     * `pending` 记正在飞的请求 key —— 每个 id 只问一次，列表每次变动不会重复探测。
     */
    const staleProbe = useRef({ answered: new Set(), pending: "" });

    /**
     * 僵死行自愈（只读探测，绝不删除）。
     *
     * 本地墓碑（PURGED_IDS_KEY）只能记住「本浏览器、装了这个墓碑机制之后」删掉的
     * 会话；更早删的（或换个浏览器/桌面版删的）没有任何墓碑，而行会一直列在侧边
     * 栏里，直到 DSH 进程重启 —— 这就是「以前点了删除的记录还在前端显示，再点
     * 删除却说没有可删除的会话」。
     *
     * 所以这里直接问 Host：列表里仍在、磁盘上已无 durable 日志、且不在运行的会话
     * 一律隐藏。Host 侧用 `sessionQuery.listSessions()` 的 `persisted` 标记判定
     * （与 DSH 自己的列表同源，不依赖本插件镜像的路径布局），服务缺失/探测失败时
     * 返回 `available: false`，这边就什么都不做 —— 只读优化不该有误隐藏的风险。
     */
    useEffect(() => {
      if (!sessionsReady) return;
      const ask = ids.filter((sid) => {
        if (staleProbe.current.answered.has(sid)) return false;   // 已问过，答案权威
        if (purged.has(sid)) return false;                       // 已隐藏，无需再问
        const s = byId[sid];
        // 在跑、空白会话不参与：在跑的会话可能还没落盘，隐藏它属于误伤。
        if (s === undefined || s.running === true || s.blank === true) return false;
        return visibleSession(sid);
      });
      if (ask.length === 0) return;
      const key = [...ask].sort().join(",");
      if (staleProbe.current.pending === key) return;
      staleProbe.current.pending = key;
      treeApi.sessionState(ask).then((result) => {
        staleProbe.current.pending = "";
        const items = result && Array.isArray(result.items) ? result.items : [];
        if (!result || result.available !== true) return;
        const stale = [];
        for (const it of items) {
          if (!it || typeof it.id !== "string" || it.known !== true) continue;
          // 判不准 / 在跑：不缓存，等它不跑了再问一次（行状态变化会重新触发本效应）。
          if (it.running === true) continue;
          staleProbe.current.answered.add(it.id);
          if (it.persisted !== true) stale.push(it.id);
        }
        if (stale.length === 0) return;
        forgetDeleted(stale);
        leaveDeletedCurrent(new Set(stale));
        showToast(t("staleSessionsRemoved", { n: stale.length }));
      }, () => {
        // 旧 Host 没有这条路由（404）或网络失败：清掉 pending，下次列表变动再试。
        staleProbe.current.pending = "";
      });
    }, [ids, byId, purged, archived, sessionsReady, forgetDeleted, leaveDeletedCurrent, t]); // eslint-disable-line react-hooks/exhaustive-deps
    /**
     * 工作区删除 = 注册项 + **其中全部会话**一起彻底删除。
     *
     * 产品约定（本轮需求）：删除工作区时把它里面的会话一并在磁盘上删掉；
     * 这是不可恢复的破坏性操作，所以确认框必须写清会话数量。
     *
     * 顺序必须是「先删会话、再删工作区」：反过来的话 `workspaces.delete` 会先把
     * 会话移入「未分组」，失去归属后就没法再按工作区定位它们了。会话没能全部
     * 删成功时**不删工作区**（fail closed），否则会留下一堆无主会话。
     *
     * @param workspaceId - 工作区 id。
     * @param title - 工作区标题（确认框用）。
     * @param sessionIds - 该工作区当前可见的会话 id（父+子代理闭包在此展开）。
     */
    const deleteWorkspace = async (workspaceId, title, sessionIds = []) => {
      if (!workspaces || typeof workspaces.delete !== "function") return;
      const all = new Set();
      for (const sid of sessionIds) for (const id of sessionClosure(sid, byId)) all.add(id);
      const confirmText = all.size === 0
        ? t("deleteWorkspaceConfirm", { name: title })
        : t("deleteWorkspaceSessionsConfirm", { name: title, n: all.size });
      if (!window.confirm(confirmText)) return;
      let deleted = [];
      if (all.size > 0) {
        let result;
        try {
          result = await treeApi.deleteSessions([...all]);
        } catch (e) {
          // 会话没删掉 → 工作区也不删，避免会话被移入「未分组」。
          reportDeleteFailure(e);
          return;
        }
        deleted = result && Array.isArray(result.deleted) ? result.deleted : [];
        const missing = result && Array.isArray(result.missing) ? result.missing : [];
        const failed = result && Array.isArray(result.failed) ? result.failed : [];
        // missing = 磁盘上早就没有日志：和 deleted 一样证明会话已不存在，同样隐藏/计数
        deleted = [...deleted, ...missing];
        if (deleted.length < all.size) {
          if (deleted.length > 0) {
            forgetDeleted(deleted);
            void refreshSessions();
          }
          showToast(failed.length > 0 ? `${t("error")}：${failed[0].error}` : t("deleteWorkspaceSessionsFailed"));
          return;
        }
      }
      try {
        await workspaces.delete(workspaceId);
        if (deleted.length > 0) {
          forgetDeleted(deleted);
          void refreshSessions();
          showToast(t("deletedWorkspaceWithSessions", { name: title, n: deleted.length }));
          return;
        }
        showToast(t("deleted"));
      } catch (e) {
        showToast(`${t("error")}：${e && e.message ? e.message : e}`);
      }
    };

    // 会话「归档」= 平台归档语义（移出列表，日志保留，官方浏览器同款行为）
    const archiveSession = useCallback(async (sid, title) => {
      if (!workspaces || typeof workspaces.archiveSession !== "function") return;
      if (!window.confirm(t("archiveSessionConfirm", { name: title }))) return;
      try {
        await workspaces.archiveSession(sid);
        showToast(t("archived"));
      } catch (e) {
        showToast(`${t("error")}：${e && e.message ? e.message : e}`);
      }
    }, [workspaces, t]);

    // 会话「彻底删除」= 删除磁盘日志（host /obsidian/session-delete）。
    // 与归档相反且不可恢复，所以：**正在运行的**会话由 Host 拒绝（含闭包内正在跑的
    // 子代理）；父会话连同其全部子代理日志一起删；确认框里写清子会话数量与被删的
    // 东西。
    //
    // 活性判定**只在 Host 侧做**，前端不本地预判。原因：前端快照里的 `running`
    // 会停旧 —— 子代理跑完时的 idle 转换不一定推给前端，缓存里那条子代理会一直
    // 显示「运行中」。用它当硬闸门会让「子代理明明已结束」的会话永远删不掉，而且
    // 前端根本不发请求，Host 的权威判定永远没机会纠正它。Host 侧的判据是
    // `agents.get(id)?.status === "running"`（per-turn：空闲即 idle），判不准时
    // fail closed，所以放行请求不会牺牲安全性。
    const deleteSession = useCallback(async (sid, title) => {
      const ids = [...sessionClosure(sid, byId)];
      const subs = ids.length - 1;
      const caveat = subs > 0 ? t("deleteSessionMore", { n: subs }) : "";
      if (!window.confirm(t("deleteSessionConfirm", { name: title, caveat }))) return;
      try {
        const result = await treeApi.deleteSessions(ids);
        const deleted = result && Array.isArray(result.deleted) ? result.deleted : [];
        const missing = result && Array.isArray(result.missing) ? result.missing : [];
        const failed = result && Array.isArray(result.failed) ? result.failed : [];
        if (deleted.length === 0 && missing.length === 0) {
          // 区分「确实没找到日志」与「host 报了失败」：后者需要让人看到原因。
          if (failed.length > 0) {
            showToast(`${t("error")}：${failed[0].error}`);
            return;
          }
          showToast(t("nothingDeleted"));
          return;
        }
        reportDeleteSuccess(result, deleted, missing, failed);
        void refreshSessions();
      } catch (e) {
        reportDeleteFailure(e);
      }
    }, [byId, refreshSessions, reportDeleteFailure, reportDeleteSuccess, t]);

    // 「未分组」整组归档 / 整组彻底删除（两者共用父+子代理闭包）
    const archiveUngrouped = useCallback(async (sessionIds, name) => {
      if (!workspaces || typeof workspaces.archiveSession !== "function") return;
      if (sessionIds.length === 0) return;
      if (!window.confirm(t("archiveUngroupedConfirm", { n: sessionIds.length, name }))) return;
      try {
        await Promise.all(sessionIds.map((sid) => workspaces.archiveSession(sid)));
        showToast(t("archived"));
      } catch (e) {
        showToast(`${t("error")}：${e && e.message ? e.message : e}`);
      }
    }, [workspaces, t]);

    const deleteUngrouped = useCallback(async (sessionIds, name) => {
      if (sessionIds.length === 0) return;
      const all = new Set();
      for (const sid of sessionIds) for (const id of sessionClosure(sid, byId)) all.add(id);
      // 同上：不在前端预判「在跑」，交给 Host 的权威判定（前端快照会停旧）。
      if (!window.confirm(t("deleteUngroupedConfirm", { n: all.size, name }))) return;
      try {
        const result = await treeApi.deleteSessions([...all]);
        const deleted = result && Array.isArray(result.deleted) ? result.deleted : [];
        const missing = result && Array.isArray(result.missing) ? result.missing : [];
        const failed = result && Array.isArray(result.failed) ? result.failed : [];
        if (deleted.length === 0 && missing.length === 0) {
          if (failed.length > 0) {
            showToast(`${t("error")}：${failed[0].error}`);
            return;
          }
          showToast(t("nothingDeleted"));
          return;
        }
        reportDeleteSuccess(result, deleted, missing, failed);
        void refreshSessions();
      } catch (e) {
        reportDeleteFailure(e);
      }
    }, [byId, refreshSessions, reportDeleteFailure, reportDeleteSuccess, t]);

    // ── 批量操作处理 ──────────────────────────────────────────────────────────
    const enterWorkspaceBatch = () => {
      setSearchOpen(false);
      setQuery("");
      setBatch({ kind: "workspaces" });
      setPicked(new Set());
    };

    const enterSessionBatch = (key) => {
      setSearchOpen(false);
      setQuery("");
      setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
      setBatch({ kind: "sessions", key });
      setPicked(new Set());
    };

    const exitBatch = () => {
      setBatch(null);
      setPicked(new Set());
    };

    const togglePicked = (id) => {
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    };

    const selectAllPicked = () => setPicked(new Set(batchCandidates));
    const invertPicked = () => setPicked(new Set(batchCandidates.filter((id) => !picked.has(id))));
    const clearPicked = () => setPicked(new Set());

    // 批量归档：一次确认，逐个走平台归档（ctx.workspaces.archiveSession）。
    // 单个失败不影响其余；提示里报成功/失败数量。
    const archivePicked = async () => {
      const list = [...pickedList];
      if (list.length === 0) return;
      if (!workspaces || typeof workspaces.archiveSession !== "function") return;
      if (!window.confirm(t("archivePickedConfirm", { n: list.length }))) return;
      const results = await Promise.allSettled(list.map((sid) => workspaces.archiveSession(sid)));
      const failed = results.filter((r) => r.status === "rejected").length;
      setPicked(new Set());
      showToast(failed === 0
        ? t("archivedPicked", { n: list.length })
        : t("archivedPickedPartial", { n: list.length - failed, m: failed }));
    };

    // 批量彻底删除：与单条/整组删除走同一条 host 路由，一次把全部 id 送过去
    // （父会话连同子代理闭包；正在运行的由 Host 权威判定拒绝）。
    const deletePicked = async () => {
      const list = [...pickedList];
      if (list.length === 0) return;
      const all = new Set();
      for (const sid of list) for (const id of sessionClosure(sid, byId)) all.add(id);
      if (!window.confirm(t("deletePickedConfirm", { n: all.size }))) return;
      try {
        const result = await treeApi.deleteSessions([...all]);
        const deleted = result && Array.isArray(result.deleted) ? result.deleted : [];
        const missing = result && Array.isArray(result.missing) ? result.missing : [];
        const failed = result && Array.isArray(result.failed) ? result.failed : [];
        if (deleted.length === 0 && missing.length === 0) {
          if (failed.length > 0) {
            showToast(`${t("error")}：${failed[0].error}`);
            return;
          }
          showToast(t("nothingDeleted"));
          return;
        }
        setPicked(new Set());
        reportDeleteSuccess(result, deleted, missing, failed);
        void refreshSessions();
      } catch (e) {
        reportDeleteFailure(e);
      }
    };

    // 批量删除工作区 = 注册项 + 其中全部会话一起彻底删除（与单行删除同语义）。
    // 逐个串行：会话没能全部删掉的工作区保持原样（fail closed），其余继续，
    // 最后汇总成功/失败数量并刷新列表。
    const deletePickedWorkspaces = async () => {
      const list = [...pickedList];
      if (list.length === 0) return;
      if (!workspaces || typeof workspaces.delete !== "function") return;
      const plans = list.map((id) => {
        const sessionIds = (groups.list.find((g) => g.key === id) ?? { sessionIds: [] }).sessionIds;
        const all = new Set();
        for (const sid of sessionIds) for (const cid of sessionClosure(sid, byId)) all.add(cid);
        return { id, all };
      });
      const totalSessions = plans.reduce((n, p) => n + p.all.size, 0);
      // 全都没会话时用短文案：避免「其中的 0 个会话将被彻底删除」这种空警告
      const confirmText = totalSessions === 0
        ? t("deletePickedWorkspacesConfirmNoSessions", { n: plans.length })
        : t("deletePickedWorkspacesConfirm", { n: plans.length, m: totalSessions });
      if (!window.confirm(confirmText)) return;
      const gone = [];
      const deletedSessions = [];
      for (const plan of plans) {
        if (plan.all.size > 0) {
          let result;
          try {
            result = await treeApi.deleteSessions([...plan.all]);
          } catch {
            // 会话删不掉（在跑 / 接口不可用）→ 该工作区保持不变，避免会话被移入未分组
            continue;
          }
          const deleted = result && Array.isArray(result.deleted) ? result.deleted : [];
          const missing = result && Array.isArray(result.missing) ? result.missing : [];
          const removed = [...deleted, ...missing];
          deletedSessions.push(...removed);
          if (removed.length < plan.all.size) continue;
        }
        try {
          await workspaces.delete(plan.id);
          gone.push(plan.id);
        } catch {
          // 工作区删除失败：保留该行，留给下次刷新纠正
        }
      }
      if (deletedSessions.length > 0) {
        forgetDeleted(deletedSessions);
        void refreshSessions();
      }
      if (gone.length === 0) {
        showToast(t("deleteWorkspaceSessionsFailed"));
        return;
      }
      if (gone.length === plans.length) {
        exitBatch();
        showToast(deletedSessions.length > 0
          ? t("deletedWorkspacesWithSessions", { n: gone.length, m: deletedSessions.length })
          : t("deletedWorkspaces", { n: gone.length }));
        return;
      }
      setPicked((prev) => {
        const next = new Set(prev);
        for (const id of gone) next.delete(id);
        return next;
      });
      showToast(t("deletedWorkspacesPartial", {
        n: gone.length,
        m: plans.length - gone.length,
        k: deletedSessions.length,
      }));
    };

    /**
     * 会话行。
     * @param sid - 会话 id。
     * @param groupKey - 所属分组（工作区 id 或 UNGROUPED_KEY）：批量模式只作用于
     *   当前目标工作区的行，其它分组的会话行保持普通行为。
     */
    const sessionRow = (sid, groupKey) => {
      const s = byId[sid];
      if (!s) return null;
      const isCurrent = s.id === current;
      const subs = runningSubagents.get(sid) ?? 0;
      const inBatch = batch !== null && batch.kind === "sessions" && batch.key === groupKey;
      const isPicked = inBatch && picked.has(sid);
      return createElement("div", {
        key: sid,
        className: `dsh-obs-session${isCurrent ? " dsh-obs-selected" : ""}${isPicked ? " dsh-obs-picked" : ""}`,
        "data-session-id": sid,
        onClick: () => {
          if (inBatch) togglePicked(sid);
          else openSession(sid);
        },
      },
        inBatch && createElement("input", {
          type: "checkbox",
          className: "dsh-obs-check",
          "data-id": sid,
          checked: isPicked,
          title: t("batchPickSession"),
          onClick: (e) => e.stopPropagation(),
          onChange: () => togglePicked(sid),
        }),
        subs > 0
          ? createElement("span", {
            className: "dsh-obs-dot dsh-obs-dot-subs",
            title: t("subagentsRunning", { n: subs }),
            "aria-label": t("subagentsRunning", { n: subs }),
          }, "◍")
          : createElement("span", { className: "dsh-obs-dot" }, "·"),
        createElement("span", { className: "dsh-obs-session-title", title: s.displayTitle || s.title || s.id }, s.displayTitle || s.title || s.id),
        createElement("span", { className: "dsh-obs-time" }, formatRelativeTime(s.updatedAt, t)),
        // 批量模式下隐藏单行动作：避免把「批量勾选」和「单行归档/删除」混在一排
        !inBatch && createElement("span", { className: "dsh-obs-actions" },
          createElement("button", {
            title: t("rename"),
            onClick: (e) => {
              e.stopPropagation();
              void renameSession(sid, s.displayTitle || s.title || s.id);
            },
          }, "✎"),
          createElement("button", {
            title: t("archiveSession"),
            onClick: (e) => {
              e.stopPropagation();
              void archiveSession(sid, s.displayTitle || s.title || s.id);
            },
          }, "🗄"),
          createElement("button", {
            className: "dsh-obs-danger",
            title: t("deleteSession"),
            onClick: (e) => {
              e.stopPropagation();
              void deleteSession(sid, s.displayTitle || s.title || s.id);
            },
          }, "🗑"),
        ),
      );
    };

    /**
     * 工作区 / 未分组组行。
     * 批量工作区模式下：真实工作区行左侧出现勾选框，点行=勾选（不再展开/收起），
     * 行尾管理动作隐藏；工具条负责全选/反选/清空/删除。
     * 普通模式下：行尾「☑」是进入该工作区会话批量的入口（截图绿框位置）。
     */
    const groupRow = (key, title, path, sessionIds) => {
      const isOpen = expanded.has(key);
      const isReal = key !== UNGROUPED_KEY;
      const anyBatch = batch !== null;
      const wsBatching = batch !== null && batch.kind === "workspaces";
      const sessionBatching = batch !== null && batch.kind === "sessions" && batch.key === key;
      const wsPicked = wsBatching && isReal && picked.has(key);
      return createElement(Fragment, { key: key },
        createElement("div", {
          className: `dsh-obs-ws-row${wsPicked ? " dsh-obs-picked" : ""}${sessionBatching ? " dsh-obs-batch-target" : ""}`,
          "data-workspace-id": isReal ? key : undefined,
          onClick: () => {
            if (wsBatching && isReal) togglePicked(key);
            else toggleGroup(key);
          },
        },
          wsBatching && isReal && createElement("input", {
            type: "checkbox",
            className: "dsh-obs-check",
            "data-id": key,
            checked: wsPicked,
            title: t("batchPickWorkspace"),
            onClick: (e) => e.stopPropagation(),
            onChange: () => togglePicked(key),
          }),
          createElement("span", { className: "dsh-obs-chev" }, isOpen ? "▾" : "▸"),
          createElement("span", { className: "dsh-obs-ws-icon" }, isOpen ? "📂" : "📁"),
          createElement("span", { className: "dsh-obs-ws-title", title: path }, title),
          !anyBatch && isReal && createElement("span", { className: "dsh-obs-actions" },
            createElement("button", {
              title: t("rename"),
              onClick: (e) => {
                e.stopPropagation();
                void renameWorkspace(key, title);
              },
            }, "✎"),
            createElement("button", {
              title: t("delete"),
              onClick: (e) => {
                e.stopPropagation();
                void deleteWorkspace(key, title, sessionIds);
              },
            }, "🗑"),
          ),
          !anyBatch && !isReal && sessionIds.length > 0 && createElement("span", { className: "dsh-obs-actions" },
            createElement("button", {
              title: t("archiveUngrouped"),
              onClick: (e) => {
                e.stopPropagation();
                void archiveUngrouped(sessionIds, title);
              },
            }, "🗄"),
            createElement("button", {
              className: "dsh-obs-danger",
              title: t("deleteUngrouped"),
              onClick: (e) => {
                e.stopPropagation();
                void deleteUngrouped(sessionIds, title);
              },
            }, "🗑"),
          ),
          // 工作区行批量入口：紧贴行尾管理动作左侧（与标题行「批量工作区」呼应）
          !anyBatch && isReal && sessionIds.length > 0 && createElement("button", {
            className: "dsh-obs-mini",
            title: t("batchSessions"),
            "aria-label": t("batchSessions"),
            onClick: (e) => {
              e.stopPropagation();
              enterSessionBatch(key);
            },
          }, "☑"),
          !anyBatch && isReal && createElement("button", {
            className: "dsh-obs-mini",
            title: t("newSession"),
            onClick: (e) => {
              e.stopPropagation();
              startSession(key);
            },
          }, "＋"),
        ),
        isOpen && createElement("div", null,
          sessionIds.length === 0 && createElement("div", { className: "dsh-obs-ws-empty" }, t("noSessions")),
          sessionIds.map((sid) => sessionRow(sid, key)),
        ),
      );
    };

    // 折叠轨道（wide=false）：紧凑图标列，点击展开侧边栏
    if (wide !== true) {
      return createElement("div", { className: "dsh-obs-rail" },
        createElement("button", {
          type: "button",
          title: t("notes"),
          onClick: () => {
            if (expandSidebar) expandSidebar();
            patchShared({ notesOpen: true });
          },
        }, "📚"),
        createElement("button", {
          type: "button",
          title: t("searchSessions"),
          onClick: () => {
            if (expandSidebar) expandSidebar();
          },
        }, "🔍"),
      );
    }

    const header = createElement("div", { className: "dsh-obs-ws-head" },
      createElement("span", { className: "dsh-obs-ws-head-label" }, t("wsSection")),
      createElement("span", { style: { flex: 1 } }),
      // 标题行批量入口（截图绿框位置：搜索按钮左侧）：只批量工作区（勾选后删除）
      createElement("button", {
        className: `dsh-obs-head-btn${batch !== null && batch.kind === "workspaces" ? " dsh-obs-on" : ""}`,
        title: t("batchWorkspaces"),
        "aria-label": t("batchWorkspaces"),
        onClick: () => {
          if (batch !== null && batch.kind === "workspaces") exitBatch();
          else enterWorkspaceBatch();
        },
      }, "☑"),
      createElement("button", {
        className: `dsh-obs-head-btn${searchOpen ? " dsh-obs-on" : ""}`,
        title: t("searchSessions"),
        onClick: () => {
          if (batch !== null) exitBatch();
          setSearchOpen((v) => !v);
          setQuery("");
        },
      }, "🔍"),
      createElement("button", {
        className: "dsh-obs-head-btn",
        title: t("addWorkspace"),
        onClick: () => void addWorkspace(),
      }, "＋"),
    );

    const searchRow = searchOpen && createElement("div", { className: "dsh-obs-search" },
      createElement("input", {
        autoFocus: true,
        placeholder: t("sessionSearchPlaceholder"),
        value: query,
        onChange: (e) => setQuery(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Escape") { setSearchOpen(false); setQuery(""); }
        },
      }),
    );

    // 批量工具条：说明 + 全选/反选/清空 + 模式专属动作 + 取消。
    // 动作按钮在「未勾选」时禁用，避免对空集合发确认框。
    const batchBar = batch !== null && createElement("div", { className: "dsh-obs-batchbar" },
      createElement("span", { className: "dsh-obs-batchbar-info" },
        t(batch.kind === "workspaces" ? "batchWorkspacesLabel" : "batchSessionsLabel", { n: pickedList.length })),
      createElement("button", { title: t("batchSelectAll"), onClick: selectAllPicked }, t("batchSelectAll")),
      createElement("button", { title: t("batchInvert"), onClick: invertPicked }, t("batchInvert")),
      createElement("button", { title: t("batchClear"), disabled: pickedList.length === 0, onClick: clearPicked }, t("batchClear")),
      batch.kind === "sessions" && createElement("button", {
        title: t("archivePicked"),
        disabled: pickedList.length === 0,
        onClick: () => void archivePicked(),
      }, t("batchArchiveShort")),
      batch.kind === "sessions" && createElement("button", {
        className: "dsh-obs-danger",
        title: t("deletePicked"),
        disabled: pickedList.length === 0,
        onClick: () => void deletePicked(),
      }, t("batchDeleteShort")),
      batch.kind === "workspaces" && createElement("button", {
        className: "dsh-obs-danger",
        title: t("deletePickedWorkspaces"),
        disabled: pickedList.length === 0,
        onClick: () => void deletePickedWorkspaces(),
      }, t("batchDeleteWsShort")),
      createElement("button", { title: t("batchExit"), onClick: exitBatch }, t("batchExit")),
    );

    let body;
    if (q !== "") {
      body = matched.length === 0
        ? createElement("div", { className: "dsh-obs-empty" }, t("noSessions"))
        : matched.map((sid) => sessionRow(sid));
    } else {
      const parts = [];
      for (const g of groups.list) {
        parts.push(groupRow(g.key, g.workspace.title, g.workspace.path, g.sessionIds));
      }
      if (groups.ungrouped.length > 0) {
        parts.push(groupRow(UNGROUPED_KEY, t("ungrouped"), "", groups.ungrouped));
      }
      parts.push(
        createElement("div", {
          key: "notes",
          className: `dsh-obs-notes-row${notesOpen ? " dsh-obs-notes-row-on" : ""}`,
          onClick: () => patchShared({ notesOpen: !shared.notesOpen }),
        },
          createElement("span", { className: "dsh-obs-chev" }, notesOpen ? "▾" : "▸"),
          createElement("span", { className: "dsh-obs-notes-icon" }, "📚"),
          createElement("span", { className: "dsh-obs-notes-title" }, t("notes")),
          noteCount > 0 && createElement("span", { className: "dsh-obs-notes-count" }, String(noteCount)),
        ),
      );
      if (notesOpen) {
        parts.push(createElement("div", { key: "notes-pane", className: "dsh-obs-notes-pane" },
          createElement(TreeView, { t, uiWorkspace }),
        ));
      }
      body = parts;
    }

    return createElement("div", { className: "dsh-obs-sidebar" },
      header,
      searchRow,
      batchBar,
      createElement("div", { className: "dsh-obs-ws-body" }, body),
    );
  }

  // ── P2b：vendor 懒加载 + 媒体 / transclusion / mermaid 渲染产物 ──────────────
  // 渲染层（renderer-c 的 M16/M18/M19/M20）在 renderNumbered 里通过 handlers 调用这里的
  // 工厂：handlers.mediaKind/mediaElement、embedElement、mermaidElement、loadVendor、vendor。
  // 这样 client 侧的懒加载、缓存、降级逻辑不塞进 markdown.js，也不破坏渲染器纯函数边界；
  // 只实现到 M13 的渲染器会忽略多出来的 handler 字段，行为不变（P2a 回归不受影响）。
  const KATEX_VERSION = "0.19.1";
  const MERMAID_VERSION = "12.2.0";
  const VENDOR_VERSIONS = { katex: KATEX_VERSION, mermaid: MERMAID_VERSION };
  const VENDOR_FILES = {
    katex: { script: "katex.min.js", css: "katex.min.css" },
    mermaid: { script: "mermaid.min.js" },
  };
  const vendorPromises = new Map();
  let mermaidRenderSeq = 0;

  // sanitize.js 由 build.mjs 拼进同一 factory 闭包（Lead 负责改构建）；未拼入时
  // mermaid 走「不可用」降级，绝不退回 dangerouslySetInnerHTML。
  const sanitizeSvgModule = typeof sanitizeSvgToReact === "function" ? sanitizeSvgToReact : null;

  /** vendor 静态资源 URL（必须带 `?v=<版本>` 才能命中 host 的长缓存，见 lib/vendor/README.md） */
  function vendorUrl(name, file) {
    const version = VENDOR_VERSIONS[name] ?? "0";
    return `/obsidian/vendor/${name}/${file}?v=${encodeURIComponent(version)}`;
  }

  /** 同步取已加载的第三方库全局对象（未就绪返回 null） */
  function vendorGlobal(name) {
    if (typeof window === "undefined") return null;
    if (name === "katex") {
      const katex = window.katex;
      return katex && typeof katex.renderToString === "function" ? katex : null;
    }
    if (name === "mermaid") {
      const mermaid = window.mermaid;
      return mermaid && typeof mermaid.render === "function" ? mermaid : null;
    }
    return null;
  }

  function vendorReady(name) { return vendorGlobal(name) !== null; }

  function loadVendorCss(name) {
    const href = vendorUrl(name, VENDOR_FILES[name].css);
    if (typeof document === "undefined" || !document.head) return Promise.resolve(false);
    if (document.querySelector(`link[data-dsh-obs-vendor-css="${name}"]`)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.setAttribute("data-dsh-obs-vendor-css", name);
      link.onload = () => resolve(true);
      link.onerror = () => resolve(false);
      document.head.appendChild(link);
    });
  }

  function loadVendorScript(name) {
    const src = vendorUrl(name, VENDOR_FILES[name].script);
    if (typeof document === "undefined" || !document.head) return Promise.resolve(false);
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.setAttribute("data-dsh-obs-vendor-script", name);
      script.onload = () => resolve(vendorReady(name));
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }

  /**
   * 懒加载第三方渲染库（单例 Promise 缓存）：同步已就绪时不会发请求；失败只 toast 一次、
   * 不重试（避免断网时每次渲染都重发）。成功时 patchShared({vendorRev}) 通知 Dock 重渲染，
   * 渲染器下一次 renderNumbered 就能拿到 `vendor()` 的真实库并输出渲染产物。
   * @param {string} name - "katex" | "mermaid"。
   * @param {(key: string, params?: object) => string} [t] - 本地化函数（失败 toast 用）。
   * @returns {Promise<boolean>} 是否加载成功。
   */
  function loadVendor(name, t) {
    if (vendorReady(name)) return Promise.resolve(true);
    if (vendorPromises.has(name)) return vendorPromises.get(name);
    if (!VENDOR_FILES[name]) return Promise.resolve(false);
    const loads = [loadVendorScript(name)];
    if (VENDOR_FILES[name].css) loads.push(loadVendorCss(name));
    const failToast = () => {
      showToast(t ? t("vendorLoadFailed", { name }) : `load vendor failed: ${name}`);
    };
    const promise = Promise.all(loads)
      .then((results) => {
        const ok = results.every(Boolean) && vendorReady(name);
        if (!ok) failToast();
        else patchShared({ vendorRev: shared.vendorRev + 1 });
        return ok;
      })
      .catch(() => { failToast(); return false; });
    vendorPromises.set(name, promise);
    return promise;
  }

  /** 媒体扩展名 → kind（audio/video/pdf；不是媒体返回 null），renderer 分派用 */
  function mediaKindOf(rel) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(rel ?? ""));
    if (!m) return null;
    const ext = m[1].toLowerCase();
    if (ext === "mp3" || ext === "wav" || ext === "ogg" || ext === "m4a") return "audio";
    if (ext === "mp4" || ext === "webm") return "video";
    if (ext === "pdf") return "pdf";
    return null;
  }

  function currentDocTheme() {
    try {
      return typeof document !== "undefined" && document.body && document.body.hasAttribute("data-ds-dark-theme")
        ? "dark"
        : "default";
    } catch { return "default"; }
  }

  const MAX_EMBED_DEPTH = 2;
  const MAX_EMBED_LINES = 200;
  const MAX_EMBED_BYTES = 64 * 1024;
  const MAX_EMBED_CACHE = 50;
  const embedNoteCache = new Map();      // `${path}@${vaultRev}` → note payload
  const embedResolveCache = new Map();   // `${target}@${vaultRev}` → path | null
  const embedResolveInFlight = new Map(); // 同一目标的并发解析合并成一次请求
  const embedFetchInFlight = new Map();   // 同一笔记的并发读取合并成一次请求

  /** 搜索结果解析顺序（M13）：文件名/标题大小写不敏感精确 → matchedAlias → 第一个结果 */
  function pickSearchResult(results, target) {
    const list = Array.isArray(results) ? results : [];
    const lower = String(target ?? "").trim().toLowerCase();
    const nameMatches = (x) => {
      const name = typeof x.name === "string" ? x.name.toLowerCase() : "";
      return name === `${lower}.md` || name === lower;
    };
    const exact = list.find(nameMatches);
    const aliasExact = list.find((x) => typeof x.matchedAlias === "string" && x.matchedAlias.toLowerCase() === lower);
    const aliasAny = list.find((x) => typeof x.matchedAlias === "string" && x.matchedAlias !== "");
    return exact ?? aliasExact ?? aliasAny ?? list[0] ?? null;
  }

  /**
   * transclusion 目标解析：`![[note]]` 的 target 可能是相对路径也可能只是文件名。
   * 先按路径直接读（host /note 会做路径校验），失败再走 search 按文件名/别名匹配。
   * @returns {Promise<string|null>} 笔记相对路径。
   */
  async function resolveEmbedTarget(target, vaultRev) {
    const raw = String(target ?? "").trim();
    if (raw === "") return null;
    const cacheKey = `resolve:${raw}@${vaultRev}`;
    if (embedResolveCache.has(cacheKey)) return embedResolveCache.get(cacheKey);
    if (embedResolveInFlight.has(cacheKey)) return embedResolveInFlight.get(cacheKey);
    const job = (async () => {
      let path = null;
      try {
        const payload = await treeApi.note(raw);
        if (payload && typeof payload.path === "string") {
          path = payload.path;
          embedNoteCache.set(`${path}@${vaultRev}`, payload);
        }
      } catch { /* 不是路径，走 search 兜底 */ }
      if (path === null) {
        try {
          const r = await treeApi.search(raw);
          const found = pickSearchResult(r && r.results, raw);
          path = found && typeof found.path === "string" ? found.path : null;
        } catch { path = null; }
      }
      embedResolveCache.set(cacheKey, path);
      embedResolveInFlight.delete(cacheKey);
      return path;
    })();
    embedResolveInFlight.set(cacheKey, job);
    return job;
  }

  /** 读被嵌入笔记（按 path + vaultRev 缓存；vault 变化后 key 变化自然失效） */
  async function fetchEmbedNote(path, vaultRev) {
    const key = `${path}@${vaultRev}`;
    if (embedNoteCache.has(key)) return embedNoteCache.get(key);
    if (embedFetchInFlight.has(key)) return embedFetchInFlight.get(key);
    const job = (async () => {
      const payload = await treeApi.note(path);
      if (embedNoteCache.size >= MAX_EMBED_CACHE) {
        const first = embedNoteCache.keys().next().value;
        if (first !== undefined) embedNoteCache.delete(first);
      }
      embedNoteCache.set(key, payload);
      embedFetchInFlight.delete(key);
      return payload;
    })();
    embedFetchInFlight.set(key, job);
    return job;
  }

  function embedByteLength(text) {
    try {
      if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
    } catch { /* ignore */ }
    return String(text).length * 3;   // 兜底粗估（UTF-8 最坏 4 字节/字符，取 3 不夸大）
  }

  /**
   * 按标题 / `^id` 切嵌入片段（M18 v1，对齐真机 Obsidian 1.14.4 Oracle）：
   *  - `^id`：行尾块引用所在段落（前后连续非空行）；块 id 字符集与 Obsidian/markdown
   *    侧一致，只认 `[A-Za-z0-9-]`（下划线、中文都不算合法 id → {found:false}）；
   *  - 标题：**包含标题行本身**（Obsidian 的 heading embed 以 `<h2 data-heading=…>`
   *    开头），到下一个「层级 ≤ 该标题」的标题前；
   *  - 空 anchor：整篇。
   */
  function sliceEmbedContent(content, anchor) {
    const normalized = String(content ?? "").replace(/\r\n/g, "\n");
    const raw = typeof anchor === "string" ? anchor.trim() : "";
    if (raw === "") return { found: true, text: normalized };
    const lines = normalized.split("\n");
    if (raw.startsWith("^")) {
      const id = raw.slice(1);
      let idx = -1;
      for (let i = 0; i < lines.length; i++) {
        const m = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(lines[i]);
        if (m && m[1] === id) { idx = i; break; }
      }
      if (idx < 0) return { found: false, text: "" };
      let start = idx;
      while (start > 0 && lines[start - 1].trim() !== "") start -= 1;
      let end = idx;
      while (end < lines.length - 1 && lines[end + 1].trim() !== "") end += 1;
      return { found: true, text: lines.slice(start, end + 1).join("\n") };
    }
    const want = normalizeHeadingAnchor(raw);
    let startIdx = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
      if (!m) continue;
      if (normalizeHeadingAnchor(m[2]) === want) { startIdx = i; level = m[1].length; break; }
    }
    if (startIdx < 0) return { found: false, text: "" };
    let end = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const m = /^(#{1,6})\s+/.exec(lines[i]);
      if (m && m[1].length <= level) { end = i; break; }
    }
    return { found: true, text: lines.slice(startIdx, end).join("\n") };
  }

  /** 整篇嵌入的标题栏文字：Obsidian 显示笔记名（basename，不带 `.md` 扩展名） */
  function embedTitleText(path) {
    const base = String(path ?? "").split("/").pop() ?? "";
    return base.replace(/\.md$/i, "");
  }

  /** 媒体嵌入（M19）：audio/video 原生控件；PDF iframe 失败降级为打开/下载链接 */
  function MediaEmbed({ t, rel, kind, from }) {
    const [failed, setFailed] = useState(false);
    const url = treeApi.assetUrl(rel, from);
    const fallback = createElement("a", {
      className: "dsh-obs-md-pdf-open",
      href: url,
      target: "_blank",
      rel: "noreferrer",
    }, `${t("mediaOpen")}：${rel}`);
    if (failed) return fallback;
    if (kind === "pdf") {
      return createElement("iframe", {
        className: "dsh-obs-md-pdf",
        src: url,
        title: rel,
        onError: () => setFailed(true),
      });
    }
    if (kind === "video") {
      return createElement("video", {
        className: "dsh-obs-md-video",
        controls: true,
        preload: "metadata",
        src: url,
        onError: () => setFailed(true),
      });
    }
    if (kind === "audio") {
      return createElement("audio", {
        className: "dsh-obs-md-audio",
        controls: true,
        preload: "none",
        src: url,
        onError: () => setFailed(true),
      });
    }
    return fallback;
  }

  // ── 主题订阅（M16/M20）：DSH 用 body[data-ds-dark-theme] 切换浅/深主题。KaTeX 颜色
  // 走 `inherit`，CSS 变量变了不用重渲染；mermaid 需要按新主题重新 initialize/render。
  const themeListeners = new Set();
  let themeObserver = null;
  let themeRevision = 0;

  function notifyThemeChange() {
    themeRevision += 1;
    for (const fn of [...themeListeners]) {
      try { fn(themeRevision); } catch { /* 单个订阅者失败不影响其它 */ }
    }
  }

  /** 订阅浅/深主题变化（首个订阅时挂 MutationObserver；环境不支持时降级为不订阅） */
  function subscribeTheme(fn) {
    if (typeof fn !== "function") return () => { };
    themeListeners.add(fn);
    if (themeObserver === null
      && typeof document !== "undefined"
      && typeof MutationObserver === "function"
      && document.body) {
      themeObserver = new MutationObserver(notifyThemeChange);
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class"] });
    }
    return () => { themeListeners.delete(fn); };
  }

  /**
   * mermaid 块渲染（M20 client 侧）：懒加载 vendor → initialize(strict, htmlLabels:false) →
   * render → SVG 走 sanitizeSvgToReact 重建 React 树。
   * - `vendorRev` 变化重跑（vendor 懒加载完成）；`themeRev` 变化重跑（浅/深主题切换）；
   * - `renderFallback` 是 markdown 传入的「带精确 src span 的源码节点工厂」（可选）：
   *   loading / 失败态渲染提示 + 该 fallback（满足 D13「降级源码可选中提问」）；
   *   不传时失败态退回无 span 的 `<pre class="dsh-obs-code">`（P2 契约允许的降级）。
   */
  function MermaidBlock({ t, code, vendorRev, renderFallback }) {
    const [state, setState] = useState({ status: "loading", node: null, message: "" });
    const [themeRev, setThemeRev] = useState(0);
    useEffect(() => subscribeTheme((revision) => setThemeRev(revision)), []);
    useEffect(() => {
      let cancelled = false;
      const run = async () => {
        const ok = await loadVendor("mermaid", t);
        if (cancelled) return;
        const mermaid = vendorGlobal("mermaid");
        if (!ok || mermaid === null || sanitizeSvgModule === null) {
          setState({ status: "error", node: null, message: t("mermaidUnavailable") });
          return;
        }
        try {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            htmlLabels: false,          // 契约 M20：不让 label 变 foreignObject（会被 sanitizer 丢弃）
            theme: currentDocTheme(),
          });
          const id = `dsh-obs-mermaid-${++mermaidRenderSeq}`;
          const result = await mermaid.render(id, code);
          if (cancelled) return;
          const svg = result && typeof result === "object" ? result.svg : String(result ?? "");
          const node = sanitizeSvgModule(svg, React, { allowStyleAttributes: true, keyPrefix: id });
          if (node === null) { setState({ status: "error", node: null, message: t("mermaidError") }); return; }
          setState({ status: "ready", node, message: "" });
        } catch (e) {
          if (!cancelled) setState({ status: "error", node: null, message: String(e && e.message ? e.message : e) });
        }
      };
      void run();
      return () => { cancelled = true; };
    }, [code, vendorRev, themeRev, t]);

    if (state.status === "ready") return createElement("div", { className: "dsh-obs-md-mermaid" }, state.node);
    // renderFallback 是 markdown 惰性构造的「带精确 src span 的逐行源码节点」：
    // 只在 loading / 失败 / sanitize 失败时调用（纯函数、每次返回全新数组、文本只做 React
    // 文本子节点），放在提示下方、包进 dsh-obs-code 容器里；不传则退回无 span 的源码块。
    let fallback = null;
    if (typeof renderFallback === "function") {
      try { fallback = renderFallback(); } catch { fallback = null; }
    }
    const hint = state.status === "loading"
      ? createElement("div", { className: "dsh-obs-md-embed-loading" }, t("mermaidLoading"))
      : createElement("div", { className: "dsh-obs-md-embed-error" }, `${t("mermaidError")}：${state.message}`);
    if (fallback !== null && fallback !== undefined) {
      return createElement(Fragment, null, hint,
        createElement("div", { className: "dsh-obs-code dsh-obs-md-mermaid-fallback" }, fallback));
    }
    // 兼容未传 renderFallback 的渲染器：loading 只有提示；失败补一个无 span 的源码块
    if (state.status === "loading") return hint;
    return createElement(Fragment, null, hint, createElement("pre", { className: "dsh-obs-code" }, code));
  }

  /**
   * transclusion 块（M18 client 侧）：解析目标 → 读缓存 → 切片段 → 限额检查 →
   * 用 renderNumbered(..., { lineNumbers:false }) 渲染嵌入内容（不产外层行号/src span）。
   * 嵌入内的相对图片按被嵌入笔记路径解析，双链沿用外层 onWikilink。
   */
  function TransclusionEmbed({ t, target, anchor, depth, stack, onWikilink, vaultRev }) {
    const [state, setState] = useState({ status: "loading", content: "", path: "", lines: 0 });
    useEffect(() => {
      let cancelled = false;
      const run = async () => {
        setState({ status: "loading", content: "", path: "", lines: 0 });
        try {
          const path = await resolveEmbedTarget(target, vaultRev);
          if (cancelled) return;
          if (path === null) { setState({ status: "error", content: "", path: "", lines: 0, message: t("embedMissing", { name: target }) }); return; }
          if (stack.includes(path)) { setState({ status: "error", content: "", path, lines: 0, message: t("embedCycle") }); return; }
          if (depth >= MAX_EMBED_DEPTH) { setState({ status: "error", content: "", path, lines: 0, message: t("embedDepth") }); return; }
          const payload = await fetchEmbedNote(path, vaultRev);
          if (cancelled) return;
          const sliced = sliceEmbedContent(payload && payload.content ? payload.content : "", anchor);
          if (!sliced.found) {
            setState({ status: "error", content: "", path, lines: 0, message: t("embedAnchorMissing", { anchor: anchor ?? "" }) });
            return;
          }
          const lines = sliced.text === "" ? 0 : sliced.text.split("\n").length;
          if (lines > MAX_EMBED_LINES || embedByteLength(sliced.text) > MAX_EMBED_BYTES) {
            setState({ status: "truncated", content: "", path, lines });
            return;
          }
          setState({ status: "ready", content: sliced.text, path, lines });
        } catch (e) {
          if (!cancelled) setState({ status: "error", content: "", path: "", lines: 0, message: String(e && e.message ? e.message : e) });
        }
      };
      void run();
      return () => { cancelled = true; };
    }, [target, anchor, depth, vaultRev, t]);
    if (state.status === "loading") return createElement("div", { className: "dsh-obs-md-embed-loading" }, t("embedLoading"));
    if (state.status === "error") return createElement("div", { className: "dsh-obs-md-embed-error" }, state.message);
    if (state.status === "truncated") {
      return createElement("div", { className: "dsh-obs-md-embed-error" },
        createElement("span", null, t("embedTooLong", { lines: state.lines })),
        createElement("button", {
          className: "dsh-obs-md-embed-open",
          onClick: () => { if (typeof onWikilink === "function") onWikilink(target, undefined); },
        }, t("embedOpen")),
      );
    }
    const innerHandlers = createPreviewHandlers({
      t,
      onWikilink,
      from: state.path,
      depth: depth + 1,
      stack: [...stack, state.path],
      vaultRev,
    });
    // 整篇嵌入的标题栏（对齐 Obsidian 1.14.4 Oracle）：只有 `![[note]]`（无 anchor）
    // 才有 embed title，标题/块嵌入的 title 为空。标题文字 = 笔记 basename（去 .md），
    // 点击用 onWikilink 打开目标；生成内容，不产 data-line-no / data-obs-src。
    const isWholeNote = anchor === undefined || anchor === null || String(anchor).trim() === "";
    const titleBar = isWholeNote
      ? createElement("button", {
        className: "dsh-obs-md-embed-title",
        onClick: () => { if (typeof onWikilink === "function") onWikilink(state.path, undefined); },
      }, embedTitleText(state.path))
      : null;
    return createElement("div", { className: "dsh-obs-md-embed" }, titleBar, renderNumbered(state.content, innerHandlers, { lineNumbers: false }));
  }

  /**
   * 预览渲染器 handlers 工厂（P2b 扩展点，renderer-c 按这个签名接）：
   *  - mediaKind(rel) -> "audio"|"video"|"pdf"|null
   *  - mediaElement(rel, key) -> React 节点（audio/video/pdf，失败自动降级链接）
   *  - mathElement(tex, displayMode, key) -> React 节点 | null（null = 未就绪/失败，调用方降级源码；
   *    调用它会自动触发 KaTeX 懒加载，加载完成 client 重渲染后再次调用即返回真产物）
   *  - embedElement(target, anchor, key) -> React 节点（transclusion 块；最外层 depth=0）
   *  - mermaidElement(code, key, renderFallback?) -> React 节点（mermaid 块，内部懒加载 + 降级）。
   *    renderFallback 由 markdown 惰性构造：`() => ReactNode[]`，每次返回全新的「逐行源码」
   *    节点数组（每行 div.dsh-obs-md-src-line，外层路径内含 span.dsh-obs-src；
   *    lineNumbers:false 嵌套路径为纯文本、无 span；无行号/无围栏符，空行占位）。
   *    client 只在 loading / 渲染失败 / sanitize 失败时调用；源码文本只作 React 文本子节点，
   *    绝不塞进字符串属性。不传时失败态退回无 span 的源码块（已知差异）。
   *  - loadVendor(name) -> Promise<boolean>；vendor(name) -> 全局对象|null（同步判断，不触发加载）
   * 未实现这些 hook 的渲染器会忽略多出来的字段，P2a 行为不变。
   */
  function createPreviewHandlers({ t, onWikilink, from, depth, stack, vaultRev }) {
    return {
      onWikilink,
      assetUrl: (rel) => treeApi.assetUrl(rel, from),
      loadVendor: (name) => loadVendor(name, t),
      vendor: vendorGlobal,
      mediaKind: (rel) => mediaKindOf(rel),
      mediaElement: (rel, key) => createElement(MediaEmbed, { key, t, rel, kind: mediaKindOf(rel), from }),
      mermaidElement: (code, key, renderFallback) => createElement(MermaidBlock, {
        key,
        t,
        code,
        vendorRev: shared.vendorRev,
        renderFallback,
      }),
      mathElement: (tex, displayMode, key) => {
        const katex = vendorGlobal("katex");
        if (katex === null) {
          void loadVendor("katex", t);   // 首次遇到数学：懒加载，加载完由 vendorRev 触发重渲染
          return null;
        }
        try {
          // throwOnError:true → 非法公式直接抛错，这里转成 null 让 markdown 走「源码 + 精确
          // src span」降级（契约 §3.8/D13）；trust 保持默认 false，不执行公式里的任意命令。
          const html = katex.renderToString(String(tex), { throwOnError: true, trust: false, displayMode: displayMode === true });
          return createElement("span", {
            key,
            className: displayMode === true ? "dsh-obs-md-math-block" : "dsh-obs-md-math-inline",
            dangerouslySetInnerHTML: { __html: html },
          });
        } catch {
          return null;
        }
      },
      embedElement: (target, anchor, key) => {
        if (depth >= MAX_EMBED_DEPTH) {
          return createElement("div", { key, className: "dsh-obs-md-embed-error" }, t("embedDepth"));
        }
        return createElement(TransclusionEmbed, { key, t, target, anchor, depth, stack, onWikilink, vaultRev });
      },
    };
  }

  // ── 右侧笔记 Dock（shell.overlay）──────────────────────────────────────────
  function Dock({ t, workspaces }) {
    const { openNote, vaultRev } = useShared();
    const [note, setNote] = useState(null);
    const [root, setRoot] = useState("");
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [width, setWidth] = useState(() => {
      try {
        const v = parseInt(localStorage.getItem(LS_DOCK_WIDTH) ?? "", 10);
        if (Number.isFinite(v) && v >= 380) return Math.min(v, 900);
      } catch { /* ignore */ }
      return 520;
    });
    const [pos, setPos] = useState(null);
    const dragState = useRef(null);
    const resizeState = useRef(null);
    // 「选中片段提问」（预览 / 编辑态共用）
    const previewRef = useRef(null);
    const editorRef = useRef(null);
    const gutterRef = useRef(null);
    const dockRef = useRef(null);
    const leavesRef = useRef([]);
    const askOpenRef = useRef(false);
    const [ask, setAsk] = useState(null);        // {span, rect, basePath, content}
    const [askOpen, setAskOpen] = useState(false);
    const [draftQ, setDraftQ] = useState("");
    // ── P2 交互状态（M11 折叠 / M12 脚注与锚点 / M13 跨篇 pending anchor）──────
    // collapsedCallouts === null 表示还没从「源码默认」的 DOM 里 seed 出权威集合：
    // 首帧不传 options，渲染器按源码默认输出；seed 后每次渲染都传完整 Set。
    const [collapsedCallouts, setCollapsedCallouts] = useState(null);
    const pendingScrollRef = useRef(null);     // callout 折叠重渲染后要恢复的滚动位置
    const fnTargetTimerRef = useRef(null);     // 脚注定义行高亮 1.5s 定时器
    const pendingAnchorRef = useRef(null);     // 跨篇打开后待滚动的锚点 { path, anchor }

    // 加载笔记
    useEffect(() => {
      if (!openNote) {
        setNote(null);
        setEditing(false);
        setError("");
        return;
      }
      let cancelled = false;
      setEditing(false);
      setError("");
      setNote(null);
      Promise.all([treeApi.root(), treeApi.note(openNote.rel)]).then(([info, payload]) => {
        if (cancelled) return;
        setRoot(info.root);
        setNote(payload);
      }).catch((e) => {
        if (!cancelled) setError(String(e && e.message ? e.message : e));
      });
      return () => {
        cancelled = true;
      };
    }, [openNote, vaultRev]);

    // 双工刷新：Dock 打开且未编辑时轮询 mtime，Agent 修改 vault 后自动反映
    useEffect(() => {
      if (!openNote || editing || !note) return;
      const timer = window.setInterval(async () => {
        try {
          const fresh = await treeApi.note(openNote.rel);
          if (fresh.mtimeMs !== note.mtimeMs) {
            setNote((prev) => prev ? {
              ...prev,
              content: fresh.content,
              frontmatter: fresh.frontmatter,
              links: fresh.links,
              size: fresh.size,
              mtimeMs: fresh.mtimeMs,
            } : prev);
          }
        } catch { /* 文件可能被外部删除，保持现状 */ }
      }, 3000);
      return () => window.clearInterval(timer);
    }, [openNote, editing, note]);

    useEffect(() => {
      try {
        localStorage.setItem(LS_DOCK_WIDTH, String(width));
      } catch { /* ignore */ }
    }, [width]);

    // 预览口径：渲染、行号与选区映射统一用规范化（CRLF→LF）后的内容。
    // 渲染器内部也是 LF 口径，两边必须基于同一份字符串；否则 CRLF 笔记的
    // DOM 选区反查源码偏移会整体错位（选中提问的「第 X 行 / > 原文」都会错）。
    const previewContent = note ? normalizePreviewContent(note.content) : "";

    /** 预览 DOM 里「当前收起」的 callout key 集合（M11 seed / 首次点击初始化用） */
    const readCollapsedCalloutKeys = () => {
      const el = previewRef.current;
      const keys = new Set();
      if (!el || typeof el.querySelectorAll !== "function") return keys;
      for (const btn of el.querySelectorAll("[data-callout-toggle]")) {
        if (btn.getAttribute("aria-expanded") === "false") {
          const key = btn.getAttribute("data-callout-toggle");
          if (key !== null) keys.add(key);
        }
      }
      return keys;
    };

    /**
     * 同篇锚点滚动（M12/M13）：`^id` 找 `[data-block-id]`；标题优先找
     * `[data-heading-anchor]`（P2 契约 §12 C6），渲染器还没写该属性时退回
     * 「标题行 lc 可见文本」匹配（P1 标题行同样适用）。找不到返回 false。
     */
    const scrollToAnchor = (anchor) => {
      const el = previewRef.current;
      if (!el || typeof anchor !== "string" || typeof el.querySelectorAll !== "function") return false;
      const raw = anchor.trim();
      if (raw === "") return false;
      let target = null;
      if (raw.startsWith("^")) {
        const id = raw.slice(1);
        if (id !== "") {
          for (const row of el.querySelectorAll("[data-block-id]")) {
            if (row.getAttribute("data-block-id") === id) { target = row; break; }
          }
        }
      } else {
        const want = normalizeHeadingAnchor(raw);
        if (want !== "") {
          for (const row of el.querySelectorAll("[data-heading-anchor]")) {
            if (normalizeHeadingAnchor(row.getAttribute("data-heading-anchor")) === want) { target = row; break; }
          }
          if (!target) {
            for (const row of el.querySelectorAll(".dsh-obs-md-row")) {
              const cls = String(row.getAttribute("class") || "");
              if (!/(?:^|\s)dsh-obs-md-(?:heading|h[1-6])(?:\s|$)/.test(cls)) continue;
              const lc = typeof row.querySelector === "function" ? row.querySelector(".dsh-obs-md-lc") : null;
              const text = ((lc ?? row).textContent ?? "");
              if (normalizeHeadingAnchor(text) === want) { target = row; break; }
            }
          }
        }
      }
      if (!target) return false;
      if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center" });
      return true;
    };

    /** 脚注引用点击（M12）：滚动到定义行并高亮 1.5s；缺定义给 toast 提示 */
    const jumpToFootnoteDef = (label) => {
      const el = previewRef.current;
      if (!el || label === null || typeof el.querySelectorAll !== "function") return;
      let target = null;
      for (const row of el.querySelectorAll("[data-footnote-def]")) {
        if (row.getAttribute("data-footnote-def") === label) { target = row; break; }
      }
      if (!target) {
        showToast(`${t("footnoteMissing")}：[^${label}]`);
        return;
      }
      if (fnTargetTimerRef.current !== null) { window.clearTimeout(fnTargetTimerRef.current); fnTargetTimerRef.current = null; }
      for (const prev of el.querySelectorAll(".dsh-obs-md-fn-target")) prev.classList.remove("dsh-obs-md-fn-target");
      target.classList.add("dsh-obs-md-fn-target");
      if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center" });
      fnTargetTimerRef.current = window.setTimeout(() => {
        target.classList.remove("dsh-obs-md-fn-target");
        fnTargetTimerRef.current = null;
      }, 1500);
    };

    /**
     * 预览容器点击委托：renderer-b 约定 toggle / fnref 不带 onClick（P2 契约 §12），
     * client 统一按 data-* 属性分派，避免每次重渲染重新绑定大量闭包。
     */
    const onPreviewClick = (e) => {
      const tg = e && e.target;
      if (!tg || typeof tg.closest !== "function") return;
      const toggle = tg.closest("[data-callout-toggle]");
      if (toggle) {
        e.preventDefault();
        const key = toggle.getAttribute("data-callout-toggle");
        if (key === null) return;
        // 先记住滚动位置，重渲染后由 effect 恢复（折叠会改变内容高度）
        const body = dockRef.current && typeof dockRef.current.querySelector === "function"
          ? dockRef.current.querySelector(".dsh-obs-dock-body")
          : null;
        pendingScrollRef.current = body && typeof body.scrollTop === "number" ? body.scrollTop : null;
        const wasCollapsed = toggle.getAttribute("aria-expanded") === "false";
        setCollapsedCallouts((prev) => {
          const next = prev === null ? readCollapsedCalloutKeys() : new Set(prev);
          if (wasCollapsed) next.delete(key); else next.add(key);
          return next;
        });
        return;
      }
      const ref = tg.closest("[data-footnote-ref]");
      if (ref) {
        e.preventDefault();
        jumpToFootnoteDef(ref.getAttribute("data-footnote-ref"));
      }
    };

    // 换笔记：折叠状态（key 是源码 offset）与脚注高亮都不跨笔记；pending 锚点
    // 只有在它指向的笔记已经不是当前笔记时才丢弃（跨篇跳转正是「换笔记 + 带锚点」）。
    useEffect(() => {
      setCollapsedCallouts(null);
      pendingScrollRef.current = null;
      if (pendingAnchorRef.current !== null
        && (!openNote || pendingAnchorRef.current.path !== openNote.rel)) {
        pendingAnchorRef.current = null;
      }
      if (fnTargetTimerRef.current !== null) { window.clearTimeout(fnTargetTimerRef.current); fnTargetTimerRef.current = null; }
    }, [openNote]);

    // M11 折叠状态 seed：首帧不传 options（源码默认）→ 从 DOM 的 aria-expanded 读出
    // 「当前收起」的 key 形成权威 Set；之后每次渲染都传 Set（Set() = 全展开）。
    useEffect(() => {
      if (editing || !note || collapsedCallouts !== null) return;
      setCollapsedCallouts(readCollapsedCalloutKeys());
    }, [note, editing, collapsedCallouts, vaultRev]);

    // 折叠切换后恢复滚动位置（重渲染换了 DOM，scrollTop 会跳回顶部）
    useEffect(() => {
      if (pendingScrollRef.current === null) return;
      const body = dockRef.current && typeof dockRef.current.querySelector === "function"
        ? dockRef.current.querySelector(".dsh-obs-dock-body")
        : null;
      if (body) body.scrollTop = pendingScrollRef.current;
      pendingScrollRef.current = null;
    }, [collapsedCallouts]);

    // M13 跨篇锚点：新笔记渲染完成后滚动一次；找不到就丢弃，不反复尝试
    useEffect(() => {
      if (editing || !note) return;
      const pending = pendingAnchorRef.current;
      if (!pending || pending.path !== note.path) return;
      pendingAnchorRef.current = null;
      scrollToAnchor(pending.anchor);
    }, [note, editing]);

    // 卸载时清掉脚注高亮定时器
    useEffect(() => () => {
      if (fnTargetTimerRef.current !== null) { window.clearTimeout(fnTargetTimerRef.current); fnTargetTimerRef.current = null; }
    }, []);

    // 预览渲染后重建偏移叶子表（「选中片段提问」用）
    useEffect(() => {
      if (editing || !note || !previewRef.current) { leavesRef.current = []; return; }
      leavesRef.current = computeLeafSpans(previewRef.current);
    }, [note, editing, vaultRev]);

    // 同步浮层展开态到 ref（供 mousedown/mouseup 判定，避免聚焦输入框清空选区后误关）
    useEffect(() => { askOpenRef.current = askOpen; }, [askOpen]);

    // 编辑态行号栏：内容/滚动后保持行号与 textarea 文本垂直对齐（textarea 为 white-space:pre，无折行）
    useEffect(() => {
      const g = gutterRef.current;
      const ed = editorRef.current;
      if (g && ed) g.scrollTop = ed.scrollTop;
    }, [editing, draft]);

    // 预览态选中监听：mouseup / mousedown（测试桩无 addEventListener 则跳过）
    useEffect(() => {
      if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
      const onUp = () => {
        if (editing || !note || !previewRef.current) return;
        const span = spanFromSelection(previewRef.current, leavesRef.current, previewContent);
        if (span && !askOpenRef.current) {
          setAsk({ span, rect: selRect() || { top: 64, bottom: 96, left: 40 }, basePath: treeApi.absPath(note.path, root), content: previewContent });
          setAskOpen(false);
        } else if (!askOpenRef.current) {
          setAsk(null);
        }
      };
      const onDown = (e) => {
        if (askOpenRef.current) return;
        const tg = e.target;
        if (tg && tg.closest && tg.closest(".dsh-obs-askpop")) return;
        setAsk(null);
      };
      document.addEventListener("mouseup", onUp);
      document.addEventListener("mousedown", onDown);
      return () => {
        document.removeEventListener("mouseup", onUp);
        document.removeEventListener("mousedown", onDown);
      };
    }, [editing, note, root, vaultRev]);

    const submitAsk = useCallback((question) => {
      if (!ask) return;
      const prompt = buildPrompt(ask.basePath, ask.content, ask.span, question);
      if (injectPrompt(prompt)) {
        showToast(`${t("cited")}：已引用选中片段（${ask.span.text.length} 字符）`);
      } else {
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            navigator.clipboard.writeText(prompt).then(() => showToast(t("noInput"))).catch(() => showToast(t("citeFail")));
          } else {
            showToast(t("citeFail"));
          }
        } catch {
          showToast(t("citeFail"));
        }
      }
      setAsk(null); setAskOpen(false); setDraftQ("");
    }, [ask, t]);

    const closeAsk = useCallback(() => {
      setAskOpen(false); setAsk(null); setDraftQ("");
    }, []);

    // 编辑态选区（textarea 原生 selectionStart/End 直接切片；值按 API value 的 LF 口径）
    const onEditorSel = useCallback(() => {
      const ed = editorRef.current;
      if (!ed || !note) return;
      if (ed.selectionStart === ed.selectionEnd) { setAsk(null); return; }
      const start = ed.selectionStart, end = ed.selectionEnd;
      const sel = editorSelectionSpan(ed.value, start, end);
      const r = ed.getBoundingClientRect ? ed.getBoundingClientRect() : null;
      setAsk({
        span: sel.span,
        rect: r ? { top: r.top - 6, bottom: r.top + 32, left: r.left } : { top: 64, bottom: 96, left: 40 },
        basePath: treeApi.absPath(note.path, root),
        content: sel.content,
      });
      setAskOpen(false);
    }, [note, root]);

    // 编辑态粘贴图片：捕获 image/* → base64 → 落盘附件目录 → 光标处插入 ![[...]]
    const onPasteImage = useCallback(async (e) => {
      const items = e && e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item && item.kind === "file" && item.type && item.type.startsWith("image/")) {
          const file = item.getAsFile ? item.getAsFile() : null;
          if (!file) continue;
          e.preventDefault();
          try {
            const dataUrl = await fileToDataUrl(file);
            const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
            if (data === "") throw new Error("empty image data");
            const r = await treeApi.attach(data, note ? note.path : "");
            const embed = `![[${r.path}]]`;
            const ed = editorRef.current;
            const cur = ed ? ed.value : draft;   // 受控 textarea：DOM 值即当前 draft
            const start = ed ? (typeof ed.selectionStart === "number" ? ed.selectionStart : cur.length) : cur.length;
            const end = ed ? (typeof ed.selectionEnd === "number" ? ed.selectionEnd : start) : start;
            const next = insertEmbedAtSelection(cur, start, end, embed);
            setDraft(next);
            if (ed && typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
              window.requestAnimationFrame(() => {
                ed.focus();
                const p = start + embed.length;
                if (typeof ed.setSelectionRange === "function") ed.setSelectionRange(p, p);
              });
            }
            showToast(t("imageInserted"));
          } catch (err) {
            showToast(String(err && err.message ? err.message : err));
          }
          return;
        }
      }
    }, [t, draft]);

    const beginDrag = useCallback((e) => {
      e.preventDefault();
      const base = pos ?? { x: Math.max(12, window.innerWidth - width - 24), y: 64 };
      dragState.current = { startX: e.clientX, startY: e.clientY, base };
      const onMove = (ev) => {
        const st = dragState.current;
        if (!st) return;
        setPos({
          x: Math.min(Math.max(0, st.base.x + ev.clientX - st.startX), Math.max(0, window.innerWidth - 160)),
          y: Math.min(Math.max(8, st.base.y + ev.clientY - st.startY), Math.max(8, window.innerHeight - 80)),
        });
      };
      const onUp = () => {
        dragState.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    }, [pos, width]);

    const beginResize = useCallback((e) => {
      e.preventDefault();
      e.stopPropagation();
      resizeState.current = { startX: e.clientX, baseW: width };
      document.body.classList.add("dsh-obs-resizing");
      const onMove = (ev) => {
        const st = resizeState.current;
        if (!st) return;
        setWidth(Math.min(Math.max(380, st.baseW - (ev.clientX - st.startX)), Math.round(window.innerWidth * 0.92)));
      };
      const onUp = () => {
        resizeState.current = null;
        document.body.classList.remove("dsh-obs-resizing");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    }, [width]);

    const save = useCallback(async () => {
      if (!note) return;
      setSaving(true);
      setError("");
      try {
        const r = await treeApi.save(note.path, draft);
        const fresh = await treeApi.note(note.path);
        setNote(fresh);
        setEditing(false);
        patchShared({ vaultRev: shared.vaultRev + 1 });
        if (r && Array.isArray(r.deletedAttachments) && r.deletedAttachments.length > 0) {
          showToast(`${t("imageRemoved")}：${r.deletedAttachments.length} 张 → ${r.deletedAttachments.join("、")}`);
        }
      } catch (e) {
        setError(String(e && e.message ? e.message : e));
      } finally {
        setSaving(false);
      }
    }, [note, draft, t]);

    const remove = useCallback(async () => {
      if (!note) return;
      if (!window.confirm(t("deleteConfirm"))) return;
      try {
        await treeApi.deleteNote(note.path);
        patchShared({ openNote: null, vaultRev: shared.vaultRev + 1 });
      } catch (e) {
        setError(String(e && e.message ? e.message : e));
      }
    }, [note, t]);

    const rename = useCallback(async () => {
      if (!note) return;
      const name = await askText(t("renamePrompt"), note.name);
      if (name === null || name.trim() === "") return;
      try {
        const r = await treeApi.renameNote(note.path, name.trim());
        const rel = note.path.split("/").slice(0, -1).concat(r.name).join("/");
        patchShared({ openNote: { rel, name: r.name }, vaultRev: shared.vaultRev + 1 });
      } catch (e) {
        setError(String(e && e.message ? e.message : e));
      }
    }, [note, t]);

    const cite = useCallback(async () => {
      if (!note) return;
      await citeToChat(treeApi.absPath(note.path, root), t);
    }, [note, root, t]);

    /**
     * 双链/嵌入跳转（M13）：
     *  - target 为空 → 同篇锚点（`[[#标题]]` / `[[#^id]]`，anchor 必有）；
     *  - target 是当前笔记名 → 同篇锚点；
     *  - 跨篇 → 打开目标笔记，anchor 记进 pendingAnchorRef，等新笔记渲染后滚动一次。
     * 解析顺序（契约 §3.6）：文件名/标题大小写不敏感精确 → alias（搜索结果
     * matchedAlias）→ 现有第一个结果兜底。
     */
    const openWikilink = useCallback(async (target, anchor) => {
      if (editing && note !== null && draft !== note.content && !window.confirm(t("discard"))) return;
      const targetText = typeof target === "string" ? target.trim() : "";
      const anchorText = typeof anchor === "string" ? anchor.trim() : "";
      const currentName = note ? String(note.name || "").replace(/\.md$/i, "").toLowerCase() : "";

      // 同篇：空 target（[[#标题]] / [[#^id]]），或 target 就是当前笔记名
      if (note !== null && (targetText === "" || targetText.toLowerCase() === currentName)) {
        if (anchorText !== "" && scrollToAnchor(anchorText)) return;
        if (anchorText !== "") {
          showToast(`${t("wikilinkNotFound")}：[[${targetText === "" ? "" : `${targetText}#`}${anchorText}]]`);
        }
        return;
      }
      if (targetText === "") return;

      const r = await treeApi.search(targetText);
      const results = Array.isArray(r && r.results) ? r.results : [];
      const found = pickSearchResult(results, targetText);
      if (!found) {
        showToast(`${t("wikilinkNotFound")}：[[${targetText}]]`);
        return;
      }
      // 解析结果就是当前笔记：不重开，直接滚动锚点
      if (note !== null && found.path === note.path) {
        if (anchorText !== "" && scrollToAnchor(anchorText)) return;
        if (anchorText !== "") showToast(`${t("wikilinkNotFound")}：[[${found.name}#${anchorText}]]`);
        return;
      }
      pendingAnchorRef.current = anchorText === "" ? null : { path: found.path, anchor: anchorText };
      patchShared({ openNote: { rel: found.path, name: found.name } });
    }, [editing, draft, note, t]);

    const dirty = editing && note !== null && draft !== note.content;

    // 编辑态行号（每行一个，对应源码行数；textarea 为 white-space:pre 无折行，行号与文本行一一对齐）
    const gutterLineCount = draft.split("\n").length;
    const gutterDigits = Math.max(2, String(gutterLineCount).length);
    const gutterNumbers = Array.from({ length: gutterLineCount }, (_, i) => i + 1).join("\n");

    if (!openNote) return null;
    const style = pos
      ? { left: `${pos.x}px`, top: `${pos.y}px`, width: `${width}px` }
      : { right: 16, top: 60, width: `${width}px` };

    const tags = note && note.frontmatter && note.frontmatter.tags
      ? String(note.frontmatter.tags).split(/[,\s]+/).filter((x) => x !== "")
      : [];

    // 预览渲染 handlers：P2a 的 onText/双链 + P2b 的媒体/嵌入/mermaid/vendor 扩展点
    const previewHandlers = createPreviewHandlers({
      t,
      onWikilink: (target, anchor) => void openWikilink(target, anchor),
      from: note ? note.path : "",
      depth: 0,
      stack: note ? [note.path] : [],
      vaultRev,
    });
    previewHandlers.onText = () => { };

    return createElement("div", { ref: dockRef, className: "dsh-obs-dock", style },
      createElement("div", { className: "dsh-obs-handle", title: t("resize"), onMouseDown: beginResize }),
      createElement("div", { className: "dsh-obs-dock-head", title: t("move"), onMouseDown: beginDrag },
        createElement("div", { className: "dsh-obs-dock-title" },
          createElement("span", null, "📝"),
          createElement("span", null, note ? note.name : openNote.name),
        ),
        !editing && note && createElement("button", { onClick: () => void cite() }, `⤴ ${t("cite")}`),
        !editing && note && createElement("button", { onClick: () => { setDraft(note.content); setEditing(true); } }, t("edit")),
        editing && createElement("button", {
          className: "dsh-obs-primary",
          disabled: saving,
          onClick: () => void save(),
        }, saving ? t("saving") : `${t("save")}${dirty ? " ●" : ""}`),
        editing && createElement("button", {
          onClick: () => {
            if (!dirty || window.confirm(t("discard"))) setEditing(false);
          },
        }, t("cancel")),
        !editing && note && createElement("button", { title: t("rename"), onClick: () => void rename() }, "✎"),
        !editing && note && createElement("button", { title: t("delete"), onClick: () => void remove() }, "🗑"),
        createElement("button", { title: t("close"), onClick: () => patchShared({ openNote: null }) }, "✕"),
      ),
      note && createElement("div", { className: "dsh-obs-dock-meta" },
        note.path,
        createElement("span", null, formatSize(note.size)),
        tags.map((tag) => createElement("span", { key: tag, className: "dsh-obs-tag" }, `#${tag}`)),
      ),
      note === null
        ? error !== ""
          ? createElement("div", { className: "dsh-obs-error" }, error)
          : createElement("div", { className: "dsh-obs-empty" }, t("loading"))
        : editing
          ? createElement("div", { className: "dsh-obs-editor" },
            createElement("div", {
              ref: gutterRef,
              className: "dsh-obs-editor-gutter",
              "aria-hidden": "true",
              style: { width: `${gutterDigits}ch` },
            }, gutterNumbers),
            createElement("textarea", {
              ref: editorRef,
              autoFocus: true,
              value: draft,
              onChange: (e) => setDraft(e.target.value),
              spellCheck: false,
              onScroll: (e) => { if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop; },
              onPaste: (e) => void onPasteImage(e),
              onMouseUp: () => onEditorSel(),
              onKeyUp: (e) => { if (!["Shift", "Control", "Meta", "Alt"].includes(e.key)) onEditorSel(); },
              onKeyDown: (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                  e.preventDefault();
                  void save();
                }
              },
            }),
          )
          : createElement("div", { className: "dsh-obs-dock-body" },
            createElement("div", { ref: previewRef, className: "dsh-obs-md", onClick: onPreviewClick },
              renderNumbered(previewContent, previewHandlers, collapsedCallouts === null ? undefined : { collapsedCallouts }),
            ),
          ),
      error !== "" && note !== null && createElement("div", { className: "dsh-obs-error" }, error),
      ask && createElement("div", {
        className: "dsh-obs-askpop",
        style: (() => {
          const vw = window.innerWidth, vh = window.innerHeight;
          const panelW = 300;                                  // 输入面板宽度（工具条更窄，沿用此界做边界）
          const panelH = askOpen ? 150 : 40;
          let top = ask.rect.top - panelH - 8;
          if (top < 6) top = ask.rect.bottom + 8;              // 上方放不下 → 翻到选区下方
          top = Math.max(8, Math.min(top, vh - panelH - 8));   // 纵向夹紧视口
          // 以 Dock 卡片左右界为准夹紧，避免横向超出灰色卡片
          let left;
          const dockEl = dockRef.current;
          if (dockEl && typeof dockEl.getBoundingClientRect === "function") {
            const dr = dockEl.getBoundingClientRect();
            const lo = dr.left + 8;
            const hi = dr.right - panelW - 8;
            left = hi >= lo ? Math.max(lo, Math.min(ask.rect.left, hi)) : lo;
          } else {
            left = Math.max(8, Math.min(ask.rect.left, vw - panelW - 8));
          }
          return { left: `${left}px`, top: `${top}px` };
        })(),
      },
        askOpen
          ? createElement("div", { className: "dsh-obs-askinput" },
            createElement("div", { className: "dsh-obs-askcap" }, t("askCap", { n: ask.span.text.length })),
            createElement("textarea", {
              autoFocus: true,
              className: "dsh-obs-askta",
              value: draftQ,
              onChange: (e) => setDraftQ(e.target.value),
              spellCheck: false,
              onKeyDown: (e) => {
                if (e.isComposing || e.keyCode === 229) return;   // 输入法组合期间不发送
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAsk(draftQ); }
                else if (e.key === "Escape") { e.preventDefault(); closeAsk(); }
              },
            }),
            createElement("div", { className: "dsh-obs-askrow" },
              createElement("span", { className: "dsh-obs-askhint" }, t("askCancel")),
              createElement("button", { className: "dsh-obs-asksend", onMouseDown: (e) => e.preventDefault(), onClick: () => submitAsk(draftQ) }, t("askSend")),
            ),
          )
          : createElement("div", { className: "dsh-obs-askbar" },
            createElement("button", { onMouseDown: (e) => e.preventDefault(), onClick: () => { setAskOpen(true); setDraftQ(""); } }, `💬 ${t("ask")}`),
            createElement("button", { onMouseDown: (e) => e.preventDefault(), onClick: () => submitAsk("请解释这段内容") }, `⚡ ${t("explain")}`),
            createElement("span", { className: "dsh-obs-asklen" }, `${ask.span.text.length} 字符`),
          ),
      ),
    );
  }

  // ── Toast（shell.overlay）──────────────────────────────────────────────────
  function Toast() {
    const { toast } = useShared();
    if (!toast) return null;
    return createElement("div", { className: "dsh-obs-toast" }, toast);
  }

  // ── 文本输入卡片（shell.overlay）：替代 window.prompt ───────────────────────
  function Prompt({ t }) {
    const { prompt } = useShared();
    const [value, setValue] = useState("");
    useEffect(() => {
      if (prompt) setValue(prompt.initial ?? "");
    }, [prompt]);
    if (!prompt) return null;
    const commit = () => closePrompt(value);
    return createElement("div", {
      className: "dsh-obs-prompt-layer",
      onMouseDown: (e) => { if (e.target === e.currentTarget) closePrompt(null); },
    },
      createElement("div", { className: "dsh-obs-prompt" },
        createElement("div", { className: "dsh-obs-prompt-title" }, prompt.title),
        createElement("input", {
          autoFocus: true,
          className: "dsh-obs-prompt-input",
          placeholder: prompt.title,
          value,
          onChange: (e) => setValue(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") closePrompt(null);
          },
        }),
        createElement("div", { className: "dsh-obs-askrow" },
          createElement("button", {
            className: "dsh-obs-asksend",
            onClick: () => commit(),
          }, t("confirm")),
          createElement("button", {
            className: "dsh-obs-prompt-cancel",
            onClick: () => closePrompt(null),
          }, t("cancel")),
        ),
      ),
    );
  }

  // ── 插件入口 ───────────────────────────────────────────────────────────────
  const inject = ["slots", "locale", "workspaces", "sessions"];

  function apply(ctx) {
    injectCss();
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-obsidian-vault: locale dictionaries");

    const sessions = ctx.sessions;
    const workspaces = ctx.workspaces;

    // ── UI 导航能力（新建会话 / 选择目录）─────────────────────────────────
    // 「新建会话」startSession 与「选择目录」pickDirectory 属于官方
    // @deepseek-ai/dsh-client-ui-workspace 注册的 ctx.uiWorkspace（UI 导航
    // 能力）；纯控制器 ctx.workspaces（IWorkspaces）只有 create / rename /
    // delete / archiveSession / insert* —— 在上面直接调 workspaces.startSession()
    // 只会被 `typeof ... !== "function"` 守卫静默 return，表现为「点＋没反应」。
    // 用 ctx.get 惰性解析：slots 的 inject 工厂结果会被渲染器缓存到注册期，
    // 且官方服务可能晚于本插件 apply；服务缺失时保留对旧式 workspaces.* 的兜底。
    const resolveUiWorkspace = () => {
      if (typeof ctx.get !== "function") return undefined;
      const svc = ctx.get("uiWorkspace");
      return svc === undefined || svc === null ? undefined : svc;
    };
    const uiWorkspace = {
      /**
       * 新建（或复用该工作区已有空白）会话并打开。
       * @param workspaceId - 目标工作区。
       * @param onError - 失败回调（官方实现自身只 console.warn，插件需要给用户反馈）。
       * @returns 是否已派发。
       */
      startSession(workspaceId, onError) {
        const svc = resolveUiWorkspace();
        if (svc && typeof svc.startSession === "function") {
          svc.startSession(workspaceId);
          return true;
        }
        // 兜底：uiWorkspace 不可用时自行 create + open（不复用空白会话）。
        if (sessions !== undefined && typeof sessions.create === "function") {
          const opts = workspaceId === undefined || workspaceId === "" ? undefined : { workspaceId };
          Promise.resolve(sessions.create(opts)).then((id) => {
            // 打开同样走 openSession（0.1.7+ 没有 sessions.open）。
            uiWorkspace.openSession(id, (error) => {
              if (typeof onError === "function") onError(error ?? new Error("uiWorkspace.openSession unavailable"));
            });
          }, (e) => {
            if (typeof onError === "function") onError(e);
          });
          return true;
        }
        if (typeof onError === "function") onError(new Error("uiWorkspace / sessions unavailable"));
        return false;
      },
      /**
       * 打开（选中）一个会话。
       *
       * DSH 0.1.7 起 `ctx.sessions`（ClientSessions）**不再有 `open`**：会话
       * 选中/打开属于 UI 导航能力，由 `ctx.uiWorkspace.openSession()` 承担
       * （官方侧边栏的 `open` 就是它）。桌面版内嵌的 dsh 是 0.1.7-rc.2，所以
       * 只调用 `sessions.open()` 会让每一条会话行都「点了没反应」——typeof
       * 守卫把缺失的方法静默吞掉，连报错都没有。旧版（如 dsh web 0.1.5）仍
       * 保留 `sessions.open`，这里作为兜底。
       * @param sessionId - 目标会话 id。
       * @returns 是否已派发打开请求。
       */
      openSession(sessionId, onError) {
        /** 失败统一出口：把原因交给调用方提示，绝不让异常炸在 onClick 里。 */
        const fail = (error) => {
          if (typeof onError === "function") onError(error ?? null);
          return false;
        };
        const svc = resolveUiWorkspace();
        if (svc && typeof svc.openSession === "function") {
          // 官方 openSession 对未知/陈旧 id 会同步抛
          // `sessions.retain: unknown session <id>`。
          try {
            svc.openSession(sessionId);
            return true;
          } catch (error) {
            return fail(error);
          }
        }
        if (sessions !== undefined && typeof sessions.open === "function") {
          try {
            sessions.open(sessionId);
            return true;
          } catch (error) {
            return fail(error);
          }
        }
        return fail(null);
      },
      /**
       * 打开 Host 原生目录选择器。
       * @returns 选中目录，取消返回 null。
       */
      async pickDirectory() {
        const svc = resolveUiWorkspace();
        if (svc && typeof svc.pickDirectory === "function") return svc.pickDirectory();
        if (workspaces !== undefined && typeof workspaces.pickDirectory === "function") {
          return workspaces.pickDirectory();
        }
        throw new Error("uiWorkspace.pickDirectory unavailable");
      },
    };

    // 常驻接管 sidebar.workspaces（single 槽位，priority:-100 阴影官方
    // WorkspaceBrowser）：核心会话浏览器 + 「📚 笔记」顶级行 + 行下笔记树。
    ctx.slots.inject("sidebar.workspaces", () => {
      const dispose = ctx.slots.register(
        {
          name: "sidebar.workspaces",
          id: "obsidian-workspace-sidebar",
          priority: -100,
          locale: NS,
          inject: () => ({ workspaces, sessions, uiWorkspace }),
        },
        WorkspaceSidebar,
      );
      return () => dispose();
    });

    // 官方输入动作面桥接（见 ComposerBridge）：只有 session 作用域槽位才拿得到
    // `inputActions`，DSH 0.2+ 的 composer 是 Lexical contenteditable，DOM 注入
    // 已不是稳定入口。槽位或服务缺失（旧版 DSH）时该注册不生效，注入自动退回 DOM。
    try {
      ctx.slots.inject("conversation.composer.dock", () => {
        try {
          const disposeBridge = ctx.slots.register(
            { name: "conversation.composer.dock", id: "obsidian-composer-bridge", order: 1, label: "Obsidian composer bridge" },
            ComposerBridge,
          );
          return () => disposeBridge();
        } catch {
          return () => { };
        }
      });
    } catch { /* 旧版 DSH 无该槽位：忽略，走 DOM 兜底 */ }

    // 右侧 Dock + Toast + 输入卡片（shell.overlay 为 list 槽位，可叠加）
    ctx.slots.inject("shell.overlay", () => {
      const d1 = ctx.slots.register(
        { name: "shell.overlay", id: "obsidian-dock", order: 30, label: "Obsidian note dock", locale: NS, inject: () => ({ workspaces }) },
        Dock,
      );
      const d2 = ctx.slots.register(
        { name: "shell.overlay", id: "obsidian-toast", order: 5, label: "Obsidian toast", locale: NS },
        Toast,
      );
      const d3 = ctx.slots.register(
        { name: "shell.overlay", id: "obsidian-prompt", order: 6, label: "Obsidian text prompt", locale: NS },
        Prompt,
      );
      return () => {
        d1();
        d2();
        d3();
      };
    });
  }

  exports.apply = apply;
  exports.inject = inject;
})();
