// Server-rendered website. Every fact shown here comes from server/data/hotel.js,
// the same source the voice agent's RAG and tools use, so answers can be verified on the page.
import { company, hotels, ratePlans, seasons, policies, loyalty, packages, guide, faqs, TAX_RATE } from './data/hotel.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => `₹${n.toLocaleString('en-IN')}`;
const NAV = [['/', 'Home'], ['/hotels/goa', 'Hotels'], ['/pricing', 'Pricing'], ['/guide', 'Guest guide'], ['/faq', 'FAQ'], ['/about', 'About'], ['/dashboard', 'Latency']];

export function layout({ title, body, active = '', scripts = [], description = company.tagline }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Halvora Hotels &amp; Retreats</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%231f4e4a'/%3E%3Cpath d='M9 22V10h3v5h8v-5h3v12h-3v-4.5h-8V22z' fill='%23f3e7d3'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/css/site.css">
</head>
<body>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="/"><span class="brand-mark">H</span><span>Halvora<small>Hotels &amp; Retreats</small></span></a>
    <button class="nav-toggle" aria-label="Menu" aria-expanded="false" onclick="this.setAttribute('aria-expanded', document.body.classList.toggle('nav-open'))">☰</button>
    <nav class="nav">${NAV.map(([h, l]) => `<a href="${h}" class="${active === h ? 'active' : ''}">${l}</a>`).join('')}<a class="btn btn-sm" href="/talk">Talk to Aria</a></nav>
  </div>
</header>
<main>${body}</main>
<footer class="site-footer">
  <div class="wrap footer-grid">
    <div><strong>${esc(company.name)}</strong><p>${esc(company.tagline)}</p><p class="muted small">A fictional company built for the Voice Agent Engineering capstone. Bookings made here are simulated.</p></div>
    <div><strong>Properties</strong>${hotels.map((h) => `<a href="/hotels/${h.id}">${esc(h.name)}</a>`).join('')}</div>
    <div><strong>Help</strong><a href="/guide">Guest guide</a><a href="/faq">FAQ</a><a href="/pricing">Pricing</a><a href="/settings">API settings</a></div>
    <div><strong>Contact</strong><span>${esc(company.contact.reservationsPhone)}</span><span>${esc(company.contact.email)}</span><a href="/talk">Talk to the voice agent</a></div>
  </div>
</footer>
<a class="talk-fab" href="/talk" aria-label="Talk to Aria, our voice concierge"><span class="fab-dot"></span>Talk to Aria</a>
${scripts.map((s) => `<script type="module" src="${s}"></script>`).join('')}
</body>
</html>`;
}

const hotelImg = { goa: 'sea', udaipur: 'lake', munnar: 'hills', mumbai: 'city' };

export function homePage() {
  const features = [
    ['Voice concierge, 24x7', 'Aria answers questions, checks live availability and books rooms on the website, by phone, and over LiveKit and Vapi.'],
    ['Breakfast included', 'Every Flexible Rate stay includes breakfast for all registered guests.'],
    ['Free cancellation', 'Cancel Flexible Rate bookings free up to 48 hours before check-in.'],
    ['Halvora Circle', 'Free loyalty programme: 10 points per ₹100, upgrades and late check-out.'],
    ['Free Wi-Fi everywhere', 'Up to 500 Mbps at Mumbai and 200 Mbps at Goa.'],
    ['Sustainable stays', 'No single-use plastic; Goa and Munnar run on 60 percent or more solar power.'],
    ['Airport transfers', 'Fixed-price sedans and SUVs from every nearby airport.'],
    ['Pet-friendly Munnar', 'Bring pets up to 15 kg to our tea-estate cottages.'],
  ];
  return layout({
    title: 'Boutique hotels in Goa, Udaipur, Munnar and Mumbai',
    active: '/',
    body: `
<section class="hero">
  <div class="wrap hero-grid">
    <div>
      <p class="eyebrow">Boutique hotels across India</p>
      <h1>${esc(company.tagline)}</h1>
      <p class="lead">Beachfront in Goa, a lakeside haveli in Udaipur, a tea estate in Munnar and a business hotel in Mumbai. Ask Aria, our voice concierge, anything, or book a room just by talking.</p>
      <div class="cta-row"><a class="btn" href="/talk">Talk to Aria now</a><a class="btn btn-ghost" href="/pricing">See room rates</a></div>
      <p class="small muted">Try asking: “Do you have a sea view room in Goa for two next weekend?”</p>
    </div>
    <div class="hero-card">
      <div class="orb-preview"><span></span><span></span><span></span></div>
      <p><strong>Four ways to talk to Aria</strong></p>
      <ol class="ways"><li>On this website (cascaded or speech-to-speech)</li><li>By phone through Twilio</li><li>LiveKit agent</li><li>Vapi agent</li></ol>
      <a href="/dashboard" class="small">Compare their latency →</a>
    </div>
  </div>
</section>
<section class="wrap section">
  <h2>Our properties</h2>
  <div class="cards">${hotels.map((h) => `
    <a class="card hotel-card" href="/hotels/${h.id}">
      <div class="hotel-art art-${hotelImg[h.id]}"><span>${esc(h.kind)}</span></div>
      <div class="card-body"><h3>${esc(h.name)}</h3><p class="muted small">${esc(h.location)}</p><p>${esc(h.summary)}</p><p class="price">From ${inr(Math.min(...h.rooms.map((r) => r.rate)))} <span class="muted small">/ night + tax</span></p></div>
    </a>`).join('')}
  </div>
</section>
<section class="band">
  <div class="wrap section">
    <h2>Why guests choose Halvora</h2>
    <div class="feature-grid">${features.map(([t, d]) => `<div class="feature"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
  </div>
</section>
<section class="wrap section stats">${company.stats.map(([k, v]) => `<div><strong>${esc(v)}</strong><span>${esc(k)}</span></div>`).join('')}</section>`,
  });
}

export function hotelPage(id) {
  const h = hotels.find((x) => x.id === id);
  if (!h) return null;
  return layout({
    title: h.name,
    active: '/hotels/goa',
    description: h.summary,
    body: `
<section class="page-head art-${hotelImg[h.id]}"><div class="wrap"><p class="eyebrow">${esc(h.kind)}</p><h1>${esc(h.name)}</h1><p>${esc(h.location)}</p></div></section>
<div class="wrap tabs-inline">${hotels.map((x) => `<a href="/hotels/${x.id}" class="${x.id === h.id ? 'active' : ''}">${esc(x.name.replace('Halvora ', ''))}</a>`).join('')}</div>
<section class="wrap section two-col">
  <div>
    <p class="lead">${esc(h.description)}</p>
    <p><strong>Check-in</strong> ${esc(h.checkIn)} · <strong>Check-out</strong> ${esc(h.checkOut)}</p>
    <h2>Rooms and rates</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Room</th><th>Flexible Rate / night</th><th>Saver Rate / night</th><th>Max guests</th><th>Size</th><th>View</th></tr></thead>
      <tbody>${h.rooms.map((r) => `<tr><td><strong>${esc(r.name)}</strong><div class="small muted">${esc(r.bed)} · ${esc(r.features.join(', '))}</div></td><td>${inr(r.rate)}</td><td>${inr(Math.round(r.rate * 0.85))}</td><td>${r.maxGuests}</td><td>${esc(r.size)}</td><td>${esc(r.view)}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="small muted">Rates are per room per night before ${TAX_RATE * 100}% tax. ${esc(h.seasonal)} Peak season (Dec 20 to Jan 5) is 30% higher.</p>
    <h2>Dining</h2><ul>${h.dining.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
    <h2>Amenities</h2><ul>${h.amenities.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
  </div>
  <aside class="side">
    <div class="side-card"><h3>Getting here</h3><ul>${h.transfers.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
    <div class="side-card"><h3>Pets</h3><p>${esc(h.pets)}</p></div>
    <div class="side-card accent"><h3>Book by voice</h3><p>Say: “Check availability at ${esc(h.name)} for two guests from the 12th to the 15th.”</p><a class="btn" href="/talk">Talk to Aria</a></div>
  </aside>
</section>`,
  });
}

export function pricingPage() {
  const addons = [
    ['Breakfast on Saver Rate', '₹1,200 per adult per day'],
    ['Extra bed (age 6+)', '₹2,500 per night, breakfast included'],
    ['Crib', 'Free'],
    ['Early check-in from 10 AM', '₹2,000, subject to availability'],
    ['Late check-out until 3 PM', '₹2,500 (free for Circle Gold and Platinum)'],
    ['Pet (Munnar only, up to 15 kg)', '₹1,500 per night per pet'],
    ['Security deposit', '₹5,000 per room, refundable'],
  ];
  return layout({
    title: 'Pricing',
    active: '/pricing',
    body: `
<section class="page-head"><div class="wrap"><p class="eyebrow">Pricing</p><h1>Room rates, plans and packages</h1><p>All rates are per room per night in Indian rupees, before ${TAX_RATE * 100}% tax.</p></div></section>
<section class="wrap section">
  <h2>Rate plans</h2>
  <div class="cards two">${ratePlans.map((p) => `<div class="card pad"><h3>${esc(p.name)}</h3><p>${esc(p.detail)}</p></div>`).join('')}</div>
  <h2>Room rates by property</h2>
  ${hotels.map((h) => `<h3><a href="/hotels/${h.id}">${esc(h.name)}</a></h3><div class="table-wrap"><table><thead><tr><th>Room</th><th>Flexible</th><th>Saver</th><th>Max guests</th></tr></thead><tbody>${h.rooms.map((r) => `<tr><td>${esc(r.name)}</td><td>${inr(r.rate)}</td><td>${inr(Math.round(r.rate * 0.85))}</td><td>${r.maxGuests}</td></tr>`).join('')}</tbody></table></div>`).join('')}
  <h2>Seasonal pricing and taxes</h2><ul>${seasons.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
  <h2>Add-ons and fees</h2><div class="table-wrap"><table><tbody>${addons.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table></div>
  <h2 id="packages">Packages</h2><div class="cards two">${packages.map(([n, w, t]) => `<div class="card pad"><h3>${esc(n)}</h3><p class="small muted">${esc(w)}</p><p>${esc(t)}</p></div>`).join('')}</div>
  <h2 id="loyalty">${esc(loyalty.name)}</h2><p>${esc(loyalty.intro)}</p>
  <div class="table-wrap"><table><thead><tr><th>Tier</th><th>Qualification</th><th>Benefits</th></tr></thead><tbody>${loyalty.tiers.map(([t, q, b]) => `<tr><td><strong>${esc(t)}</strong></td><td>${esc(q)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table></div>
</section>`,
  });
}

export function guidePage() {
  return layout({
    title: 'Guest guide',
    active: '/guide',
    body: `
<section class="page-head"><div class="wrap"><p class="eyebrow">Documentation</p><h1>Guest guide and policies</h1><p>Everything you need before, during and after your stay.</p></div></section>
<section class="wrap section two-col">
  <div>
    <h2>Using Halvora</h2>
    ${guide.map(([t, d]) => `<h3 id="${t.toLowerCase().replace(/[^a-z]+/g, '-')}">${esc(t)}</h3><p>${esc(d)}</p>`).join('')}
    <h2 id="policies">Hotel policies</h2>
    ${policies.map(([t, d]) => `<h3>${esc(t)}</h3><p>${esc(d)}</p>`).join('')}
  </div>
  <aside class="side"><div class="side-card"><h3>Search the guide</h3><input id="kb-q" placeholder="e.g. pets, ID, late check-out" aria-label="Search the guide"><div id="kb-results" class="small"></div></div>
  <div class="side-card"><h3>On this page</h3>${guide.map(([t]) => `<a class="toc" href="#${t.toLowerCase().replace(/[^a-z]+/g, '-')}">${esc(t)}</a>`).join('')}<a class="toc" href="#policies">Hotel policies</a></div></aside>
</section>`,
    scripts: ['/js/kb-search.js'],
  });
}

export function faqPage() {
  return layout({
    title: 'FAQ',
    active: '/faq',
    body: `
<section class="page-head"><div class="wrap"><p class="eyebrow">FAQ</p><h1>Frequently asked questions</h1></div></section>
<section class="wrap section narrow">${faqs.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}
<p class="muted">Can't find your answer? <a href="/talk">Ask Aria</a> or call ${esc(company.contact.reservationsPhone)}.</p></section>`,
  });
}

export function aboutPage() {
  return layout({
    title: 'About us',
    active: '/about',
    body: `
<section class="page-head"><div class="wrap"><p class="eyebrow">Company</p><h1>About Halvora</h1><p>${esc(company.mission)}</p></div></section>
<section class="wrap section two-col">
  <div>
    <p class="lead">${esc(company.description)}</p>
    <h2>Sustainability</h2><ul>${company.sustainability.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
    <h2>Awards</h2><ul>${company.awards.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
  </div>
  <aside class="side">
    <div class="side-card"><h3>By the numbers</h3>${company.stats.map(([k, v]) => `<p><strong>${esc(v)}</strong> ${esc(k)}</p>`).join('')}<p><strong>${company.founded}</strong> Founded</p><p><strong>HQ</strong> ${esc(company.headquarters)}</p></div>
    <div class="side-card"><h3>Contact</h3><p>Reservations: ${esc(company.contact.reservationsPhone)}</p><p>WhatsApp: ${esc(company.contact.whatsapp)}</p><p>Email: ${esc(company.contact.email)}</p><p>Groups and events: ${esc(company.contact.groupsEmail)}</p><p>Careers: ${esc(company.contact.careersEmail)}</p><p class="small muted">${esc(company.contact.hours)}</p></div>
  </aside>
</section>`,
  });
}

export function talkPage() {
  return layout({
    title: 'Talk to Aria',
    active: '/talk',
    body: `
<section class="page-head slim"><div class="wrap"><p class="eyebrow">Voice concierge</p><h1>Talk to Aria</h1><p>One agent, four ways to reach it. Every turn's latency is measured and sent to the <a href="/dashboard">comparison dashboard</a>.</p></div></section>
<section class="wrap section talk">
  <div class="mode-tabs" role="tablist">
    <button role="tab" data-mode="web" class="active">1 · Website agent</button>
    <button role="tab" data-mode="phone">2 · Phone (Twilio)</button>
    <button role="tab" data-mode="livekit">3 · LiveKit</button>
    <button role="tab" data-mode="vapi">4 · Vapi</button>
  </div>
  <div class="talk-grid">
    <div class="console">
      <div class="panel" data-panel="web">
        <div class="seg" role="radiogroup" aria-label="Architecture">
          <button data-arch="cascade" class="active">Cascaded<small>ASR → LLM → TTS</small></button>
          <button data-arch="s2s">Speech-to-Speech<small>Gemini Live</small></button>
        </div>
        <label class="switch" id="fast-wrap"><input type="checkbox" id="fast-toggle" checked><span></span> Low Latency mode</label>
        <p class="small muted" id="arch-note"></p>
      </div>
      <div class="panel" data-panel="phone" hidden>
        <p>Call Aria on a real phone line:</p>
        <p class="phone-number" id="phone-number">Not configured</p>
        <form id="callback-form" class="callback">
          <label>Or have Aria call you back<input id="cb-phone" type="tel" placeholder="+91 98765 43210" autocomplete="tel" required></label>
          <button class="btn" type="submit">Call me</button>
        </form>
        <p class="small muted" id="cb-status">The phone agent uses the same cascaded pipeline in Low Latency mode, with mu-law audio end to end.</p>
      </div>
      <div class="panel" data-panel="livekit" hidden><p>The same agent running as a LiveKit Agents worker (Deepgram STT, Gemini LLM, Deepgram TTS, Silero VAD) in a LiveKit Cloud room.</p><p class="small muted" id="lk-note"></p></div>
      <div class="panel" data-panel="vapi" hidden><p>The same prompt, tools and knowledge hosted on Vapi. Tools call back into this server.</p><p class="small muted" id="vapi-note"></p></div>

      <div class="stage">
        <button id="talk-btn" class="orb" aria-label="Start talking"><span class="ring"></span><span class="label">Start</span></button>
        <p id="status" class="status">Tap to start a conversation</p>
        <div class="meter"><span id="mic-level"></span></div>
      </div>
      <div class="latency-strip" id="latency-strip" aria-live="polite"></div>
    </div>
    <div class="transcript-wrap">
      <div class="transcript-head"><strong>Conversation</strong><button id="clear-transcript" class="link">Clear</button></div>
      <div id="transcript" class="transcript" aria-live="polite"><p class="muted small">Your conversation appears here. Try:<br>“What's the cancellation policy?”<br>“Do you have a Pool Villa in Goa from the 10th to the 13th next month?”<br>“Can I bring my dog?”</p></div>
    </div>
  </div>
</section>`,
    scripts: ['/js/talk.js'],
  });
}

export function dashboardPage() {
  return layout({
    title: 'Latency dashboard',
    active: '/dashboard',
    body: `
<section class="page-head slim"><div class="wrap"><p class="eyebrow">Benchmark</p><h1>Latency comparison</h1><p>Real measurements from conversations on this deployment. Nothing is simulated.</p></div></section>
<section class="wrap section">
  <div class="dash-actions"><button class="btn btn-ghost btn-sm" id="refresh">Refresh</button><span class="small muted" id="updated"></span></div>
  <div id="dash-cards" class="dash-cards"></div>
  <h2>Comparison table</h2>
  <div class="table-wrap"><table id="dash-table"></table></div>
  <h2>Per-stage breakdown (average ms)</h2>
  <div id="stage-chart" class="stage-chart"></div>
  <h2>Recent turns</h2>
  <div class="table-wrap"><table id="recent"></table></div>
  <details class="method"><summary>How each metric is measured</summary>
    <ul>
      <li><strong>Response latency (headline):</strong> the time from when the user stops speaking to when the agent's first audio plays. On the website, the browser measures it with its own voice-activity detector and the audio playout clock (voice-to-voice). For LiveKit, it's measured from the remote audio track in the browser. For Vapi, it comes from Vapi's own end-of-call report (turnLatency), plus a browser measurement. For Twilio, it's measured on the server, from the last word's audio timestamp to the first TTS frame sent to Twilio. It excludes the phone network's own delay (often 150 to 300 ms).</li>
      <li><strong>First response:</strong> the response latency of the first user turn in each session, which includes cold connections.</li>
      <li><strong>End-of-turn:</strong> the time from the last spoken word to the final transcript (endpointing window plus ASR finalisation).</li>
      <li><strong>LLM TTFT:</strong> the time from the final transcript to the first LLM token, including RAG and prompt building.</li>
      <li><strong>TTS TTFB:</strong> the time from the first text chunk sent to TTS to the first audio byte back (streaming latency).</li>
      <li><strong>Perceived:</strong> like response latency, but counts a pre-rendered filler phrase ("One moment...") as the first audio.</li>
    </ul>
  </details>
</section>`,
    scripts: ['/js/dashboard.js'],
  });
}

export function settingsPage() {
  return layout({
    title: 'API settings',
    active: '/settings',
    body: `
<section class="page-head slim"><div class="wrap"><p class="eyebrow">For evaluators</p><h1>API settings</h1><p>This deployment comes with keys configured. If you hit a free-tier limit, paste your own keys here. They stay in this browser (localStorage) and are sent only to this server for your own sessions. They are never stored or logged.</p></div></section>
<section class="wrap section narrow">
  <form id="settings-form" class="settings">
    <label>Gemini API key <span class="muted small">(cascaded LLM + speech-to-speech)</span><input name="gemini" type="password" autocomplete="off" placeholder="AIza..."></label>
    <label>Groq API key <span class="muted small">(Low Latency LLM)</span><input name="groq" type="password" autocomplete="off" placeholder="gsk_..."></label>
    <label>Deepgram API key <span class="muted small">(streaming ASR + TTS)</span><input name="deepgram" type="password" autocomplete="off"></label>
    <label>OpenAI API key <span class="muted small">(optional alternative LLM)</span><input name="openai" type="password" autocomplete="off" placeholder="sk-..."></label>
    <label>Preferred LLM for the cascaded pipeline
      <select name="llm"><option value="auto">Auto (Gemini for Standard, Groq for Low Latency)</option><option value="gemini">Gemini</option><option value="groq">Groq</option><option value="openai">OpenAI</option></select></label>
    <div class="cta-row"><button class="btn" type="submit">Save</button><button class="btn btn-ghost" type="button" id="clear-keys">Clear keys</button></div>
    <p id="settings-status" class="small"></p>
  </form>
  <h2>Server status</h2><div id="server-status" class="small"></div>
  <p class="small muted">The LiveKit, Vapi and Twilio integrations use this deployment's own accounts and can't be switched to visitor keys.</p>
</section>`,
    scripts: ['/js/settings.js'],
  });
}

export function notFoundPage() {
  return layout({ title: 'Not found', body: '<section class="wrap section narrow"><h1>Page not found</h1><p><a href="/">Back to home</a></p></section>' });
}
