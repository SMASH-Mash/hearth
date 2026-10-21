// README screenshots: drives the device with "/tool" commands (no model needed).
// Usage: Mend on :8787 and Hearth on :5180 running, then: npm run screenshots
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = `${ROOT}docs/screenshots`;
const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
await mkdir(OUT, { recursive: true });

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
await page.goto(`${BASE}?session=shots-${Date.now()}&voice=0`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const cmd = async (t, wait = 3500) => { await page.fill('#typeInput', t); await page.press('#typeInput', 'Enter'); await page.waitForTimeout(wait); };
const frame = page.frameLocator('#app iframe');

await cmd('/tool find_repair_guides {"device":"Bosch dishwasher","problem":"water left at the bottom, it won\'t drain"}', 7000);
await page.locator('#screen').screenshot({ path: `${OUT}/guides.png` });
await cmd('/tool start_repair {"guideId":182595}');
await frame.locator('button:has-text("Start step 1")').click();
await page.waitForSelector('#sheet.on', { timeout: 15000 });
await page.waitForTimeout(1500);
await page.locator('#screen').screenshot({ path: `${OUT}/safety.png` });
await page.click('#sheetForm .choice.yes');
await page.waitForTimeout(12000); // let the caption fade
await page.locator('#screen').screenshot({ path: `${OUT}/step.png` });
await page.screenshot({ path: `${OUT}/hearth.png` });
await cmd('/tool appliance_passport {}', 12000);
await page.locator('#screen').screenshot({ path: `${OUT}/passport.png` });
await browser.close();
console.log(`screenshots → ${OUT}`);
