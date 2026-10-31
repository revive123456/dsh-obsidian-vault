# Demo environment and asset pipeline

Everything in [`docs/assets`](../../docs/assets) is produced by this directory:
an isolated DeepSeek Harness instance, a throwaway vault, and a headless Chrome
driven over the DevTools Protocol. No dependency on playwright/puppeteer, no real
`~/.dsh`, no real notes.

## Isolation guarantees

- `DSH_HOME` points at a scratch directory (`/tmp/dsh-storefront-demo/home` by
  default). The real `~/.dsh` is never read or written.
- The vault is a copy of the committed demo vault (`tools/demo/vault/`), served
  from the scratch directory. The workspace row is seeded in the scratch store
  and points at `/tmp/.../workspace`.
- The profile patch is written inside the scratch `DSH_HOME` and pins the locale
  to English and the first-use directory to the scratch root.
- The web server runs on port **5601** (the packaging verification uses 5599).

## Prerequisites

- macOS with Google Chrome at
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (set `CHROME=…`
  otherwise). Chrome 155 was used.
- `ffmpeg` (7.1.1 was used; set `FFMPEG=…` if it lives elsewhere).
- Node.js `^22.19 || >=24` (global `WebSocket` is required).
- Network access **on first run only**: `setup.sh start` installs
  `@deepseek-ai/dsh@0.2.1-rc.5` into the scratch directory. Reuse an existing
  install with `DSH_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js`.
- `pnpm` on `PATH` (`dsh plugin` forwards to it).

## Produce the assets

```bash
# 1) boot the isolated demo (installs DSH and the plugin on first run)
tools/demo/setup.sh start
#    → prints the authenticated URL; reuse it with:
export DSH_URL="$(tools/demo/setup.sh url)"

# 2) static screenshots → docs/assets/screenshot-*.png (2x device scale)
node tools/demo/capture.mjs shots

# 3) hero recording → /tmp/dsh-storefront-demo/frames/ (variable-rate JPEG)
node tools/demo/capture.mjs record

# 4) frames → docs/assets/hero.gif (resampled to 10 fps, palette-optimised,
#    retries smaller encodings until it fits the 5 MB budget)
node tools/demo/make-gif.mjs

# stop / wipe the scratch environment
tools/demo/setup.sh stop
tools/demo/setup.sh reset
```

`capture.mjs` also has a `probe` mode (`DSH_URL=… node tools/demo/capture.mjs
probe`) that dumps the sidebar DOM state and two screenshots into the scratch
directory — useful when a selector stops matching after a DSH upgrade.

## Files

| Path | Purpose |
| --- | --- |
| `vault/` | The committed demo vault: 9 notes with callouts, tables, fenced code, task lists, wikilinks, frontmatter and one generated attachment. |
| `make-demo-image.mjs` | Pure-Node PNG generator for `vault/attachments/demo-attachment.png` (no image libraries). |
| `setup.sh` | Isolated DSH install/seed/boot (`start`), `stop`, `reset`, `url`. |
| `capture.mjs` | Zero-dependency CDP driver: `shots`, `record`, `probe`. |
| `make-gif.mjs` | Timestamped frames → fixed-fps GIF via ffmpeg. |

## How the recording works

- `capture.mjs` launches `chrome --headless=new --remote-debugging-port=0`, then
  connects to the page target over the DevTools WebSocket (`Page`, `Runtime`,
  `Input`, `Emulation` domains).
- Before navigating it sets an English locale (`Emulation.setLocaleOverride` +
  `Accept-Language`); a fresh scratch `DSH_HOME` has no stored language
  preference, so the client falls back to that.
- The first-run modals (release notes / "Get started") render a full-page mask
  that swallows every real mouse event. `prepare()` dismisses them and waits for
  a quiet window before the scripted clicks start.
- Actions are real mouse/key events (`Input.dispatchMouseEvent`,
  `Input.insertText`), so the recorded UI is the same one a user sees.
- `record` screenshots the page at ~11 fps while the scenario runs, storing each
  frame with its timestamp in `manifest.json`.
- `make-gif.mjs` resamples the variable-rate frames onto 10 fps, builds a palette
  and loops forever. The size budget is enforced by retrying with fewer colours
  and a smaller width.

## Changing the demo

- Edit the notes under `vault/` (they are plain Markdown) or add files/folders.
- The scenario steps live in `shots()` / `record()` in `capture.mjs`; selectors
  use the plugin's own classes (`dsh-obs-*`) where possible.
- Keep the GIF honest: it must show the real product, not a mock.
