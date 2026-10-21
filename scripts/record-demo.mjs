// Records the Mend-on-Hearth demo (live, unscripted AI responses) → demo/mend-demo.mp4
//
// Needs Mend on :8787 and Hearth on :5180 (with a model). Animations run SLOW× slower
// while frames are captured, then the timeline is sped back up; waiting for the AI is
// therefore shortened by the same factor, which the title card says.
//
//   FFMPEG=/path/to/ffmpeg npm run record
// Env: BASE, SLOW (default 4), FFMPEG, BROWSER_PATH, LIMIT_MIN (watchdog, default 40)
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:5180/';
const SLOW = Number(process.env.SLOW || 4);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const W = 1600, H = 900, DSF = 1.2;
const FRAMES = `${ROOT}demo/frames`;
const LIMIT_MIN = Number(process.env.LIMIT_MIN || 40);
setTimeout(() => { console.error(`Aborted: recording took longer than ${LIMIT_MIN} min.`); process.exit(2); }, LIMIT_MIN * 60000).unref();

await rm(FRAMES, { recursive: true, force: true });
await mkdir(FRAMES, { recursive: true });

const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DSF, locale: 'en-US', timezoneId: 'America/New_York' });
await ctx.addInitScript((slow) => { window.__HS_SLOWMO = slow; }, SLOW);
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);

/* ---------- frame capture (ack after write = backpressure) ---------- */
const frames = [];
let n = 0;
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  const file = `f${String(++n).padStart(6, '0')}.jpg`;
  frames.push({ file, ts: metadata.timestamp });
  await writeFile(`${FRAMES}/${file}`, Buffer.from(data, 'base64'));
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
const wait = (ms) => page.waitForTimeout(ms * SLOW);
const marks = [];
let t0 = 0;
const mark = (text) => marks.push({ t: (Date.now() - t0) / 1000 / SLOW, text });

/* ---------- overlay ---------- */
async function overlay() {
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = `
      #demo-cap{position:fixed;left:50%;bottom:22px;z-index:99999;max-width:min(1080px,90vw);padding:13px 24px;border-radius:18px;background:rgba(6,10,18,.92);border:1px solid rgba(38,217,255,.25);color:#fff;font:650 21px/1.4 Inter,'Segoe UI',system-ui,sans-serif;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.5);transform:translate(-50%,0);transition:opacity .45s,transform .6s cubic-bezier(.2,.8,.2,1);pointer-events:none}
      #demo-cap.hide{opacity:0;transform:translate(-50%,14px)}
      #demo-cap b{color:#26d9ff}
      #demo-you{position:fixed;left:50%;top:18px;z-index:99999;display:flex;align-items:center;gap:12px;padding:12px 22px 12px 14px;border-radius:999px;background:#f3f7fb;color:#0b1220;font:650 22px/1.3 Inter,'Segoe UI',system-ui,sans-serif;box-shadow:0 16px 40px rgba(0,0,0,.45);transform:translate(-50%,0) scale(1);transition:opacity .4s,transform .55s cubic-bezier(.34,1.4,.64,1);pointer-events:none;max-width:80vw}
      #demo-you.hide{opacity:0;transform:translate(-50%,-14px) scale(.96)}
      #demo-you i{flex:none;width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#26d9ff,#2f6bff);display:grid;place-items:center}
      #demo-you i::before{content:'';width:10px;height:16px;border-radius:6px;background:#fff}
      #demo-cursor{position:fixed;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;background:rgba(38,217,255,.28);border:2.5px solid #26d9ff;z-index:100000;pointer-events:none;transition:transform .75s cubic-bezier(.2,.8,.2,1),opacity .4s,background-color .2s;opacity:0;transform:translate(900px,600px)}
      #demo-cursor.down{background:rgba(38,217,255,.75)}
      #demo-card{position:fixed;inset:0;z-index:99998;display:grid;place-items:center;text-align:center;color:#fff;padding:40px;background:radial-gradient(60% 60% at 50% 40%,#10233f,#05070d 70%);transition:opacity .7s;font-family:Inter,'Segoe UI',system-ui,sans-serif}
      #demo-card.hide{opacity:0;pointer-events:none}
      #demo-card h1{font-size:60px;font-weight:800;letter-spacing:-2px;line-height:1.08;margin:0}
      #demo-card p{font-size:25px;opacity:.88;margin:18px auto 0;max-width:980px;font-weight:550}
      #demo-card .k{font-size:15px;letter-spacing:.16em;text-transform:uppercase;color:#26d9ff;font-weight:800;margin-bottom:16px}
      #demo-card .row{display:flex;gap:22px;justify-content:center;margin-top:30px;flex-wrap:wrap}
      #demo-card .stat{padding:16px 22px;border-radius:18px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12)}
      #demo-card .stat b{display:block;font-size:36px;font-weight:800;color:#ffb547}
      #demo-card .stat span{font-size:16px;opacity:.8}
      #demo-card .in{animation:cardIn .9s cubic-bezier(.2,.8,.2,1) both}
      @keyframes cardIn{from{opacity:0;transform:translateY(22px)}}`;
    document.head.appendChild(st);
    for (const id of ['demo-cap', 'demo-you', 'demo-card']) document.body.appendChild(Object.assign(document.createElement('div'), { id, className: 'hide' }));
    document.body.appendChild(Object.assign(document.createElement('div'), { id: 'demo-cursor' }));
  });
}

async function caption(html, ms = 0) {
  if (html) mark(html.replace(/<[^>]+>/g, ''));
  await page.evaluate((h) => {
    const c = document.getElementById('demo-cap');
    c.classList.add('hide');
    if (h) setTimeout(() => { c.innerHTML = h; c.classList.remove('hide'); }, 180 * (window.__HS_SLOWMO || 1));
  }, html);
  if (ms) await wait(ms);
}

async function card(html, ms) {
  if (html) mark(`[card] ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)}`);
  await page.evaluate((h) => {
    const c = document.getElementById('demo-card');
    if (h === null) { c.classList.add('hide'); return; }
    c.innerHTML = `<div class="in">${h}</div>`;
    c.classList.remove('hide');
  }, html);
  if (ms) await wait(ms);
}

const logCount = () => page.evaluate(() => document.querySelectorAll('#log li').length);
/** Waits (real time: the AI isn't slowed) until a new inspector entry matches. */
async function waitForLog(re, since, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const hit = await page.evaluate(([src, flags, b]) => {
      const items = [...document.querySelectorAll('#log li')];
      const fresh = items.slice(0, items.length - b);
      return fresh.some((li) => new RegExp(src, flags).test(li.textContent));
    }, [re.source, re.flags, since]);
    if (hit) return true;
    await page.waitForTimeout(400);
  }
  console.warn(`timed out waiting for ${re}`);
  return false;
}

/** The person speaks: show the bubble, hand the words to the device, wait for the AI's reply. */
async function you(text, { expect = /Said/, timeout = 90000, keep = 1800 } = {}) {
  mark(`[you] ${text}`);
  await page.evaluate((t) => { const b = document.getElementById('demo-you'); b.innerHTML = `<i></i><span>“${t}”</span>`; b.classList.remove('hide'); }, text);
  await wait(900);
  const before = await logCount();
  await page.evaluate((t) => window.hearth.say(t), text);
  await wait(keep);
  await page.evaluate(() => document.getElementById('demo-you').classList.add('hide'));
  if (expect) await waitForLog(expect, before, timeout);
  return before;
}

async function tap(frameSel, text) {
  const frame = page.frameLocator('#app iframe');
  const loc = frame.locator(`${frameSel}:has-text("${text}")`).first();
  const box = await loc.boundingBox();
  if (!box) return false;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.evaluate(([x, y]) => { const c = document.getElementById('demo-cursor'); c.style.opacity = '1'; c.style.transform = `translate(${x}px,${y}px)`; }, [x, y]);
  await wait(900);
  await page.evaluate(() => document.getElementById('demo-cursor').classList.add('down'));
  await page.mouse.click(x, y);
  await wait(200);
  await page.evaluate(() => { const c = document.getElementById('demo-cursor'); c.classList.remove('down'); setTimeout(() => { c.style.opacity = '0'; }, 1200); });
  return true;
}

/* ---------- the walkthrough ---------- */
await page.goto(`${BASE}?session=demo-${Date.now()}&voice=0`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('#servers .srv'), null, { timeout: 60000 });
await cdp.send('Animation.enable');
await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 / SLOW });
await overlay();
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: W * DSF, maxHeight: H * DSF, everyNthFrame: 4 });
t0 = Date.now();

await card(`<div class="k">The problem</div><h1>You can't scroll a phone<br>with wet hands inside a dishwasher.</h1>
  <div class="row"><div class="stat"><b>62 million t</b><span>e-waste in 2022, only 22% recycled</span></div><div class="stat"><b>82 million t</b><span>expected by 2030</span></div></div>
  <p style="font-size:16px;opacity:.6">UN Global E-waste Monitor 2024</p>`, 6000);
await card(`<div class="k">Alexa+ track · MCP 2025-11-25</div><h1>Mend</h1>
  <p>Hands-free repair for Alexa+: one step at a time, by voice, with photos on the Echo Show.<br>Safety checks the AI can't fake. A passport that remembers your home.</p>
  <p style="font-size:17px;opacity:.65;margin-top:26px">Running in Hearth, our open-source Alexa+ simulator · Live, unscripted AI (Gemini via Strands Agents) · AI waiting time shortened</p>`, 6500);
await card(null, 900);

await caption('<b>Hearth</b> simulates Alexa+ on an Echo Show. The inspector on the right shows every MCP message.', 3500);
await caption('');
await you("Alexa, my dishwasher won't drain. There's water sitting at the bottom.", { expect: /Said/ });
await caption('Mend checks the <b>appliance passport</b> and finds the iFixit guide for <b>your exact Bosch model</b>.', 4500);
await you("Yes, let's do the easy one.", { expect: /Said/ });
await caption('Difficulty, time, tools, and the <b>risks Mend will check</b> before each step.', 4500);
await caption('');
let before = await you('Okay, next.', { expect: /Elicitation/ });
await wait(800);
await caption('Before risky steps, Mend asks <b>the person directly</b> (MCP elicitation). The AI can\'t confirm for you.', 4500);
before = await you("Yes, it's unplugged.", { expect: /Said/ });
await caption('Each step is spoken, with the <b>real photo</b> from the guide. Truly hands-free.', 4500);
await caption('Or just tap: the <b>voice assistant stays in sync</b> with the screen.', 1200);
before = await logCount();
if (await tap('button', 'Next')) await waitForLog(/Said/, before, 30000);
await wait(3500);
await you('Next.', { expect: /Said/ });
await wait(2500);
await caption('');
await you("It's draining now. It's fixed!", { expect: /Said/ });
await caption('<b>Logged</b> in the passport. The filter\'s maintenance clock resets.', 4000);
await you('What maintenance is due?', { expect: /Said/ });
await wait(2500);
await caption('');
await you('Add a new drain pump for my dishwasher to my cart.', { expect: /Elicitation/ });
await wait(800);
await caption('<b>Purchases need your approval</b> too, every single time.', 3000);
await you('Yes, add it.', { expect: /Said/ });
await caption('Cart (simulated in this prototype) with the exact part search.', 3500);
await caption('Under the hood: <b>MCP 2025-11-25</b> over Streamable HTTP · <b>MCP Apps</b> · <b>elicitation</b> · Agent Skill · Strands Agents SDK.', 4500);
await caption('');

await card(`<h1>Mend <span style="color:#26d9ff">+</span> Hearth</h1>
  <p>github.com/SMASH-Mash/mend · github.com/SMASH-Mash/hearth</p>
  <p style="font-size:19px;opacity:.75">Open source (MIT) · Repair guides from iFixit (CC BY-NC-SA) · Built for the Alexa+ track</p>`, 6000);

await cdp.send('Page.stopScreencast');
await wait(300);
await browser.close();

/* ---------- assemble ---------- */
frames.sort((a, b) => a.ts - b.ts);
const lines = ['ffconcat version 1.0'];
for (let i = 0; i < frames.length; i++) {
  const dur = i < frames.length - 1 ? frames[i + 1].ts - frames[i].ts : 0.5;
  lines.push(`file '${frames[i].file}'`, `duration ${Math.max(0.001, dur).toFixed(4)}`);
}
lines.push(`file '${frames[frames.length - 1].file}'`);
await writeFile(`${FRAMES}/list.ffconcat`, lines.join('\n'));
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
await writeFile(`${ROOT}demo/timeline.txt`, marks.map((m) => `${fmt(m.t)}  ${m.text}`).join('\n') + '\n');
const out = `${ROOT}demo/mend-demo.mp4`;
execFileSync(FFMPEG, [
  '-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-f', 'concat', '-safe', '0', '-i', `${FRAMES}/list.ffconcat`,
  '-vf', `setpts=PTS/${SLOW},fps=30,scale=1920:1080:flags=lanczos,format=yuv420p`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-movflags', '+faststart', out,
], { stdio: 'inherit' });
console.log(`${frames.length} frames → ${out}\ntimeline → demo/timeline.txt`);
