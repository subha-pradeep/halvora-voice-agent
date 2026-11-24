// The agent "brain" shared by every web/phone deployment of the cascaded pipeline.
import { overview, retrieve, formatContext } from './kb.js';
import { toolDefs, runTool, todayISO } from './tools.js';
import { streamTurn } from './llm.js';
import { chooseLLM, models } from './config.js';

export const AGENT_NAME = 'Aria';

// Static prompt. Kept byte-identical across turns and sessions so providers can cache the prefix
// (Gemini implicit caching / OpenAI automatic prompt caching). Dynamic data goes in the user turn.
export function buildInstructions({ style = 'Answer in 2 to 3 short sentences.', channel = 'voice', includeDate = false } = {}) {
  return [
    `You are ${AGENT_NAME}, the voice concierge of Halvora Hotels & Retreats. You are on a live ${channel === 'phone' ? 'phone call' : 'voice call'}.`,
    'Speaking style: warm, natural, concise. Plain spoken sentences only: no markdown, bullet points, emojis or headings. Say amounts like "11,500 rupees" and dates like "December 3rd". Ask one question at a time.',
    style,
    'Facts: use only the Halvora overview, the retrieved Halvora information and tool results. Never invent prices, policies or availability. If something is not covered, say you are not sure and offer a callback or the reservations line +91 80 5550 0142.',
    'Availability and prices for specific dates: always call check_availability. Convert relative dates ("next Friday") using today\'s date. Hotels are goa, udaipur, munnar and mumbai.',
    'Booking: collect hotel, check-in and check-out dates, number of guests, room type, rate plan (Flexible includes breakfast and is refundable; Saver is 15 percent cheaper and non-refundable), full name and phone number. Repeat a one-sentence summary with the total and get a yes before calling create_booking. Then read the confirmation code clearly, character by character.',
    'Cancellation: call cancel_booking without confirm first, tell the guest the fee and refund, and only after they agree call it again with confirm true.',
    'Callback: if the guest wants a call, ask for their number with country code and call request_callback.',
    'If the guest interrupts you, stop and address what they just said.',
    includeDate ? `Today is ${todayISO()} in India.` : '',
    '',
    'HALVORA OVERVIEW',
    overview(),
  ].filter((l) => l !== '').join('\n');
}

const weekday = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

export class Conversation {
  constructor({ profile, keys, llmPref = 'auto', channel = 'voice', ip }) {
    this.profile = profile;
    this.keys = keys;
    this.llmPref = llmPref;
    this.channel = channel;
    this.ip = ip;
    this.history = [];
    this.system = buildInstructions({ style: profile.style, channel });
    this.llm = chooseLLM(profile.id, keys, llmPref);
  }

  trimmedHistory() {
    const maxTurns = this.profile.historyTurns;
    let users = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === 'user' && ++users > maxTurns) return this.history.slice(i + 1);
    }
    return this.history;
  }

  candidates() {
    const list = [];
    if (this.llm) list.push(this.llm);
    // Fallback providers if the first one fails before producing tokens (e.g. free-tier 429).
    for (const p of ['gemini', 'groq', 'openai']) {
      if (this.keys[p] && !list.some((c) => c.provider === p)) list.push(chooseLLM(this.profile.id, this.keys, p));
    }
    return list;
  }

  // Async generator: yields {type:'text', text} | {type:'tool', names} ; returns metrics object.
  async *respond(userText, { signal } = {}) {
    if (!this.llm) throw new Error('No LLM API key configured (add a Gemini, Groq or OpenAI key).');
    const m = { llmProvider: this.llm.provider, llmModel: this.llm.model, toolRounds: 0, toolMs: 0 };
    const today = todayISO();
    const { results, ms } = retrieve(userText, this.profile.topK);
    m.ragMs = ms;
    m.ragChunks = results.length;
    const ctx = formatContext(results, this.profile.contextChars);
    const augmented = `[Today: ${today}, ${weekday(today)}, India time]\n[Retrieved Halvora information]\n${ctx || 'none'}\n[Guest said]\n${userText}`;

    this.history.push({ role: 'user', content: userText });
    const working = [...this.trimmedHistory()];
    working[working.length - 1] = { role: 'user', content: augmented };

    const t0 = performance.now();
    let full = '';
    for (let round = 0; round <= this.profile.maxToolRounds; round++) {
      const allowTools = round < this.profile.maxToolRounds;
      let done = null;
      const cands = this.candidates();
      for (let ci = 0; ci < cands.length; ci++) {
        const cand = cands[ci];
        let produced = false;
        try {
          const tReq = performance.now();
          for await (const ev of streamTurn({ ...cand, key: this.keys[cand.provider], system: this.system, messages: working, tools: allowTools ? toolDefs : undefined, maxTokens: this.profile.maxTokens, temperature: 0.4, signal })) {
            if (ev.type === 'text') {
              if (!produced && m.ttftMs === undefined) m.ttftMs = Math.round(performance.now() - tReq);
              produced = true;
              full += ev.text;
              yield ev;
            } else if (ev.type === 'done') done = ev;
          }
          if (ci > 0) { m.llmProvider = cand.provider; m.llmModel = cand.model; m.fallback = true; }
          break;
        } catch (e) {
          if (signal?.aborted) throw e;
          if (produced || ci === cands.length - 1) throw e;
          console.warn(`[brain] ${cand.provider}/${cand.model} failed (${e.status || ''} ${String(e.message).slice(0, 120)}); falling back`);
        }
      }
      if (done?.usage) { m.inputTokens = (m.inputTokens || 0) + (done.usage.input || 0); m.outputTokens = (m.outputTokens || 0) + (done.usage.output || 0); m.cachedTokens = (m.cachedTokens || 0) + (done.usage.cached || 0); }
      const calls = done?.toolCalls || [];
      const assistantMsg = { role: 'assistant', content: full, toolCalls: calls.length ? calls : undefined, ...(done?.raw?.gemini && m.llmProvider === 'gemini' ? { gemini: done.raw.gemini } : {}) };
      if (!calls.length) {
        this.history.push({ role: 'assistant', content: full });
        break;
      }
      // Tool round.
      m.toolRounds++;
      yield { type: 'tool', names: calls.map((c) => c.name) };
      const tt = performance.now();
      const outputs = await Promise.all(calls.map((c) => runTool(c.name, c.args, { ip: this.ip, topK: this.profile.topK })));
      m.toolMs += Math.round(performance.now() - tt);
      m.tools = [...(m.tools || []), ...calls.map((c) => c.name)];
      working.push(assistantMsg);
      this.history.push(assistantMsg);
      calls.forEach((c, i) => {
        const toolMsg = { role: 'tool', name: c.name, toolCallId: c.id, content: JSON.stringify(outputs[i]) };
        working.push(toolMsg);
        this.history.push(toolMsg);
      });
      full = full && !/[.!?]\s*$/.test(full) ? full + '. ' : full ? full + ' ' : '';
    }
    m.llmTotalMs = Math.round(performance.now() - t0);
    m.responseChars = full.length;
    return m;
  }

  markInterrupted(spokenChars) {
    const last = [...this.history].reverse().find((x) => x.role === 'assistant');
    if (last && typeof last.content === 'string' && !last.gemini) {
      last.content = last.content.slice(0, Math.max(0, spokenChars)) + ' [interrupted by guest]';
    }
  }
}

// Splits a token stream into speakable chunks. The first chunk can be emitted at a clause boundary
// (low-latency mode) so TTS starts as early as possible; later chunks are whole sentences.
export class Chunker {
  constructor(firstChunk = 'sentence') { this.buf = ''; this.first = true; this.mode = firstChunk; }
  push(text) {
    this.buf += text;
    const out = [];
    let start = 0;
    for (let i = 0; i < this.buf.length - 1; i++) {
      const ch = this.buf[i];
      if (!/\s/.test(this.buf[i + 1])) continue;
      const clause = this.first && this.mode === 'clause';
      const isEnd = /[.!?]/.test(ch) || (clause && /[,;:]/.test(ch));
      if (!isEnd) continue;
      const piece = this.buf.slice(start, i + 1);
      if (piece.trim().length < (clause ? 12 : 3)) continue;
      if (ch === '.' && /\b(?:Mr|Mrs|Ms|Dr|St|Rs|No|vs|approx)\.$/i.test(piece)) continue;
      out.push(piece);
      start = i + 1;
      this.first = false;
    }
    this.buf = this.buf.slice(start);
    if (this.buf.length > 220) { // very long run-on sentence: cut at a space
      const cut = this.buf.lastIndexOf(' ', 200);
      if (cut > 40) { out.push(this.buf.slice(0, cut)); this.buf = this.buf.slice(cut + 1); this.first = false; }
    }
    return out.map(clean).filter(Boolean);
  }
  flush() { const t = clean(this.buf); this.buf = ''; return t ? [t] : []; }
}

export function clean(t) {
  return t.replace(/[*_#`>]+/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/\s+/g, ' ').trim();
}

export { models };
