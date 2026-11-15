/* Wildfire Monitor — 4-screen flow: search → select area → graphs & calendar → 15-day burning activity */
(() => {
'use strict';
const GEO = window.FRP_GEO;
const $ = id => document.getElementById(id);
const PERIODS = ['2006-2009', '2010-2013', '2014-2017', '2018-2021', '2022-2025', '2026'];
const PERIOD_YEARS = { '2006-2009': [2006, 2009], '2010-2013': [2010, 2013], '2014-2017': [2014, 2017], '2018-2021': [2018, 2021], '2022-2025': [2022, 2025], '2026': [2026, 2026] };
const PLABEL = p => p === '2026' ? '2026 (Jan–Aug)' : p.replace('-', '–');
// one hue, light → dark toward 2026
const PCOL = ['#efa98f', '#e4836a', '#d45c45', '#b8392a', '#8a1f17', '#4a0b0a'];
const CATS = ['All', 'Extreme', 'Large', 'Small'];
const CAT_NOTE = ['all events', 'fire_size_class = Extreme', 'fire_size_class = Large', 'fire_size_class = Small'];
const CLS_COL = ['#7a1410', '#d83a30', '#ecc0aa']; // Extreme, Large, Small
const Y0 = 2006, Y1 = 2026, NY = Y1 - Y0 + 1;
const EPOCH = Date.UTC(2006, 0, 1);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ======================= helpers ======================= */
const tip = $('tip');
const nf = (v, d = 1) => v == null || Number.isNaN(v) ? '–' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function showTip(html, e) {
  tip.innerHTML = html; tip.classList.add('on');
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
const hideTip = () => tip.classList.remove('on');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const doyOf = (y, m, d) => (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 864e5 + 1;
const dayIdx = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - EPOCH) / 864e5);
const dateOfIdx = i => new Date(EPOCH + i * 864e5);
const fmtDate = dt => `${MON[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
const md = dt => `${MON[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
const isoIdx = i => dateOfIdx(i).toISOString().slice(0, 10);
const weekOfDoy = doy => Math.min(52, Math.floor((doy - 1) / 7) + 1);
function weekRange(w) {
  const s = new Date(Date.UTC(2001, 0, 7 * (w - 1) + 1)), e = new Date(Date.UTC(2001, 0, w === 52 ? 365 : 7 * w));
  return `${md(s)} – ${md(e)}${w === 52 ? ' (incl. remaining days)' : ''}`;
}
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
}
function niceMax(v) {
  if (!(v > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}
const tickFmt = t => nf(t, t % 1 ? (t < 1 ? 2 : 1) : 0);
function chips(el, opts, get, set) {
  const paint = () => { el.innerHTML = opts.map(o => `<button class="chip${get() === o.v ? ' active' : ''}" data-v="${o.v}" aria-pressed="${get() === o.v}">${o.t}</button>`).join(''); };
  paint();
  el.onclick = e => { const b = e.target.closest('button'); if (!b) return; const v = isNaN(+b.dataset.v) ? b.dataset.v : +b.dataset.v; set(v); paint(); };
}
const RAMP = ['#fff1b0', '#f1b277', '#e84b31', '#b3161a', '#5c0a0a'].map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
function rampRGB(t) {
  t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t)), f = t - i, a = RAMP[i], b = RAMP[i + 1];
  return a.map((v, k) => Math.round(v + (b[k] - v) * f));
}
const ramp = t => `rgb(${rampRGB(t).join(',')})`;
function busy(on, msg) { $('busy').classList.toggle('on', on); if (msg) $('busyMsg').textContent = msg; }
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

/* ======================= geography ======================= */
const poly10 = (c, u, v) => c[0] + c[1] * u + c[2] * v + c[3] * u * u + c[4] * u * v + c[5] * v * v + c[6] * u * u * u + c[7] * u * u * v + c[8] * u * v * v + c[9] * v * v * v;
const toGrid = (lon, lat) => [poly10(GEO.fwd.x, lon + 120, lat - 37), poly10(GEO.fwd.y, lon + 120, lat - 37)];
const toLonLat = (x, y) => [poly10(GEO.inv.lon, x / 1000, y / 1000), poly10(GEO.inv.lat, x / 1000, y / 1000)];
function bboxOf(rings) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  rings.forEach(r => r.forEach(([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }));
  return { x0, x1, y0, y1 };
}
function inRings(x, y, rings) {
  let inside = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(a / 2); }
const gridToLL = rings => rings.map(r => r.map(([x, y]) => toLonLat(x, y)));
const llToGrid = rings => rings.map(r => r.map(([lo, la]) => toGrid(lo, la)));
function densify(ring, n = 12) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    for (let k = 0; k < n; k++) out.push([x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]);
  }
  return out;
}

/* ======================= places (worldwide search; data for California only) ======================= */
const CA = { name: 'California', type: 'State', sub: 'United States', data: true, rings: GEO.ca, bbox: bboxOf(GEO.ca) };
const PLACES = [CA];
GEO.counties.forEach(c => PLACES.push({ name: c.name + ' County', type: 'County', sub: 'California, United States', data: true, rings: c.rings, bbox: bboxOf(c.rings) }));
GEO.caPlaces.forEach(c => { const [x, y] = toGrid(c.lon, c.lat); PLACES.push({ name: c.name, type: 'City', sub: 'California, United States', data: true, point: [x, y], bbox: { x0: x - 70, x1: x + 70, y0: y - 70, y1: y + 70 } }); });
GEO.states.forEach(s => PLACES.push({ name: s.name, type: 'State', sub: 'United States', data: false, ll: s.rings, llbox: bboxOf(s.rings) }));
const COUNTRY = {};
GEO.countries.forEach(c => { const p = { name: c.name, type: 'Country', sub: '', data: false, ll: c.rings, llbox: bboxOf(c.rings) }; COUNTRY[c.name] = p; PLACES.push(p); });
const ALIAS = { 'United States of America': ['USA', 'United States', 'US', 'America'], 'South Korea': ['Korea', 'Republic of Korea'], 'United Kingdom': ['UK', 'Britain', 'England'], 'Russia': ['Russian Federation'] };
Object.entries(ALIAS).forEach(([k, v]) => { if (COUNTRY[k]) COUNTRY[k].alias = v; });
COUNTRY['United States'] = COUNTRY['United States of America'];
GEO.worldCities.forEach(c => PLACES.push({ name: c.name, type: 'City', sub: c.country, data: false, llpt: [c.lon, c.lat], country: COUNTRY[c.country] }));
const COUNTIES = PLACES.filter(p => p.type === 'County');

/* ======================= data (decoded lazily) ======================= */
let D = null, coreReady = null;
function loadCore() {
  if (coreReady) return coreReady;
  coreReady = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'data/core.js';
    s.onload = async () => {
      try {
        const C = window.FRP_CORE;
        let buf;
        try {
          const resp = await fetch('data:application/octet-stream;base64,' + C.b64);
          buf = await new Response(resp.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        } catch (e) {
          const bin = atob(C.b64), u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          buf = await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        }
        const T = { float32: Float32Array, uint32: Uint32Array, uint16: Uint16Array, int16: Int16Array, uint8: Uint8Array };
        const col = {};
        C.layout.forEach(l => { col[l.name] = new T[l.type](buf, l.offset, l.length); });
        delete C.b64;
        Object.assign(col, { lastDate: C.lastDate, firstDate: C.firstDate, rows: C.rows });
        const [ly, lm, ld] = C.lastDate.split('-').map(Number);
        col.nDays = dayIdx(ly, lm, ld) + 1;
        const ds = new Int32Array(col.nDays + 1); let r = 0;
        for (let d = 0; d <= col.nDays; d++) { while (r < col.day.length && col.day[r] < d) r++; ds[d] = r; }
        col.dayStart = ds;
        col.dYear = new Uint16Array(col.nDays); col.dWeek = new Uint8Array(col.nDays);
        for (let d = 0; d < col.nDays; d++) { const dt = dateOfIdx(d), y = dt.getUTCFullYear(); col.dYear[d] = y; col.dWeek[d] = weekOfDoy(doyOf(y, dt.getUTCMonth() + 1, dt.getUTCDate())); }
        const nE = col.edur.length; col.eDay = new Uint16Array(nE);
        for (let e = 0; e < nE; e++) col.eDay[e] = Math.floor(col.efirst[e] / 1440);
        const dens = new Uint16Array(col.cx.length);
        for (let i = 0; i < col.cid.length; i++) if (dens[col.cid[i]] < 65535) dens[col.cid[i]]++;
        col.dens = dens;
        D = col; res(col);
      } catch (e) { rej(e); }
    };
    s.onerror = () => rej(new Error('could not load data/core.js'));
    document.head.appendChild(s);
  });
  coreReady.then(() => {
    $('loadStatus').classList.add('done');
    $('loadStatus').textContent = `Data ready · ${nf(D.rows, 0)} pixel observations · ${nf(D.frp.length, 0)} pixel-dates · ${nf(D.edur.length, 0)} events`;
    document.querySelectorAll('.js-last').forEach(e => e.textContent = fmtDate(dateOfIdx(D.nDays - 1)));
    $('dateInput').min = D.firstDate; $('dateInput').max = D.lastDate;
    if (route() === 'region') { drawRegion(); updateSelInfo(); }
  }, e => { $('loadStatus').textContent = 'Could not load data: ' + e.message; });
  return coreReady;
}

/* ======================= state & routing ======================= */
const state = { place: null, sel: null, R: null, metric: 'frp', hidden: new Set(), date: null, aDay: 7, extent: 'sel', playing: null, win: null };
const SCREENS = ['title', 'region', 'dashboard', 'activity'];
const route = () => { const h = location.hash.replace('#/', ''); return SCREENS.includes(h) ? h : 'title'; };
async function render() {
  const s = route();
  if (s !== 'title' && !state.place) { location.hash = '#/title'; return; }
  if ((s === 'dashboard' || s === 'activity') && !state.sel) { location.hash = '#/region'; return; }
  if (s === 'activity' && state.date == null) { location.hash = '#/dashboard'; return; }
  stopPlay(); hideTip();
  SCREENS.forEach(k => $('s-' + k).classList.toggle('on', k === s));
  document.querySelectorAll('#steps a').forEach(a => {
    const i = SCREENS.indexOf(a.dataset.s);
    a.classList.toggle('cur', a.dataset.s === s);
    a.classList.toggle('off', (i >= 1 && !state.place) || (i >= 2 && !state.sel) || (i >= 3 && state.date == null));
  });
  scrollTo(0, 0);
  if (s === 'region') enterRegion();
  if (s === 'dashboard') await enterDashboard();
  if (s === 'activity') await enterActivity();
}
addEventListener('hashchange', render);

/* ======================= 1. title & search ======================= */
let hlIdx = 0, matches = [];
function searchRender() {
  const q = $('searchInput').value.trim().toLowerCase();
  if (!q) { $('searchResults').innerHTML = ''; matches = []; return; }
  const score = p => {
    const names = [p.name, ...(p.alias || [])].map(n => n.toLowerCase());
    if (names.some(n => n === q)) return 0;
    if (names.some(n => n.startsWith(q))) return 1;
    if (names.some(n => n.split(/[\s-]+/).some(w => w.startsWith(q)))) return 2;
    if (names.some(n => n.includes(q))) return 3;
    return 9;
  };
  matches = PLACES.map(p => [score(p), p]).filter(([s]) => s < 9)
    .sort((a, b) => a[0] - b[0] || (b[1].data - a[1].data) || a[1].name.localeCompare(b[1].name)).slice(0, 8).map(x => x[1]);
  hlIdx = 0;
  $('searchResults').innerHTML = !matches.length
    ? `<div class="label">No match</div><div class="result dis">No place found for “${esc(q)}”.<br><small>Try a country, U.S. state, California county or city.</small></div>`
    : `<div class="label">Places</div>` + matches.map((p, i) => `<button class="result${i === hlIdx ? ' hl' : ''}" data-i="${i}" type="button">
        <span>&#9906; &nbsp; ${esc(p.name)} <small class="ptype">${p.type}</small></span>
        <small>${esc(p.sub)}${p.sub ? ' · ' : ''}<span class="${p.data ? 'has-data' : 'no-data'}">${p.data ? 'Data available' : 'No data yet'}</span></small></button>`).join('');
}
function choosePlace(p) {
  if (!p) return;
  if (state.place !== p) { state.place = p; state.sel = null; state.R = null; state.date = null; regionView = null; }
  if (route() === 'region') render(); else location.hash = '#/region';
}
$('searchInput').addEventListener('input', searchRender);
$('searchInput').addEventListener('keydown', e => {
  if (!matches.length || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  e.preventDefault(); hlIdx = (hlIdx + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
  $('searchResults').querySelectorAll('.result[data-i]').forEach(b => b.classList.toggle('hl', +b.dataset.i === hlIdx));
});
$('searchForm').addEventListener('submit', e => { e.preventDefault(); if (!$('searchInput').value.trim()) { $('searchInput').value = 'California'; searchRender(); } choosePlace(matches[hlIdx]); });
$('searchResults').addEventListener('click', e => { const b = e.target.closest('.result[data-i]'); if (b) choosePlace(matches[+b.dataset.i]); });

/* ======================= map renderer (California grid coordinates) ======================= */
function fitView(canvas, ext, pad = 24, padT = 24, padB = 24) {
  const box = canvas.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  canvas.width = Math.round(box.width * dpr); canvas.height = Math.round(box.height * dpr);
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = box.width, H = box.height;
  const s = Math.min((W - 2 * pad) / (ext.x1 - ext.x0), (H - padT - padB) / (ext.y1 - ext.y0));
  const ox = (W - s * (ext.x1 - ext.x0)) / 2, oy = padT + (H - padT - padB - s * (ext.y1 - ext.y0)) / 2;
  return { ctx, W, H, s, X: x => ox + (x - ext.x0) * s, Y: y => oy + (ext.y1 - y) * s, ix: px => (px - ox) / s + ext.x0, iy: py => ext.y1 - (py - oy) / s };
}
function pathRings(v, rings) { const c = v.ctx; c.beginPath(); rings.forEach(r => r.forEach(([x, y], i) => i ? c.lineTo(v.X(x), v.Y(y)) : c.moveTo(v.X(x), v.Y(y)))); c.closePath(); }
let densCanvas = null;
function densityLayer() {
  if (densCanvas || !D) return densCanvas;
  const B = 4, bx0 = -760, by0 = -1220, w = Math.ceil(1860 / B), h = Math.ceil(2140 / B), acc = new Float32Array(w * h);
  for (let c = 0; c < D.cx.length; c++) { const i = Math.floor((D.cx[c] - bx0) / B), j = Math.floor((D.cy[c] - by0) / B); acc[(h - 1 - j) * w + i] += D.dens[c]; }
  let mx = 0; for (const v of acc) mx = Math.max(mx, v);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(w, h);
  for (let k = 0; k < acc.length; k++) if (acc[k] > 0) { const t = Math.log1p(acc[k]) / Math.log1p(mx), [r, g, b] = rampRGB(.25 + t * .7); img.data.set([r, g, b, Math.round(60 + 150 * t)], k * 4); }
  ctx.putImageData(img, 0, 0);
  return (densCanvas = { cv, x0: bx0, y0: by0, x1: bx0 + w * B, y1: by0 + h * B });
}
function drawBase(v, opts = {}) {
  const c = v.ctx;
  c.fillStyle = '#eef2f0'; c.fillRect(0, 0, v.W, v.H);
  pathRings(v, CA.rings); c.fillStyle = '#f6eee7'; c.fill('evenodd');
  if (opts.density && densityLayer()) {
    const d = densCanvas; c.save(); pathRings(v, CA.rings); c.clip();
    c.imageSmoothingEnabled = v.s * 4 < 3; c.globalAlpha = .55;
    c.drawImage(d.cv, v.X(d.x0), v.Y(d.y1), (d.x1 - d.x0) * v.s, (d.y1 - d.y0) * v.s); c.restore();
  }
  c.lineWidth = .7; c.strokeStyle = 'rgba(173,117,103,.35)';
  COUNTIES.forEach(k => { pathRings(v, k.rings); c.stroke(); });
  pathRings(v, CA.rings); c.lineWidth = 1.6; c.strokeStyle = 'rgba(173,117,103,.85)'; c.stroke();
  const p = state.place;
  if (p && p.type === 'County') { pathRings(v, p.rings); c.lineWidth = 2; c.strokeStyle = '#31201c'; c.setLineDash([2, 3]); c.stroke(); c.setLineDash([]); }
  if (p && p.point) { c.beginPath(); c.arc(v.X(p.point[0]), v.Y(p.point[1]), 6, 0, 7); c.lineWidth = 2.5; c.strokeStyle = '#31201c'; c.stroke(); }
  c.font = '700 11px DM Sans, sans-serif'; c.fillStyle = '#816b63';
  const lab = (t, x, y) => { const px = v.X(x), py = v.Y(y); if (px > 8 && px < v.W - 90 && py > 30 && py < v.H - 40) c.fillText(t, px, py); };
  lab('PACIFIC OCEAN', -640, -700); lab('NEVADA', 640, 430); lab('ARIZONA', 1000, -1080);
}
function drawCities(v) {
  const c = v.ctx; c.font = '700 11px DM Sans, sans-serif';
  Object.entries(GEO.cities).forEach(([n, [x, y]]) => {
    const px = v.X(x), py = v.Y(y); if (px < 0 || px > v.W - 60 || py < 0 || py > v.H) return;
    c.fillStyle = '#31201c'; c.beginPath(); c.arc(px, py, 2.8, 0, 7); c.fill();
    const w = c.measureText(n).width; c.fillStyle = 'rgba(255,253,250,.82)'; c.fillRect(px + 5, py - 9, w + 8, 16);
    c.fillStyle = '#31201c'; c.fillText(n, px + 9, py + 3);
  });
}
function drawSel(v, sel, { fill = true, handles = false } = {}) {
  if (!sel) return;
  const c = v.ctx; pathRings(v, sel.rings);
  if (fill) { c.fillStyle = 'rgba(216,58,48,.22)'; c.fill('evenodd'); }
  c.lineWidth = 3; c.strokeStyle = '#d83a30'; c.setLineDash([8, 5]); c.stroke(); c.setLineDash([]);
  if (handles && sel.corners) sel.corners.forEach(([x, y]) => { c.beginPath(); c.arc(v.X(x), v.Y(y), 5, 0, 7); c.fillStyle = '#d83a30'; c.fill(); c.lineWidth = 2; c.strokeStyle = '#fff'; c.stroke(); });
}
function padExt(b, f = .08, min = 40) {
  const w = Math.max(min, b.x1 - b.x0), h = Math.max(min, b.y1 - b.y0), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  return { x0: cx - w / 2 - w * f, x1: cx + w / 2 + w * f, y0: cy - h / 2 - h * f, y1: cy + h / 2 + h * f };
}

/* world map for places without data (equirectangular, lon/lat) */
function drawWorldPlace() {
  const p = state.place, cv = $('regionCanvas');
  let b = p.llbox || (p.country && p.country.llbox) || { x0: p.llpt[0] - 4, x1: p.llpt[0] + 4, y0: p.llpt[1] - 3, y1: p.llpt[1] + 3 };
  if (p.llpt) b = { x0: p.llpt[0] - 12, x1: p.llpt[0] + 12, y0: p.llpt[1] - 8, y1: p.llpt[1] + 8 };
  else { const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, w = Math.max(b.x1 - b.x0, 16), h = Math.max(b.y1 - b.y0, 11); b = { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 }; }
  const k = Math.cos((b.y0 + b.y1) / 2 * Math.PI / 180) || .2;
  const ext = padExt({ x0: b.x0 * k, x1: b.x1 * k, y0: b.y0, y1: b.y1 }, .12, .5);
  const v = fitView(cv, ext, 20, 70, 50), c = v.ctx, P = (lo, la) => [v.X(lo * k), v.Y(la)];
  c.fillStyle = '#eef2f0'; c.fillRect(0, 0, v.W, v.H);
  const ring = r => { c.beginPath(); r.forEach(([lo, la], i) => { const [x, y] = P(lo, la); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.closePath(); };
  [...GEO.countries, ...GEO.states].forEach(g => g.rings.forEach(r => { ring(r); c.fillStyle = '#f3ece4'; c.fill(); c.strokeStyle = 'rgba(173,117,103,.45)'; c.lineWidth = .8; c.stroke(); }));
  gridToLL(CA.rings).forEach(r => { ring(r); c.fillStyle = 'rgba(216,58,48,.18)'; c.fill(); c.strokeStyle = '#d83a30'; c.lineWidth = 1.5; c.stroke(); });
  const shape = p.ll || (p.country && p.country.ll);
  if (shape) shape.forEach(r => { ring(r); c.fillStyle = 'rgba(49,32,28,.10)'; c.fill(); c.strokeStyle = '#31201c'; c.lineWidth = 1.6; c.setLineDash([3, 3]); c.stroke(); c.setLineDash([]); });
  if (p.llpt) { const [x, y] = P(...p.llpt); c.beginPath(); c.arc(x, y, 6, 0, 7); c.fillStyle = '#31201c'; c.fill(); c.font = '700 12px DM Sans, sans-serif'; c.fillText(p.name, x + 10, y + 4); }
}

/* ======================= 2. region selection ======================= */
let regionView = null, regionV = null, drag = null;
function enterRegion() {
  const p = state.place;
  $('regionTitle').textContent = `Select a region in ${p.name}`;
  $('regionCrumb').textContent = `${p.sub ? p.sub + ' / ' : ''}${p.name} / Region selection`;
  $('regionMapLabel').textContent = p.name;
  $('methodCard').classList.toggle('disabled', !p.data); ['zoomBox', 'regionLegend'].forEach(id => { $(id).hidden = !p.data; });
  $('regionSub').textContent = p.data ? 'Drag on the map to draw a rectangle, enter two coordinate points, or upload a GeoJSON file.' : 'Search works worldwide, but fire data is currently available for California only.';
  $('regionHint').textContent = p.data ? 'Drag to select · Scroll or +/− to zoom · Shift+drag to pan' : 'Preview only';
  const banner = $('noDataBanner'); banner.hidden = p.data;
  if (!p.data) {
    banner.innerHTML = `<b>No fire data for ${esc(p.name)} yet.</b><p>Wildfire Monitor currently covers California, USA (shaded red). Other regions will be added later.</p><button class="btn small" id="goCA">Explore California &rarr;</button>`;
    $('goCA').onclick = () => choosePlace(CA);
  }
  $('usePlace').textContent = p.type === 'City' ? `Use 20 km around ${p.name}` : `Use all of ${p.name}`;
  if (p.data && !regionView) regionView = padExt(p.bbox, .05);
  if (state.sel) fillCoordInputs(state.sel);
  drawRegion(); updateSelInfo();
}
function drawRegion() {
  if (route() !== 'region' || !state.place) return;
  if (!state.place.data) { regionV = null; drawWorldPlace(); return; }
  const v = regionV = fitView($('regionCanvas'), regionView, 20, 70, 50);
  drawBase(v, { density: true });
  drawSel(v, drag && drag.mode === 'sel' ? drag.sel : state.sel, { handles: true });
  drawCities(v);
}
/* a selection keeps grid rings (for drawing) and lon/lat rings (pixels are tested by their latitude/longitude) */
function makeSel(kind, gridRings, llRings, label, llRect) {
  return { kind, rings: gridRings, ll: llRings, llRect: !!llRect, label, bbox: bboxOf(gridRings), llbbox: bboxOf(llRings),
    corners: kind === 'drag' ? [0, 1, 2, 3].map(i => gridRings[0][i * 12]) : null };
}
function rectSelFromGrid(r) {
  const ring = densify([[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]]);
  return makeSel('drag', [ring], gridToLL([ring]), null);
}
function setSel(sel) {
  state.sel = sel; state.R = null; state.date = null;
  drawRegion(); updateSelInfo(); if (sel) fillCoordInputs(sel);
}
function cellMask(sel) {
  const m = new Uint8Array(D.cx.length), b = sel.llbbox;
  for (let c = 0; c < m.length; c++) {
    const lo = D.clon[c], la = D.clat[c];
    if (lo < b.x0 || lo > b.x1 || la < b.y0 || la > b.y1) continue;
    m[c] = sel.llRect || inRings(lo, la, sel.ll) ? 1 : 0;
  }
  return m;
}
function updateSelInfo() {
  const sel = state.sel, st = $('regionStatus');
  $('toDashboard').disabled = !sel;
  if (!state.place.data) { st.textContent = 'NO DATA FOR THIS REGION'; st.classList.remove('on'); $('selStats').innerHTML = ''; $('regionFoot').textContent = 'Fire data is available for California only.'; return; }
  if (!sel) { st.textContent = 'NO AREA SELECTED'; st.classList.remove('on'); $('selStats').innerHTML = '<div class="full">No area selected yet.</div>'; $('regionFoot').textContent = 'Select an area to continue.'; return; }
  st.textContent = `AREA SELECTED · ${sel.kind === 'drag' ? 'RECTANGLE' : 'POLYGON'}`; st.classList.add('on');
  const area = sel.rings.reduce((a, r) => a + ringArea(r), 0) * 0.25;
  const html = n => `<div><div class="k">${nf(area, 0)} km²</div><div class="d">Selected area</div></div>${n}<div class="full">${esc(sel.label)}</div>`;
  if (!D) { $('selStats').innerHTML = html('<div><div class="k">…</div><div class="d">Loading data</div></div>'); return; }
  const inC = cellMask(sel); let pd = 0; for (let c = 0; c < inC.length; c++) if (inC[c]) pd += D.dens[c];
  $('selStats').innerHTML = html(`<div><div class="k">${nf(pd, 0)}</div><div class="d">Fire pixel-dates inside</div></div>`);
  $('regionFoot').textContent = `${state.place.name} · ${sel.label} · ready for graphs and calendar.`;
}
function fillCoordInputs(sel) {
  const b = sel.llbbox;
  $('latA').value = b.y1.toFixed(2); $('lonA').value = b.x0.toFixed(2); $('latB').value = b.y0.toFixed(2); $('lonB').value = b.x1.toFixed(2);
}
const rc = $('regionCanvas');
const evPos = e => { const r = rc.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
rc.addEventListener('pointerdown', e => {
  if (!regionV) return; rc.setPointerCapture(e.pointerId);
  const [px, py] = evPos(e);
  if (e.shiftKey || e.button === 1 || e.button === 2) { drag = { mode: 'pan', px, py, view: { ...regionView } }; rc.classList.add('pan'); }
  else drag = { mode: 'sel', gx: regionV.ix(px), gy: regionV.iy(py), sel: null };
});
rc.addEventListener('pointermove', e => {
  if (!drag) return; const [px, py] = evPos(e);
  if (drag.mode === 'pan') {
    const dx = (px - drag.px) / regionV.s, dy = (py - drag.py) / regionV.s;
    regionView = { x0: drag.view.x0 - dx, x1: drag.view.x1 - dx, y0: drag.view.y0 + dy, y1: drag.view.y1 + dy }; drawRegion(); return;
  }
  const gx = regionV.ix(px), gy = regionV.iy(py);
  drag.rect = { x0: Math.min(drag.gx, gx), x1: Math.max(drag.gx, gx), y0: Math.min(drag.gy, gy), y1: Math.max(drag.gy, gy) };
  drag.sel = rectSelFromGrid(drag.rect); drawRegion();
});
const endDrag = () => {
  if (!drag) return; rc.classList.remove('pan');
  const d = drag; drag = null;
  if (d.mode === 'sel' && d.rect && (d.rect.x1 - d.rect.x0) * regionV.s > 6 && (d.rect.y1 - d.rect.y0) * regionV.s > 6) {
    const s = d.sel, b = s.llbbox; s.label = `Drawn rectangle (≈ ${b.y0.toFixed(2)}–${b.y1.toFixed(2)}°N, ${(-b.x1).toFixed(2)}–${(-b.x0).toFixed(2)}°W)`;
    setSel(s);
  } else drawRegion();
};
rc.addEventListener('pointerup', endDrag); rc.addEventListener('pointercancel', endDrag);
rc.addEventListener('contextmenu', e => e.preventDefault());
function zoomAt(f, px, py) {
  if (!regionV) return;
  const gx = regionV.ix(px), gy = regionV.iy(py), v = regionView;
  regionView = { x0: gx - (gx - v.x0) * f, x1: gx + (v.x1 - gx) * f, y0: gy - (gy - v.y0) * f, y1: gy + (v.y1 - gy) * f }; drawRegion();
}
rc.addEventListener('wheel', e => { if (!regionV) return; e.preventDefault(); const [px, py] = evPos(e); zoomAt(e.deltaY > 0 ? 1.2 : 1 / 1.2, px, py); }, { passive: false });
$('zoomIn').onclick = () => regionV && zoomAt(1 / 1.4, regionV.W / 2, regionV.H / 2);
$('zoomOut').onclick = () => regionV && zoomAt(1.4, regionV.W / 2, regionV.H / 2);
$('zoomReset').onclick = () => { if (!state.place.data) return; regionView = padExt(state.place.bbox, .05); drawRegion(); };
$('clearSel').onclick = () => setSel(null);
$('usePlace').onclick = () => {
  const p = state.place; if (!p.data) return;
  if (p.point) { const s = rectSelFromGrid({ x0: p.point[0] - 20, x1: p.point[0] + 20, y0: p.point[1] - 20, y1: p.point[1] + 20 }); s.label = `20 km × 20 km around ${p.name}`; setSel(s); return; }
  setSel(makeSel('poly', p.rings, gridToLL(p.rings), `All of ${p.name}`));
};
$('applyCoords').onclick = () => {
  const v = ['latA', 'lonA', 'latB', 'lonB'].map(id => parseFloat($(id).value));
  if (v.some(Number.isNaN)) { $('coordMsg').textContent = 'Enter all four numbers.'; return; }
  const la1 = Math.max(v[0], v[2]), la0 = Math.min(v[0], v[2]), lo0 = Math.min(v[1], v[3]), lo1 = Math.max(v[1], v[3]);
  if (la0 < 32 || la1 > 42.5 || lo0 < -125 || lo1 > -113.5) { $('coordMsg').textContent = 'Stay within California (32–42.5°N, 125–113.5°W).'; return; }
  const ll = [densify([[lo0, la0], [lo1, la0], [lo1, la1], [lo0, la1]], 30)];
  $('coordMsg').textContent = 'Area created from coordinates.';
  setSel(makeSel('poly', llToGrid(ll), ll, `Coordinates ${la0}–${la1}°N, ${-lo1}–${-lo0}°W`, true));
  regionView = padExt(state.sel.bbox, .3, 80); drawRegion();
};
function readGeoJSON(text, name) {
  try {
    const g = JSON.parse(text), rings = [];
    const take = geom => {
      if (!geom) return;
      if (geom.type === 'Polygon') rings.push(geom.coordinates[0]);
      else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(p => rings.push(p[0]));
      else if (geom.type === 'GeometryCollection') geom.geometries.forEach(take);
    };
    if (g.type === 'FeatureCollection') g.features.forEach(f => take(f.geometry)); else if (g.type === 'Feature') take(g.geometry); else take(g);
    if (!rings.length) throw new Error('no Polygon or MultiPolygon found');
    const ll = rings.map(r => r.map(([lo, la]) => [lo, la]));
    setSel(makeSel('poly', llToGrid(ll), ll, `GeoJSON: ${name}`));
    regionView = padExt(state.sel.bbox, .3, 80); drawRegion();
    $('geoMsg').textContent = `${name} · ${rings.length} polygon(s) loaded.`;
  } catch (e) { $('geoMsg').textContent = 'Could not read GeoJSON: ' + e.message; }
}
$('geoFile').onchange = e => { const f = e.target.files[0]; if (f) f.text().then(t => readGeoJSON(t, f.name)); };
const dz = $('dropZone');
['dragenter', 'dragover'].forEach(k => dz.addEventListener(k, e => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach(k => dz.addEventListener(k, e => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) f.text().then(t => readGeoJSON(t, f.name)); });
$('toDashboard').onclick = () => { location.hash = '#/dashboard'; };

/* ======================= region computation ======================= */
function computeRegion() {
  const inC = cellMask(state.sel), n = D.frp.length, nE = D.edur.length, nD = D.nDays;
  const rows = [], evIn = new Uint8Array(nE);
  const dSum = new Float64Array(nD), dValid = new Uint32Array(nD), dActive = new Uint32Array(nD);
  for (let i = 0; i < n; i++) {
    if (!inC[D.cid[i]]) continue;
    rows.push(i); evIn[D.eid[i]] = 1;
    const d = D.day[i], f = D.frp[i]; dActive[d]++;
    if (f === f) { dSum[d] += f; dValid[d]++; }
  }
  const evList = []; for (let e = 0; e < nE; e++) if (evIn[e]) evList.push(e);
  const ySum = new Float64Array(NY); for (let d = 0; d < nD; d++) ySum[D.dYear[d] - Y0] += dSum[d];
  return { rows: Int32Array.from(rows), evList, dSum, dValid, dActive, ySum, inC, cache: {} };
}
/* category: 0 all, 1 Extreme, 2 Large, 3 Small */
function weeklyFor(metric) {
  const R = state.R; if (R.cache[metric]) return R.cache[metric];
  const K = (c, y, w) => (c * NY + (y - Y0)) * 52 + (w - 1), size = 4 * NY * 52;
  const sum = new Float64Array(size), cnt = new Uint32Array(size);
  if (metric === 'frp') {
    for (const i of R.rows) {
      const f = D.frp[i]; if (f !== f) continue; // missing stays missing
      const d = D.day[i], y = D.dYear[d], w = D.dWeek[d], c = D.ecls[D.eid[i]] + 1;
      sum[K(0, y, w)] += f; cnt[K(0, y, w)]++; sum[K(c, y, w)] += f; cnt[K(c, y, w)]++;
    }
  } else {
    for (const e of R.evList) {
      const d = D.eDay[e]; if (d >= D.nDays) continue;
      const y = D.dYear[d], w = D.dWeek[d], c = D.ecls[e] + 1, v = metric === 'duration' ? D.edur[e] : D.ecells[e];
      sum[K(0, y, w)] += v; cnt[K(0, y, w)]++; sum[K(c, y, w)] += v; cnt[K(c, y, w)]++;
    }
  }
  const out = [0, 1, 2, 3].map(c => {
    const data = {}, n = {};
    for (const p of PERIODS) {
      const [a, b] = PERIOD_YEARS[p]; data[p] = []; n[p] = 0;
      for (let w = 1; w <= 52; w++) {
        let s = 0, k = 0; // value within each year first, then equal-weight mean across years
        for (let y = a; y <= b; y++) { const kk = K(c, y, w); n[p] += cnt[kk]; if (cnt[kk]) { s += sum[kk] / cnt[kk]; k++; } }
        data[p].push(k ? s / k : null);
      }
    }
    return { data, n };
  });
  return (R.cache[metric] = out);
}

/* ======================= 3. dashboard ======================= */
const METRICS = [
  { key: 'frp', title: 'Weekly mean FRP', unit: 'MW', nUnit: 'pixel-dates',
    desc: 'Pixel-date FRP = mean integrated_modis_equiv_index_mw of the same 500 m pixel on the same UTC date; pixel-date values are then averaged by week. Missing calibrated values are left out, never set to 0.' },
  { key: 'duration', title: 'Observed duration per event', unit: 'days', nUnit: 'events',
    desc: 'Each event is placed in the week of its first observation (first_observation_utc); duration_days is averaged per year and week. This is the time from first to last observation, not continuous burning time.' },
  { key: 'cells', title: 'Unique observed grid cells per event', unit: 'cells', nUnit: 'events',
    desc: 'unique_grid_cells = number of distinct 500 m pixels observed during the event. This is not the actual burned area.' },
];
async function enterDashboard() {
  if (!D) { busy(true, 'Loading observation data…'); await loadCore(); }
  if (!state.R) { busy(true, 'Calculating the selected area…'); await nextFrame(); state.R = computeRegion(); }
  busy(false);
  const R = state.R, p = state.place, sel = state.sel;
  if (state.date == null) state.date = busiestDay();
  $('dashCrumb').textContent = `${p.sub ? p.sub + ' / ' : ''}${p.name} / FIRMS data`;
  $('dashTitle').textContent = `${p.name} · Selected area`;
  $('dashSub').textContent = `${sel.label}. Only pixels whose latitude/longitude fall inside this area are used.`;
  $('dashMapLabel').textContent = p.name;
  const cls = [0, 0, 0]; R.evList.forEach(e => cls[D.ecls[e]]++);
  let py = Y0, pv = -1; R.ySum.forEach((v, i) => { if (v > pv) { pv = v; py = Y0 + i; } });
  $('sideStats').innerHTML = `<div><div class="k">${nf(R.rows.length, 0)}</div><div class="d">Fire pixel-dates</div></div><div><div class="k">${nf(R.evList.length, 0)}</div><div class="d">Events touching the area</div></div>
    <div><div class="k">${nf(cls[0], 0)}</div><div class="d">Extreme events</div></div><div><div class="k">${py}</div><div class="d">Year with the most total FRP</div></div>
    <div class="full">${esc(sel.label)}</div>`;
  drawDashMap(); renderLegend(); renderWeekly(); renderCalendars(); renderMissing(); renderCounts(); renderNotes();
}
function drawDashMap() {
  const b = state.place.bbox, s = state.sel.bbox;
  const ext = padExt({ x0: Math.min(b.x0, s.x0), x1: Math.max(b.x1, s.x1), y0: Math.min(b.y0, s.y0), y1: Math.max(b.y1, s.y1) }, .05);
  const v = fitView($('dashCanvas'), ext, 14, 44, 14);
  drawBase(v, { density: true }); drawSel(v, state.sel); drawCities(v);
}
function busiestDay() {
  const R = state.R; let best = D.nDays - 1, bv = -1;
  for (let d = 0; d < D.nDays; d++) if (R.dSum[d] > bv) { bv = R.dSum[d]; best = d; }
  return best;
}

/* weekly charts: one chart per category, one line per period (darker toward 2026) */
function renderLegend() {
  $('periodLegend').innerHTML = `<span class="label">Periods</span>` + PERIODS.map((p, i) => `<button class="pl${state.hidden.has(p) ? ' off' : ''}" data-p="${p}" aria-pressed="${!state.hidden.has(p)}"><i style="background:${PCOL[i]}"></i>${PLABEL(p)}</button>`).join('')
    + `<span class="footer-note">Click to show or hide a period</span>`;
}
$('periodLegend').addEventListener('click', e => {
  const b = e.target.closest('.pl'); if (!b) return;
  const p = b.dataset.p; state.hidden.has(p) ? state.hidden.delete(p) : state.hidden.add(p);
  if (state.hidden.size === PERIODS.length) state.hidden.delete(p);
  renderLegend(); renderWeekly();
});
const CW = 440, CH = 210, CL = 44, CR = 10, CT = 12, CB = 34;
function renderWeekly() {
  const shown = METRICS.filter(m => m.key === state.metric);
  $('weekly').innerHTML = shown.map(m => {
    const mi = METRICS.indexOf(m), G = weeklyFor(m.key);
    return `<p class="metric-desc"><b>${m.title}</b> — ${m.desc}</p><div class="graph-grid">` + G.map((g, ci) => chartCard(m, mi, ci, g)).join('') + '</div>';
  }).join('');
  $('weekly').querySelectorAll('.chart').forEach(bindChart);
}
function chartCard(m, mi, ci, g) {
  const vis = PERIODS.filter(p => !state.hidden.has(p));
  const yMax = niceMax(Math.max(0, ...vis.flatMap(p => g.data[p].filter(v => v != null))));
  const x = w => CL + (w - 1) * (CW - CL - CR) / 51, y = v => CT + (1 - v / yMax) * (CH - CT - CB);
  const lines = PERIODS.map((p, pi) => {
    if (state.hidden.has(p)) return '';
    const vals = g.data[p]; let d = '', pen = false;
    vals.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
    const lone = vals.map((v, i) => v != null && vals[i - 1] == null && vals[i + 1] == null ? `<circle cx="${x(i + 1)}" cy="${y(v)}" r="2" fill="${PCOL[pi]}"/>` : '').join('');
    return `<path d="${d}" stroke="${PCOL[pi]}" class="ln"/>${lone}`;
  }).join('');
  const total = PERIODS.reduce((s, p) => s + g.n[p], 0);
  return `<div class="card chart" data-m="${m.key}" data-c="${ci}">
    <div class="chart-title"><span><span class="num">${mi * 4 + ci + 1}</span>${CATS[ci]}</span><small>${CAT_NOTE[ci]} · ${m.unit} · ${nf(total, 0)} ${m.nUnit}</small></div>
    <svg viewBox="0 0 ${CW} ${CH}" role="img" aria-label="${m.title}, ${CATS[ci]}, weeks 1 to 52 by period">
      ${[0, .5, 1].map(t => `<line class="gl" x1="${CL}" x2="${CW - CR}" y1="${y(yMax * t)}" y2="${y(yMax * t)}"/><text class="ax" x="${CL - 6}" y="${y(yMax * t) + 3.5}" text-anchor="end">${tickFmt(yMax * t)}</text>`).join('')}
      ${[1, 9, 18, 26, 35, 44, 52].map(w => `<text class="ax" x="${x(w)}" y="${CH - 18}" text-anchor="middle">${w}</text>`).join('')}
      <text class="ax" x="${(CL + CW - CR) / 2}" y="${CH - 3}" text-anchor="middle">Week of year (1–52)</text>
      ${total ? '' : `<text class="ax" x="${(CL + CW) / 2}" y="${CH / 2 - 6}" text-anchor="middle">No observations in this area</text>`}
      ${lines}
      <line class="xh" y1="${CT}" y2="${CH - CB}" style="display:none"/>
      <rect class="hb" x="${CL}" y="0" width="${CW - CL - CR}" height="${CH - CB}" fill="transparent"/>
    </svg></div>`;
}
function bindChart(el) {
  const svg = el.querySelector('svg'), xh = svg.querySelector('.xh');
  const m = METRICS.find(q => q.key === el.dataset.m), ci = +el.dataset.c, g = weeklyFor(m.key)[ci];
  const hb = svg.querySelector('.hb');
  hb.addEventListener('mousemove', e => {
    const r = svg.getBoundingClientRect(), sx = (e.clientX - r.left) / r.width * CW;
    const w = Math.max(1, Math.min(52, Math.round((sx - CL) / (CW - CL - CR) * 51) + 1)), xx = CL + (w - 1) * (CW - CL - CR) / 51;
    xh.setAttribute('x1', xx); xh.setAttribute('x2', xx); xh.style.display = '';
    const rows = PERIODS.map((p, pi) => state.hidden.has(p) ? '' : `<div class="trow"><i style="background:${PCOL[pi]}"></i>${PLABEL(p)}<b>${g.data[p][w - 1] == null ? '–' : nf(g.data[p][w - 1], 2)}</b></div>`).join('');
    showTip(`<b>${CATS[ci]} · Week ${w}</b><br><span class="mut">${weekRange(w)} · ${m.unit}</span>${rows}`, e);
  });
  hb.addEventListener('mouseleave', () => { xh.style.display = 'none'; hideTip(); });
}

/* calendars: ±7 days, ±1 month, year — value = mean FRP of the fire pixels that day (0 if none) */
function dayVal(di) {
  if (di < 0 || di >= D.nDays) return undefined;
  const R = state.R; return { v: R.dValid[di] ? R.dSum[di] / R.dValid[di] : 0, act: R.dActive[di], valid: R.dValid[di] };
}
let cMin = .1, cMax = 1;
const calColor = v => v == null || v <= 0 ? null : ramp(Math.log(Math.max(v, cMin) / cMin) / Math.log(cMax / cMin));
function addMonths(di, k) {
  const dt = dateOfIdx(di), m = dt.getUTCMonth() + k, d = dt.getUTCDate();
  const yy = dt.getUTCFullYear() + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  return dayIdx(yy, mm + 1, Math.min(d, daysIn(yy, mm + 1)));
}
function cellHTML(di, extra = '') {
  const v = dayVal(di);
  if (v === undefined) return di >= D.nDays ? `<i class="c pending${extra}" data-di="${di}"></i>` : `<i class="c nodata${extra}" data-di="${di}"></i>`;
  const col = calColor(v.v);
  return `<i class="c${di === state.date ? ' sel' : ''}${extra}" data-di="${di}"${col ? ` style="background:${col}"` : ''} tabindex="0" role="button" aria-label="${fmtDate(dateOfIdx(di))}"></i>`;
}
function weekGrid(a, b) {
  // columns = weeks, rows = Sun–Sat
  const startDow = dateOfIdx(a).getUTCDay(), nCols = Math.ceil((startDow + (b - a + 1)) / 7);
  const cols = [], months = []; let lastM = -1;
  for (let col = 0; col < nCols; col++) {
    const cells = [];
    for (let row = 0; row < 7; row++) { const di = a - startDow + col * 7 + row; cells.push(di < a || di > b ? '<i class="c void"></i>' : cellHTML(di)); }
    cols.push(`<div class="wg-col" style="grid-column:${col + 2};grid-row:1">${cells.join('')}</div>`);
    const first = Math.max(a - startDow + col * 7, a), dt = dateOfIdx(first);
    if ((col === 0 || dt.getUTCDate() <= 7) && dt.getUTCMonth() !== lastM) { lastM = dt.getUTCMonth(); months.push(`<span style="grid-column:${col + 2}">${MON[lastM]}</span>`); }
  }
  const tpl = `grid-template-columns:28px repeat(${nCols},minmax(0,1fr))`;
  const pc = Math.ceil((D.nDays - (a - startDow)) / 7); // first fully pending week column
  const pending = b >= D.nDays && pc < nCols - 1 ? `<div class="wg-pending" style="grid-column:${pc + 2} / ${nCols + 2};grid-row:1">To be updated</div>` : '';
  return `<div class="wg-months" style="${tpl}">${months.join('')}</div><div class="wg" style="${tpl}"><div class="wg-days" style="grid-column:1;grid-row:1"><span>Sun</span><span></span><span>Tue</span><span></span><span>Thu</span><span></span><span>Sat</span></div>${cols.join('')}${pending}</div>`;
}
function renderCalendars() {
  const c = state.date, dt = dateOfIdx(c), y = dt.getUTCFullYear();
  const yA = dayIdx(y, 1, 1), yB = dayIdx(y, 12, 31); // always a full year so cell size never changes
  const mA = addMonths(c, -1), mB = addMonths(c, 1);
  const vals = [];
  for (let d = Math.min(yA, mA, c - 7); d <= Math.max(yB, mB, c + 7); d++) { const v = dayVal(d); if (v && v.v > 0) vals.push(v.v); }
  vals.sort((p, q) => p - q);
  cMax = vals.length ? vals[vals.length - 1] : 1; cMin = vals.length ? Math.max(cMax / 1e4, quantile(vals, .05)) : .1; if (cMax <= cMin) cMax = cMin * 10;
  $('dateInput').value = isoIdx(c);
  $('calWeek').innerHTML = `<div class="strip">${Array.from({ length: 15 }, (_, i) => cellHTML(c - 7 + i, ' big')).join('')}</div>
    <div class="heat-axis"><span>${md(dateOfIdx(c - 7))} · −7 days</span><span><b>${md(dt)}</b> · selected</span><span>+7 days · ${md(dateOfIdx(c + 7))}</span></div>`;
  $('calMonth').innerHTML = weekGrid(mA, mB) + `<div class="heat-axis"><span>${fmtDate(dateOfIdx(mA))}</span><span>${fmtDate(dateOfIdx(mB))}</span></div>`;
  $('calYearTitle').textContent = `Year ${y}${yB >= D.nDays ? ` · data through ${fmtDate(dateOfIdx(D.nDays - 1))}, later dates to be updated` : ''}`;
  $('calYear').innerHTML = weekGrid(yA, yB);
  $('calLegend').innerHTML = `<span><b>Colour: mean FRP of fire pixels per day</b> (MW, log scale, shared by all three calendars)</span><span><i class="zero"></i>0 / no measurement</span><span>${tickFmt(+cMin.toPrecision(2))}</span><span class="ramp" style="background:linear-gradient(90deg,${[0, .25, .5, .75, 1].map(ramp).join(',')})"></span><span>${nf(cMax, 0)} MW</span><span><i class="pd"></i>to be updated</span><span><i class="nd"></i>before data start</span>`;
}
const calSec = $('calendarSec');
calSec.addEventListener('mousemove', e => {
  const t = e.target.closest('.c'); if (!t || t.classList.contains('void')) return hideTip();
  const di = +t.dataset.di, v = dayVal(di);
  if (v === undefined) return showTip(`<b>${fmtDate(dateOfIdx(di))}</b><br><span class="mut">${di >= D.nDays ? `To be updated — data currently runs through ${fmtDate(dateOfIdx(D.nDays - 1))}` : 'Before the start of the data'}</span>`, e);
  showTip(`<b>${fmtDate(dateOfIdx(di))}</b><br>Mean FRP: <b>${nf(v.v, 2)} MW</b>${v.act ? '' : ' <span class="mut">(no fire pixels → 0)</span>'}<br>Fire pixels: <b>${nf(v.act, 0)}</b>${v.act !== v.valid ? ` <span class="mut">(${nf(v.act - v.valid, 0)} without calibrated FRP)</span>` : ''}<br><span class="mut">Click to select</span>`, e);
});
calSec.addEventListener('mouseleave', hideTip);
function pickFrom(e) {
  const t = e.target.closest('.c'); if (!t || t.classList.contains('void') || t.classList.contains('nodata') || t.classList.contains('pending')) return false;
  state.date = +t.dataset.di; renderCalendars(); return true;
}
calSec.addEventListener('click', pickFrom);
calSec.addEventListener('keydown', e => { if (e.target.classList && e.target.classList.contains('c') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (pickFrom(e) && e.key === 'Enter') location.hash = '#/activity'; } });
$('dateInput').addEventListener('change', e => {
  const [y, m, d] = e.target.value.split('-').map(Number); if (!y) return;
  const di = dayIdx(y, m, d); if (di < 0 || di >= D.nDays) { renderCalendars(); return; }
  state.date = di; renderCalendars();
});
$('goActivity').onclick = () => { if (state.date != null) location.hash = '#/activity'; };

/* supporting charts */
function renderMissing() {
  const R = state.R, el = $('missChart'), W = Math.max(320, el.clientWidth || 700), H = 150, L = 46, Rr = 6, T = 18, B = 24;
  const n = new Uint32Array(NY), miss = new Uint32Array(NY);
  for (let d = 0; d < D.nDays; d++) { const k = D.dYear[d] - Y0; n[k] += R.dActive[d]; miss[k] += R.dActive[d] - R.dValid[d]; }
  const data = Array.from({ length: NY }, (_, i) => ({ year: Y0 + i, n: n[i], miss: miss[i], r: n[i] ? miss[i] / n[i] * 100 : 0 }));
  const yMax = niceMax(Math.max(1, ...data.map(d => d.r)) * 1.15), bw = (W - L - Rr) / NY, y = v => T + (1 - v / yMax) * (H - T - B), w = Math.max(3, bw - 5);
  el.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" height="${H}">
    ${[0, yMax].map(t => `<line class="grid" x1="${L}" x2="${W - Rr}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${tickFmt(t)}%</text>`).join('')}
    ${data.map((d, i) => { const bx = L + i * bw + 2.5; return `<rect class="bar-miss" x="${bx}" y="${y(d.r)}" width="${w}" height="${Math.max(0, y(0) - y(d.r))}" rx="2"/>${d.r > 0 ? `<text class="lbl" x="${bx + w / 2}" y="${y(d.r) - 4}" text-anchor="middle">${nf(d.r, 1)}</text>` : ''}
      <text class="axis" x="${bx + w / 2}" y="${H - 7}" text-anchor="middle">${W < 600 && i % 2 ? '' : "'" + String(d.year).slice(2)}</text><rect class="hit" x="${L + i * bw}" y="0" width="${bw}" height="${H - B}" data-i="${i}"/>`; }).join('')}
  </svg>`;
  el.querySelectorAll('.hit').forEach(r => { const d = data[+r.dataset.i];
    r.addEventListener('mousemove', e => showTip(`<b>${d.year}</b><br>Pixel-dates without calibrated FRP: <b>${nf(d.miss, 0)} / ${nf(d.n, 0)}</b> (${nf(d.r, 2)}%)`, e));
    r.addEventListener('mouseleave', hideTip); });
}
function renderCounts() {
  const R = state.R, el = $('countChart'), W = Math.max(320, el.clientWidth || 700), H = 220, L = 46, Rr = 6, T = 20, B = 26;
  const data = Array.from({ length: NY }, (_, i) => ({ year: Y0 + i, c: [0, 0, 0] }));
  for (const e of R.evList) { const d = D.eDay[e]; if (d < D.nDays) data[D.dYear[d] - Y0].c[D.ecls[e]]++; }
  data.forEach(d => { d.all = d.c[0] + d.c[1] + d.c[2]; });
  const mx = Math.max(1, ...data.map(d => d.all)), yMax = niceMax(mx), bw = (W - L - Rr) / NY, y = v => T + (1 - v / yMax) * (H - T - B), w = Math.max(3, bw - 5);
  $('countLegend').innerHTML = [0, 1, 2].map(k => `<span><i style="width:11px;height:11px;border-radius:2px;background:${CLS_COL[k]}"></i>${CATS[k + 1]}</span>`).join('');
  el.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" height="${H}">
    ${[0, .5, 1].map(t => `<line class="grid" x1="${L}" x2="${W - Rr}" y1="${y(yMax * t)}" y2="${y(yMax * t)}"/><text class="axis" x="${L - 6}" y="${y(yMax * t) + 4}" text-anchor="end">${nf(yMax * t, 0)}</text>`).join('')}
    ${data.map((d, i) => { const bx = L + i * bw + 2.5; let acc = 0, s = '';
      [2, 1, 0].forEach(k => { const v = d.c[k]; if (!v) return; const y0 = y(acc), y1 = y(acc + v); s += `<rect x="${bx}" y="${y1}" width="${w}" height="${Math.max(1, y0 - y1 - (acc ? 2 : 0))}" rx="2" fill="${CLS_COL[k]}"${d.year === Y1 ? ' opacity=".6"' : ''}/>`; acc += v; });
      return s + `${d.all === mx ? `<text class="lbl" x="${bx + w / 2}" y="${y(d.all) - 5}" text-anchor="middle">${nf(d.all, 0)}</text>` : ''}<text class="axis" x="${bx + w / 2}" y="${H - 8}" text-anchor="middle">${W < 600 && i % 2 ? '' : "'" + String(d.year).slice(2)}</text><rect class="hit" x="${L + i * bw}" y="0" width="${bw}" height="${H - B}" data-i="${i}"/>`; }).join('')}
  </svg>`;
  el.querySelectorAll('.hit').forEach(r => { const d = data[+r.dataset.i];
    r.addEventListener('mousemove', e => showTip(`<b>Events starting in ${d.year}</b>${d.year === Y1 ? ' <span class="mut">(Jan–Aug)</span>' : ''}<br>All: <b>${nf(d.all, 0)}</b><br>Extreme: <b>${nf(d.c[0], 0)}</b><br>Large: <b>${nf(d.c[1], 0)}</b><br>Small: <b>${nf(d.c[2], 0)}</b>`, e));
    r.addEventListener('mouseleave', hideTip); });
  $('countNote').textContent = 'These are events detected and assembled in the integrated dataset, not official wildfire counts. Events touching the selected area are counted once, by the year of their first observation.';
}
function renderNotes() {
  $('notesBody').innerHTML = `<ul>
  <li>Source: <code>california_500m_2006_2026_with_event_id_and_size.csv</code> (${nf(D.rows, 0)} rows, ${D.firstDate} – ${D.lastDate}). Columns used: time_utc, grid_x, grid_y, latitude, longitude, integrated_modis_equiv_index_mw, event_id, fire_size_class.</li>
  <li>Area filter: only pixels whose latitude/longitude fall inside the selected area. Duration and grid-cell graphs use events with at least one pixel inside the area, with whole-event values.</li>
  <li>Size classes are the fire_size_class values (Extreme, Large, Small); All combines the three. Each pixel-date takes the class of its most frequent event_id.</li>
  <li>grid_fire_event_summary.csv.gz was not available, so the event table is derived from the same file: first_observation_utc = first time_utc, duration_days = (last − first observation) in days, unique_grid_cells = distinct (grid_x, grid_y).</li>
  <li>Weeks: 7-day blocks from 1 January; the remaining 1–2 days go into week 52. Weekly values are computed within each year first, then years are averaged with equal weight (years with no value that week are skipped). 2026 has data through ${D.lastDate} only.</li>
  <li>Missing integrated_modis_equiv_index_mw values stay missing (not 0, not replaced by viirs_native_mw). In the calendars, a day without any FRP measurement counts as 0.</li></ul>`;
}

/* ======================= 4. burning activity ======================= */
function climoDay(m, d, skipYear) {
  const vals = [];
  for (let y = 2016; y <= 2025; y++) { if (y === skipYear || d > daysIn(y, m)) continue; const v = dayVal(dayIdx(y, m, d)); if (v) vals.push(v.v); }
  vals.sort((a, b) => a - b);
  return { med: quantile(vals, .5), p10: quantile(vals, .1), p90: quantile(vals, .9), n: vals.length };
}
async function enterActivity() {
  if (!D) { busy(true, 'Loading observation data…'); await loadCore(); }
  if (!state.R) { busy(true, 'Calculating the selected area…'); await nextFrame(); state.R = computeRegion(); }
  busy(false);
  const c = state.date, days = Array.from({ length: 15 }, (_, i) => c + i - 7);
  const exts = { sel: padExt(state.sel.bbox, .15, 60), ca: padExt(CA.bbox, .02) };
  const frames = days.map(di => {
    const fr = { di, nodata: di < 0 || di >= D.nDays, x: [], y: [], f: [], inn: [] };
    if (fr.nodata) return fr;
    for (let i = D.dayStart[di]; i < D.dayStart[di + 1]; i++) { const ci = D.cid[i]; fr.x.push(D.cx[ci]); fr.y.push(D.cy[ci]); fr.f.push(D.frp[i]); fr.inn.push(state.R.inC[ci]); }
    return fr;
  });
  let vals = frames.flatMap(f => f.f.filter((v, k) => f.inn[k] && v === v && v > 0));
  if (!vals.length) vals = frames.flatMap(f => f.f.filter(v => v === v && v > 0));
  vals.sort((a, b) => a - b);
  const hi = vals.length ? vals[vals.length - 1] : 10, lo = vals.length ? Math.max(.01, quantile(vals, .02)) : .1;
  state.win = { days, frames, exts, lo, hi: Math.max(hi, lo * 10) }; state.aDay = 7;
  const p = state.place;
  $('actCrumb').textContent = `${p.name} / Fire Radiative Power`;
  $('actSub').textContent = `${fmtDate(dateOfIdx(c))} ± 7 days · ${state.sel.label}`;
  $('frpLabels').innerHTML = [state.win.hi, Math.sqrt(state.win.hi * state.win.lo), state.win.lo].map(v => `<span>${tickFmt(+v.toPrecision(2))}</span>`).join('');
  $('tlStart').textContent = fmtDate(dateOfIdx(days[0])); $('tlMid').textContent = fmtDate(dateOfIdx(c)) + ' (selected)'; $('tlEnd').textContent = fmtDate(dateOfIdx(days[14]));
  drawActivity(); renderMini();
}
function drawActivity() {
  const W = state.win; if (!W || route() !== 'activity') return;
  const v = fitView($('actCanvas'), W.exts[state.extent], 20, 60, 50), c = v.ctx;
  drawBase(v, {});
  const f = W.frames[state.aDay], cs = Math.max(1.6, v.s), lg = Math.log(W.hi / W.lo);
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < f.x.length; i++) {
    if ((pass === 0) === !!f.inn[i]) continue; // outside first (faded), inside on top
    const px = v.X(f.x[i]) - cs / 2, py = v.Y(f.y[i]) - cs / 2; if (px < -cs || py < -cs || px > v.W || py > v.H) continue;
    c.globalAlpha = f.inn[i] ? 1 : .28; const val = f.f[i];
    if (val !== val) { c.fillStyle = '#fff'; c.fillRect(px, py, cs, cs); c.strokeStyle = '#6b5b55'; c.lineWidth = 1; c.strokeRect(px, py, cs, cs); }
    else { c.fillStyle = ramp(Math.log(Math.max(val, W.lo) / W.lo) / lg); c.fillRect(px, py, cs, cs); }
  }
  c.globalAlpha = 1;
  drawSel(v, state.sel, { fill: false }); drawCities(v);
  const km = [1, 2, 5, 10, 20, 50, 100, 200].find(k => k * 2 * v.s >= 70) || 200, len = km * 2 * v.s;
  c.fillStyle = '#31201c'; c.fillRect(v.W - 24 - len, v.H - 30, len, 3); c.font = '11px DM Sans, sans-serif'; c.fillText(`${km} km`, v.W - 24 - len, v.H - 36);
  let nIn = 0, miss = 0; f.inn.forEach((k, i) => { if (k) { nIn++; if (f.f[i] !== f.f[i]) miss++; } });
  $('mapDate').innerHTML = `${fmtDate(dateOfIdx(f.di))}${state.aDay === 7 ? ' · selected' : ''} &nbsp;·&nbsp; ${f.nodata ? 'no data' : `${nf(nIn, 0)} fire pixels in area${miss ? ` (${miss} uncalibrated)` : ''}`}`;
  $('daySlider').value = state.aDay; drawMiniCursor();
}
function setDay(i) { state.aDay = (i + 15) % 15; drawActivity(); }
$('daySlider').addEventListener('input', e => { stopPlay(); setDay(+e.target.value); });
$('prevBtn').onclick = () => { stopPlay(); setDay(state.aDay - 1); };
$('nextBtn').onclick = () => { stopPlay(); setDay(state.aDay + 1); };
$('playBtn').onclick = () => state.playing ? stopPlay() : startPlay();
function startPlay() { state.playing = setInterval(() => setDay(state.aDay + 1), 700); $('playBtn').textContent = 'Pause'; }
function stopPlay() { clearInterval(state.playing); state.playing = null; $('playBtn').textContent = 'Play'; }
let miniX = null;
function renderMini() {
  const W = state.win, el = $('miniChart'), w = Math.max(320, el.clientWidth || 900), H = 190, L = 56, R = 12, T = 12, B = 28;
  const sy = dateOfIdx(state.date).getUTCFullYear();
  const pts = W.days.map(di => { const dt = dateOfIdx(di), v = dayVal(di); return { dt, v: v ? v.v : null, c: climoDay(dt.getUTCMonth() + 1, dt.getUTCDate(), sy) }; });
  const yMax = niceMax(Math.max(1e-6, ...pts.map(p => Math.max(p.v || 0, p.c.p90 || 0))));
  const x = i => L + i * (w - L - R) / 14, y = v => T + (1 - v / yMax) * (H - T - B);
  const band = pts.map((p, i) => p.c.p90 != null ? `${x(i)},${y(p.c.p90)}` : null).filter(Boolean).join(' ') + ' ' + pts.map((p, i) => p.c.p10 != null ? `${x(i)},${y(p.c.p10)}` : null).filter(Boolean).reverse().join(' ');
  const line = k => { let d = '', pen = false; pts.forEach((p, i) => { const v = k(p); if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`; pen = true; }); return d; };
  $('miniTitle').textContent = '15-day FRP trend in the selected area — daily mean FRP of fire pixels (MW)';
  $('miniYear').textContent = String(sy);
  el.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${w} ${H}" height="${H}">
    ${[0, .5, 1].map(t => `<line class="grid" x1="${L}" x2="${w - R}" y1="${y(yMax * t)}" y2="${y(yMax * t)}"/><text class="axis" x="${L - 6}" y="${y(yMax * t) + 4}" text-anchor="end">${tickFmt(yMax * t)}</text>`).join('')}
    <polygon class="band" points="${band}"/><path class="med" d="${line(p => p.c.med)}"/><path class="cur" d="${line(p => p.v)}"/>
    ${pts.map((p, i) => p.v != null ? `<circle class="curdot" cx="${x(i)}" cy="${y(p.v)}" r="${i === 7 ? 4.5 : 3}"/>` : '').join('')}
    ${pts.map((p, i) => i % 2 === 0 || i === 7 ? `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="middle"${i === 7 ? ' style="font-weight:800;fill:var(--ink)"' : ''}>${md(p.dt)}</text>` : '').join('')}
    <line class="now" id="miniNow" y1="${T}" y2="${H - B}"/>
    ${pts.map((p, i) => `<rect class="hit" data-i="${i}" x="${x(i) - (w - L - R) / 28}" y="0" width="${(w - L - R) / 14}" height="${H - B}"/>`).join('')}
  </svg>`;
  miniX = x;
  el.querySelectorAll('.hit').forEach(r => {
    const p = pts[+r.dataset.i];
    r.addEventListener('mousemove', e => showTip(`<b>${fmtDate(p.dt)}</b><br>${sy}: <b>${p.v == null ? 'no data' : nf(p.v, 2) + ' MW'}</b><br><span class="mut">Normal (2016–2025${sy >= 2016 && sy <= 2025 ? `, excl. ${sy}` : ''}) median ${nf(p.c.med, 2)} · 10–90th ${nf(p.c.p10, 2)}–${nf(p.c.p90, 2)} · ${p.c.n} years</span>`, e));
    r.addEventListener('mouseleave', hideTip);
    r.addEventListener('click', () => { stopPlay(); setDay(+r.dataset.i); });
  });
  drawMiniCursor();
}
function drawMiniCursor() { const l = $('miniNow'); if (l && miniX) { const xx = miniX(state.aDay); l.setAttribute('x1', xx); l.setAttribute('x2', xx); } }

/* ======================= controls & global ======================= */
chips($('metricChips'), [{ v: 'frp', t: 'Weekly mean FRP' }, { v: 'duration', t: 'Duration per event' }, { v: 'cells', t: 'Grid cells per event' }], () => state.metric, v => { state.metric = v; renderWeekly(); });
chips($('extentChips'), [{ v: 'sel', t: 'Selected area' }, { v: 'ca', t: 'All California' }], () => state.extent, v => { state.extent = v; drawActivity(); });
$('downloadBtn').onclick = () => {
  if (!state.R) { alert('Select a region and an area first.'); return; }
  const R = state.R, lines = ['date,mean_frp_mw,fire_pixels,calibrated_pixels,frp_sum_mw'];
  for (let d = 0; d < D.nDays; d++) if (R.dActive[d]) lines.push(`${isoIdx(d)},${R.dValid[d] ? (R.dSum[d] / R.dValid[d]).toFixed(4) : 0},${R.dActive[d]},${R.dValid[d]},${R.dSum[d].toFixed(3)}`);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `frp_daily_${state.place.name.replace(/\s+/g, '_')}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
let rT = null;
addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(() => {
  const s = route(); if (s === 'region') drawRegion();
  if (s === 'dashboard' && state.R) { drawDashMap(); renderCounts(); renderMissing(); }
  if (s === 'activity' && state.win) { drawActivity(); renderMini(); }
}, 120); });

loadCore();
render();
})();
