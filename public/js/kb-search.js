// Guide page search, backed by the same BM25 retriever the voice agent uses.
const q = document.querySelector('#kb-q');
const out = document.querySelector('#kb-results');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let t;
q.addEventListener('input', () => {
  clearTimeout(t);
  t = setTimeout(async () => {
    if (q.value.trim().length < 2) { out.innerHTML = ''; return; }
    const r = await (await fetch(`/api/kb/search?q=${encodeURIComponent(q.value)}`)).json();
    out.innerHTML = r.results.map((x) => `<div class="kb-hit"><a href="${esc(x.url)}"><strong>${esc(x.title)}</strong></a><p>${esc(x.text.slice(0, 220))}${x.text.length > 220 ? '…' : ''}</p></div>`).join('') + `<p class="muted">Retrieved in ${r.ms} ms, the same search Aria uses.</p>`;
  }, 150);
});
