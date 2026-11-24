// Latency comparison dashboard. Renders only real stored measurements.
const $ = (s) => document.querySelector(s);
const fmt = (ms) => (ms == null ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STAGES = [
  ['endOfTurnMs', 'End-of-turn', 'var(--series-1)'],
  ['llmTtftMs', 'LLM TTFT', 'var(--series-2)'],
  ['ttsTtfbMs', 'TTS TTFB', 'var(--series-3)'],
];

const tip = document.createElement('div');
tip.className = 'viz-tip';
tip.setAttribute('role', 'tooltip');
document.body.appendChild(tip);
function showTip(e, html) { tip.innerHTML = html; tip.style.display = 'block'; const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8); tip.style.left = `${x}px`; tip.style.top = `${e.clientY + 14}px`; }
function hideTip() { tip.style.display = 'none'; }
function bindTips(root) {
  root.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('mousemove', (e) => showTip(e, el.dataset.tip));
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('focus', () => { const r = el.getBoundingClientRect(); showTip({ clientX: r.left, clientY: r.bottom }, el.dataset.tip); });
    el.addEventListener('blur', hideTip);
  });
}

async function load() {
  const r = await fetch('/api/metrics');
  const { summary, recent, platforms } = await r.json();
  const ids = Object.keys(platforms);
  const withData = ids.filter((id) => summary[id].turns > 0);
  $('#updated').textContent = `Updated ${new Date().toLocaleTimeString()} · ${recent.length ? `${withData.length} of ${ids.length} deployment modes have data` : 'no data yet: hold a few conversations on the Talk page'}`;

  // Headline: one hero bar per platform (single series, one hue), fastest first.
  const max = Math.max(1, ...withData.map((id) => summary[id].avgResponseMs || 0));
  const order = [...ids].sort((a, b) => (summary[a].avgResponseMs ?? Infinity) - (summary[b].avgResponseMs ?? Infinity));
  $('#dash-cards').innerHTML = `<div class="hero-bars" role="img" aria-label="Average response latency by deployment mode">${order.map((id) => {
    const s = summary[id];
    const w = s.avgResponseMs ? Math.max(2, (100 * s.avgResponseMs) / max) : 0;
    return `<div class="hb-row">
      <div class="hb-label">${esc(s.label)}<small>${s.turns ? `${s.turns} turns · ${esc(s.headlineSource)}` : 'no data yet'}</small></div>
      <div class="hb-track">${s.avgResponseMs ? `<span class="hb-bar" tabindex="0" style="width:${w}%" data-tip="<strong>${esc(s.label)}</strong><br>Average ${fmt(s.avgResponseMs)}<br>p50 ${fmt(s.p50Ms)} · p90 ${fmt(s.p90Ms)}<br>First response ${fmt(s.firstResponseMs)}"></span>` : ''}</div>
      <div class="hb-value">${fmt(s.avgResponseMs)}</div>
    </div>`;
  }).join('')}</div>`;

  // Comparison table (also the accessible table view of both charts).
  const cols = [
    ['firstResponseMs', 'First response'], ['avgResponseMs', 'Average response'], ['p50Ms', 'p50'], ['p90Ms', 'p90'],
    ['clientV2vMs', 'Browser v2v'], ['serverResponseMs', 'Server / framework'], ['endOfTurnMs', 'End-of-turn'], ['sttMs', 'STT'],
    ['llmTtftMs', 'LLM TTFT'], ['ttsTtfbMs', 'TTS TTFB (streaming)'], ['perceivedMs', 'Perceived (with filler)'],
  ];
  $('#dash-table').innerHTML = `<thead><tr><th>Deployment</th><th>Turns</th>${cols.map(([, l]) => `<th>${l}</th>`).join('')}<th>Prompt cache hit</th></tr></thead><tbody>${ids.map((id) => {
    const s = summary[id];
    return `<tr><td><strong>${esc(s.label)}</strong></td><td>${s.turns}</td>${cols.map(([k]) => `<td class="num">${fmt(s[k])}</td>`).join('')}<td class="num">${s.cacheHitRate == null ? '–' : `${s.cacheHitRate}%`}</td></tr>`;
  }).join('')}</tbody>`;

  // Per-stage stacked bars: three series in fixed categorical order, legend + direct labels.
  const stageMax = Math.max(1, ...ids.map((id) => STAGES.reduce((t, [k]) => t + (summary[id][k] || 0), 0)));
  $('#stage-chart').innerHTML = `<div class="legend">${STAGES.map(([, l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}</div>${ids.map((id) => {
    const s = summary[id];
    const parts = STAGES.filter(([k]) => s[k] != null);
    const total = parts.reduce((t, [k]) => t + s[k], 0);
    return `<div class="hb-row"><div class="hb-label">${esc(s.label)}</div><div class="hb-track stack">${parts.map(([k, l, c]) => `<span class="seg" tabindex="0" style="width:${(100 * s[k]) / stageMax}%;background:${c}" data-tip="<strong>${esc(s.label)}</strong><br>${l}: ${fmt(s[k])}">${(100 * s[k]) / stageMax > 9 ? `<em>${fmt(s[k])}</em>` : ''}</span>`).join('')}</div><div class="hb-value">${total ? fmt(total) : '–'}</div></div>`;
  }).join('')}<p class="small muted">Stages are averaged over turns that report them. The website speech-to-speech mode has no separate stages, because one model does everything.</p>`;

  $('#recent').innerHTML = `<thead><tr><th>Time</th><th>Deployment</th><th>Turn</th><th>Browser v2v</th><th>Server / framework</th><th>End-of-turn</th><th>LLM TTFT</th><th>TTS TTFB</th><th>Model</th><th>Tools</th><th>Source</th></tr></thead><tbody>${recent.slice(0, 40).map((r) => `<tr${r.interrupted ? ' class="muted"' : ''}><td>${new Date(r.ts).toLocaleTimeString()}</td><td>${esc(platforms[r.platform])}</td><td>${r.turnIndex ?? ''}</td><td class="num">${fmt(r.clientV2vMs)}</td><td class="num">${fmt(r.responseMs)}</td><td class="num">${fmt(r.endOfTurnMs)}</td><td class="num">${fmt(r.llmTtftMs)}</td><td class="num">${fmt(r.ttsTtfbMs)}</td><td class="small">${esc(r.llm || '')}</td><td class="small">${esc((r.tools || []).join(', '))}</td><td class="small">${esc(r.source)}${r.interrupted ? ' · interrupted' : ''}</td></tr>`).join('') || '<tr><td colspan="11" class="muted">No turns recorded yet.</td></tr>'}</tbody>`;
  bindTips(document);
}

$('#refresh').onclick = load;
load();
setInterval(() => { if (!document.hidden) load(); }, 15000);
