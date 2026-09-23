import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 9335;
const DEFAULT_OPACITY = 0.27;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function getImageMime(imagePath) {
  const extension = path.extname(imagePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  throw new Error(`Unsupported image type: ${extension || '(none)'}. Use JPG, JPEG, or PNG.`);
}

export function normalizeOpacity(value = DEFAULT_OPACITY) {
  const opacity = Number(value);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new Error('Opacity must be a number between 0 and 1.');
  }
  return Math.round(opacity * 100) / 100;
}

export function buildWallpaperCss({ imageDataUrl, opacity = DEFAULT_OPACITY }) {
  if (!/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(imageDataUrl)) {
    throw new Error('Wallpaper image must be an in-memory JPEG or PNG data URL.');
  }
  const safeOpacity = normalizeOpacity(opacity);
  return `
html[data-codex-local-wallpaper="on"],
html[data-codex-local-wallpaper="on"] body {
  background: transparent !important;
  min-height: 100%;
}

/* The app shell has two opaque surface layers. Keep content surfaces intact,
   but let the wallpaper show through the shell and the main work area. */
html[data-codex-local-wallpaper="on"] main.flex.h-full.min-h-0.flex-col.overflow-hidden.bg-surface.no-drag,
html[data-codex-local-wallpaper="on"] [data-app-shell-main-surface] {
  background-color: transparent !important;
  background-image: none !important;
}

html[data-codex-local-wallpaper="on"] body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image: url("${imageDataUrl}");
  background-position: center center;
  background-repeat: no-repeat;
  background-size: cover;
  opacity: ${safeOpacity};
}

html[data-codex-local-wallpaper="on"] body > * {
  position: relative;
  z-index: 1;
}
`;
}

export function chooseCdpTarget(targets) {
  const pages = targets.filter((target) =>
    target && target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string'
  );
  return pages.find((target) => target.url === 'app://-/index.html') ?? null;
}

export function decideLaunch(processes) {
  if (processes.some((process) => String(process.name).toLowerCase() === 'chatgpt.exe')) {
    return { action: 'refuse', reason: 'codex-already-running' };
  }
  return { action: 'launch' };
}

export function buildInjectionScript(css) {
  const serializedCss = JSON.stringify(css);
  return `(() => {
  const id = "codex-local-wallpaper-style";
  const install = () => {
    let style = document.getElementById(id);
    if (!style) {
      const parent = document.head || document.documentElement;
      if (!parent) return false;
      style = document.createElement("style");
      style.id = id;
      parent.appendChild(style);
    }
    style.textContent = ${serializedCss};
    if (document.documentElement) document.documentElement.dataset.codexLocalWallpaper = "on";
    return true;
  };
  if (!install()) {
    const observer = new MutationObserver(() => {
      if (install()) observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  }
  return { installed: Boolean(document.getElementById(id)), href: location.href };
})()`;
}

async function readWallpaperDataUrl(imagePath) {
  const resolvedPath = path.resolve(imagePath);
  const mime = getImageMime(resolvedPath);
  const bytes = await fs.readFile(resolvedPath);
  if (bytes.byteLength === 0) throw new Error('Wallpaper image is empty.');
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Wallpaper image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MiB.`);
  }
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

async function listCodexProcesses() {
  const { stdout } = await execFileAsync('tasklist.exe', [
    '/FI', 'IMAGENAME eq ChatGPT.exe', '/FO', 'CSV', '/NH',
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^"([^"]+)","(\d+)"/);
    return match ? [{ name: match[1], pid: Number(match[2]) }] : [];
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.json();
}

async function getCdpTarget(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  return chooseCdpTarget(targets);
}

async function waitForCdpTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const target = await getCdpTarget(port);
      if (target) return target;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const suffix = lastError ? ` Last error: ${lastError.message}` : '';
  throw new Error(`No Codex page appeared on local CDP port ${port}.${suffix}`);
}

class CdpSession {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket connection timed out.')), 5000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket connection failed.')); }, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP command failed.'));
      else pending.resolve(message.result ?? null);
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP socket closed.'));
      this.pending.clear();
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.socket && this.socket.readyState < 2) this.socket.close();
  }
}

async function injectIntoTarget(target, css) {
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.connect();
  try {
    const script = buildInjectionScript(css);
    await session.request('Page.addScriptToEvaluateOnNewDocument', { source: script });
    const result = await session.request('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.result?.value ?? null;
  } finally {
    session.close();
  }
}

function parseArgs(argv) {
  const options = { port: DEFAULT_PORT, opacity: DEFAULT_OPACITY, launch: false, timeoutMs: 10000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--image') options.image = next();
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--opacity') options.opacity = Number(next());
    else if (arg === '--codex-exe') options.codexExe = next();
    else if (arg === '--profile-path') options.profilePath = next();
    else if (arg === '--launch') options.launch = true;
    else if (arg === '--timeout-ms') options.timeoutMs = Number(next());
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log('Usage: node wallpaper.mjs --image <jpg|jpeg|png> [--launch --codex-exe <ChatGPT.exe>]');
  console.log('       --port <number>       Local CDP port (default 9335)');
  console.log('       --opacity <0..1>      Wallpaper opacity (default 0.27)');
  console.log('       --launch              Start Codex only when no ChatGPT.exe exists');
}

async function launchCodex(options) {
  if (!options.codexExe) throw new Error('--launch requires --codex-exe.');
  const args = [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${options.port}`,
  ];
  if (options.profilePath) args.push(`--user-data-dir=${options.profilePath}`);
  const child = spawn(options.codexExe, args, { detached: true, windowsHide: false, stdio: 'ignore' });
  child.unref();
}

export async function run(options) {
  if (!options.image) throw new Error('--image is required.');
  const imageDataUrl = await readWallpaperDataUrl(options.image);
  const css = buildWallpaperCss({ imageDataUrl, opacity: options.opacity });
  const processes = await listCodexProcesses();

  if (options.launch) {
    const decision = decideLaunch(processes);
    if (decision.action === 'refuse') {
      throw new Error('Codex is already running; refusing to launch another instance. Close it manually before using --launch.');
    }
    await launchCodex(options);
  }

  const target = await waitForCdpTarget(options.port, options.launch ? options.timeoutMs : 1500);
  const result = await injectIntoTarget(target, css);
  return { port: options.port, targetId: target.id, result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) printHelp();
    else {
      const result = await run(options);
      console.log(JSON.stringify({ ok: true, ...result }));
    }
  } catch (error) {
    console.error(`[codex-local-wallpaper] ${error.message}`);
    process.exitCode = 1;
  }
}
