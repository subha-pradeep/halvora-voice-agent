import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halvora-test-'));
const { retrieve } = await import('../server/kb.js');
const { runTool, todayISO } = await import('../server/tools.js');
const { Chunker } = await import('../server/brain.js');
const { sanitize, recordMetric, summary } = await import('../server/metrics.js');

const plusDays = (n) => new Date(Date.parse(`${todayISO()}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

test('retrieval finds the right policy', () => {
  assert.equal(retrieve('can I bring my dog').results[0].title, 'Policy: Pets');
  assert.match(retrieve('what is the cancellation policy').results[0].title, /Cancellation|cancellation/);
  assert.ok(retrieve('restaurants in mumbai').results[0].title.includes('Mumbai'));
});

test('availability, booking, lookup and two-step cancel', async () => {
  const ci = plusDays(75), co = plusDays(78);
  const a = await runTool('check_availability', { hotel: 'munnar', check_in: ci, check_out: co, guests: 2 });
  assert.equal(a.nights, 3);
  assert.equal(a.options.length, 3);
  const b = await runTool('create_booking', { hotel: 'Munnar', room_type: 'valley view', check_in: ci, check_out: co, guests: 2, guest_name: 'Asha Rao', phone: '+91 98765 43210' });
  assert.equal(b.confirmed, true);
  assert.match(b.confirmation_code, /^HLV-[A-Z0-9]{5}$/);
  const l = await runTool('lookup_booking', { confirmation_code: b.confirmation_code.toLowerCase().replace('-', ' ') });
  assert.equal(l.status, 'confirmed');
  assert.equal(l.phone_last4, '3210');
  const c1 = await runTool('cancel_booking', { confirmation_code: b.confirmation_code });
  assert.equal(c1.needs_confirmation, true);
  assert.equal(c1.cancellation_fee_inr, 0);
  const c2 = await runTool('cancel_booking', { confirmation_code: b.confirmation_code, confirm: true });
  assert.equal(c2.cancelled, true);
});

test('validation errors', async () => {
  assert.ok((await runTool('check_availability', { hotel: 'paris', check_in: plusDays(5), check_out: plusDays(6) })).error);
  assert.ok((await runTool('check_availability', { hotel: 'goa', check_in: plusDays(6), check_out: plusDays(5) })).error);
  assert.ok((await runTool('create_booking', { hotel: 'goa', room_type: 'pool villa', check_in: plusDays(5), check_out: plusDays(6), guests: 9, guest_name: 'X Y', phone: '+919876543210' })).error);
});

test('tax is 12% and Saver is 15% off', async () => {
  const ci = plusDays(60), co = plusDays(61);
  const a = await runTool('check_availability', { hotel: 'udaipur', check_in: ci, check_out: co });
  const o = a.options[0];
  assert.equal(o.total_with_tax, Math.round(o.avg_per_night * 1.12));
  assert.equal(o.saver_total_with_tax, Math.round(Math.round(o.avg_per_night * 0.85) * 1.12));
});

test('chunker emits an early clause in low-latency mode and handles abbreviations', () => {
  const c = new Chunker('clause');
  const out = [...c.push('Of course, the Pool Villa is 21,000 rupees a night. Rs. 500 '), ...c.push('extra for breakfast. Anything else'), ...c.flush()];
  assert.deepEqual(out, ['Of course, the Pool Villa is 21,000 rupees a night.', 'Rs. 500 extra for breakfast.', 'Anything else']);
});

test('metrics sanitize rejects unknown platforms and bad values', () => {
  assert.equal(sanitize({ platform: 'evil' }), null);
  const r = sanitize({ platform: 'twilio', responseMs: 900, llmTtftMs: -5, endOfTurnMs: 'x' });
  assert.equal(r.responseMs, 900);
  assert.equal(r.llmTtftMs, undefined);
  recordMetric({ platform: 'twilio', responseMs: 1000, turnIndex: 1 });
  recordMetric({ platform: 'twilio', responseMs: 2000, turnIndex: 2 });
  const s = summary().twilio;
  assert.equal(s.avgResponseMs, 1500);
  assert.equal(s.firstResponseMs, 1000);
});
