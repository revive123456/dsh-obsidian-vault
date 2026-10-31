#!/usr/bin/env node
/**
 * Turn the raw CDP frames from `capture.mjs record` into the README hero GIF.
 *
 * - resamples the variable-length frame intervals onto a fixed frame rate
 * - builds an optimal palette and loops forever
 * - retries with a smaller encoding if the GIF exceeds the size budget
 *
 * Usage: node tools/demo/make-gif.mjs [--out docs/assets/hero.gif]
 * Env:  FRAMES_DIR (default /tmp/dsh-storefront-demo/frames)
 *       GIF_MAX_BYTES (default 5 MB), GIF_WIDTH (default 1280)
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const FRAMES_DIR = process.env.FRAMES_DIR || "/tmp/dsh-storefront-demo/frames";
const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";
const MAX_BYTES = Number(process.env.GIF_MAX_BYTES || 5 * 1024 * 1024);
const WIDTH = Number(process.env.GIF_WIDTH || 1280);

const argOut = process.argv.indexOf("--out");
const OUT = argOut > 0 ? resolve(process.argv[argOut + 1]) : join(REPO, "docs", "assets", "hero.gif");

function die(message) {
  console.error(`make-gif.mjs: ${message}`);
  process.exit(1);
}

if (!existsSync(FFMPEG)) die(`ffmpeg not found at ${FFMPEG} (set FFMPEG=…)`);
const manifestPath = join(FRAMES_DIR, "manifest.json");
if (!existsSync(manifestPath)) die(`no manifest at ${manifestPath}; run capture.mjs record first`);

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const frames = manifest.frames ?? [];
if (frames.length < 10) die(`only ${frames.length} frames recorded; nothing to build`);

/** Resample the timestamped frames onto a fixed fps sequence of copies. */
function resample(fps) {
  const step = 1000 / fps;
  const duration = frames[frames.length - 1].t;
  const seqDir = join(FRAMES_DIR, `seq-${fps}fps`);
  rmSync(seqDir, { recursive: true, force: true });
  mkdirSync(seqDir, { recursive: true });
  let cursor = 0;
  let count = 0;
  for (let t = 0; t <= duration; t += step) {
    while (cursor + 1 < frames.length && frames[cursor + 1].t <= t) cursor += 1;
    count += 1;
    copyFileSync(frames[cursor].file, join(seqDir, `frame-${String(count).padStart(5, "0")}.jpg`));
  }
  return { seqDir, count, seconds: duration / 1000 };
}

function encode(seqDir, fps, { colors, width, dither }) {
  mkdirSync(dirname(OUT), { recursive: true });
  const filter = [
    `[0:v]scale=${width}:-1:flags=lanczos,split[s0][s1]`,
    `[s0]palettegen=max_colors=${colors}:stats_mode=diff[p]`,
    `[s1][p]paletteuse=dither=${dither}:diff_mode=rectangle[out]`,
  ].join(";");
  const args = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", String(fps),
    "-i", join(seqDir, "frame-%05d.jpg"),
    "-filter_complex", filter,
    "-map", "[out]",
    "-loop", "0",
    OUT,
  ];
  const run = spawnSync(FFMPEG, args, { encoding: "utf8" });
  if (run.status !== 0) die(`ffmpeg failed:\n${run.stderr || run.stdout}`);
  return statSync(OUT).size;
}

// Try a few encodings, from best-looking to smallest, and keep the first that
// fits the budget. The GIF is documentation, so legibility beats colour count.
const attempts = [
  { fps: 10, colors: 192, width: WIDTH, dither: "sierra2_4a" },
  { fps: 10, colors: 128, width: WIDTH, dither: "bayer:bayer_scale=3" },
  { fps: 8, colors: 96, width: Math.min(WIDTH, 1120), dither: "bayer:bayer_scale=3" },
  { fps: 8, colors: 64, width: Math.min(WIDTH, 1000), dither: "bayer:bayer_scale=3" },
];

for (const attempt of attempts) {
  const { seqDir, count, seconds } = resample(attempt.fps);
  const bytes = encode(seqDir, attempt.fps, attempt);
  const kb = (bytes / 1024).toFixed(0);
  console.log(`hero.gif: ${count} frames @${attempt.fps}fps (${seconds.toFixed(1)}s), colors=${attempt.colors}, width=${attempt.width} → ${kb} KB`);
  if (bytes <= MAX_BYTES) {
    console.log(`wrote ${OUT} (${(bytes / 1024 / 1024).toFixed(2)} MB, budget ${(MAX_BYTES / 1024 / 1024).toFixed(1)} MB)`);
    process.exit(0);
  }
  console.log(`  over budget (${(bytes / 1024 / 1024).toFixed(2)} MB), trying a smaller encoding…`);
}
die(`could not get the GIF under ${(MAX_BYTES / 1024 / 1024).toFixed(1)} MB — trim the recording or lower GIF_WIDTH`);
