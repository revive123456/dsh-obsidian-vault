#!/usr/bin/env node
/**
 * Zero-dependency headless-Chrome driver for the README assets.
 *
 * Talks to Chrome over the DevTools Protocol with the Node >=22 global
 * `WebSocket`, so no playwright/puppeteer install is needed.
 *
 * Usage:
 *   DSH_URL="http://127.0.0.1:5601/?token=…" node tools/demo/capture.mjs shots
 *   DSH_URL="http://127.0.0.1:5601/?token=…" node tools/demo/capture.mjs record
 *
 *   SELFTEST_URL="file:///tmp/dsh-cdp-selftest.html" node tools/demo/capture.mjs selftest
 *
 * Outputs:
 *   shots  → docs/assets/*.png (2x device scale, clipped where useful)
 *   record → tools/demo/out/frames/frame-00001.jpg … + manifest.json
 *
 * Env:
 *   CHROME       Chrome binary (macOS default below)
 *   VIEWPORT     WxH, default 1280x800
 *   DEMO_DIR     scratch dir, default /tmp/dsh-storefront-demo
 *   ASSETS_DIR   screenshots dir, default <repo>/docs/assets
 *   HTTP_TIMEOUT wait for the DSH UI, seconds, default 90
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const DEMO_DIR = process.env.DEMO_DIR || "/tmp/dsh-storefront-demo";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ASSETS_DIR = process.env.ASSETS_DIR || join(REPO, "docs", "assets");
const FRAMES_DIR = process.env.FRAMES_DIR || join(DEMO_DIR, "frames");
const [VW, VH] = (process.env.VIEWPORT || "1280x800").split("x").map(Number);
const WAIT_UI_MS = Number(process.env.HTTP_TIMEOUT || 90) * 1000;

const mode = process.argv[2] || "shots";
const targetUrl = process.env.SELFTEST_URL || process.env.DSH_URL || "";

// ── CDP client ──────────────────────────────────────────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.method || "cdp"} ${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result);
        return;
      }
      const list = this.waiters.get(msg.method);
      if (list && list.length > 0) {
        const w = list.shift();
        this.waiters.delete(msg.method);
        w.resolve(msg.params);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
    });
  }

  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(method) ?? [];
      const waiter = { resolve: (v) => { clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => {
        const i = list.indexOf(waiter);
        if (i >= 0) list.splice(i, 1);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      list.push(waiter);
      this.waiters.set(method, list);
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

// ── Chrome lifecycle ────────────────────────────────────────────────────────
async function launchChrome(url) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME=…)`);
  const profile = join(DEMO_DIR, "chrome-profile");
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--mute-audio",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${VW},${VH}`,
    "--lang=en-US",
    url ?? "about:blank",
  ];
  const child = spawn(CHROME, args, { stdio: "ignore", detached: false });
  child.unref?.();
  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 30000;
  while (!existsSync(portFile)) {
    if (Date.now() > deadline) throw new Error("Chrome did not expose DevToolsActivePort");
    await sleep(100);
  }
  let port = 0;
  for (let i = 0; i < 30 && port === 0; i += 1) {
    const [first] = readFileSync(portFile, "utf8").split("\n");
    port = Number(first);
    if (port === 0) await sleep(100);
  }
  const listDeadline = Date.now() + 20000;
  let page = null;
  while (!page) {
    if (Date.now() > listDeadline) throw new Error("Chrome did not expose a page target");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch { /* not ready yet */ }
    if (!page) await sleep(150);
  }
  return { child, port, page };
}

// ── page helpers ────────────────────────────────────────────────────────────
function makePage(cdp) {
  const page = {
    cdp,

    async evaluate(expression) {
      const r = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error(`evaluate failed: ${d.text} ${d.exception?.description ?? ""}`.trim());
      }
      return r.result.value;
    },

    async waitFor(expression, { timeout = 20000, label = expression, interval = 100 } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          if (await page.evaluate(expression)) return true;
        } catch { /* page may be navigating */ }
        await sleep(interval);
      }
      throw new Error(`timeout waiting for ${label}`);
    },

    async rect(selector, text = null, { index = 0 } = {}) {
      const expr = `(() => {
        const sel = ${JSON.stringify(selector)};
        const want = ${JSON.stringify(text)};
        const idx = ${index};
        const nodes = [...document.querySelectorAll(sel)];
        const matches = nodes.filter((n) => {
          if (want === null) return true;
          return (n.textContent || "").trim().includes(want);
        });
        const el = matches[idx];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      })()`;
      const out = await page.evaluate(expr);
      if (!out) throw new Error(`element not found: ${selector}${text === null ? "" : ` containing ${JSON.stringify(text)}`}`);
      return out;
    },

    async waitRect(selector, text = null, { timeout = 15000, label } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const out = await page.evaluate(`(() => {
          const sel = ${JSON.stringify(selector)};
          const want = ${JSON.stringify(text)};
          const nodes = [...document.querySelectorAll(sel)];
          const el = nodes.find((n) => want === null || (n.textContent || "").trim().includes(want));
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        })()`);
        if (out) return out;
        await sleep(100);
      }
      throw new Error(`timeout waiting for ${label || `${selector} ${text ?? ""}`}`);
    },

    async mouse(x, y, type = "mouseMoved", buttons = 0, button = "none") {
      await cdp.send("Input.dispatchMouseEvent", { type, x, y, button, buttons, clickCount: type === "mousePressed" ? 1 : 0 });
    },

    async click(selector, text = null, { x = null, y = null } = {}) {
      let px = x, py = y;
      if (px === null) {
        const r = await page.waitRect(selector, text);
        px = r.x;
        py = r.y;
      }
      await page.mouse(px, py, "mouseMoved");
      await sleep(30);
      await page.mouse(px, py, "mousePressed", 1, "left");
      await sleep(40);
      await page.mouse(px, py, "mouseReleased", 0, "left");
    },

    /** Drag the mouse across an element's text to create a real selection. */
    async selectText(selector, text, { chars = null } = {}) {
      const r = await page.waitRect(selector, text);
      const pad = Math.min(4, r.width / 4);
      const x1 = r.left + pad;
      const x2 = r.right - pad;
      const y = r.top + r.height / 2;
      await page.mouse(x1, y, "mouseMoved");
      await page.mouse(x1, y, "mousePressed", 1, "left");
      const steps = 8;
      for (let i = 1; i <= steps; i += 1) {
        await page.mouse(x1 + ((x2 - x1) * i) / steps, y, "mouseMoved", 1, "left");
        await sleep(15);
      }
      await page.mouse(x2, y, "mouseReleased", 0, "left");
    },

    async type(text, { delay = 28 } = {}) {
      for (const ch of [...text]) {
        await cdp.send("Input.insertText", { text: ch });
        if (delay > 0) await sleep(delay);
      }
    },

    async press(key, { code = null, keyCode = null, modifiers = 0 } = {}) {
      const def = {
        Escape: { code: "Escape", keyCode: 27 },
        Enter: { code: "Enter", keyCode: 13 },
      }[key] || { code, keyCode };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers });
    },

    async scroll(selector, top, { smooth = true } = {}) {
      await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        if (${smooth}) el.scrollTo({ top: ${top}, behavior: "smooth" });
        else el.scrollTop = ${top};
        return true;
      })()`);
    },

    /**
     * Dismiss the first-run modals. Two are chained on a fresh DSH_HOME: the
     * release-notes dialog (button "Continue") and the "Get started" sign-in
     * prompt (aria-label "Close" / Escape). Both render a full-page mask, so
     * every real mouse click would be swallowed until they are gone. The
     * modals mount a few seconds after the shell, hence the polling window.
     */
    async dismissModals({ quietMs = 2500, maxMs = 12000 } = {}) {
      const start = Date.now();
      let quietSince = Date.now();
      while (Date.now() - start < maxMs) {
        const state = await page.evaluate(`(() => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const buttons = [...document.querySelectorAll("button")].filter(visible);
          const cont = buttons.find((b) => /^(继续|Continue|Got it|知道了)$/.test((b.textContent || "").trim()));
          const close = buttons.find((b) => /close|关闭/i.test(b.getAttribute("aria-label") || ""));
          return {
            cont: cont ? true : false,
            close: close ? true : false,
            mask: !!document.querySelector('[class*="_mask_"]'),
          };
        })()`);
        if (state.cont || state.close) {
          await page.evaluate(`(() => {
            const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            const buttons = [...document.querySelectorAll("button")].filter(visible);
            const cont = buttons.find((b) => /^(继续|Continue|Got it|知道了)$/.test((b.textContent || "").trim()));
            const close = buttons.find((b) => /close|关闭/i.test(b.getAttribute("aria-label") || ""));
            const target = cont || close;
            if (target) target.click();
            return !!target;
          })()`);
          quietSince = Date.now();
          await sleep(700);
          continue;
        }
        if (state.mask) {
          await page.press("Escape");
          quietSince = Date.now();
          await sleep(600);
          continue;
        }
        if (Date.now() - quietSince > quietMs) return true;
        await sleep(250);
      }
      return false;
    },

    async screenshotFile(path, { format = "png", quality = 90, scale = 1, clip = null } = {}) {
      const params = { format, fromSurface: true, captureBeyondViewport: false };
      if (format === "jpeg") params.quality = quality;
      if (clip) params.clip = { ...clip, scale };
      const { data } = await cdp.send("Page.captureScreenshot", params);
      writeFileSync(path, Buffer.from(data, "base64"));
      return path;
    },

    async screenshotBase64({ format = "jpeg", quality = 85 } = {}) {
      const { data } = await cdp.send("Page.captureScreenshot", { format, quality, fromSurface: true, captureBeyondViewport: false });
      return data;
    },
  };
  return page;
}

// ── scenarios ───────────────────────────────────────────────────────────────
const SEL = {
  notesRow: ".dsh-obs-notes-row",
  notesPane: ".dsh-obs-notes-pane",
  treeRow: ".dsh-obs-row",
  dock: ".dsh-obs-dock",
  dockBody: ".dsh-obs-dock-body",
  md: ".dsh-obs-md",
  src: ".dsh-obs-src",
  editor: ".dsh-obs-editor textarea",
  askbar: ".dsh-obs-askbar",
  askpop: ".dsh-obs-askpop",
  toast: ".dsh-obs-toast",
};

async function openNotes(page) {
  const paneExpr = `!!document.querySelector(${JSON.stringify(SEL.notesPane)})`;
  if (await page.evaluate(paneExpr)) return;
  // A late-mounting first-run modal can swallow the first click; retry after
  // clearing any mask that appeared after `prepare()`.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await page.evaluate(`!!document.querySelector('[class*="_mask_"]')`)) {
      await page.dismissModals({ quietMs: 1200, maxMs: 8000 });
    }
    await page.click(SEL.notesRow);
    try {
      await page.waitFor(paneExpr, { timeout: 4000, label: "notes tree" });
      await sleep(600);
      return;
    } catch { /* retry */ }
  }
  await page.waitFor(paneExpr, { timeout: 5000, label: "notes tree" });
}

/** True while a first-run modal mask is up (it swallows every real click). */
async function maskUp(page) {
  return page.evaluate(`!!document.querySelector('[class*="_mask_"]')`);
}

async function clearMask(page) {
  if (await maskUp(page)) {
    await page.dismissModals({ quietMs: 1200, maxMs: 10000 });
    await sleep(300);
  }
}

async function expandFolder(page, name, childName) {
  const expanded = `(() => {
    const rows = [...document.querySelectorAll(${JSON.stringify(SEL.treeRow)})];
    const el = rows.find((n) => (n.textContent || "").trim().includes(${JSON.stringify(name)}));
    return el ? (el.textContent || "").trim().includes("▾") : false;
  })()`;
  if (await page.evaluate(expanded)) return;
  const wantChild = `(() => [...document.querySelectorAll(${JSON.stringify(SEL.treeRow)})]
    .some((n) => (n.textContent || "").includes(${JSON.stringify(childName)})))()`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await clearMask(page);
    await page.click(SEL.treeRow, name);
    for (let i = 0; i < 20; i += 1) {
      if (await page.evaluate(wantChild)) return;
      await sleep(150);
    }
  }
  throw new Error(`folder ${JSON.stringify(name)} did not reveal ${JSON.stringify(childName)}`);
}

async function openNote(page, name) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await clearMask(page);
    await page.click(SEL.treeRow, name);
    try {
      await page.waitFor(`!!document.querySelector(${JSON.stringify(SEL.md)})`, { timeout: 5000, label: "preview" });
      await sleep(500);
      return;
    } catch { /* retry */ }
  }
  throw new Error(`note ${JSON.stringify(name)} did not open`);
}

async function prepare(page) {
  await page.waitFor(`!!document.querySelector(${JSON.stringify(SEL.notesRow)})`, { timeout: WAIT_UI_MS, label: "dsh shell + plugin sidebar" });
  await page.waitFor(`document.readyState === "complete"`, { label: "document complete" });
  await page.evaluate(`document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true`);
  // The first-run modals mount after the shell: keep polling for a few seconds
  // so they cannot swallow the first real click.
  await page.dismissModals({ quietMs: 4000, maxMs: 15000 });
  await sleep(500);
}

/** Static screenshots for the README (2x device scale). */
async function shots(page) {
  const out = ASSETS_DIR;
  mkdirSync(out, { recursive: true });
  const dockShot = async (name) => {
    const dock = await page.rect(SEL.dock);
    await page.screenshotFile(join(out, name), {
      scale: 2,
      clip: { x: dock.left, y: dock.top, width: dock.width, height: dock.height },
    });
    console.log(`shot: ${name.replace(/^screenshot-|\.png$/g, "")}`);
  };

  // 1) full window: notes tree in the sidebar + the docked preview
  await openNotes(page);
  await expandFolder(page, "Notes", "Callout gallery");
  await openNote(page, "Callout gallery");
  await sleep(800);
  await page.screenshotFile(join(out, "screenshot-sidebar.png"), { scale: 2, clip: { x: 0, y: 0, width: VW, height: VH } });
  console.log("shot: sidebar");

  // 2) callout rendering close-up
  await page.scroll(SEL.dockBody, 120);
  await sleep(900);
  await dockShot("screenshot-callouts.png");

  // 3) real tables + fenced code, on the syntax note
  await openNote(page, "Markdown syntax");
  await page.scroll(SEL.dockBody, 150);
  await sleep(900);
  await dockShot("screenshot-markdown.png");

  // 4) edit mode: line-numbered source editor
  await page.click(".dsh-obs-dock-head button", "Edit");
  await page.waitFor(`!!document.querySelector(${JSON.stringify(SEL.editor)})`, { label: "editor" });
  await sleep(700);
  await dockShot("screenshot-editing.png");
  await page.click(".dsh-obs-dock-head button", "Cancel");
  await sleep(500);

  // 5) selection in the rendered preview → Ask popup with a drafted question
  await openNote(page, "Callout gallery");
  await page.scroll(SEL.dockBody, 340);
  await sleep(700);
  await page.selectText(SEL.src, "Why are there line numbers on every preview");
  await page.waitFor(`!!document.querySelector(${JSON.stringify(SEL.askbar)})`, { timeout: 5000, label: "ask bar" });
  await page.click(`${SEL.askbar} button`, "Ask");
  await page.waitFor(`!!document.querySelector(".dsh-obs-askta")`, { label: "ask popup" });
  await page.evaluate(`(() => {
    const ta = document.querySelector(".dsh-obs-askta");
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    return true;
  })()`);
  await page.type("Where does the line number come from?", { delay: 25 });
  await sleep(700);
  await dockShot("screenshot-ask.png");
}

/** Capture frames while driving the hero GIF workflow. */
async function record(page) {
  rmSync(FRAMES_DIR, { recursive: true, force: true });
  mkdirSync(FRAMES_DIR, { recursive: true });
  const frames = [];
  const started0 = Date.now();
  let running = true;
  const targetFrameMs = Number(process.env.FRAME_MS || 90);

  const loop = (async () => {
    while (running) {
      const started = Date.now();
      try {
        const data = await page.screenshotBase64({ format: "jpeg", quality: 82 });
        const file = join(FRAMES_DIR, `frame-${String(frames.length + 1).padStart(5, "0")}.jpg`);
        writeFileSync(file, Buffer.from(data, "base64"));
        frames.push({ file, t: Date.now() - started0 });
      } catch { /* capture can fail while the page is busy; skip that frame */ }
      const spent = Date.now() - started;
      if (spent < targetFrameMs) await sleep(targetFrameMs - spent);
    }
  })();

  await sleep(400);

  // 1. notes panel closed → open the notes tree
  await openNotes(page);
  await sleep(900);

  // 2. expand two folders
  await expandFolder(page, "Notes", "Callout gallery");
  await sleep(500);
  await expandFolder(page, "Projects", "Roadmap");
  await sleep(700);

  // 3. open the callout gallery note
  await openNote(page, "Callout gallery");
  await sleep(1600);

  // 4. scroll through the rendered callouts
  await page.scroll(SEL.dockBody, 330);
  await sleep(1200);

  // 4b. hop to the syntax note to show real tables and fenced code
  await openNote(page, "Markdown syntax");
  await page.scroll(SEL.dockBody, 60);
  await sleep(1300);

  // 4c. back to the callout note for the editing step
  await openNote(page, "Callout gallery");
  await sleep(600);

  // 5. edit the note: line-numbered source editor, type a new callout
  await page.scroll(SEL.dockBody, 0);
  await sleep(400);
  await page.click(".dsh-obs-dock-head button", "Edit");
  await page.waitFor(`!!document.querySelector(${JSON.stringify(SEL.editor)})`, { label: "editor" });
  await sleep(600);
  await page.evaluate(`(() => {
    const ta = document.querySelector(${JSON.stringify(SEL.editor)});
    if (!ta) return false;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    return true;
  })()`);
  await sleep(250);
  await page.type("\n\n> [!tip] Saved from the demo GIF", { delay: 32 });
  await sleep(650);

  // 6. save → preview, then scroll to the new callout at the end
  await page.click(".dsh-obs-dock-head button", "Save");
  await sleep(1200);
  await page.scroll(SEL.dockBody, 99999);
  await sleep(400);
  await page.scroll(SEL.dockBody, 99999, { smooth: false });
  await sleep(1400);

  // 7. select a line → floating Ask / Explain bar
  await page.scroll(SEL.dockBody, 360);
  await sleep(700);
  await page.selectText(SEL.src, "Why are there line numbers on every preview");
  await page.waitFor(`!!document.querySelector(${JSON.stringify(SEL.askbar)})`, { timeout: 5000, label: "ask bar" });
  await sleep(1000);

  // 8. open the Ask popup and type the question
  await page.click(`${SEL.askbar} button`, "Ask");
  await sleep(500);
  await page.evaluate(`(() => {
    const ta = document.querySelector(".dsh-obs-askta");
    if (!ta) return false;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    return true;
  })()`);
  await page.type("Where does the line number come from?", { delay: 34 });
  await sleep(1400);

  running = false;
  await loop;
  const manifest = { width: VW, height: VH, capturedAt: new Date().toISOString(), frames };
  writeFileSync(join(FRAMES_DIR, "manifest.json"), JSON.stringify(manifest));
  console.log(`recorded ${frames.length} frames in ${((Date.now() - started0) / 1000).toFixed(1)}s → ${FRAMES_DIR}`);
}

/** Dump the page state to debug selector/loader problems (writes DEMO_DIR/probe*.png). */
async function probe(page) {
  await prepare(page);
  await sleep(1200);
  const info = await page.evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const sidebar = q(".dsh-obs-sidebar");
    return {
      title: document.title,
      lang: document.documentElement.lang,
      bodyText: (document.body.innerText || "").slice(0, 500),
      hasSidebar: !!sidebar,
      notesRows: document.querySelectorAll(".dsh-obs-notes-row").length,
      pane: !!q(".dsh-obs-notes-pane"),
      mask: !!q('[class*="_mask_"]'),
      boot: typeof globalThis.__DSH_BOOT__ === "object",
      url: location.href.replace(/token=[^&]+/, "token=<redacted>"),
    };
  })()`);
  const shot = join(DEMO_DIR, "probe.png");
  await page.screenshotFile(shot, { format: "png", scale: 1 });
  console.log(JSON.stringify({ ...info, shot }, null, 2));

  // Native mouse click first (what the scenarios use), DOM `.click()` as the
  // fallback so a report can tell "input did not land" from "selector wrong".
  await page.click(SEL.notesRow);
  await sleep(1000);
  const afterMouse = await page.evaluate(`(() => ({
    pane: !!document.querySelector(".dsh-obs-notes-pane"),
    notesOpen: (() => { try { return localStorage.getItem("dsh-obsidian:notesOpen"); } catch { return "err"; } })(),
  }))()`);
  if (!afterMouse.pane) await page.evaluate(`(() => { const el = document.querySelector(".dsh-obs-notes-row"); if (el) el.click(); return !!el; })()`);
  await sleep(1200);
  const after = await page.evaluate(`(() => ({
    pane: !!document.querySelector(".dsh-obs-notes-pane"),
    rows: document.querySelectorAll(".dsh-obs-row").length,
    tree: document.querySelector(".dsh-obs-tree") ? document.querySelector(".dsh-obs-tree").innerText.slice(0, 400) : null,
  }))()`);
  const shot2 = join(DEMO_DIR, "probe-open.png");
  await page.screenshotFile(shot2, { format: "png", scale: 1 });
  console.log(JSON.stringify({ afterMouse, after, shot: shot2 }, null, 2));
}

/** Minimal sanity check of the CDP plumbing against a local file. */
async function selftest(page) {
  await page.waitFor(`document.readyState === "complete"`);
  await page.waitFor(`!!document.querySelector("#hello")`, { label: "selftest page" });
  await page.click("#hello");
  await page.waitFor(`document.querySelector("#out").textContent.includes("clicked")`, { label: "click handler" });
  await page.evaluate(`(() => { localStorage.setItem("probe", "1"); return true; })()`);
  await page.selectText("#para", "select me");
  const sel = await page.evaluate(`String(document.getSelection())`);
  const shot = join(DEMO_DIR, "selftest.png");
  mkdirSync(DEMO_DIR, { recursive: true });
  await page.screenshotFile(shot, { format: "png", scale: 1 });
  console.log(JSON.stringify({ ok: true, selection: sel, shot }));
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!targetUrl) throw new Error("set DSH_URL (or SELFTEST_URL for the plumbing check)");
  if (mode !== "selftest") {
    const u = new URL(targetUrl);
    if (!/^127\.0\.0\.1$|^localhost$/.test(u.hostname)) {
      throw new Error(`refusing to drive a non-local URL: ${targetUrl} (the demo must use an isolated local DSH)`);
    }
  }
  mkdirSync(DEMO_DIR, { recursive: true });
  const { child, page: target } = await launchChrome();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const page = makePage(cdp);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
    // Keep screenshots deterministic across runs.
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }).catch(() => {});
    if (mode !== "selftest") {
      // Force an English UI regardless of the host system locale: a fresh
      // isolated DSH_HOME has no stored locale preference, so the client falls
      // back to the browser's first accepted language.
      await cdp.send("Emulation.setLocaleOverride", { locale: "en-US" }).catch(() => {});
      await cdp.send("Emulation.setUserAgentOverride", { acceptLanguage: "en-US,en;q=0.9" }).catch(() => {});
      const loaded = page.cdp.once("Page.loadEventFired", 60000).catch(() => null);
      await cdp.send("Page.navigate", { url: targetUrl });
      await loaded;
    }
    if (mode === "shots") await shots(page);
    else if (mode === "record") await record(page);
    else if (mode === "probe") await probe(page);
    else if (mode === "selftest") await selftest(page);
    else throw new Error(`unknown mode: ${mode}`);
    console.log("done");
  } finally {
    cdp.close();
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
}

main().catch((error) => {
  console.error(`capture.mjs: ${error.message}`);
  process.exit(1);
});
