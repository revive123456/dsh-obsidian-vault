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
    deleteWorkspaceConfirm: "删除工作区「{name}」？目录与文件保留，其会话将移入未分组。",
    renameSessionPrompt: "会话新标题",
    deleteSession: "删除会话（归档）",
    deleteSessionConfirm: "删除会话「{name}」？将从列表移除并归档，日志保留。",
    deleteUngrouped: "删除全部未分组会话",
    deleteUngroupedConfirm: "删除「{name}」中的 {n} 个会话？将从列表移除并归档，日志保留。",
    subagentsRunning: "{n} 个子代理运行中",
    renamed: "已重命名",
    deleted: "已删除",
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
    error: "出错了",
    imageInserted: "已插入图片",
    attachDir: "附件目录",
    attachDirPick: "选择附件目录（Vault 内）",
    attachDirEdit: "手写附件目录",
    attachDirClear: "清空（回到 Vault 根）",
    attachDirPlaceholder: "Vault 相对路径，如 docs/images",
    imageRemoved: "已同步删除未引用的图片",
    attachDirConfirm: "更改截图落盘目录：{from} → {to}。会**自动把原目录下的截图移动到新目录**、删除原目录（若空），并同步更新笔记里的引用路径。确认更改？",
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
    deleteWorkspaceConfirm: "Delete workspace “{name}”? The directory and files stay; its sessions move to Ungrouped.",
    renameSessionPrompt: "New session title",
    deleteSession: "Delete session (archive)",
    deleteSessionConfirm: "Delete session “{name}”? It is removed from the list and archived; the log is kept.",
    deleteUngrouped: "Delete all ungrouped sessions",
    deleteUngroupedConfirm: "Delete all {n} sessions in “{name}”? They are removed from the list and archived; logs are kept.",
    subagentsRunning: "{n} subagent(s) running",
    renamed: "Renamed",
    deleted: "Deleted",
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
    error: "Error",
    imageInserted: "Image inserted",
    attachDir: "Attachment dir",
    attachDirPick: "Choose attachment dir (inside vault)",
    attachDirEdit: "Type an attachment dir",
    attachDirClear: "Clear (back to vault root)",
    attachDirPlaceholder: "Vault-relative path, e.g. docs/images",
    imageRemoved: "Deleted unreferenced image(s)",
    attachDirConfirm: "Change screenshot dir: {from} → {to}. This will automatically move existing screenshots to the new dir, remove the old dir (if empty), and update note references. Continue?",
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

  let shared = { notesOpen: readNotesOpen(), openNote: null, vaultRev: 0, toast: null, noteCount: 0 };
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

  function showToast(message) {
    patchShared({ toast: message });
    window.setTimeout(() => {
      if (shared.toast === message) patchShared({ toast: null });
    }, 2600);
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
      throw new Error(json && json.error ? json.error : `HTTP ${res.status}`);
    }
    return json;
  }

  function mentionFor(absPath) {
    return /[\s"]/.test(absPath) ? `@"${absPath}"` : `@${absPath}`;
  }

  /** 把 @路径 注入对话输入框（React 受控 textarea 的 native setter + input 事件）。 */
  function insertIntoComposer(absPath) {
    const scroll = document.querySelector("div[data-input-scroll]");
    const textarea = scroll ? scroll.querySelector("textarea") : null;
    if (!textarea || textarea.disabled || textarea.readOnly) return false;
    const mention = mentionFor(absPath);
    const current = textarea.value;
    const separator = current !== "" && !current.endsWith("\n") ? "\n" : "";
    const next = `${current}${separator}${mention}\n`;
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

  /** 把任意文本（不只 @路径）注入对话输入框（native setter + input 事件） */
  function injectPrompt(text) {
    if (typeof document === "undefined" || typeof window === "undefined") return false;
    const scroll = document.querySelector("div[data-input-scroll]");
    const textarea = scroll ? scroll.querySelector("textarea") : null;
    if (!textarea || textarea.disabled || textarea.readOnly) return false;
    const prefix = textarea.value;
    const sep = prefix !== "" && !prefix.endsWith("\n") ? "\n" : "";
    const next = `${prefix}${sep}${text}\n`;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    try {
      if (setter) setter.call(textarea, next); else textarea.value = next;
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
    `.dsh-obs-md-row.dsh-obs-md-list .dsh-obs-md-lc{list-style:none}`,
    `.dsh-obs-md-row.dsh-obs-md-code .dsh-obs-md-lc{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:var(--dsw-alias-interactive-bg-hover);border-radius:4px;padding:1px 5px}`,

    `.dsh-obs-md h3,.dsh-obs-md h4,.dsh-obs-md h5,.dsh-obs-md h6{margin:14px 0 6px;line-height:1.4}`,
    `.dsh-obs-md p{margin:8px 0}`,
    `.dsh-obs-md ul,.dsh-obs-md ol{margin:8px 0;padding-left:22px}`,
    `.dsh-obs-md li{margin:3px 0}`,
    `.dsh-obs-md blockquote{margin:8px 0;padding:4px 12px;border-left:3px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-radius:0 6px 6px 0}`,
    `.dsh-obs-md code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:var(--dsw-alias-interactive-bg-hover);padding:1px 5px;border-radius:4px}`,
    `.dsh-obs-code{margin:8px 0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6}`,
    `.dsh-obs-md table{border-collapse:collapse;margin:8px 0}`,
    `.dsh-obs-md th,.dsh-obs-md td{border:1px solid var(--dsw-alias-border-l2);padding:4px 10px;font-size:12.5px}`,
    `.dsh-obs-md hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:12px 0}`,
    `.dsh-obs-md img{max-width:100%;border-radius:8px}`,
    `.dsh-obs-md a{color:var(--dsw-alias-brand-primary)}`,
    `.dsh-obs-wikilink{display:inline;padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font-size:inherit;text-decoration:underline;text-decoration-style:dotted}`,
    `.dsh-obs-wikilink:hover{color:var(--dsw-alias-label-primary)}`,
    `.dsh-obs-editor{flex:1;display:flex;min-height:0}`,
    `.dsh-obs-editor-gutter{flex:none;box-sizing:content-box;min-width:2ch;padding:12px 8px 12px 10px;text-align:right;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.7;white-space:pre;overflow:hidden;user-select:none;-webkit-user-select:none;border-right:1px solid var(--dsw-alias-border-l1);background:transparent}`,
    `.dsh-obs-editor textarea{flex:1;resize:none;border:0;outline:none;padding:12px 16px 12px 12px;background:transparent;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.7;white-space:pre;overflow:auto}`,
    `.dsh-obs-error{padding:8px 12px;font-size:12px;color:var(--dsw-alias-state-error-primary);border-top:1px solid var(--dsw-alias-border-l1)}`,
    `.dsh-obs-handle{position:absolute;left:-6px;top:14px;bottom:14px;width:12px;cursor:col-resize;border-radius:6px;z-index:2}`,
    `.dsh-obs-handle:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
    `body.dsh-obs-resizing{user-select:none;cursor:col-resize}`,
    // Toast
    `.dsh-obs-toast{pointer-events:none;position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:60;padding:8px 16px;border-radius:999px;background:var(--dsw-alias-bg-inverted);color:var(--dsw-alias-label-primary-foreground);font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,0.3)}`,
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

  const treeApi = {
    tree: (path = "") => api(`/tree?path=${encodeURIComponent(path)}`),
    search: (q) => api(`/search?q=${encodeURIComponent(q)}`),
    root: () => api("/root"),
    setRoot: (root) => api("/root", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root }),
    }),
    // 上传粘贴的图片（base64）→ { path }，embed 相对路径
    attach: (data) => api("/attach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    }),
    // 设置附件目录（POSIX 相对路径；"" = Vault 根）
    setAttachDir: (dir) => api("/attach-dir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir }),
    }),
    // embed/相对路径 → 图片字节流地址（预览用）
    assetUrl: (rel) => `/obsidian/file?path=${encodeURIComponent(rel)}`,
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
    absPath: (rel, root) => {
      const parts = rel.split("/").filter((p) => p !== "");
      return [root, ...parts].join("\\").replace(/^([a-zA-Z]):\\\\/, "$1:\\");
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

    const loadRoot = useCallback(async () => {
      setLoading(true);
      setError("");
      setDirs({});
      setExpanded(new Set());
      try {
        const info = await treeApi.root();
        setRootInfo(info);
        setAttachDirState(typeof info.attachmentDir === "string" ? info.attachmentDir : "attachments");
        if (info.exists) {
          const list = await treeApi.tree("");
          setDirs({ "": list.entries });
        }
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
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) next.delete(rel);
        else next.add(rel);
        return next;
      });
      if (dirs[rel] === undefined) {
        try {
          const list = await treeApi.tree(rel);
          setDirs((d) => ({ ...d, [rel]: list.entries }));
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        }
      }
    }, [dirs]);

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
      const value = window.prompt(t("pasteVaultTitle"));
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
      const name = window.prompt(t("noteNamePrompt"));
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
      const name = window.prompt(t("newFolderPrompt"));
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
      rootInfo && rootInfo.exists && attachDir !== null && createElement("div", { className: "dsh-obs-root-row", title: t("attachDir") },
        createElement("span", { className: "dsh-obs-root-path" },
          `📎 ${t("attachDir")}: ${attachDir === "" ? t("vaultRoot") : attachDir}`),
        createElement("button", {
          className: "dsh-obs-mini",
          title: t("attachDirPick"),
          onClick: (e) => { e.stopPropagation(); void pickAttachDir(); },
        }, "📂"),
        createElement("button", {
          className: "dsh-obs-mini",
          title: t("attachDirEdit"),
          onClick: (e) => { e.stopPropagation(); setAttachInput(attachDir); setAttachOpen((v) => !v); },
        }, "✎"),
        createElement("button", {
          className: "dsh-obs-mini",
          title: t("attachDirClear"),
          onClick: (e) => { e.stopPropagation(); void applyAttachDir(""); },
        }, "↺"),
      ),
      attachOpen && rootInfo && rootInfo.exists && createElement("div", { className: "dsh-obs-search" },
        createElement("input", {
          autoFocus: true,
          placeholder: t("attachDirPlaceholder"),
          value: attachInput,
          onChange: (e) => setAttachInput(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter") void applyAttachDir(attachInput);
            if (e.key === "Escape") setAttachOpen(false);
          },
        }),
      ),
      body,
      error !== "" && createElement("div", { className: "dsh-obs-error" }, error),
    );
  }

  // ── 常驻 WorkspaceSidebar（sidebar.workspaces 接管）─────────────────────────
  const EMPTY_SESSIONS = { ids: [], byId: {}, current: undefined, phase: "ready" };
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
    const current = sessionsState.current;

    const visibleSession = (sid) => {
      const s = byId[sid];
      if (!s || archived.has(sid)) return false;
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
    }, [items, ids, byId, archived, current]); // eslint-disable-line react-hooks/exhaustive-deps

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
    }, [ids, byId, archived, q, current]);

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

    const openSession = useCallback((sid) => {
      if (sessions && typeof sessions.open === "function") sessions.open(sid);
    }, [sessions]);

    const renameWorkspace = useCallback(async (workspaceId, currentTitle) => {
      if (!workspaces || typeof workspaces.rename !== "function") return;
      const name = window.prompt(t("renameWorkspacePrompt"), currentTitle);
      if (name === null || name.trim() === "" || name.trim() === currentTitle) return;
      try {
        await workspaces.rename(workspaceId, name.trim());
        showToast(t("renamed"));
      } catch (e) {
        showToast(`${t("error")}：${e && e.message ? e.message : e}`);
      }
    }, [workspaces, t]);

    const deleteWorkspace = useCallback(async (workspaceId, title) => {
      if (!workspaces || typeof workspaces.delete !== "function") return;
      if (!window.confirm(t("deleteWorkspaceConfirm", { name: title }))) return;
      try {
        await workspaces.delete(workspaceId);
        showToast(t("deleted"));
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
      const name = window.prompt(t("renameSessionPrompt"), currentTitle);
      if (name === null || name.trim() === "" || name.trim() === currentTitle) return;
      try {
        const result = await binding.session.rename(name.trim());
        if (!result.ok) throw new Error(result && result.error && result.error.message ? result.error.message : "rename failed");
        showToast(t("renamed"));
      } catch (e) {
        showToast(`${t("error")}：${e && e.message ? e.message : e}`);
      }
    }, [sessions, t]);

    // 会话「删除」= 平台归档语义（与官方浏览器一致：移出列表，日志保留）
    const deleteSession = useCallback(async (sid, title) => {
      if (!workspaces || typeof workspaces.archiveSession !== "function") return;
      if (!window.confirm(t("deleteSessionConfirm", { name: title }))) return;
      try {
        await workspaces.archiveSession(sid);
        showToast(t("deleted"));
      } catch (e) {
        showToast(`${t("error")}：${e && e.message ? e.message : e}`);
      }
    }, [workspaces, t]);

    // 「未分组」整组删除：逐个归档该组全部会话
    const deleteUngrouped = useCallback(async (sessionIds, name) => {
      if (!workspaces || typeof workspaces.archiveSession !== "function") return;
      if (sessionIds.length === 0) return;
      if (!window.confirm(t("deleteUngroupedConfirm", { n: sessionIds.length, name }))) return;
      try {
        await Promise.all(sessionIds.map((sid) => workspaces.archiveSession(sid)));
        showToast(t("deleted"));
      } catch (e) {
        showToast(`${t("error")}：${e && e.message ? e.message : e}`);
      }
    }, [workspaces, t]);

    const sessionRow = (sid) => {
      const s = byId[sid];
      if (!s) return null;
      const selected = s.id === current;
      const subs = runningSubagents.get(sid) ?? 0;
      return createElement("div", {
        key: sid,
        className: `dsh-obs-session${selected ? " dsh-obs-selected" : ""}`,
        onClick: () => openSession(sid),
      },
        subs > 0
          ? createElement("span", {
            className: "dsh-obs-dot dsh-obs-dot-subs",
            title: t("subagentsRunning", { n: subs }),
            "aria-label": t("subagentsRunning", { n: subs }),
          }, "◍")
          : createElement("span", { className: "dsh-obs-dot" }, "·"),
        createElement("span", { className: "dsh-obs-session-title", title: s.displayTitle || s.title || s.id }, s.displayTitle || s.title || s.id),
        createElement("span", { className: "dsh-obs-time" }, formatRelativeTime(s.updatedAt, t)),
        createElement("span", { className: "dsh-obs-actions" },
          createElement("button", {
            title: t("rename"),
            onClick: (e) => {
              e.stopPropagation();
              void renameSession(sid, s.displayTitle || s.title || s.id);
            },
          }, "✎"),
          createElement("button", {
            title: t("deleteSession"),
            onClick: (e) => {
              e.stopPropagation();
              void deleteSession(sid, s.displayTitle || s.title || s.id);
            },
          }, "🗑"),
        ),
      );
    };

    const groupRow = (key, title, path, sessionIds) => {
      const isOpen = expanded.has(key);
      return createElement(Fragment, { key: key },
        createElement("div", { className: "dsh-obs-ws-row", onClick: () => toggleGroup(key) },
          createElement("span", { className: "dsh-obs-chev" }, isOpen ? "▾" : "▸"),
          createElement("span", { className: "dsh-obs-ws-icon" }, isOpen ? "📂" : "📁"),
          createElement("span", { className: "dsh-obs-ws-title", title: path }, title),
          key !== UNGROUPED_KEY && createElement("span", { className: "dsh-obs-actions" },
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
                void deleteWorkspace(key, title);
              },
            }, "🗑"),
          ),
          key === UNGROUPED_KEY && sessionIds.length > 0 && createElement("span", { className: "dsh-obs-actions" },
            createElement("button", {
              title: t("deleteUngrouped"),
              onClick: (e) => {
                e.stopPropagation();
                void deleteUngrouped(sessionIds, title);
              },
            }, "🗑"),
          ),
          key !== UNGROUPED_KEY && createElement("button", {
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
          sessionIds.map((sid) => sessionRow(sid)),
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
      createElement("button", {
        className: `dsh-obs-head-btn${searchOpen ? " dsh-obs-on" : ""}`,
        title: t("searchSessions"),
        onClick: () => {
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
      createElement("div", { className: "dsh-obs-ws-body" }, body),
    );
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
        const span = spanFromSelection(previewRef.current, leavesRef.current, note.content);
        if (span && !askOpenRef.current) {
          setAsk({ span, rect: selRect() || { top: 64, bottom: 96, left: 40 }, basePath: treeApi.absPath(note.path, root), content: note.content });
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

    // 编辑态选区（textarea 原生 selectionStart/End 直接切片）
    const onEditorSel = useCallback(() => {
      const ed = editorRef.current;
      if (!ed || !note) return;
      if (ed.selectionStart === ed.selectionEnd) { setAsk(null); return; }
      const start = ed.selectionStart, end = ed.selectionEnd;
      const r = ed.getBoundingClientRect ? ed.getBoundingClientRect() : null;
      setAsk({
        span: { text: note.content.slice(start, end), start, end, mode: "edit" },
        rect: r ? { top: r.top - 6, bottom: r.top + 32, left: r.left } : { top: 64, bottom: 96, left: 40 },
        basePath: treeApi.absPath(note.path, root),
        content: note.content,
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
            const r = await treeApi.attach(data);
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
      const name = window.prompt(t("renamePrompt"), note.name);
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

    const openWikilink = useCallback(async (target) => {
      if (editing && draft !== note && draft !== note.content && !window.confirm(t("discard"))) return;
      const r = await treeApi.search(target);
      const exact = r.results.find((x) => x.name.toLowerCase() === `${target.toLowerCase()}.md` || x.name.toLowerCase() === target.toLowerCase());
      const found = exact ?? r.results[0];
      if (!found) {
        showToast(`${t("wikilinkNotFound")}：[[${target}]]`);
        return;
      }
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
            createElement("div", { ref: previewRef, className: "dsh-obs-md" },
              renderNumbered(note.content, {
                onWikilink: (target) => void openWikilink(target),
                onText: () => {},
                assetUrl: (rel) => treeApi.assetUrl(rel),
              }),
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
            if (typeof sessions.open === "function") sessions.open(id);
          }, (e) => {
            if (typeof onError === "function") onError(e);
          });
          return true;
        }
        if (typeof onError === "function") onError(new Error("uiWorkspace / sessions unavailable"));
        return false;
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

    // 右侧 Dock + Toast（shell.overlay 为 list 槽位，可叠加）
    ctx.slots.inject("shell.overlay", () => {
      const d1 = ctx.slots.register(
        { name: "shell.overlay", id: "obsidian-dock", order: 30, label: "Obsidian note dock", locale: NS, inject: () => ({ workspaces }) },
        Dock,
      );
      const d2 = ctx.slots.register(
        { name: "shell.overlay", id: "obsidian-toast", order: 5, label: "Obsidian toast", locale: NS },
        Toast,
      );
      return () => {
        d1();
        d2();
      };
    });
  }

  exports.apply = apply;
  exports.inject = inject;
})();
