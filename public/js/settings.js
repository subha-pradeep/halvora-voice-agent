const form = document.querySelector('#settings-form');
const status = document.querySelector('#settings-status');
const KEY = 'halvora-keys';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const saved = load();
for (const el of form.elements) if (el.name && saved[el.name]) el.value = saved[el.name];

form.onsubmit = (e) => {
  e.preventDefault();
  const data = {};
  for (const el of form.elements) if (el.name && el.value.trim()) data[el.name] = el.value.trim();
  localStorage.setItem(KEY, JSON.stringify(data));
  status.textContent = 'Saved in this browser. New voice sessions will use these keys.';
};
document.querySelector('#clear-keys').onclick = () => { localStorage.removeItem(KEY); form.reset(); status.textContent = 'Keys cleared.'; };

fetch('/api/config').then((r) => r.json()).then((c) => {
  const yes = (b) => (b ? '✅ configured' : '— not configured');
  document.querySelector('#server-status').innerHTML = `
    <p>Gemini key ${yes(c.keysPresent.gemini)} · Groq key ${yes(c.keysPresent.groq)} · Deepgram key ${yes(c.keysPresent.deepgram)} · OpenAI key ${yes(c.keysPresent.openai)}</p>
    <p>Website cascaded ${yes(c.features.cascade)} · Speech-to-speech ${yes(c.features.s2s)} · Twilio ${yes(c.features.twilio)} · LiveKit ${yes(c.features.livekit)} · Vapi ${yes(c.features.vapi)}</p>
    <p>Visitor keys ${c.allowClientKeys ? 'accepted' : 'disabled on this server'}.</p>`;
});
