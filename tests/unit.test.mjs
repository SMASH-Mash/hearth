import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseGemini, geminiCandidates, loadConfig, DEFAULT_CONFIG } from '../server/config.js';
import { systemPrompt, DeviceSession } from '../server/session.js';

test('picks the newest stable Gemini Flash model', () => {
  assert.equal(chooseGemini(['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']), 'gemini-2.5-flash');
  assert.equal(chooseGemini(['gemini-2.5-flash', 'gemini-3-flash-preview']), 'gemini-3-flash-preview', 'a newer generation preview wins');
  assert.equal(chooseGemini(['gemini-3-flash', 'gemini-3-flash-preview']), 'gemini-3-flash', 'stable beats preview of the same generation');
  assert.equal(chooseGemini(['gemini-2.5-flash-image', 'gemini-2.5-flash-preview-tts']), 'gemini-2.5-flash', 'fallback');
});

test('fallback chain: newest stable Flash models, then one Flash-Lite', () => {
  const names = ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.8-flash-tts', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
  assert.deepEqual(geminiCandidates(names), ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']);
  assert.deepEqual(geminiCandidates(['gemini-3-flash-preview']), ['gemini-3-flash-preview'], 'falls back to the single best');
});

test('config falls back to the Mend demo', async () => {
  const cfg = await loadConfig('does-not-exist.json');
  assert.deepEqual(cfg, DEFAULT_CONFIG);
});

test('system prompt makes the assistant a voice and keeps confirmations human', () => {
  const p = systemPrompt({ name: 'Alexa' }, [{ name: 'mend', title: 'Mend', instructions: 'Read ONE step at a time.' }]);
  assert.match(p, /You are Alexa/);
  assert.match(p, /spoken aloud/);
  assert.match(p, /never claim they confirmed/);
  assert.match(p, /## Mend\nRead ONE step at a time\./);
});

function fakeStream() {
  const lines = [];
  return { lines, write: (s) => lines.push(s) };
}

test('elicitation goes to the device and the answer comes back', async () => {
  const s = new DeviceSession('t1', { config: DEFAULT_CONFIG, model: null, modelLabel: 'none' });
  const res = fakeStream();
  s.streams.add(res);
  const pending = s.askPerson('mend', { message: 'Is it unplugged?', requestedSchema: { type: 'object', properties: { confirmed: { type: 'boolean' } } } });
  const sent = res.lines.find((l) => l.startsWith('event: elicit'));
  const id = JSON.parse(sent.split('data: ')[1]).id;
  assert.equal(s.answer(id, { action: 'accept', content: { confirmed: true } }), true);
  assert.deepEqual(await pending, { action: 'accept', content: { confirmed: true } });
  assert.equal(s.answer(id, { action: 'accept' }), false, 'each request is answered once');
});

test('a refreshed page gets the screens the session already loaded', () => {
  const s = new DeviceSession('t2', { config: DEFAULT_CONFIG, model: null, modelLabel: 'none' });
  s.uiCache.set('ui://mend/screen.html', { html: '<p>hi</p>', csp: null });
  const res = fakeStream();
  s.replayTo(res);
  assert.match(res.lines[0], /^event: screenResource\ndata: .*"uri":"ui:\/\/mend\/screen.html"/);
});

test('screen taps are noted for the model', () => {
  const s = new DeviceSession('t3', { config: DEFAULT_CONFIG, model: null, modelLabel: 'none' });
  s.note('Person tapped Next');
  assert.deepEqual(s.notes, ['[Screen update: Person tapped Next]']);
});
