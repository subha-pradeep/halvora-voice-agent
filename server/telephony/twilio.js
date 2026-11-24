// Twilio phone integration: inbound calls, outbound callbacks, and the Media Streams bridge
// into the same cascaded pipeline (mu-law 8 kHz in and out, no transcoding needed).
import crypto from 'node:crypto';
import { twilio, profiles, env, PUBLIC_BASE_URL } from '../config.js';
import { CascadeSession } from '../pipelines/cascade.js';

export const twilioEnabled = () => !!(twilio.accountSid && twilio.authToken && twilio.number);

const hmac = (s) => crypto.createHmac('sha256', twilio.authToken || 'x').update(s).digest('hex').slice(0, 32);

export function validTwilioSignature(req) {
  if (!twilio.authToken) return false;
  const sig = req.get('X-Twilio-Signature') || '';
  const url = PUBLIC_BASE_URL + req.originalUrl;
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', twilio.authToken).update(data).digest('base64');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export function voiceWebhook(req, res) {
  if (process.env.TWILIO_SKIP_SIGNATURE !== 'true' && !validTwilioSignature(req)) {
    console.warn('[twilio] rejected webhook with invalid signature. Is PUBLIC_BASE_URL exactly the public URL Twilio calls?');
    return res.status(403).type('text/plain').send('invalid signature');
  }
  const callSid = String(req.body?.CallSid || '');
  const wsUrl = PUBLIC_BASE_URL.replace(/^http/, 'ws') + '/twilio/media';
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlEscape(wsUrl)}">
      <Parameter name="token" value="${hmac(callSid)}"/>
      <Parameter name="direction" value="${xmlEscape(req.query.callback ? 'callback' : 'inbound')}"/>
    </Stream>
  </Connect>
</Response>`);
}

// WebSocket handler for wss://<host>/twilio/media
export function handleMediaStream(ws, req) {
  let session = null;
  let streamSid = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      const callSid = msg.start.callSid;
      if (msg.start.customParameters?.token !== hmac(callSid)) {
        console.warn('[twilio] media stream with bad token; closing');
        return ws.close();
      }
      const transport = {
        sendAudio: (buf) => ws.readyState === 1 && ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: buf.toString('base64') } })),
        clear: () => ws.readyState === 1 && ws.send(JSON.stringify({ event: 'clear', streamSid })),
        event: (e) => { if (e.type === 'user' || e.type === 'assistant' || e.type === 'error') console.log(`[twilio ${callSid.slice(-6)}] ${e.type}: ${e.text || e.message || ''}`); },
        close: () => { try { ws.close(); } catch {} },
      };
      session = new CascadeSession({
        transport,
        profile: profiles[twilio.profile] || profiles.fast,
        keys: { ...env },
        platform: 'twilio',
        channel: 'phone',
        inEncoding: 'mulaw', inRate: 8000, outEncoding: 'mulaw',
        awaitClientMetrics: false,
      });
      try { session.start(); } catch (e) { console.error('[twilio]', e.message); ws.close(); }
    } else if (msg.event === 'media' && session) {
      if (msg.media.track && msg.media.track !== 'inbound') return;
      session.pushAudio(Buffer.from(msg.media.payload, 'base64'));
    } else if (msg.event === 'stop') {
      session?.close();
    }
  });
  ws.on('close', () => session?.close());
  ws.on('error', () => session?.close());
}

// ---- Outbound callback with abuse limits (calls cost money and reach real people) ----
const recent = { byPhone: new Map(), byIp: new Map(), day: { date: '', count: 0 } };
function limit(phone, ip) {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (recent.day.date !== today) recent.day = { date: today, count: 0 };
  if (recent.day.count >= Number(process.env.CALLBACK_DAILY_LIMIT || 40)) throw new Error('Daily callback limit reached. Please call us instead.');
  if (now - (recent.byPhone.get(phone) || 0) < 120000) throw new Error('A callback to this number was just requested. Please wait two minutes.');
  const ipHits = (recent.byIp.get(ip) || []).filter((t) => now - t < 3600000);
  if (ipHits.length >= 5) throw new Error('Too many callback requests. Please try again later.');
  recent.byPhone.set(phone, now);
  recent.byIp.set(ip, [...ipHits, now]);
  recent.day.count++;
}

export async function placeCallback({ phone, ip = 'unknown', delayMs = 0 }) {
  if (!twilioEnabled()) throw new Error('Twilio is not configured on this deployment.');
  if (!/^\+\d{10,15}$/.test(phone)) throw new Error('Phone number must be in international format, e.g. +919876543210.');
  limit(phone, ip);
  const doCall = async () => {
    const body = new URLSearchParams({ To: phone, From: twilio.number, Url: `${PUBLIC_BASE_URL}/twilio/voice?callback=1`, Method: 'POST' });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Calls.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const hint = j.code === 21219 || /unverified/i.test(j.message || '') ? ' (Twilio trial accounts can only call verified numbers.)' : '';
      throw new Error((j.message || `Twilio error ${r.status}`) + hint);
    }
    console.log(`[twilio] callback placed to ...${phone.slice(-4)} sid=${j.sid}`);
    return j.sid;
  };
  if (delayMs) { setTimeout(() => doCall().catch((e) => console.error('[twilio] callback failed:', e.message)), delayMs); return null; }
  return doCall();
}
