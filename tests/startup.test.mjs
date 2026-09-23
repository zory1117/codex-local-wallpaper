import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { buildInjectionScript, buildWallpaperCss, chooseCdpTarget } from '../src/wallpaper.mjs';

const require = createRequire(import.meta.url);
const runtimeRoot = process.env.CODEX_PRIMARY_RUNTIME
  ?? path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime');
const { chromium } = require(path.join(runtimeRoot, 'dependencies', 'node', 'node_modules', 'playwright'));
const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=';
const css = buildWallpaperCss({ imageDataUrl });
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CODEX_TEST_CHROME
    ?? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe') });
});
after(async () => { await browser?.close(); });

test('startup injection waits for the document head instead of silently losing the wallpaper', async () => {
  const page = await browser.newPage();
  try {
    await page.addInitScript({ content: `window.headAtInjection = !!document.head; ${buildInjectionScript(css)}` });
    await page.goto('data:text/html,<html><head></head><body><div id="root"><main data-app-shell-main-surface="default"></main></div></body></html>');
    const state = await page.evaluate(() => ({
      headAtInjection: window.headAtInjection,
      installed: !!document.getElementById('codex-local-wallpaper-style'),
      enabled: document.documentElement.dataset.codexLocalWallpaper,
    }));
    assert.equal(state.headAtInjection, false, 'fixture must inject before a head exists');
    assert.equal(state.installed, true, 'wallpaper must survive the initial document construction');
    assert.equal(state.enabled, 'on');
  } finally { await page.close(); }
});

test('startup target selection waits for the Codex main page, not a blank or auxiliary window', () => {
  const auxiliary = [
    { type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:9335/blank' },
    { type: 'page', url: 'app://-/index.html?initialRoute=%2Favatar-overlay', webSocketDebuggerUrl: 'ws://127.0.0.1:9335/pet' },
    { type: 'page', url: 'app://-/detached-window.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9335/detached' },
  ];
  assert.equal(chooseCdpTarget(auxiliary), null);
  const main = { type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9335/main' };
  assert.equal(chooseCdpTarget([...auxiliary, main]), main);
});
