// Knowledge base + retrieval.
// Retrieval is in-process BM25 (no embedding API call), so it costs well under 1 ms per query.
// This is a deliberate latency decision: a network embedding call would add 150-400 ms per turn.
import { company, hotels, ratePlans, seasons, policies, loyalty, packages, guide, faqs, TAX_RATE } from './data/hotel.js';

const rupees = (n) => `${n.toLocaleString('en-IN')} rupees`;

function buildChunks() {
  const chunks = [];
  const add = (title, text, url, tags = '') => chunks.push({ id: chunks.length, title, text, url, tags });

  add('About Halvora', `${company.description} Mission: ${company.mission} ${company.stats.map(([k, v]) => `${k}: ${v}.`).join(' ')}`, '/about', 'company founded headquarters');
  add('Contact Halvora', `Reservations phone ${company.contact.reservationsPhone}. WhatsApp ${company.contact.whatsapp}. Email ${company.contact.email}. Groups and events ${company.contact.groupsEmail}. Careers ${company.contact.careersEmail}. ${company.contact.hours}`, '/about', 'contact phone email number call');
  add('Sustainability and awards', `${company.sustainability.join(' ')} Awards: ${company.awards.join('; ')}.`, '/about', 'green solar environment award');

  for (const h of hotels) {
    const url = `/hotels/${h.id}`;
    add(`${h.name} overview`, `${h.name} is a ${h.kind.toLowerCase()} at ${h.location}. ${h.description} Check-in ${h.checkIn}, check-out ${h.checkOut}.`, url, `${h.id} property hotel location`);
    add(`${h.name} rooms and rates`, h.rooms.map((r) => `${r.name}: ${rupees(r.rate)} per night (Flexible Rate, before tax), up to ${r.maxGuests} guests, ${r.size}, ${r.bed} bed, ${r.view} view; ${r.features.join(', ')}.`).join(' ') + ` ${h.seasonal}`, url, `${h.id} room price rate cost tariff night`);
    add(`${h.name} dining`, h.dining.join(' '), url, `${h.id} restaurant food bar breakfast dinner`);
    add(`${h.name} amenities`, h.amenities.join('. ') + '.', url, `${h.id} pool spa gym wifi parking facilities`);
    add(`${h.name} transfers and pets`, `Airport and station transfers: ${h.transfers.join('; ')}. ${h.pets}`, url, `${h.id} airport pickup transfer taxi`);
  }

  add('Rate plans', ratePlans.map((p) => `${p.name}: ${p.detail}`).join(' '), '/pricing', 'flexible saver refundable breakfast');
  add('Seasonal pricing and taxes', seasons.join(' '), '/pricing', 'season peak monsoon weekend tax discount minimum stay');
  for (const [title, text] of policies) add(`Policy: ${title}`, text, '/guide#policies', title === 'Pets' ? 'policy pet animal allowed munnar' : 'policy rules');
  add('Halvora Circle loyalty programme', `${loyalty.intro} ${loyalty.tiers.map(([t, q, b]) => `${t} tier (${q}): ${b}.`).join(' ')}`, '/pricing#loyalty', 'loyalty points member rewards tier');
  for (const [name, where, text] of packages) add(`Package: ${name}`, `${name} package (${where}): ${text}`, '/pricing#packages', 'package offer deal');
  for (const [title, text] of guide) add(`Guest guide: ${title}`, text, '/guide', 'how to guide');
  for (const [q, a] of faqs) add(`FAQ: ${q}`, `Q: ${q} A: ${a}`, '/faq', 'faq question');
  return chunks;
}

export const chunks = buildChunks();

// ---------- BM25 ----------
const STOP = new Set('a an the is are am was were be been of to in on at for and or with by from do does did can could i you we it this that my me your our what which how much many there have has any about please tell would like want'.split(' '));
const SYN = {
  price: ['rate', 'cost', 'tariff'], much: ['rate', 'price'], expensive: ['rate', 'price'], villa: ['room'], suite: ['room'], cost: ['rate', 'price'], tariff: ['rate', 'price'], cheap: ['rate', 'saver', 'discount'],
  dog: ['pet'], dogs: ['pet'], cat: ['pet'], pets: ['pet'], kids: ['children', 'child'], kid: ['children'], baby: ['children', 'crib'],
  refund: ['cancellation', 'cancel'], cancel: ['cancellation'], wifi: ['wi-fi', 'internet'], internet: ['wi-fi'],
  pickup: ['transfer', 'airport'], taxi: ['transfer'], cab: ['transfer'], food: ['dining', 'restaurant'], eat: ['dining', 'restaurant'],
  wheelchair: ['accessible', 'accessibility'], disabled: ['accessible'], honeymoon: ['couple', 'package'], wedding: ['events'],
  checkin: ['check-in'], checkout: ['check-out'], massage: ['spa'], swimming: ['pool'], gym: ['fitness'], points: ['circle', 'loyalty'],
  bombay: ['mumbai'], bkc: ['mumbai'], kerala: ['munnar'], rajasthan: ['udaipur'], beach: ['goa'], lake: ['udaipur'], tea: ['munnar'],
};

function tokenize(text) {
  const toks = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));
  const out = [];
  for (let t of toks) {
    if (t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1); // naive stemming
    out.push(t);
    if (t.includes('-')) out.push(...t.split('-').filter(Boolean));
  }
  return out;
}

const docs = chunks.map((c) => {
  const toks = tokenize(`${c.title} ${c.title} ${c.tags} ${c.text}`);
  const tf = new Map();
  for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
  return { len: toks.length, tf };
});
const avgLen = docs.reduce((s, d) => s + d.len, 0) / docs.length;
const df = new Map();
for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
const N = docs.length;
const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));

export function retrieve(query, k = 3) {
  const t0 = performance.now();
  const q = tokenize(query);
  const terms = new Map();
  for (const t of q) {
    terms.set(t, Math.max(terms.get(t) || 0, 1));
    for (const s of SYN[t] || []) terms.set(s, Math.max(terms.get(s) || 0, 0.6));
  }
  const k1 = 1.4, b = 0.7;
  const scored = docs.map((d, i) => {
    let s = 0;
    for (const [t, w] of terms) {
      const f = d.tf.get(t);
      if (!f) continue;
      s += w * idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen)));
    }
    return { i, s };
  });
  scored.sort((a, b2) => b2.s - a.s);
  const results = scored.filter((x) => x.s > 0).slice(0, k).map((x) => ({ ...chunks[x.i], score: +x.s.toFixed(2) }));
  return { results, ms: +(performance.now() - t0).toFixed(3) };
}

export function formatContext(results, maxChars = 2400) {
  let out = '';
  for (const r of results) {
    const piece = `[${r.title}] ${r.text}\n`;
    if (out.length + piece.length > maxChars) break;
    out += piece;
  }
  return out.trim();
}

// Compact, stable overview that goes in the (cacheable) system prompt prefix.
export function overview() {
  const lines = [
    `${company.name}: ${company.description}`,
    `Reservations: ${company.contact.reservationsPhone}, ${company.contact.email}.`,
    'Properties and Flexible Rate per night before tax:',
    ...hotels.map((h) => `- ${h.name} (${h.kind}, ${h.location}; check-in ${h.checkIn}, check-out ${h.checkOut}): ${h.rooms.map((r) => `${r.name} ${rupees(r.rate)}, max ${r.maxGuests} guests`).join('; ')}.`),
    `Tax: ${TAX_RATE * 100} percent on room charges. Saver Rate is 15 percent cheaper, room only, non-refundable. Flexible Rate includes breakfast, with free cancellation up to 48 hours before check-in (72 hours December 20 to January 5).`,
    'Seasons: peak December 20 to January 5 is 30 percent higher (3-night minimum at Goa and Udaipur); monsoon June 1 to September 30 is 20 percent lower at Goa and Munnar; Mumbai Friday and Saturday nights are 15 percent lower.',
  ];
  return lines.join('\n');
}
