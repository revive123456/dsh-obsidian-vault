/**
 * Vault 根目录的持久化管理（host 侧）：
 * 设置文件位于 $DSH_HOME/dsh-obsidian-vault.json（DSH_HOME 缺省 ~/.dsh），
 * 默认 Vault 根 = $DSH_WORKSPACE/obsidian_vault（DSH_WORKSPACE 缺省 process.cwd()）。
 */
import { readFile, writeFile, rename, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const SETTINGS_FILENAME = "dsh-obsidian-vault.json";

export function settingsPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ""
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh");
  return join(home, SETTINGS_FILENAME);
}

/** 默认 Vault 根：$DSH_WORKSPACE/obsidian_vault，缺省 process.cwd()/obsidian_vault。 */
export function defaultVaultRoot() {
  const ws = process.env.DSH_WORKSPACE;
  if (ws && ws.trim() !== "") return join(ws, "obsidian_vault");
  return join(process.cwd(), "obsidian_vault");
}

export async function readSettings() {
  try {
    const raw = await readFile(settingsPath(), "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data.vaultRoot === "string" && data.vaultRoot.trim() !== "") {
      return { vaultRoot: data.vaultRoot };
    }
  } catch {
    // 设置文件不存在或损坏：回到默认值。
  }
  return { vaultRoot: null };
}

export async function writeSettings(settings) {
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
  await rename(tmp, path);
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
  await writeSettings({ vaultRoot: real });
  return real;
}
