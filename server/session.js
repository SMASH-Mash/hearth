// One device session = one Strands agent + its MCP connections + the browser(s) showing it.

import { randomUUID } from 'node:crypto';
import { Agent, McpClient } from '@strands-agents/sdk';

const ELICIT_TIMEOUT_MS = 5 * 60000;

export function systemPrompt(assistant, servers) {
  const skills = servers.filter((s) => s.instructions).map((s) => `## ${s.title || s.name}\n${s.instructions}`).join('\n\n');
  return `You are ${assistant.name}, a voice assistant on an Echo Show-style smart display (a Hearth simulation of Alexa+).
Everything you write is spoken aloud. Use short, natural spoken sentences: no markdown, lists, headings, URLs or emojis.
The display shows screens from the connected skills, so don't read out long lists or tables that are already on screen. When a tool's result begins with a short spoken summary, base your reply on it. Never invent facts, steps, numbers or instructions that a tool didn't give you; if you don't have them, call the tool.
Use the connected skills' tools whenever they can help. If a tool asks the person to confirm something, the device asks them directly: never claim they confirmed, and never pass confirmation flags on their behalf unless they just said yes out loud.
Today is ${new Date().toDateString()}.

Connected skills:
${skills || 'none'}`;
}

export class DeviceSession {
  constructor(id, { config, model, modelLabel, log = () => {} }) {
    this.id = id;
    this.config = config;
    this.model = model;
    this.modelLabel = modelLabel;
    this.log = log;
    this.streams = new Set();
    this.pending = new Map();
    this.notes = [];
    this.servers = [];
    this.uiTools = new Map();
    this.uiCache = new Map();
    this.queue = Promise.resolve();
    this.ready = null;
  }

  /** A newly opened page (or a refresh) needs the screens this session already fetched. */
  replayTo(res) {
    for (const [uri, r] of this.uiCache) res.write(`event: screenResource\ndata: ${JSON.stringify({ uri, ...r })}\n\n`);
  }

  send(type, data = {}) {
    const line = `event: ${type}\ndata: ${JSON.stringify({ ...data, at: Date.now() })}\n\n`;
    for (const res of this.streams) res.write(line);
  }

  async start() {
    this.ready ||= this._start();
    return this.ready;
  }

  async _start() {
    for (const s of this.config.servers) {
      const mcp = new McpClient({
        url: s.url,
        headers: s.headers,
        clientName: 'hearth',
        clientVersion: '1.0.0',
        elicitationCallback: (_ctx, params) => this.askPerson(s.name, params),
      });
      try {
        await mcp.connect();
      } catch (e) {
        this.send('error', { message: `Could not connect to ${s.name} at ${s.url}: ${e.message}` });
        continue;
      }
      // Capture full tool results (incl. structuredContent) for MCP Apps screens;
      // the model itself only receives the text content.
      const callTool = mcp.callTool.bind(mcp);
      mcp.callTool = async (tool, input, opts) => {
        const result = await callTool(tool, input, opts);
        await this.showScreen(tool.name, input, result).catch((e) => this.log('screen', e));
        return result;
      };
      const { tools } = await mcp.client.listTools();
      for (const t of tools) {
        const uri = t._meta?.ui?.resourceUri || t._meta?.['ui/resourceUri'];
        if (uri) this.uiTools.set(t.name, { uri, client: mcp, server: s.name });
      }
      this.servers.push({
        name: s.name,
        url: s.url,
        title: mcp.serverVersion?.title || mcp.serverVersion?.name || s.name,
        version: mcp.serverVersion?.version,
        instructions: mcp.serverInstructions,
        tools: tools.map((t) => ({ name: t.name, title: t.title, hasScreen: Boolean(t._meta?.ui?.resourceUri) })),
        client: mcp,
      });
    }
    if (this.model) {
      this.agent = new Agent({
        model: this.model,
        tools: this.servers.map((s) => s.client),
        systemPrompt: systemPrompt(this.config.assistant, this.servers),
        printer: false,
      });
    }
    this.send('ready', this.describe());
    return this;
  }

  describe() {
    return {
      assistant: this.config.assistant,
      model: this.modelLabel,
      servers: this.servers.map(({ client, ...s }) => ({ ...s, protocol: '2025-11-25' })),
    };
  }

  /** Server → person: show the question on the device and wait for their answer. */
  askPerson(server, params) {
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => { if (this.pending.delete(id)) resolve({ action: 'cancel' }); }, ELICIT_TIMEOUT_MS);
      this.pending.set(id, (answer) => { clearTimeout(timer); resolve(answer); });
      this.send('elicit', { id, server, message: params.message, mode: params.mode || 'form', schema: params.requestedSchema || null, url: params.url || null });
    });
  }

  answer(id, answer) {
    const resolve = this.pending.get(id);
    if (!resolve) return false;
    this.pending.delete(id);
    resolve(answer);
    this.send('elicitDone', { id, action: answer.action });
    return true;
  }

  async showScreen(toolName, input, result) {
    const ui = this.uiTools.get(toolName);
    if (!ui) return;
    let html = this.uiCache.get(ui.uri);
    if (!html) {
      const res = await ui.client.client.readResource({ uri: ui.uri });
      const item = res.contents?.[0];
      html = { html: item?.text || '', csp: item?._meta?.ui?.csp || null };
      this.uiCache.set(ui.uri, html);
      this.send('screenResource', { uri: ui.uri, ...html });
    }
    this.send('screen', { uri: ui.uri, server: ui.server, toolName, input, result });
  }

  /** A tool call from a touch on an MCP App screen, or a developer's "/tool" command (direct). */
  async callFromScreen(name, args, { direct = false } = {}) {
    await this.start();
    const owner = this.servers.find((s) => s.tools.some((t) => t.name === name));
    const target = owner?.client || this.servers[0]?.client;
    if (!target) throw new Error('No MCP server connected');
    const source = direct ? 'developer' : 'screen';
    this.send('tool', { name, input: args, source });
    const result = await target.client.callTool({ name, arguments: args });
    this.send('toolDone', { name, status: result.isError ? 'error' : 'success', source });
    if (direct) await this.showScreen(name, args, result).catch((e) => this.log('screen', e));
    const speech = result.structuredContent?.speech || result.content?.find((c) => c.type === 'text')?.text;
    this.notes.push(`[The person used the screen: ${name}${speech ? ` → "${speech}"` : ''}]`);
    if (speech && this.config.assistant.speakScreenResults) this.send('say', { text: speech, source: 'screen' });
    return result;
  }

  note(text) {
    if (text) this.notes.push(`[Screen update: ${String(text).slice(0, 500)}]`);
  }

  /** Runs one spoken turn through the agent, streaming everything to the device. */
  say(text) {
    this.queue = this.queue.then(() => this._turn(text)).catch((e) => {
      this.log('turn', e);
      this.send('error', { message: e.message });
      this.send('state', { state: 'idle' });
    });
    return this.queue;
  }

  async _turn(text) {
    await this.start();
    if (!this.agent) throw new Error('No model configured. Add GEMINI_API_KEY to hearth/.env, or use /tool <name> {json} to call tools directly.');
    const prompt = this.notes.length ? `${this.notes.splice(0).join('\n')}\nThe person says: ${text}` : text;
    this.send('heard', { text });
    this.send('state', { state: 'thinking' });
    for await (const ev of this.agent.stream(prompt)) {
      if (ev.type === 'modelStreamUpdateEvent' && ev.event?.type === 'modelContentBlockDeltaEvent' && ev.event.delta?.type === 'textDelta') {
        this.send('delta', { text: ev.event.delta.text });
      } else if (ev.type === 'beforeToolCallEvent') {
        this.send('tool', { name: ev.toolUse.name, input: ev.toolUse.input, id: ev.toolUse.toolUseId, source: 'assistant' });
      } else if (ev.type === 'afterToolCallEvent') {
        this.send('toolDone', { name: ev.toolUse.name, id: ev.toolUse.toolUseId, status: ev.result?.status, error: ev.error?.message, source: 'assistant' });
      } else if (ev.type === 'modelMessageEvent') {
        const said = (ev.message?.content || []).filter((b) => typeof b.text === 'string').map((b) => b.text).join(' ').trim();
        if (said) this.send('say', { text: said, source: 'assistant' });
      }
    }
    this.send('state', { state: 'idle' });
  }

  async close() {
    for (const s of this.servers) await s.client.disconnect?.().catch?.(() => {});
    for (const [, resolve] of this.pending) resolve({ action: 'cancel' });
    this.pending.clear();
  }
}
