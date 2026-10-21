// Hearth device: voice in/out, MCP Apps host, elicitation by voice, inspector.
import { AppBridge, PostMessageTransport } from './vendor/app-bridge.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const SESSION = params.get('session') || (() => {
  try {
    const k = localStorage.getItem('hearth.session') || crypto.randomUUID();
    localStorage.setItem('hearth.session', k);
    return k;
  } catch { return crypto.randomUUID(); }
})();

const device = $('#device');
const state = { now: 'idle', layer: 'home', reply: '', elicit: null, assistant: { name: 'Alexa', wakeWord: 'alexa' }, speaking: 0 };

/* ---------------- helpers ---------------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(path, data) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: SESSION, ...data }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  return out;
}
const blocksText = (blocks) => (blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();

function setState(s) {
  state.now = s;
  device.dataset.state = s;
  document.body.dataset.state = s;
}

function setLayer(name) {
  state.layer = name;
  for (const id of ['home', 'talk', 'app']) $(`#${id}`).classList.toggle('on', id === name);
  if (name !== 'app') $('#captions').classList.remove('on');
}

function showText(text, { live = false } = {}) {
  if (state.elicit) return; // the elicitation sheet shows the question itself
  if (state.layer === 'app') {
    const c = $('#captions');
    c.textContent = text;
    c.classList.toggle('on', Boolean(text));
  } else {
    setLayer('talk');
    $('#reply').innerHTML = esc(text).split(/(\s+)/).map((w) => (/\s/.test(w) ? w : `<span class="w">${w}</span>`)).join('');
  }
  if (!live) clearTimeout(showText.t);
}

/* ---------------- speech out ---------------- */

const voiceOut = $('#voiceOut');
let voice = null;
function pickVoice() {
  const all = speechSynthesis.getVoices().filter((v) => /^en(-|_)US/i.test(v.lang));
  const prefer = [/Ava.*Natural/i, /Aria.*Natural/i, /Jenny.*Natural/i, /Emma.*Natural/i, /Natural/i, /Google US English/i, /Samantha/i];
  voice = prefer.map((re) => all.find((v) => re.test(v.name))).find(Boolean) || all[0] || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.addEventListener('voiceschanged', pickVoice);
}

function speak(text, { then } = {}) {
  if (!text) return then?.();
  showText(text);
  if (!voiceOut.checked || !('speechSynthesis' in window)) {
    // Silent mode (e.g. recordings): keep captions up for a comfortable reading time.
    setState('speaking');
    clearTimeout(speak.t);
    speak.t = setTimeout(() => afterSpeech(then), Math.min(9000, 1400 + text.length * 48));
    return;
  }
  // Chrome cuts long utterances, so speak sentence by sentence.
  const parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    state.speaking = Math.max(0, state.speaking - 1);
    if (!state.speaking) afterSpeech(then);
  };
  state.speaking += 1;
  setState('speaking');
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p.trim());
    if (voice) u.voice = voice;
    u.rate = 1.02;
    if (i === parts.length - 1) u.onend = u.onerror = done;
    speechSynthesis.speak(u);
  });
  // Some browsers never fire onend (no voices installed, headless): don't leave the device "speaking".
  setTimeout(done, 3000 + text.length * 75);
}

function afterSpeech(then) {
  if (state.now === 'speaking') setState('idle');
  // Captions over a skill screen fade once speech ends, so they never hide its controls.
  clearTimeout(afterSpeech.t);
  afterSpeech.t = setTimeout(() => { if (state.now !== 'speaking') $('#captions').classList.remove('on'); }, 1400);
  then?.();
  if (state.elicit && $('#handsFree').checked) listen({ forElicit: true });
  else if ($('#handsFree').checked && state.now === 'idle' && /\?\s*$/.test(state.reply)) listen();
}

/* ---------------- speech in ---------------- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function listen({ forElicit = false } = {}) {
  if (!SR) { $('#typeInput').focus(); return; }
  if (rec) { rec.stop(); return; }
  speechSynthesis.cancel();
  rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  let final = '';
  setState('listening');
  if (!forElicit && state.layer !== 'app') { setLayer('talk'); $('#heard').textContent = ''; $('#reply').textContent = ''; }
  rec.onresult = (e) => {
    let interim = '';
    for (const r of e.results) (r.isFinal ? (final += r[0].transcript) : (interim += r[0].transcript));
    const said = (final || interim).trim();
    if (forElicit) showText(said, { live: true });
    else if (state.layer === 'app') showText(said, { live: true });
    else $('#heard').textContent = said;
  };
  rec.onend = () => {
    rec = null;
    if (state.now === 'listening') setState('idle');
    const text = final.trim();
    if (!text) return;
    if (forElicit && state.elicit) return voiceAnswer(text);
    say(text);
  };
  rec.onerror = () => { rec = null; setState('idle'); };
  rec.start();
}

function stripWake(text) {
  const w = (state.assistant.wakeWord || 'alexa').toLowerCase();
  return text.replace(new RegExp(`^\\s*(hey\\s+)?${w}[,.!]?\\s*`, 'i'), '').trim() || text;
}

/** Developer commands: "/tool name {json}" calls a tool directly and shows its screen; "/tools" lists them. */
async function command(text) {
  const [, cmd, rest = ''] = text.match(/^\/(\w+)\s*(.*)$/s) || [];
  if (cmd === 'tool') {
    const [, name, json] = rest.match(/^(\S+)\s*(.*)$/s) || [];
    if (!name) return addLog('error', { message: 'Usage: /tool <name> {"arg": "value"}' });
    let args = {};
    try { args = json ? JSON.parse(json) : {}; } catch { return addLog('error', { message: 'Arguments must be JSON' }); }
    $('#setup').hidden = true;
    try { await api('/api/tools/call', { name, arguments: args, direct: true }); } catch (e) { addLog('error', { message: e.message }); }
  } else if (cmd === 'home') {
    setLayer('home');
  } else {
    addLog('error', { message: 'Commands: /tool <name> {json} · /home' });
  }
}

async function say(raw) {
  if (String(raw || '').trim().startsWith('/')) return command(String(raw).trim());
  const text = stripWake(String(raw || '').trim());
  if (!text) return;
  if (state.elicit) return voiceAnswer(text);
  speechSynthesis.cancel();
  state.reply = '';
  try { await api('/api/say', { text }); } catch (e) { addLog('error', { message: e.message }); speak(`Sorry, ${e.message}`); }
}

/* ---------------- MCP Apps host ---------------- */

const resources = new Map();
let mounted = null;

function withCsp(html, csp) {
  const allow = ['data:', 'blob:', ...(csp?.resourceDomains || [])].join(' ');
  const connect = (csp?.connectDomains || []).join(' ') || "'none'";
  const frames = (csp?.frameDomains || []).join(' ') || "'none'";
  const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${allow}; style-src 'unsafe-inline' ${allow}; img-src ${allow}; media-src ${allow}; font-src ${allow}; connect-src ${connect}; frame-src ${frames}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`) : meta + html;
}

async function mount(uri) {
  const res = resources.get(uri);
  if (!res) throw new Error(`UI resource ${uri} not loaded`);
  const box = $('#app');
  if (mounted) { try { await mounted.bridge.teardownResource({}); } catch { /* view gone */ } }
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  iframe.setAttribute('title', 'Skill screen');
  box.replaceChildren(iframe);
  const bridge = new AppBridge(null, { name: 'Hearth', version: '1.0.0' }, {
    openLinks: {}, serverTools: {}, logging: {}, updateModelContext: { text: {} }, message: { text: {} },
  }, {
    hostContext: {
      theme: 'dark', displayMode: 'fullscreen', availableDisplayModes: ['fullscreen'], platform: 'web',
      locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      deviceCapabilities: { touch: true, hover: false },
      containerDimensions: { width: box.clientWidth, height: box.clientHeight },
    },
  });
  bridge.oncalltool = (p) => api('/api/tools/call', { name: p.name, arguments: p.arguments || {} });
  bridge.onopenlink = async ({ url }) => { window.open(url, '_blank', 'noopener'); return {}; };
  bridge.onupdatemodelcontext = async (p) => { api('/api/context', { text: blocksText(p.content) || JSON.stringify(p.structuredContent || {}) }).catch(() => {}); return {}; };
  bridge.onmessage = async (p) => { say(blocksText(p.content)); return {}; };
  bridge.onloggingmessage = (p) => addLog('appLog', p);
  const ready = new Promise((r) => { bridge.oninitialized = () => r(); });
  await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
  iframe.srcdoc = withCsp(res.html, res.csp);
  return { uri, bridge, ready: Promise.race([ready, new Promise((r) => setTimeout(r, 8000))]) };
}

async function showScreen(ev) {
  try {
    if (!mounted || mounted.uri !== ev.uri) mounted = await mount(ev.uri);
    await mounted.ready;
    setLayer('app');
    await mounted.bridge.sendToolInput({ arguments: ev.input || {} });
    await mounted.bridge.sendToolResult(ev.result);
  } catch (e) {
    addLog('error', { message: `Screen: ${e.message}` });
  }
}

/* ---------------- elicitation ---------------- */

function openSheet(ev) {
  state.elicit = ev;
  $('#sheetFrom').textContent = `${ev.server} asks you`;
  $('#sheetMsg').textContent = ev.message;
  const form = $('#sheetForm');
  const props = Object.entries(ev.schema?.properties || {});
  const single = props.length === 1 && props[0][1].type === 'boolean';
  if (ev.mode === 'url') {
    form.innerHTML = `<button class="choice yes" type="button" data-a="open">Open link</button><button class="choice" type="button" data-a="decline">Not now</button>`;
  } else if (single || !props.length) {
    const label = props[0]?.[1]?.title || 'Yes';
    form.innerHTML = `<button class="choice yes" type="button" data-a="yes">${esc(label)}</button><button class="choice" type="button" data-a="no">No, wait</button>`;
  } else {
    form.innerHTML = props.map(([k, p]) => {
      const name = esc(k);
      const title = esc(p.title || k);
      if (p.enum) return `<label class="field">${title}<select name="${name}">${p.enum.map((o) => `<option>${esc(o)}</option>`).join('')}</select></label>`;
      if (p.type === 'boolean') return `<label class="field"><span><input type="checkbox" name="${name}" ${p.default ? 'checked' : ''}> ${title}</span></label>`;
      return `<label class="field">${title}<input name="${name}" type="${p.type === 'number' || p.type === 'integer' ? 'number' : 'text'}" value="${esc(p.default ?? '')}"></label>`;
    }).join('') + `<button class="choice yes" type="submit">Send</button><button class="choice" type="button" data-a="no">Cancel</button>`;
  }
  $('#sheet').classList.add('on');
  $('#captions').classList.remove('on');
  speak(ev.message);
}

function closeSheet() {
  state.elicit = null;
  $('#sheet').classList.remove('on');
}

async function answer(action, content) {
  const ev = state.elicit;
  if (!ev) return;
  closeSheet();
  try { await api('/api/elicit', { elicitId: ev.id, action, content }); } catch (e) { addLog('error', { message: e.message }); }
}

function answerYesNo(yes) {
  const ev = state.elicit;
  if (!ev) return;
  const field = Object.keys(ev.schema?.properties || {})[0];
  if (yes) answer('accept', field ? { [field]: true } : {});
  else answer('decline');
}

function voiceAnswer(text) {
  if (/\b(no|nope|not yet|wait|hold on|stop|cancel|don'?t)\b/i.test(text)) return answerYesNo(false);
  if (/\b(yes|yeah|yep|yup|sure|correct|done|ok(ay)?|ready|go ahead|confirm(ed)?|approve(d)?|it'?s (off|done|safe|unplugged))\b/i.test(text)) return answerYesNo(true);
  speak('Sorry, was that a yes or a no?');
}

$('#sheetForm').addEventListener('click', (e) => {
  const a = e.target.closest('[data-a]')?.dataset.a;
  if (!a) return;
  if (a === 'yes') answerYesNo(true);
  else if (a === 'no' || a === 'decline') answer('decline');
  else if (a === 'open') { window.open(state.elicit.url, '_blank', 'noopener'); answer('accept', {}); }
});
$('#sheetForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const ev = state.elicit;
  const content = {};
  for (const [k, p] of Object.entries(ev?.schema?.properties || {})) {
    const el = e.target.elements[k];
    if (!el) continue;
    content[k] = p.type === 'boolean' ? el.checked : p.type === 'number' || p.type === 'integer' ? Number(el.value) : el.value;
  }
  answer('accept', content);
});

/* ---------------- inspector ---------------- */

const LABELS = { heard: 'Heard', tool: 'Tool call', toolDone: 'Tool done', say: 'Said', elicit: 'Elicitation', elicitDone: 'Answered', screen: 'Screen', error: 'Error', appLog: 'App log', ready: 'Connected' };
function addLog(kind, data) {
  const ol = $('#log');
  const li = document.createElement('li');
  li.dataset.kind = kind; // not a class: names like "heard" and "screen" are device layers
  const time = new Date(data.at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let summary = '';
  if (kind === 'heard' || kind === 'say') summary = data.text;
  else if (kind === 'tool') summary = `${data.name}${data.source === 'screen' ? ' (from screen tap)' : ''}`;
  else if (kind === 'toolDone') summary = `${data.name} → ${data.status}${data.error ? `: ${data.error}` : ''}`;
  else if (kind === 'elicit') summary = data.message;
  else if (kind === 'elicitDone') summary = data.action;
  else if (kind === 'screen') summary = `${data.toolName} → ${data.uri} (${data.result?.structuredContent?.view || 'result'})`;
  else if (kind === 'error') summary = data.message;
  else summary = '';
  const detail = kind === 'tool' ? data.input : kind === 'screen' ? data.result?.structuredContent : kind === 'elicit' ? data.schema : kind === 'appLog' ? data : null;
  li.innerHTML = `<span class="k">${LABELS[kind] || kind}</span><span class="t">${time}</span><div>${esc(summary)}</div>${detail ? `<details><summary class="muted">payload</summary><pre>${esc(JSON.stringify(detail, null, 2))}</pre></details>` : ''}`;
  ol.prepend(li);
  while (ol.children.length > 150) ol.lastChild.remove();
}
$('#clearLog').addEventListener('click', () => { $('#log').innerHTML = ''; });
$('#inspectorToggle').addEventListener('click', (e) => {
  const on = document.body.classList.toggle('no-inspector');
  e.currentTarget.setAttribute('aria-pressed', String(!on));
});
if (params.has('noinspector')) document.body.classList.add('no-inspector');
if (params.get('voice') === '0') voiceOut.checked = false;

function renderServers(info) {
  state.assistant = info.assistant || state.assistant;
  $('#servers').innerHTML = `<div class="meta">Model: ${esc(info.model)} · Agent: Strands Agents SDK</div>` + (info.servers || []).map((s) => `
    <div class="srv"><b>${esc(s.title)}</b><span class="meta">${esc(s.url)} · MCP ${esc(s.protocol)} · ${s.tools.length} tools</span>
    <div class="tools">${s.tools.map((t) => `<span class="${t.hasScreen ? 'has-screen' : ''}" title="${t.hasScreen ? 'has an MCP App screen' : ''}">${esc(t.name)}</span>`).join('')}</div></div>`).join('');
}

/* ---------------- events from the agent ---------------- */

function connectEvents() {
  const es = new EventSource(`/api/events?session=${encodeURIComponent(SESSION)}`);
  const on = (type, fn) => es.addEventListener(type, (e) => { const d = JSON.parse(e.data); fn(d); });
  on('ready', (d) => { renderServers(d); addLog('ready', d); });
  on('heard', (d) => {
    addLog('heard', d);
    if (state.layer !== 'app') { setLayer('talk'); $('#heard').textContent = d.text; $('#reply').textContent = ''; }
  });
  on('state', (d) => { if (state.now !== 'speaking' || d.state === 'thinking') setState(d.state); });
  on('delta', (d) => { state.reply += d.text; if (!speechSynthesis.speaking) showText(state.reply, { live: true }); });
  on('say', (d) => { addLog('say', d); state.reply = d.text; speak(d.text); });
  on('tool', (d) => addLog('tool', d));
  on('toolDone', (d) => addLog('toolDone', d));
  on('screenResource', (d) => resources.set(d.uri, { html: d.html, csp: d.csp }));
  on('screen', (d) => { addLog('screen', d); showScreen(d); });
  on('elicit', (d) => { addLog('elicit', d); openSheet(d); });
  on('elicitDone', (d) => addLog('elicitDone', d));
  on('error', (d) => { addLog('error', d); });
  es.onerror = () => { /* EventSource reconnects by itself */ };
}

/* ---------------- controls & home ---------------- */

$('#mic').addEventListener('click', () => listen({ forElicit: Boolean(state.elicit) }));
$('#typeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#typeInput').value;
  $('#typeInput').value = '';
  say(v);
});
let spaceDown = false;
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !spaceDown && document.activeElement?.tagName !== 'INPUT') { spaceDown = true; e.preventDefault(); listen({ forElicit: Boolean(state.elicit) }); }
});
addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; rec?.stop(); } });

const TRY = ['"Alexa, my dishwasher won\'t drain"', '"Alexa, what maintenance is due?"', '"Alexa, show my appliance passport"', '"Alexa, my fridge is making noise"'];
let tryI = 0;
function tick() {
  const d = new Date();
  $('#clock').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M/i, '');
  $('#date').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}
setInterval(tick, 15000);
setInterval(() => {
  if (state.layer !== 'home') return;
  const q = $('#tryQ');
  q.textContent = TRY[(tryI = (tryI + 1) % TRY.length)];
  q.style.animation = 'none'; void q.offsetWidth; q.style.animation = '';
}, 6000);
tick();
setLayer('home');

// Scripted demos and tests drive the device through this.
window.hearth = { say, answer: answerYesNo, home: () => setLayer('home'), get state() { return { ...state } } };

const status = await fetch('/api/status').then((r) => r.json()).catch(() => null);
if (!status) {
  const s = $('#setup');
  s.hidden = false;
  s.innerHTML = '<h3>Hearth server is not reachable</h3><p>Start it with <code>npm start</code>.</p>';
} else {
  if (!status.ok) {
    const s = $('#setup');
    s.hidden = false;
    s.innerHTML = `<h3>Almost ready</h3><p>${esc(status.error)}</p><p>Then restart with <code>npm start</code>. Meanwhile, try <code>/tool appliance_passport {}</code></p>`;
  }
  connectEvents();
}
