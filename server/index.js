import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { AccessToken } from 'livekit-server-sdk';
import { PORT, ROOT, PUBLIC_BASE_URL, ALLOW_CLIENT_KEYS, ADMIN_TOKEN, INTERNAL_SECRET, env, profiles, resolveKeys, chooseLLM, livekit, vapi, twilio } from './config.js';
import * as site from './site.js';
import { retrieve } from './kb.js';
import { setCallbackHook, runTool } from './tools.js';
import { Conversation, AGENT_NAME } from './brain.js';
import { CascadeSession, friendly } from './pipelines/cascade.js';
import { S2SSession } from './pipelines/s2s.js';
import { voiceWebhook, handleMediaStream, placeCallback, twilioEnabled } from './telephony/twilio.js';
import { assistantConfig, toolsWebhook, eventsWebhook, vapiEnabled } from './vapi.js';
import { recordMetric, summary, allMetrics, clearMetrics, PLATFORMS } from './metrics.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'microphone=(self)');
  next();
});
app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1h' }));

// Simple fixed-window rate limiter.
function rateLimit(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const arr = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Too many requests, slow down.' });
    arr.push(now);
    hits.set(req.ip, arr);
    if (hits.size > 5000) hits.clear();
    next();
  };
}

// ---------- Pages ----------
const html = (fn) => (req, res) => { const out = fn(req); if (!out) return res.status(404).send(site.notFoundPage()); res.type('html').send(out); };
app.get('/', html(() => site.homePage()));
app.get('/hotels', (req, res) => res.redirect('/hotels/goa'));
app.get('/hotels/:id', html((req) => site.hotelPage(req.params.id)));
app.get('/pricing', html(() => site.pricingPage()));
app.get('/guide', html(() => site.guidePage()));
app.get('/faq', html(() => site.faqPage()));
app.get('/about', html(() => site.aboutPage()));
app.get('/talk', html(() => site.talkPage()));
app.get('/dashboard', html(() => site.dashboardPage()));
app.get('/settings', html(() => site.settingsPage()));
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

// ---------- Public config ----------
app.get('/api/config', (req, res) => {
  const k = resolveKeys({});
  res.json({
    agent: AGENT_NAME,
    allowClientKeys: ALLOW_CLIENT_KEYS,
    features: {
      cascade: !!(k.deepgram && (k.gemini || k.groq || k.openai)),
      s2s: !!k.gemini,
      twilio: twilioEnabled(),
      livekit: !!(livekit.url && livekit.apiKey && livekit.apiSecret),
      vapi: vapiEnabled(),
    },
    keysPresent: { gemini: !!k.gemini, groq: !!k.groq, deepgram: !!k.deepgram, openai: !!k.openai },
    llm: { standard: chooseLLM('standard', k), fast: chooseLLM('fast', k) },
    profiles: Object.fromEntries(Object.entries(profiles).map(([id, p]) => [id, { label: p.label, endpointingMs: p.endpointingMs, topK: p.topK, maxTokens: p.maxTokens, historyTurns: p.historyTurns, firstChunk: p.firstChunk, ttsSampleRate: p.ttsSampleRate, preBufferMs: p.preBufferMs }])),
    twilioNumber: twilioEnabled() ? twilio.number : null,
    vapi: vapiEnabled() ? { publicKey: vapi.publicKey, assistantId: vapi.assistantId || null } : null,
    livekitUrl: livekit.url || null,
  });
});

app.get('/api/kb/search', rateLimit(60, 60000), (req, res) => {
  const q = String(req.query.q || '').slice(0, 200);
  const { results, ms } = retrieve(q, 4);
  res.json({ ms, results: results.map(({ title, text, url, score }) => ({ title, text, url, score })) });
});

// Text chat endpoint (handy for testing the brain without a microphone).
const textSessions = new Map();
app.post('/api/chat', rateLimit(30, 60000), async (req, res) => {
  const text = String(req.body?.text || '').slice(0, 1000).trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  let id = String(req.body?.sessionId || '');
  let s = textSessions.get(id);
  if (!s) {
    id = crypto.randomUUID();
    const profile = profiles[req.body?.profile] || profiles.standard;
    s = { conv: new Conversation({ profile, keys: resolveKeys(req.body?.keys), llmPref: req.body?.llm, ip: req.ip }), at: Date.now() };
    textSessions.set(id, s);
  }
  s.at = Date.now();
  try {
    let reply = '';
    const gen = s.conv.respond(text);
    let r;
    while (!(r = await gen.next()).done) if (r.value.type === 'text') reply += r.value.text;
    res.json({ sessionId: id, reply, metrics: r.value });
  } catch (e) {
    res.status(502).json({ error: friendly(e) });
  }
  for (const [k, v] of textSessions) if (Date.now() - v.at > 30 * 60000) textSessions.delete(k);
});

// ---------- LiveKit ----------
app.get('/api/livekit/token', rateLimit(10, 60000), async (req, res) => {
  if (!livekit.url || !livekit.apiKey || !livekit.apiSecret) return res.status(503).json({ error: 'LiveKit is not configured.' });
  const room = `halvora-${crypto.randomBytes(4).toString('hex')}`;
  const identity = `guest-${crypto.randomBytes(3).toString('hex')}`;
  const at = new AccessToken(livekit.apiKey, livekit.apiSecret, { identity, ttl: '15m' });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
  res.json({ url: livekit.url, token: await at.toJwt(), room });
});

// ---------- Twilio ----------
app.post('/twilio/voice', voiceWebhook);
app.post('/api/callback', rateLimit(5, 3600000), async (req, res) => {
  const phone = String(req.body?.phone || '').replace(/[^\d+]/g, '');
  try {
    await placeCallback({ phone, ip: req.ip });
    res.json({ ok: true, message: `Calling ${phone.slice(0, 3)}••••${phone.slice(-3)} now.` });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
setCallbackHook(({ phone, ip }) => placeCallback({ phone, ip, delayMs: 8000 }));

// ---------- Vapi ----------
app.get('/api/vapi/assistant', (req, res) => (vapiEnabled() ? res.json(assistantConfig()) : res.status(503).json({ error: 'Vapi is not configured.' })));
app.post('/vapi/tools', toolsWebhook);
app.post('/vapi/events', eventsWebhook);

// ---------- Metrics ----------
const PUBLIC_METRIC_PLATFORMS = new Set(['livekit', 'vapi']);
app.post('/api/metrics', rateLimit(120, 60000), (req, res) => {
  const rows = Array.isArray(req.body) ? req.body.slice(0, 20) : [req.body];
  let n = 0;
  for (const r of rows) if (r && PUBLIC_METRIC_PLATFORMS.has(r.platform)) { recordMetric({ ...r, source: 'client' }); n++; }
  res.json({ stored: n });
});
function internalOnly(req, res, next) {
  const got = Buffer.from(String(req.get('x-internal-secret') || ''));
  const want = Buffer.from(INTERNAL_SECRET);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(401).json({ error: 'unauthorized' });
  next();
}
app.post('/api/internal/tool', internalOnly, async (req, res) => res.json(await runTool(String(req.body?.name || ''), req.body?.args || {}, { ip: 'livekit', topK: 2 })));
app.post('/api/internal/metrics', internalOnly, (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [req.body];
  for (const r of rows.slice(0, 50)) if (r && PLATFORMS[r.platform]) recordMetric(r);
  res.json({ ok: true });
});
app.get('/api/metrics', (req, res) => res.json({ platforms: PLATFORMS, summary: summary(), recent: allMetrics().slice(-80).reverse() }));
app.delete('/api/metrics', (req, res) => {
  if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  clearMetrics();
  res.json({ ok: true });
});

app.use((req, res) => res.status(404).type('html').send(site.notFoundPage()));

// ---------- WebSockets ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 25);
const perIp = new Map();
let active = 0;

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  if (!['/ws/cascade', '/ws/s2s', '/twilio/media'].includes(pathname)) return socket.destroy();
  if (pathname !== '/twilio/media') {
    const origin = req.headers.origin;
    const allowed = [PUBLIC_BASE_URL, `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
    if (origin && !allowed.includes(origin) && process.env.ALLOW_ANY_ORIGIN !== 'true') return socket.destroy();
    if (active >= MAX_SESSIONS || (perIp.get(ip) || 0) >= 3) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return socket.destroy(); }
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    active++;
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    ws.on('close', () => { active--; const n = (perIp.get(ip) || 1) - 1; if (n <= 0) perIp.delete(ip); else perIp.set(ip, n); });
    if (pathname === '/twilio/media') return handleMediaStream(ws, req);
    handleBrowserSession(ws, pathname === '/ws/s2s' ? 's2s' : 'cascade', ip);
  });
});

function handleBrowserSession(ws, kind, ip) {
  let session = null;
  const send = (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
  const transport = {
    sendAudio: (buf) => ws.readyState === 1 && ws.send(buf, { binary: true }),
    clear: () => send({ type: 'clear' }),
    event: send,
    close: () => { try { ws.close(); } catch {} },
  };
  const startTimer = setTimeout(() => !session && ws.close(), 10000);
  ws.on('message', async (data, isBinary) => {
    if (isBinary) return session?.pushAudio(Buffer.from(data));
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'start' && !session) {
      clearTimeout(startTimer);
      const keys = resolveKeys(msg.keys || {});
      const sessionId = crypto.randomUUID();
      try {
        if (kind === 's2s') {
          session = new S2SSession({ transport, keys, ip, sessionId });
          await session.start();
        } else {
          const profile = profiles[msg.profile] || profiles.fast;
          session = new CascadeSession({ transport, profile, keys, llmPref: msg.llm || 'auto', platform: `web-cascade-${profile.id}`, ip });
          session.start();
        }
      } catch (e) {
        console.error(`[${kind}] start failed:`, e.message);
        send({ type: 'error', message: friendly(e), fatal: true });
        session = null;
        setTimeout(() => ws.close(), 200);
      }
    } else if (msg.type === 'client_metric') session?.clientMetric(msg);
    else if (msg.type === 'text' && session instanceof CascadeSession && typeof msg.text === 'string') {
      session.segments = [msg.text.slice(0, 500)];
      session.lastWordEnd = null;
      session.commitUserTurn('typed');
    } else if (msg.type === 'stop') { session?.close(); ws.close(); }
  });
  ws.on('close', () => { clearTimeout(startTimer); session?.close(); });
  ws.on('error', () => session?.close());
}

server.listen(PORT, () => {
  const k = resolveKeys({});
  console.log(`Halvora voice agent on ${PUBLIC_BASE_URL} (port ${PORT})`);
  console.log(`  keys: gemini=${!!k.gemini} groq=${!!k.groq} deepgram=${!!k.deepgram} openai=${!!k.openai} | twilio=${twilioEnabled()} livekit=${!!livekit.url} vapi=${vapiEnabled()}`);
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
