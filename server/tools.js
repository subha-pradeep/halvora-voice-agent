// Tool definitions (provider-neutral JSON schema) and handlers.
// Handlers are pure in-process JS. Results are deliberately terse to keep follow-up prompt tokens low.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hotels, TAX_RATE } from './data/hotel.js';
import { retrieve, formatContext } from './kb.js';
import { DATA_DIR } from './config.js';

const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');
let bookings = {};
try { bookings = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8')); } catch { bookings = {}; }
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFile(BOOKINGS_FILE, JSON.stringify(bookings, null, 1), () => {});
  }, 200);
}

// Hook set by the server so the agent can trigger a Twilio callback.
let callbackHook = null;
export function setCallbackHook(fn) { callbackHook = fn; }

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function findHotel(q) {
  const n = norm(q);
  if (!n) return null;
  return hotels.find((h) => norm(h.id) === n || norm(h.name).includes(n) || n.includes(norm(h.id)) || norm(h.location).includes(n)) || null;
}
function findRoom(hotel, q) {
  const n = norm(q);
  if (!n) return null;
  return hotel.rooms.find((r) => norm(r.id) === n || norm(r.name) === n) ||
    hotel.rooms.find((r) => norm(r.name).includes(n) || n.includes(norm(r.name).replace(/room$/, ''))) ||
    hotel.rooms.find((r) => r.name.toLowerCase().split(' ').filter((w) => w.length > 3 && w !== 'room').some((w) => n.includes(w)));
}

const DAY = 86400000;
function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
const iso = (d) => d.toISOString().slice(0, 10);
export function todayISO() {
  // Hotel operates on India time.
  return new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
}
function isPeak(d) { const m = d.getUTCMonth() + 1, day = d.getUTCDate(); return (m === 12 && day >= 20) || (m === 1 && day <= 5); }
function isMonsoon(d) { const m = d.getUTCMonth() + 1; return m >= 6 && m <= 9; }

function nightlyRate(hotel, room, d) {
  let f = 1;
  if (isPeak(d)) f *= 1.3;
  else if (isMonsoon(d) && (hotel.id === 'goa' || hotel.id === 'munnar')) f *= 0.8;
  const dow = d.getUTCDay();
  if (hotel.id === 'mumbai' && (dow === 5 || dow === 6)) f *= 0.85;
  return Math.round(room.rate * f);
}

function hash01(str) { return crypto.createHash('md5').update(str).digest().readUInt32BE(0) / 0xffffffff; }
function roomsLeft(hotel, room, d) {
  const day = iso(d);
  const base = isPeak(d) ? 0.55 : isMonsoon(d) ? 0.25 : 0.4;
  const h = hash01(`${hotel.id}|${room.id}|${day}`);
  // Simulated occupancy: busy but bookable; small-inventory suites can sell out in peak season.
  const occ = isPeak(d) && room.inventory <= 8 && h > 0.7 ? 1 : Math.min(0.95, base + h * 0.4);
  let left = room.inventory - Math.floor(room.inventory * occ);
  for (const b of Object.values(bookings)) {
    if (b.status === 'confirmed' && b.hotelId === hotel.id && b.roomId === room.id && b.checkIn <= day && day < b.checkOut) left -= 1;
  }
  return Math.max(0, left);
}

function validateStay(args) {
  const hotel = findHotel(args.hotel);
  if (!hotel) return { error: `Unknown hotel "${args.hotel}". Options: ${hotels.map((h) => h.id).join(', ')}.` };
  const ci = parseDate(args.check_in), co = parseDate(args.check_out);
  if (!ci || !co) return { error: 'Dates must be YYYY-MM-DD.' };
  const today = parseDate(todayISO());
  if (ci < today) return { error: `Check-in ${iso(ci)} is in the past. Today is ${iso(today)}.` };
  if (ci > new Date(today.getTime() + 365 * DAY)) return { error: 'Bookings open up to 365 days ahead.' };
  const nights = Math.round((co - ci) / DAY);
  if (nights < 1) return { error: 'Check-out must be after check-in.' };
  if (nights > 30) return { error: 'Maximum 30 nights per booking.' };
  const dates = Array.from({ length: nights }, (_, i) => new Date(ci.getTime() + i * DAY));
  if ((hotel.id === 'goa' || hotel.id === 'udaipur') && dates.some(isPeak) && nights < 3) {
    return { error: 'Peak season (Dec 20 to Jan 5) needs a 3-night minimum at Goa and Udaipur.' };
  }
  const guests = Math.max(1, parseInt(args.guests, 10) || 2);
  return { hotel, ci, co, nights, dates, guests };
}

function quote(hotel, room, dates, plan = 'flexible') {
  let sub = dates.reduce((s, d) => s + nightlyRate(hotel, room, d), 0);
  if (plan === 'saver') sub = Math.round(sub * 0.85);
  const tax = Math.round(sub * TAX_RATE);
  return { subtotal: sub, tax, total: sub + tax };
}

const handlers = {
  check_availability(args) {
    const v = validateStay(args);
    if (v.error) return v;
    const { hotel, nights, dates, guests } = v;
    const options = hotel.rooms.map((r) => {
      const left = Math.min(...dates.map((d) => roomsLeft(hotel, r, d)));
      const q = quote(hotel, r, dates);
      return { room: r.name, available: left > 0, rooms_left: left, max_guests: r.maxGuests, fits: guests <= r.maxGuests, avg_per_night: Math.round(q.subtotal / nights), total_with_tax: q.total, saver_total_with_tax: quote(hotel, r, dates, 'saver').total };
    });
    return { hotel: hotel.name, check_in: args.check_in, check_out: args.check_out, nights, guests, currency: 'INR', note: 'Flexible Rate includes breakfast; totals include 12% tax.', options };
  },

  create_booking(args) {
    const v = validateStay(args);
    if (v.error) return v;
    const { hotel, ci, co, nights, dates, guests } = v;
    const room = findRoom(hotel, args.room_type);
    if (!room) return { error: `Unknown room "${args.room_type}". Options: ${hotel.rooms.map((r) => r.name).join(', ')}.` };
    if (guests > room.maxGuests) return { error: `${room.name} fits at most ${room.maxGuests} guests.` };
    const name = String(args.guest_name || '').trim();
    const phone = String(args.phone || '').replace(/[^\d+]/g, '');
    if (name.length < 2) return { error: 'Need the guest full name.' };
    if (phone.replace(/\D/g, '').length < 10) return { error: 'Need a valid phone number with at least 10 digits.' };
    if (Math.min(...dates.map((d) => roomsLeft(hotel, room, d))) < 1) return { error: `${room.name} is sold out for those dates.` };
    const plan = args.rate_plan === 'saver' ? 'saver' : 'flexible';
    const q = quote(hotel, room, dates, plan);
    let code;
    do { code = 'HLV-' + crypto.randomBytes(4).toString('base64').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 5).padEnd(5, 'X'); } while (bookings[code]);
    bookings[code] = { code, status: 'confirmed', hotelId: hotel.id, hotel: hotel.name, roomId: room.id, room: room.name, checkIn: iso(ci), checkOut: iso(co), nights, guests, guestName: name.slice(0, 80), phone: phone.slice(0, 20), ratePlan: plan, ...q, createdAt: new Date().toISOString() };
    persist();
    return { confirmed: true, confirmation_code: code, hotel: hotel.name, room: room.name, check_in: iso(ci), check_out: iso(co), nights, guests, rate_plan: plan, total_with_tax_inr: q.total, breakfast: plan === 'flexible' };
  },

  lookup_booking(args) {
    const code = String(args.confirmation_code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^HLV/, 'HLV-');
    const b = bookings[code];
    if (!b) return { error: `No booking found for ${code || 'that code'}. Codes look like HLV-4K7Q2.` };
    const { phone, createdAt, roomId, hotelId, ...pub } = b;
    return { ...pub, phone_last4: phone.slice(-4) };
  },

  cancel_booking(args) {
    const code = String(args.confirmation_code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^HLV/, 'HLV-');
    const b = bookings[code];
    if (!b) return { error: `No booking found for ${code}.` };
    if (b.status === 'cancelled') return { error: `${code} is already cancelled.` };
    const ci = parseDate(b.checkIn);
    const hoursLeft = (ci.getTime() - 5.5 * 3600000 + 14 * 3600000 - Date.now()) / 3600000; // 2 PM IST check-in
    const window = isPeak(ci) ? 72 : 48;
    let fee = 0;
    if (b.ratePlan === 'saver') fee = b.total;
    else if (hoursLeft < window) { const h = findHotel(b.hotelId); const r = findRoom(h, b.roomId); fee = Math.round(nightlyRate(h, r, ci) * (1 + TAX_RATE)); }
    if (args.confirm !== true && args.confirm !== 'true') {
      return { needs_confirmation: true, confirmation_code: code, cancellation_fee_inr: fee, refund_inr: b.total - fee, reason: b.ratePlan === 'saver' ? 'Saver Rate is non-refundable' : fee ? `Within ${window} hours of check-in, one night is charged` : 'Free cancellation window', instruction: 'Ask the guest to confirm, then call again with confirm=true.' };
    }
    b.status = 'cancelled'; b.cancelledAt = new Date().toISOString(); b.cancellationFee = fee;
    persist();
    return { cancelled: true, confirmation_code: code, cancellation_fee_inr: fee, refund_inr: b.total - fee, refund_timeline: '5 to 7 business days to the original payment method' };
  },

  search_hotel_info(args, ctx = {}) {
    const { results } = retrieve(String(args.query || ''), ctx.topK || 3);
    return { context: formatContext(results, 1800) || 'No matching information.' };
  },

  async request_callback(args, ctx = {}) {
    const phone = String(args.phone || '').replace(/[^\d+]/g, '');
    if (!/^\+\d{10,15}$/.test(phone)) return { error: 'Need the phone number in international format with country code, for example +91 98765 43210.' };
    if (!callbackHook) return { error: 'Phone callbacks are not configured on this deployment.' };
    try {
      await callbackHook({ phone, name: args.name, reason: args.reason, ip: ctx.ip });
      return { scheduled: true, phone_last4: phone.slice(-4), note: 'The Halvora voice agent will call in about 10 seconds.' };
    } catch (e) {
      return { error: `Could not place the callback: ${e.message}` };
    }
  },
};

export const toolDefs = [
  { name: 'check_availability', description: 'Live room availability and prices for a Halvora hotel and dates.', parameters: { type: 'object', properties: { hotel: { type: 'string', description: 'goa, udaipur, munnar or mumbai' }, check_in: { type: 'string', description: 'YYYY-MM-DD' }, check_out: { type: 'string', description: 'YYYY-MM-DD' }, guests: { type: 'integer' } }, required: ['hotel', 'check_in', 'check_out'] } },
  { name: 'create_booking', description: 'Book a room. Only call after the guest confirmed hotel, room, dates, guests, rate plan, full name and phone.', parameters: { type: 'object', properties: { hotel: { type: 'string' }, room_type: { type: 'string' }, check_in: { type: 'string', description: 'YYYY-MM-DD' }, check_out: { type: 'string', description: 'YYYY-MM-DD' }, guests: { type: 'integer' }, rate_plan: { type: 'string', enum: ['flexible', 'saver'] }, guest_name: { type: 'string' }, phone: { type: 'string' } }, required: ['hotel', 'room_type', 'check_in', 'check_out', 'guests', 'guest_name', 'phone'] } },
  { name: 'lookup_booking', description: 'Look up a booking by confirmation code (HLV-XXXXX).', parameters: { type: 'object', properties: { confirmation_code: { type: 'string' } }, required: ['confirmation_code'] } },
  { name: 'cancel_booking', description: 'Cancel a booking. First call without confirm to get the fee, then with confirm=true after the guest agrees.', parameters: { type: 'object', properties: { confirmation_code: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['confirmation_code'] } },
  { name: 'search_hotel_info', description: 'Search Halvora policies, amenities, dining, packages and FAQs.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'request_callback', description: 'Have the Halvora voice agent phone the guest. Needs the number with country code.', parameters: { type: 'object', properties: { phone: { type: 'string', description: 'E.164, e.g. +919876543210' }, name: { type: 'string' }, reason: { type: 'string' } }, required: ['phone'] } },
];

export async function runTool(name, args, ctx) {
  const h = handlers[name];
  if (!h) return { error: `Unknown tool ${name}` };
  try { return await h(args || {}, ctx); } catch (e) { return { error: e.message }; }
}

export function toolsFor(names) { return names ? toolDefs.filter((t) => names.includes(t.name)) : toolDefs; }
