// Latency metrics store (JSON file) + aggregation for the comparison dashboard.
// Only real measurements are stored; nothing is seeded.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'metrics.json');
const MAX = 5000;
let rows = [];
try { rows = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { rows = []; }
let timer = null;
function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFile(FILE, JSON.stringify(rows), () => {}); }, 500);
}

export const PLATFORMS = {
  'web-cascade-standard': 'Website · Cascaded (Standard)',
  'web-cascade-fast': 'Website · Cascaded (Low Latency)',
  'web-s2s': 'Website · Speech-to-Speech',
  livekit: 'LiveKit Agent',
  vapi: 'Vapi Agent',
  twilio: 'Phone Call (Twilio)',
};

const NUM_FIELDS = ['responseMs', 'perceivedMs', 'clientV2vMs', 'endOfTurnMs', 'llmTtftMs', 'ttsTtfbMs', 'ragMs', 'toolMs', 'sttMs', 'turnIndex', 'inputTokens', 'cachedTokens', 'outputTokens', 'toolRounds'];

export function sanitize(input) {
  const platform = String(input.platform || '');
  if (!PLATFORMS[platform]) return null;
  const rec = { platform, ts: Date.now(), source: String(input.source || 'client').slice(0, 20) };
  for (const f of NUM_FIELDS) {
    const v = Number(input[f]);
    if (input[f] != null && Number.isFinite(v) && v >= 0 && v < 60000) rec[f] = Math.round(v);
  }
  if (typeof input.llm === 'string') rec.llm = input.llm.slice(0, 80);
  if (typeof input.profile === 'string') rec.profile = input.profile.slice(0, 20);
  if (typeof input.sessionId === 'string') rec.sessionId = input.sessionId.slice(0, 40);
  if (Array.isArray(input.tools)) rec.tools = input.tools.slice(0, 6).map((t) => String(t).slice(0, 40));
  if (input.interrupted) rec.interrupted = true;
  return rec;
}

export function recordMetric(input) {
  const rec = sanitize(input);
  if (!rec) return;
  rows.push(rec);
  if (rows.length > MAX) rows = rows.slice(-MAX);
  persist();
}

export function clearMetrics() { rows = []; persist(); }
export function allMetrics() { return rows; }

// "Headline" latency for a row: the best end-to-end measurement available.
// Client-measured voice-to-voice beats server-side estimates.
export const headline = (r) => r.clientV2vMs ?? r.responseMs ?? r.perceivedMs ?? null;

const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

// Two measurement families are kept separate so turns are never double-counted:
//  - clientV2vMs: browser-measured voice-to-voice (same method for every web mode)
//  - responseMs:  server/framework-reported (our pipeline timers, LiveKit metrics, Vapi report)
// The headline uses browser voice-to-voice where available (apples-to-apples across web modes),
// otherwise the server/framework number (Twilio).
export function summary() {
  const out = {};
  for (const [id, label] of Object.entries(PLATFORMS)) {
    const rs = rows.filter((r) => r.platform === id && !r.interrupted);
    const vals = (f, filter = () => true) => rs.filter(filter).map((r) => r[f]).filter((v) => Number.isFinite(v));
    const client = vals('clientV2vMs');
    const server = vals('responseMs');
    const useClient = client.length > 0;
    const heads = useClient ? client : server;
    const headField = useClient ? 'clientV2vMs' : 'responseMs';
    const first = vals(headField, (r) => r.turnIndex === 1);
    out[id] = {
      label,
      turns: Math.max(client.length, server.length),
      headlineSource: heads.length ? (useClient ? 'browser voice-to-voice' : 'server / framework') : null,
      firstResponseMs: avg(first),
      avgResponseMs: avg(heads),
      p50Ms: pct(heads, 50),
      p90Ms: pct(heads, 90),
      clientV2vMs: avg(client),
      serverResponseMs: avg(server),
      endOfTurnMs: avg(vals('endOfTurnMs')),
      sttMs: avg(vals('sttMs')),
      llmTtftMs: avg(vals('llmTtftMs')),
      ttsTtfbMs: avg(vals('ttsTtfbMs')),
      perceivedMs: avg(vals('perceivedMs')),
      cacheHitRate: (() => { const t = rs.filter((r) => r.inputTokens); const inp = t.reduce((x, r) => x + r.inputTokens, 0); return inp ? Math.round((100 * t.reduce((x, r) => x + (r.cachedTokens || 0), 0)) / inp) : null; })(),
    };
  }
  return out;
}
