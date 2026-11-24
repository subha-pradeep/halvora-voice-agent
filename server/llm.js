// Provider-neutral streaming LLM interface.
// Messages: { role: 'user'|'assistant'|'tool', content, toolCalls?, toolCallId?, name?, gemini? }
// streamTurn() yields { type: 'text', text } and finally { type: 'done', toolCalls, usage, raw }.
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import OpenAI from 'openai';

const clients = new Map();
function client(provider, key) {
  const id = `${provider}:${key}`;
  if (!clients.has(id)) {
    if (provider === 'gemini') clients.set(id, new GoogleGenAI({ apiKey: key }));
    else if (provider === 'groq') clients.set(id, new OpenAI({ apiKey: key, baseURL: 'https://api.groq.com/openai/v1', maxRetries: 1 }));
    else clients.set(id, new OpenAI({ apiKey: key, maxRetries: 1 }));
  }
  return clients.get(id);
}
export function geminiClient(key) { return client('gemini', key); }

// ---- Gemini ----
// Thinking adds hundreds of ms of TTFT; turn it off (2.5) or set it to minimal (3.x).
const thinkingSupport = new Map(); // model -> config | null (null = send nothing)
function thinkingFor(model) {
  if (thinkingSupport.has(model)) return thinkingSupport.get(model);
  if (/2\.5/.test(model)) return { thinkingBudget: 0 };
  return { thinkingLevel: ThinkingLevel.MINIMAL };
}

function toGemini(messages) {
  const contents = [];
  for (const m of messages) {
    if (m.role === 'user') contents.push({ role: 'user', parts: [{ text: m.content }] });
    else if (m.role === 'assistant') {
      if (m.gemini) contents.push({ role: 'model', parts: m.gemini });
      else {
        const parts = [];
        if (m.content) parts.push({ text: m.content });
        for (const c of m.toolCalls || []) parts.push({ functionCall: { name: c.name, args: c.args } });
        if (parts.length) contents.push({ role: 'model', parts });
      }
    } else if (m.role === 'tool') {
      const part = { functionResponse: { name: m.name, response: { result: m.content } } };
      const last = contents[contents.length - 1];
      if (last && last.role === 'user' && last.parts[0]?.functionResponse) last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
    }
  }
  return contents;
}

async function* geminiStream({ key, model, system, messages, tools, maxTokens, temperature, signal }) {
  const ai = client('gemini', key);
  const baseConfig = {
    systemInstruction: system,
    maxOutputTokens: maxTokens,
    temperature,
    abortSignal: signal,
    ...(tools?.length ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] } : {}),
  };
  const contents = toGemini(messages);
  let stream;
  const thinking = thinkingFor(model);
  try {
    stream = await ai.models.generateContentStream({ model, contents, config: thinking ? { ...baseConfig, thinkingConfig: thinking } : baseConfig });
    thinkingSupport.set(model, thinking);
  } catch (e) {
    if (!thinking || !/think/i.test(String(e.message))) throw e;
    thinkingSupport.set(model, null); // model rejects this thinking config; retry without
    stream = await ai.models.generateContentStream({ model, contents, config: baseConfig });
  }
  const parts = [];
  const toolCalls = [];
  let usage = {};
  for await (const chunk of stream) {
    const cparts = chunk.candidates?.[0]?.content?.parts || [];
    for (const p of cparts) {
      parts.push(p);
      if (p.thought) continue;
      if (p.text) yield { type: 'text', text: p.text };
      if (p.functionCall) toolCalls.push({ id: p.functionCall.id || `call_${toolCalls.length}`, name: p.functionCall.name, args: p.functionCall.args || {} });
    }
    if (chunk.usageMetadata) usage = { input: chunk.usageMetadata.promptTokenCount, output: chunk.usageMetadata.candidatesTokenCount, cached: chunk.usageMetadata.cachedContentTokenCount || 0 };
  }
  yield { type: 'done', toolCalls, usage, raw: { gemini: parts } };
}

// ---- OpenAI-compatible (OpenAI, Groq) ----
function toOpenAI(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null };
      if (m.toolCalls?.length) msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
      out.push(msg);
    } else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
  }
  return out;
}

async function* openaiStream({ provider, key, model, system, messages, tools, maxTokens, temperature, signal }) {
  const c = client(provider, key);
  const body = {
    model,
    messages: toOpenAI(system, messages),
    stream: true,
    temperature,
    ...(provider === 'openai' ? { max_completion_tokens: maxTokens, stream_options: { include_usage: true } } : { max_tokens: maxTokens }),
    ...(tools?.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), parallel_tool_calls: false } : {}),
  };
  const stream = await c.chat.completions.create(body, { signal });
  const calls = [];
  let usage = {};
  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta;
    if (d?.content) yield { type: 'text', text: d.content };
    for (const tc of d?.tool_calls || []) {
      const slot = (calls[tc.index ?? 0] ||= { id: '', name: '', args: '' });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
    const u = chunk.usage || chunk.x_groq?.usage;
    if (u) usage = { input: u.prompt_tokens, output: u.completion_tokens, cached: u.prompt_tokens_details?.cached_tokens || 0 };
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => {
    let args = {};
    try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = {}; }
    return { id: c.id || `call_${i}`, name: c.name, args };
  });
  yield { type: 'done', toolCalls, usage, raw: {} };
}

export function streamTurn(opts) {
  if (opts.provider === 'gemini') return geminiStream(opts);
  return openaiStream(opts);
}
