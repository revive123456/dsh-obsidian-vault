/**
 * 会话日志的带外维护（host 侧）。
 *
 * DSH 的持久化层**不提供**删除或保留接口 ——
 * `dsh-session-persistence` README 原文：「无删除或保留接口——剪枝已存储会话
 * 属于带外后端维护」。所以插件要支持「彻底删除会话」，只能在文件系统层面
 * 复刻官方 jsonl 后端的目录布局：
 *
 *   $DSH_HOME/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.vN.jsonl.zstd
 *
 * 因此这里镜像了 `dsh-session-persistence-jsonl` 的两个纯函数：
 *   - `encodeSegment`：id → 单个安全路径段（`.`/`..` 特判，其余非
 *     `[A-Za-z0-9._-]` 字符转 `~XXXX`）；
 *   - 项目目录名不进代码：删除按「扫描 sessions/* 下名为该段的目录」发现，
 *     于是不必知道 `projectKey` 的有损规则，也能覆盖 `_no-cwd` 等分组。
 *
 * 同时清掉对应的投影缓存 `storages/session_projcache/sessions/<id>.json`，
 * 否则重启后冷读缓存里仍会残留一条指向已删日志的记录。
 */
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { dshHome } from "./vault-store.js";

/** 会话 id 的合法形态：官方 id 只由 `[A-Za-z0-9._-]` 组成。 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** 一次请求允许删除的会话数上限（父会话 + 子代理闭包远小于此）。 */
export const SESSION_DELETE_LIMIT = 500;

/**
 * 镜像 `dsh-session-persistence-jsonl` 的 `encodeSegment`。
 * @param raw - 待编码的非空字符串。
 * @returns 可作为单个路径段的转义结果。
 */
export function encodeSegment(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("cannot encode an empty path segment");
  }
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/**
 * 判断一个字符串是否是可安全删除的会话 id。
 * @param id - 待校验的值。
 * @returns 合法（且不是 `.` / `..`）时为 true。
 */
export function isValidSessionId(id) {
  return typeof id === "string"
    && SESSION_ID_PATTERN.test(id)
    && id !== "."
    && id !== "..";
}

/** 会话日志根目录：$DSH_HOME/sessions。 */
export function sessionsRoot() {
  return join(dshHome(), "sessions");
}

/** 某个会话的投影缓存文件路径。 */
export function projectionCachePath(id) {
  return join(dshHome(), "storages", "session_projcache", "sessions", `${encodeSegment(id)}.json`);
}

/**
 * 定位一个会话 id 在磁盘上的全部会话目录。
 * 官方目录名就是 `encodeSegment(id)`，所以按该段名扫描每个项目分组即可，
 * 无需知道会话的 cwd，也无需知道 `projectKey` 的转义规则。
 * @param id - 已校验的会话 id。
 * @returns 扫描到的会话目录（通常 0 或 1 个）与本次使用的根目录。
 */
export async function findSessionDirs(id) {
  const root = sessionsRoot();
  const segment = encodeSegment(id);
  let groups;
  try {
    groups = await readdir(root, { withFileTypes: true });
  } catch {
    return { root, dirs: [] };
  }
  const dirs = [];
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const candidate = join(root, group.name, segment);
    try {
      const st = await lstat(candidate);
      // 只删真实目录：符号链接一律跳过，避免借链接删到根目录之外。
      if (st.isDirectory() && !st.isSymbolicLink()) dirs.push(candidate);
    } catch {
      // 该分组下没有这个会话，正常情况。
    }
  }
  return { root, dirs };
}

/**
 * 删除后校验：该会话在磁盘上是否真的什么都不剩。
 *
 * 删除接口只把「确实不存在了」的 id 报为成功，所以必须回读确认 —— 仅凭
 * `rm` 没有抛错不足以证明删除彻底（权限、占用、只读挂载都可能让它静默留下）。
 * @param id - 已校验的会话 id。
 * @returns `present` 为是否存在残留，`reason` 指出残留种类。
 */
export async function sessionArtifactsPresent(id) {
  const { dirs } = await findSessionDirs(id);
  if (dirs.length > 0) return { present: true, reason: "session directory" };
  try {
    await lstat(projectionCachePath(id));
    return { present: true, reason: "projection cache" };
  } catch {
    return { present: false, reason: null };
  }
}

/**
 * 彻底删除一个会话的磁盘痕迹：会话目录（含其中的 lock 与全部日志代）
 * 加上它的投影缓存。调用方须再用 {@link sessionArtifactsPresent} 回读确认。
 * @param id - 已校验的会话 id。
 * @returns 删除结果（`{ root, dirs, cacheRemoved }`）；找不到不算错误。
 */
export async function purgeSession(id) {
  const { root, dirs } = await findSessionDirs(id);
  const removed = [];
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  const cache = projectionCachePath(id);
  let cacheRemoved = false;
  try {
    await lstat(cache);
    await rm(cache, { force: true });
    cacheRemoved = true;
  } catch {
    // 缓存缺失属正常（该会话可能从未写入投影缓存）。
  }
  return { root, dirs: removed, cacheRemoved };
}
