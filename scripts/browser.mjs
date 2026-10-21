// Picks the browser for screenshots and recordings: BROWSER_PATH, then Brave,
// then Google Chrome, then Playwright's bundled Chromium.
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BRAVE = [
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  'C:/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe',
  `${process.env.LOCALAPPDATA || ''}/BraveSoftware/Brave-Browser/Application/brave.exe`,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/brave-browser',
  '/usr/bin/brave',
];

export async function launchBrowser(options = {}) {
  const opts = { headless: true, ...options };
  const path = process.env.BROWSER_PATH || BRAVE.find((p) => p && existsSync(p));
  if (path) return chromium.launch({ ...opts, executablePath: path });
  return chromium.launch({ ...opts, channel: 'chrome' }).catch(() => chromium.launch(opts));
}
