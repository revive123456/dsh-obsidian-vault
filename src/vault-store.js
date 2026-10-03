/**
 * Vault 根目录与附件行为的持久化管理（host 侧）：
 * 设置文件位于 $DSH_HOME/dsh-obsidian-vault.json（DSH_HOME 缺省 ~/.dsh），
 * 默认 Vault 根 = $DSH_WORKSPACE/obsidian_vault（DSH_WORKSPACE 缺省 process.cwd()）。
 *
 * 附件设置对齐 Obsidian「Files & Links」的两组**独立**选项：
 *   · 位置（attachmentMode）：root（Vault 根）/ fixed（固定目录）/ note（与笔记同目录）
 *     / sub（笔记目录下的子目录）
 *   · 链接格式：固定用 Obsidian 默认的「shortest path when possible」，由 index.js
 *     的 embedTargetFor 决定，**与位置设置解耦**（位置只管存哪里，链接只管怎么写）。
 */
import { readFile, writeFile, rename, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const SETTINGS_FILENAME = "dsh-obsidian-vault.json";

/** 附件落盘位置模式（对应 Obsidian 的「Default location for new attachments」）。 */
export const ATTACHMENT_MODES = new Set(["root", "fixed", "note", "sub"]);

/** DSH 主目录：$DSH_HOME（缺省 ~/.dsh）。会话日志、投影缓存等都在其下。 */
export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ""
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh");
}

export function settingsPath() {
  return join(dshHome(), SETTINGS_FILENAME);
}

/** 默认 Vault 根：$DSH_WORKSPACE/obsidian_vault，缺省 process.cwd()/obsidian_vault。 */
export function defaultVaultRoot() {
  const ws = process.env.DSH_WORKSPACE;
  if (ws && ws.trim() !== "") return join(ws, "obsidian_vault");
  return join(process.cwd(), "obsidian_vault");
}

/**
 * 读设置。缺省值刻意保持**向后兼容**：老设置文件只有 `attachmentDir`，此时按
 * 「空 → Vault 根 / 非空 → 固定目录」还原出等价行为，既有用户语义不变。
 */
export async function readSettings() {
  let data = {};
  try {
    const parsed = JSON.parse(await readFile(settingsPath(), "utf8"));
    if (parsed && typeof parsed === "object") data = parsed;
  } catch {
    // 设置文件不存在或损坏：回到默认值。
  }
  const attachmentDir = typeof data.attachmentDir === "string" ? data.attachmentDir : "attachments";
  const vaultRoot = typeof data.vaultRoot === "string" && data.vaultRoot.trim() !== "" ? data.vaultRoot : null;
  return {
    vaultRoot,
    attachmentDir,
    attachmentMode: typeof data.attachmentMode === "string" && ATTACHMENT_MODES.has(data.attachmentMode)
      ? data.attachmentMode
      : (attachmentDir === "" ? "root" : "fixed"),
    attachmentSubfolder: typeof data.attachmentSubfolder === "string" && data.attachmentSubfolder.trim() !== ""
      ? data.attachmentSubfolder.trim()
      : "attachments",
    // 目录树里隐藏附件目录（默认开；Obsidian 不隐藏，这里保留为可关闭的降噪选项）
    hideAttachmentDir: data.hideAttachmentDir !== false,
    // 保存笔记时自动删除孤儿附件（默认**关**：Obsidian 不自动删，误删不可恢复）
    deleteOrphanAttachments: data.deleteOrphanAttachments === true,
  };
}

export async function writeSettings(settings) {
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

/** 合并式写入：只覆盖 patch 里出现的字段，其余保持当前值。 */
export async function updateSettings(patch = {}) {
  const cur = await readSettings();
  const vaultRoot = patch.vaultRoot !== undefined ? patch.vaultRoot : cur.vaultRoot;
  const next = {
    ...(vaultRoot ? { vaultRoot } : {}),
    attachmentDir: patch.attachmentDir !== undefined ? patch.attachmentDir : cur.attachmentDir,
    attachmentMode: patch.attachmentMode !== undefined ? patch.attachmentMode : cur.attachmentMode,
    attachmentSubfolder: patch.attachmentSubfolder !== undefined ? patch.attachmentSubfolder : cur.attachmentSubfolder,
    hideAttachmentDir: patch.hideAttachmentDir !== undefined ? patch.hideAttachmentDir : cur.hideAttachmentDir,
    deleteOrphanAttachments: patch.deleteOrphanAttachments !== undefined
      ? patch.deleteOrphanAttachments
      : cur.deleteOrphanAttachments,
  };
  await writeSettings(next);
  return { ...next, vaultRoot: vaultRoot ?? null };
}

/**
 * 设置固定附件目录（POSIX "/" 分隔；"" 表示 Vault 根）。
 * 同时把位置模式切到 fixed / root —— 手填目录本身就表达了「用固定目录」。
 */
export async function setAttachmentDir(dir) {
  const next = await updateSettings({ attachmentDir: dir, attachmentMode: dir === "" ? "root" : "fixed" });
  return next.attachmentDir;
}

/**
 * 解析当前生效的 Vault 根：优先用户配置，否则默认值。
 * 返回 realpath（若目录存在）；目录不存在时返回 resolve 后的默认路径。
 */
export async function resolveVaultRoot() {
  const settings = await readSettings();
  const candidates = settings.vaultRoot ? [settings.vaultRoot] : [defaultVaultRoot()];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const real = await realpath(candidate);
      const st = await stat(real);
      if (st.isDirectory()) return real;
    } catch {
      // 不存在或不可访问，继续尝试下一个候选。
    }
  }
  return resolve(defaultVaultRoot());
}

/** 校验并保存用户选择的 Vault 根，返回 realpath。 */
export async function setVaultRoot(input) {
  if (typeof input !== "string" || input.trim() === "" || !isAbsolute(input)) {
    throw Object.assign(new Error("vault root must be an absolute path"), { status: 400 });
  }
  let real;
  try {
    real = await realpath(input);
  } catch {
    throw Object.assign(new Error(`directory does not exist: ${input}`), { status: 400 });
  }
  const st = await stat(real);
  if (!st.isDirectory()) {
    throw Object.assign(new Error(`not a directory: ${input}`), { status: 400 });
  }
  const next = await updateSettings({ vaultRoot: real });
  return next.vaultRoot ?? real;
}
