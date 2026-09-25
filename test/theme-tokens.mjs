/**
 * DSH 主题变量契约测试（离线）。
 *
 * 插件只允许引用 DSH 主题里真实存在的 `--dsw-*` 别名。历史事故：toast 用了
 * 主题未定义的 `--dsw-alias-bg-inverted`，导致 background 声明失效变透明，
 * 而文字色是浅色主题下的白色 —— 界面上只剩一个「底部白框、没有文字」，
 * 所有删除/归档提示都看不见。这类拼错不会报错，只会静默消失，所以要钉住。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "client.js"), "utf8");
const built = readFileSync(join(root, "lib", "client.js"), "utf8");

// 已在 DeepSeek Harness 0.1.7-rc.2 主题里核验存在的别名
// （dsh-client-ui-theme/lib/client.js 的 body / body[data-ds-dark-theme] 两套）。
const VERIFIED = new Set([
  "--dsw-alias-bg-overlay",
  "--dsw-alias-border-l1",
  "--dsw-alias-border-l2",
  "--dsw-alias-brand-primary",
  "--dsw-alias-button-primary-fill",
  "--dsw-alias-button-primary-hover",
  "--dsw-alias-interactive-bg-hover",
  "--dsw-alias-interactive-bg-hover-accent",
  "--dsw-alias-label-dimmed",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-primary-foreground",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-scrollbar-bg-l2",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-toast-bg",
  "--dsw-alias-toast-label",
  "--dsw-radius-lg",
]);

const failures = [];
function check(name, cond, extra = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures.push(name);
}

const used = (text) => [...new Set([...text.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))].sort();

for (const [label, text] of [["src", src], ["lib", built]]) {
  const unknown = used(text).filter((v) => !VERIFIED.has(v));
  check(`${label} 只引用已核验的 --dsw-* 别名`, unknown.length === 0, unknown.join(", "));
}
check("不再以 var() 引用不存在的 --dsw-alias-bg-inverted", !src.includes("var(--dsw-alias-bg-inverted"));

const toast = /\.dsh-obs-toast\{([^}]*)\}/.exec(src)?.[1] ?? "";
check("toast 有真实背景色变量", toast.includes("var(--dsw-alias-toast-bg"), toast);
check("toast 有真实文字色变量", toast.includes("var(--dsw-alias-toast-label"), toast);
check("toast 背景不再是透明（无 background 缺失）", /background:var\(--dsw-alias-toast-bg/.test(toast), toast);
check("toast 不拦截点击", toast.includes("pointer-events:none"), toast);
check("toast 不再压在输入框上（顶部居中）", toast.includes("top:40px") && !toast.includes("bottom:26px"), toast);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) FAILED: ${failures.join(" | ")}`);
  process.exit(1);
}
console.log("\nall theme-token checks passed ✔");
