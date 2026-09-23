import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildWallpaperCss,
  chooseCdpTarget,
  decideLaunch,
  getImageMime,
} from '../src/wallpaper.mjs';

test('accepts only local raster image types', () => {
  assert.equal(getImageMime('background.jpg'), 'image/jpeg');
  assert.equal(getImageMime('background.jpeg'), 'image/jpeg');
  assert.equal(getImageMime('background.png'), 'image/png');
  assert.throws(() => getImageMime('background.webp'), /Unsupported image type/);
});

test('builds a pointer-free wallpaper layer with bounded opacity', () => {
  const css = buildWallpaperCss({
    imageDataUrl: 'data:image/jpeg;base64,abc',
    opacity: 0.27,
  });

  assert.match(css, /data:image\/jpeg;base64,abc/);
  assert.match(css, /opacity:\s*0\.27/);
  assert.match(css, /pointer-events:\s*none/);
  assert.match(css, /z-index:\s*0/);
});

test('clears only the opaque app shell surfaces in a browser', async (t) => {
  const require = createRequire(import.meta.url);
  const runtimeRoot = process.env.CODEX_PRIMARY_RUNTIME
    ?? path.join(process.env.USERPROFILE ?? '', '.cache', 'codex-runtimes', 'codex-primary-runtime');
  let chromium;
  try {
    ({ chromium } = require(path.join(runtimeRoot, 'dependencies', 'node', 'node_modules', 'playwright')));
  } catch (error) {
    t.skip(`Playwright runtime unavailable: ${error.message}`);
    return;
  }

  const chromePath = process.env.CODEX_TEST_CHROME
    ?? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
  if (!fs.existsSync(chromePath)) {
    t.skip(`Chrome executable unavailable: ${chromePath}`);
    return;
  }
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const css = buildWallpaperCss({ imageDataUrl: 'data:image/jpeg;base64,abc', opacity: 0.27 });
  await page.setContent(`
    <div id="root">
      <main class="flex h-full min-h-0 flex-col overflow-hidden bg-surface no-drag">
        <aside id="sidebar">Projects</aside>
        <main data-app-shell-main-surface="default">
          <article id="message" style="background: rgb(35, 40, 55);">Message</article>
          <div data-codex-composer-root><div id="composer" style="background: rgba(161,178,223,.96); height: 80px;">Input</div></div>
        </main>
      </main>
    </div>
  `);
  await page.addStyleTag({ content: css });
  await page.evaluate(() => { document.documentElement.dataset.codexLocalWallpaper = 'on'; });

  const state = await page.evaluate(() => {
    const shell = document.querySelector('#root > main');
    const surface = document.querySelector('[data-app-shell-main-surface]');
    const message = document.querySelector('#message');
    const composer = document.querySelector('#composer');
    const before = composer.getBoundingClientRect().toJSON();
    const hit = document.elementFromPoint(before.left + 5, before.top + 5)?.id;
    return {
      shellBackground: getComputedStyle(shell).backgroundColor,
      surfaceBackground: getComputedStyle(surface).backgroundColor,
      messageBackground: getComputedStyle(message).backgroundColor,
      composerRect: before,
      hit,
    };
  });

  assert.equal(state.shellBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(state.surfaceBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(state.messageBackground, 'rgb(35, 40, 55)');
  assert.equal(state.composerRect.height, 80);
  assert.equal(state.hit, 'composer');
});

test('chooses a page target and never a browser target', () => {
  const target = chooseCdpTarget([
    { type: 'browser', webSocketDebuggerUrl: 'ws://browser' },
    { type: 'page', url: 'app://-/detached-window.html', webSocketDebuggerUrl: 'ws://detached' },
    { type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://main' },
  ]);
  assert.equal(target.webSocketDebuggerUrl, 'ws://main');
  assert.equal(chooseCdpTarget([
    { type: 'page', url: 'app://codex', webSocketDebuggerUrl: 'ws://page' },
  ]), null);
  assert.equal(chooseCdpTarget([]), null);
});

test('refuses to launch when any Codex process is already present', () => {
  assert.deepEqual(decideLaunch([{ name: 'ChatGPT.exe', pid: 123 }]), {
    action: 'refuse',
    reason: 'codex-already-running',
  });
  assert.deepEqual(decideLaunch([]), { action: 'launch' });
});
