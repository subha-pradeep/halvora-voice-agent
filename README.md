# Halvora Hotels & Retreats · AI Voice Agent (Capstone)

A production-style voice concierge (**Aria**) for a fictional boutique hotel group. One agent can be reached in four ways, and every turn's latency is measured and compared on a live dashboard.

| # | Mode | Stack |
|---|------|-------|
| 1a | Website, **cascaded** (Standard / **Low Latency**) | Deepgram Nova-3 streaming ASR → Gemini Flash / Groq Llama (streaming, tools, RAG) → Deepgram Aura-2 streaming TTS |
| 1b | Website, **speech-to-speech** | Gemini Live native-audio model (relayed by the server, which runs the tools) |
| 2 | **Phone** (Twilio): inbound calls + "call me back" | Twilio Media Streams ↔ the same cascaded pipeline, μ-law 8 kHz end to end |
| 3 | **LiveKit** agent | LiveKit Agents (Node) worker: Silero VAD + Deepgram + Gemini + Deepgram |
| 4 | **Vapi** agent | Vapi with Deepgram + Gemini; tools call back into this server |

Every mode uses the **same system prompt, knowledge base and tools** (availability, booking, lookup, two-step cancellation, knowledge search, phone callback), backed by one bookings store.

Everything runs on **free tiers**: Gemini, Groq, Deepgram ($200 signup credit), Twilio trial, LiveKit Cloud Build plan, Vapi starting credit, and Render's free plan.

---

## 1. Quick start (local)

```bash
cd halvora-voice-agent
npm install
cp .env.example .env        # then fill in your keys (see section 2)
npm run dev                 # http://localhost:3000
npm run agent               # (separate terminal) LiveKit worker
npm test                    # unit tests: RAG, tools, chunker, metrics
```

Website pages: `/` · `/hotels/goa` · `/pricing` · `/guide` · `/faq` · `/about` · **`/talk`** (all four modes) · **`/dashboard`** (latency) · `/settings` (paste your own API keys).

Phone, Vapi tools and the Vapi end-of-call report need a **public URL**. Locally, use a tunnel (`ngrok http 3000`) and set `PUBLIC_BASE_URL` to the https URL.

## 2. Accounts and keys (all free)

| Service | Where | `.env` |
|---|---|---|
| Google AI Studio | aistudio.google.com → Get API key | `GEMINI_API_KEY` |
| Groq | console.groq.com → API Keys | `GROQ_API_KEY` |
| Deepgram | console.deepgram.com → API Keys | `DEEPGRAM_API_KEY` |
| Twilio | twilio.com/try-twilio → get a trial number | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` |
| LiveKit Cloud | cloud.livekit.io → Settings → Keys | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |
| Vapi | dashboard.vapi.ai → API Keys → **Public** key | `VAPI_PUBLIC_KEY` (+ any random `VAPI_SERVER_SECRET`) |

Also set random strings for `INTERNAL_SECRET` and `ADMIN_TOKEN`.

**Twilio setup:** Phone Numbers → your number → *A call comes in* → Webhook `POST https://<your-host>/twilio/voice`.
Trial limits: callers first hear a short trial message, and outbound calls (the callback feature) only reach **verified** numbers. Verify your own number under *Verified Caller IDs* for the demo.

**Vapi:** the site starts an inline assistant built from the same prompt and tools (`GET /api/vapi/assistant`). If Vapi rejects a field (for example a model name), create an assistant in the Vapi dashboard with the same settings, then set `VAPI_ASSISTANT_ID`. Point its Server URL at `https://<host>/vapi/events` and its tools at `https://<host>/vapi/tools`. Add your Gemini and Deepgram keys under Vapi → *Provider Keys* so calls use your own free keys instead of Vapi credit.

## 3. Deploy (Render free plan)

1. Push this folder to a GitHub repo, making sure `.env` isn't committed (it's in `.gitignore`).
2. In Render: **New → Blueprint** and pick the repo. `render.yaml` creates one free web service that runs `npm run start:all` (web server + LiveKit worker).
3. Fill in the environment variables, including `PUBLIC_BASE_URL=https://<service>.onrender.com`.
4. **Keep it awake:** free instances sleep after about 15 minutes idle, which breaks phone calls. Create a free monitor at cron-job.org (or UptimeRobot) that requests `https://<service>.onrender.com/healthz` every 10 minutes.
5. Update the Twilio webhook and Vapi URLs to the Render URL.

Note: free-plan disks are ephemeral, so bookings and metrics reset on redeploy. Set `DATA_DIR` to a persistent disk if you upgrade. If memory is tight (the LiveKit worker loads an ONNX VAD model), run the worker locally with `npm run agent` and set `AGENT_SERVER_URL=https://<service>.onrender.com`.

## 4. Architecture

```
Browser ──WS PCM16 16k──▶ server/pipelines/cascade.js ──▶ Deepgram STT (WS, interim + endpointing)
   ▲                         │  final transcript
   │                         ▼
   │                     server/brain.js ── BM25 RAG (in-process, <1 ms) + tools (in-process)
   │                         │  streaming tokens (Gemini / Groq / OpenAI, auto-fallback on 429)
   │                         ▼
   │                     Chunker (first clause / sentence) ──▶ Deepgram TTS (persistent WS)
   └──────WS PCM16 16/24k────────────────────────────────────────┘   barge-in: Clear + client flush

Twilio ──Media Streams μ-law 8k──▶ same CascadeSession (no transcoding)
Browser ──WS──▶ server/pipelines/s2s.js ──▶ Gemini Live (audio in/out, tools on server)
LiveKit room ◀──▶ livekit-agent/agent.js (tools + metrics via /api/internal/*)
Vapi ◀──▶ /vapi/tools, /vapi/events (end-of-call performanceMetrics → dashboard)
```

Single source of truth: `server/data/hotel.js` drives the website pages, the RAG chunks and the booking tools, so every agent answer can be checked against the site.

## 5. Latency optimisations (Low Latency mode vs Standard)

| Technique | Where |
|---|---|
| Streaming ASR with interim results; **200 ms** endpointing (Standard 500 ms) | `config.js` profiles, `deepgram.js` |
| Streaming LLM; **Groq Llama 3.1 8B** (Standard: Gemini Flash); thinking disabled or minimal | `llm.js` |
| **Overlapped stages**: TTS starts on the **first clause** while the LLM is still generating | `brain.js` `Chunker`, `cascade.js` |
| Streaming TTS over a **pre-warmed persistent WebSocket** (no TLS per turn) | `deepgram.js` `DeepgramTTS` |
| **16 kHz** TTS audio (Standard 24 kHz) and a **40 ms** client pre-buffer (Standard 150 ms) | profiles, `public/js/audio.js` |
| **Prompt caching**: static system prompt prefix, with dynamic RAG and date in the user turn | `brain.js` `buildInstructions` |
| **Context reduction**: history 6 turns (Standard 12), RAG top-2 / 1,100 chars (Standard top-4 / 2,400) | profiles |
| **Response length cap**: 110 max tokens + a "under 35 words" instruction | profiles |
| In-process **BM25 retrieval** (no embedding API round trip), retrieved per turn instead of via a tool call | `kb.js` |
| **Tool optimisation**: terse schemas and results, in-process handlers, at most 2 tool rounds | `tools.js` |
| **Pre-rendered phrase cache** for the greeting and fillers; a filler plays instantly during tool calls | `deepgram.js` `cachedPhrase` |
| Barge-in: server `Clear` + client playback flush within one interim transcript | `cascade.js` `interrupt` |
| Provider **fallback** before the first token (free-tier 429 → next provider) | `brain.js` |
| Phone: μ-law in and out, so there's no resampling or transcoding on the hot path | `telephony/twilio.js` |

## 6. How latency is measured

- **Browser voice-to-voice** (website cascade, S2S, LiveKit, Vapi): the browser's own VAD timestamps your last voiced 20 ms frame. The agent's first audible audio is taken from the AudioContext schedule (cascade/S2S), a remote-track analyser (LiveKit) or Vapi's `speech-start` event. This is the same method for every web mode.
- **Server / framework**: our pipeline timers (end-of-turn, LLM TTFT, TTS TTFB, response), LiveKit `metrics_collected` (EOU + TTFT + TTFB), and Vapi's end-of-call `performanceMetrics.turnLatencies`.
- **Twilio** is server-measured: from the last word's audio timestamp to the first TTS frame sent. It excludes PSTN network delay.

The dashboard stores only real measurements (`data/metrics.json`). Clear them with `curl -X DELETE -H "x-admin-token: $ADMIN_TOKEN" https://<host>/api/metrics`.

## 7. Security notes

- API keys stay server-side. Visitor keys from `/settings` live in the visitor's localStorage, are used only for their own session, and are never logged or stored.
- Twilio webhooks are verified with `X-Twilio-Signature`, and media streams with a per-call HMAC token.
- The Vapi webhook checks `x-vapi-secret`, and LiveKit worker calls use `INTERNAL_SECRET`.
- WebSockets are origin-checked, with per-IP and global session caps and a 15-minute session limit.
- Callbacks are rate-limited per number, per IP and per day.
