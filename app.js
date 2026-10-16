// Closet — a digital wardrobe that stores everything locally in IndexedDB.

const CATEGORIES = [
  { id: 'shirts', label: 'Shirts' },
  { id: 'pants', label: 'Pants' },
  { id: 'coats', label: 'Coats' },
  { id: 'shoes', label: 'Shoes' },
  { id: 'dresses', label: 'Dresses' },
  { id: 'skirts', label: 'Skirts' },
];
const catLabel = id => CATEGORIES.find(c => c.id === id)?.label ?? id;

// ---------- storage ----------
const DB_NAME = 'closet-db';
const STORE = 'items';
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
const getAll = () => tx('readonly', s => s.getAll());
const putItem = item => tx('readwrite', s => s.put(item));
const deleteItem = id => tx('readwrite', s => s.delete(id));

// ---------- state ----------
let items = [];
let filter = 'all';
let currentId = null; // item open in detail view
let editingId = null; // item open in editor
let pendingPhoto = null;

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (n == null || n === '' || isNaN(n)) ? '—' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const todayStr = () => toDateStr(new Date());
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
const fmtDate = s => parseDate(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
function daysAgo(s) { return Math.round((parseDate(todayStr()) - parseDate(s)) / 86400000); }
function relDays(s) {
  const n = daysAgo(s);
  return n === 0 ? 'today' : n === 1 ? 'yesterday' : n < 0 ? fmtDate(s) : n < 60 ? `${n}d ago` : `${Math.round(n / 30)}mo ago`;
}
function shortAgo(s) {
  const n = daysAgo(s);
  return n <= 0 ? 'today' : n < 60 ? `${n}d` : `${Math.round(n / 30)}mo`;
}
const lastWorn = item => item.wears.length ? item.wears.reduce((a, b) => (a > b ? a : b)) : null;
const itemName = item => [item.color, item.brand, item.style].filter(Boolean).join(' ') || catLabel(item.category).replace(/s$/, '');
const costPerWear = item => (item.price && item.wears.length) ? item.price / item.wears.length : null;
const uid = () => (crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2200);
}

// ---------- closet view ----------
function renderFilters() {
  const counts = Object.fromEntries(CATEGORIES.map(c => [c.id, 0]));
  items.forEach(i => counts[i.category]++);
  const chips = [{ id: 'all', label: 'All', n: items.length }, ...CATEGORIES.map(c => ({ ...c, n: counts[c.id] }))];
  $('#filters').innerHTML = chips.map(c =>
    `<button class="chip ${filter === c.id ? 'active' : ''}" data-cat="${c.id}" aria-pressed="${filter === c.id}">${c.label}<span class="n">${c.n}</span></button>`
  ).join('');
}

function renderGrid() {
  const q = $('#search').value.trim().toLowerCase();
  const sort = $('#sort').value;
  let list = items.filter(i => filter === 'all' || i.category === filter);
  if (q) {
    list = list.filter(i => [i.brand, i.style, i.color, i.size, i.material, catLabel(i.category)]
      .some(v => String(v ?? '').toLowerCase().includes(q)));
  }
  const sorters = {
    recent: (a, b) => b.createdAt - a.createdAt,
    most: (a, b) => b.wears.length - a.wears.length,
    least: (a, b) => a.wears.length - b.wears.length,
    lastworn: (a, b) => (lastWorn(b) ?? '').localeCompare(lastWorn(a) ?? ''),
    price: (a, b) => (b.price ?? 0) - (a.price ?? 0),
  };
  list.sort(sorters[sort]);

  $('#empty').hidden = items.length > 0;
  if (!items.length) { $('#grid').innerHTML = ''; return; }
  if (!list.length) { $('#grid').innerHTML = `<p class="muted">No items match.</p>`; return; }

  $('#grid').innerHTML = list.map(i => {
    const lw = lastWorn(i);
    const badges = [i.onSale && 'On sale', i.altered && 'Altered'].filter(Boolean);
    return `<article class="card" data-id="${i.id}" tabindex="0">
      <img class="card-img" src="${i.photo || ''}" alt="${esc(itemName(i))}" loading="lazy" />
      <div class="card-body">
        <div class="card-title">${esc(itemName(i))}</div>
        <div class="card-sub">${esc(catLabel(i.category))}${i.size ? ' · Size ' + esc(i.size) : ''}</div>
        ${badges.length ? `<div class="badges">${badges.map(b => `<span class="badge">${b}</span>`).join('')}</div>` : ''}
        <div class="card-foot">
          <span title="${lw ? 'Last worn ' + fmtDate(lw) : 'Never worn'}">${i.wears.length}×${lw ? ' · ' + shortAgo(lw) : ' · never'}</span>
          <button class="quick-log" data-log="${i.id}" title="Log a wear today" aria-label="Log a wear today">+ Wore it</button>
        </div>
      </div>
    </article>`;
  }).join('');
}

function renderAll() {
  renderFilters();
  renderGrid();
  if (!$('#view-insights').hidden) renderInsights();
}

// ---------- logging wears ----------
async function logWear(id, date = todayStr()) {
  const item = items.find(i => i.id === id);
  item.wears.push(date);
  item.wears.sort();
  await putItem(item);
  toast(`Logged wear for ${itemName(item)} · ${fmtDate(date)}`);
  renderAll();
  if (currentId === id) renderDetail();
}

async function removeWear(id, index) {
  const item = items.find(i => i.id === id);
  item.wears.splice(index, 1);
  await putItem(item);
  renderAll();
  renderDetail();
}

// ---------- editor ----------
const form = $('#editorForm');
form.category.innerHTML = CATEGORIES.map(c => `<option value="${c.id}">${c.label.replace(/s$/, '')}</option>`).join('');

function setPhoto(src) {
  pendingPhoto = src;
  $('#photoPreview').src = src || '';
  $('#photoPreview').hidden = !src;
  $('#photoHint').hidden = !!src;
}

function openEditor(id = null) {
  editingId = id;
  const item = id ? items.find(i => i.id === id) : null;
  form.reset();
  $('#editorTitle').textContent = item ? 'Edit item' : 'Add item';
  $('#deleteBtn').hidden = !item;
  form.category.value = item?.category ?? (filter !== 'all' ? filter : 'shirts');
  for (const k of ['brand', 'style', 'color', 'size', 'material', 'alterationNotes']) form[k].value = item?.[k] ?? '';
  form.price.value = item?.price ?? '';
  form.onSale.checked = !!item?.onSale;
  form.altered.checked = !!item?.altered;
  $('#alterNotesWrap').hidden = !form.altered.checked;
  setPhoto(item?.photo ?? null);
  $('#editor').showModal();
}
window.openEditor = openEditor;

// Downscale photos so storage stays small and the closet loads fast.
function resizeImage(file, max = 900) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function handlePhotoFile(file) {
  if (!file || !file.type.startsWith('image/')) return toast('Please choose an image file');
  try { setPhoto(await resizeImage(file)); }
  catch { toast('Could not read that image (try JPG or PNG)'); }
}

$('#photoInput').addEventListener('change', e => handlePhotoFile(e.target.files[0]));
const drop = $('#photoDrop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); handlePhotoFile(e.dataTransfer.files[0]); });
form.altered.addEventListener('change', () => ($('#alterNotesWrap').hidden = !form.altered.checked));

form.addEventListener('submit', async e => {
  e.preventDefault();
  const existing = editingId ? items.find(i => i.id === editingId) : null;
  const price = form.price.value === '' ? null : Number(form.price.value);
  const item = {
    id: existing?.id ?? uid(),
    createdAt: existing?.createdAt ?? Date.now(),
    wears: existing?.wears ?? [],
    photo: pendingPhoto,
    category: form.category.value,
    brand: form.brand.value.trim(),
    style: form.style.value.trim(),
    color: form.color.value.trim(),
    size: form.size.value.trim(),
    material: form.material.value.trim(),
    price,
    onSale: form.onSale.checked,
    altered: form.altered.checked,
    alterationNotes: form.altered.checked ? form.alterationNotes.value.trim() : '',
  };
  await putItem(item);
  if (existing) Object.assign(existing, item); else items.push(item);
  $('#editor').close();
  toast(existing ? 'Saved changes' : 'Added to your closet');
  renderAll();
  if (currentId === item.id) renderDetail();
});

// Two-step delete (click once to arm, again to confirm).
$('#deleteBtn').addEventListener('click', async e => {
  const btn = e.currentTarget;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Click again to delete';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete'; }, 3000);
    return;
  }
  delete btn.dataset.armed;
  btn.textContent = 'Delete';
  await deleteItem(editingId);
  items = items.filter(i => i.id !== editingId);
  $('#editor').close();
  if ($('#detail').open) $('#detail').close();
  toast('Item deleted');
  renderAll();
});

// ---------- detail ----------
function openDetail(id) {
  currentId = id;
  $('#wearDate').value = todayStr();
  $('#wearDate').max = todayStr();
  $('#detail').showModal();
  renderDetail();
}

function renderDetail() {
  const item = items.find(i => i.id === currentId);
  if (!item) return;
  $('#detailTitle').textContent = itemName(item);
  $('#detailPhoto').src = item.photo || '';
  $('#detailPhoto').alt = itemName(item);
  const rows = [
    ['Type', catLabel(item.category).replace(/s$/, '')],
    ['Brand', item.brand], ['Style', item.style], ['Color', item.color], ['Size', item.size],
    ['Material', item.material],
    ['Price', item.price != null ? money(item.price) : ''],
    ['On sale', item.onSale ? 'Yes' : 'No'],
    ['Altered', item.altered ? ('Yes' + (item.alterationNotes ? ` — ${item.alterationNotes}` : '')) : 'No'],
  ];
  $('#detailFields').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v ? esc(v) : '<span class="muted">—</span>'}</dd>`).join('');
  const lw = lastWorn(item);
  const cpw = costPerWear(item);
  $('#detailStats').innerHTML = `
    <div class="mini-stat"><div class="v">${item.wears.length}</div><div class="l">Times worn</div></div>
    <div class="mini-stat"><div class="v">${lw ? relDays(lw) : '—'}</div><div class="l">Last worn</div></div>
    <div class="mini-stat"><div class="v">${cpw != null ? money(cpw) : '—'}</div><div class="l">Cost per wear</div></div>`;
  barChart($('#itemChart'), monthlyCounts(item.wears), { height: 140 });
  const wears = item.wears.map((d, idx) => ({ d, idx })).reverse();
  $('#wearList').innerHTML = wears.length
    ? wears.map(w => `<li><span>${fmtDate(w.d)}</span><button class="icon-btn" data-remove="${w.idx}" aria-label="Remove wear on ${fmtDate(w.d)}" title="Remove">×</button></li>`).join('')
    : `<li class="none">No wears logged yet</li>`;
}

$('#logWearBtn').addEventListener('click', () => {
  const d = $('#wearDate').value;
  if (!d) return toast('Pick a date');
  if (d > todayStr()) return toast("Can't log a future date");
  logWear(currentId, d);
});
$('#wearList').addEventListener('click', e => {
  const b = e.target.closest('[data-remove]');
  if (b) removeWear(currentId, Number(b.dataset.remove));
});
$('#editItemBtn').addEventListener('click', () => openEditor(currentId));
$('#detail').addEventListener('close', () => (currentId = null));

// ---------- usage / insights ----------
function lastNMonths(n = 12) {
  const now = new Date();
  return Array.from({ length: n }, (_, k) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (n - 1 - k), 1);
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, date: d };
  });
}
function monthlyCounts(wears) {
  const months = lastNMonths();
  const counts = Object.fromEntries(months.map(m => [m.key, 0]));
  wears.forEach(w => { const k = w.slice(0, 7); if (k in counts) counts[k]++; });
  return months.map(m => ({
    label: m.date.toLocaleDateString(undefined, { month: 'short' }),
    full: m.date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    value: counts[m.key],
  }));
}

// Single-series vertical bar chart: thin rounded-top bars, recessive grid, hover tooltip, table fallback.
function barChart(el, data, { height = 220 } = {}) {
  const W = Math.max(320, el.clientWidth || 640), H = height, pad = { t: 18, r: 8, b: 24, l: 28 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const max = Math.max(1, ...data.map(d => d.value));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = v => pad.t + ih - (v / top) * ih;
  const band = iw / data.length;
  const bw = Math.min(28, band - 2);
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const peak = data.reduce((a, d, i) => (d.value > data[a].value ? i : a), 0);

  const bars = data.map((d, i) => {
    const x = pad.l + i * band + (band - bw) / 2;
    const h = Math.max(0, y(0) - y(d.value));
    const r = Math.min(4, h, bw / 2);
    const path = h > 0
      ? `M${x},${y(0)} V${y(d.value) + r} Q${x},${y(d.value)} ${x + r},${y(d.value)} H${x + bw - r} Q${x + bw},${y(d.value)} ${x + bw},${y(d.value) + r} V${y(0)} Z`
      : '';
    const label = i === peak && d.value > 0
      ? `<text class="value-label" x="${x + bw / 2}" y="${y(d.value) - 5}" text-anchor="middle">${d.value}</text>` : '';
    return `<g data-tip="${esc(d.full)}: ${d.value} wear${d.value === 1 ? '' : 's'}">
      <rect class="hit" x="${pad.l + i * band}" y="${pad.t}" width="${band}" height="${ih}" />
      ${path ? `<path class="bar" d="${path}" />` : ''}${label}
      <text class="axis-label" x="${pad.l + i * band + band / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>
    </g>`;
  }).join('');
  const grid = ticks.map(v => `<line class="gridline" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" />
    <text class="axis-label" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Wears per month">${grid}${bars}</svg>
    <details><summary>View as table</summary><table><tr><th>Month</th><th>Wears</th></tr>
    ${data.map(d => `<tr><td>${esc(d.full)}</td><td>${d.value}</td></tr>`).join('')}</table></details>`;
}
function niceStep(max) {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const n = raw / mag;
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag);
}

// One shared tooltip for every chart.
const tip = $('#tooltip');
document.addEventListener('mousemove', e => {
  const g = e.target.closest?.('[data-tip]');
  if (!g) { tip.hidden = true; return; }
  tip.textContent = g.dataset.tip;
  tip.style.left = e.clientX + 'px';
  tip.style.top = e.clientY + 'px';
  tip.hidden = false;
});

function renderInsights() {
  const sel = $('#insightCat');
  if (!sel.options.length) {
    sel.innerHTML = `<option value="all">All items</option>` + CATEGORIES.map(c => `<option value="${c.id}">${c.label}</option>`).join('');
  }
  const allWears = items.flatMap(i => i.wears);
  const thisMonth = todayStr().slice(0, 7);
  const totalValue = items.reduce((s, i) => s + (i.price || 0), 0);
  const worn90 = items.filter(i => { const lw = lastWorn(i); return lw && daysAgo(lw) <= 90; }).length;
  const priced = items.filter(i => costPerWear(i) != null);
  const avgCpw = priced.length ? priced.reduce((s, i) => s + costPerWear(i), 0) / priced.length : null;

  $('#stats').innerHTML = [
    [items.length, 'Items in closet'],
    [allWears.length, 'Total wears logged'],
    [allWears.filter(w => w.startsWith(thisMonth)).length, 'Wears this month'],
    [items.length ? Math.round((worn90 / items.length) * 100) + '%' : '—', 'Worn in last 90 days'],
    [money(totalValue), 'Closet value'],
    [avgCpw != null ? money(avgCpw) : '—', 'Avg. cost per wear'],
  ].map(([v, l]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');

  const scoped = sel.value === 'all' ? items : items.filter(i => i.category === sel.value);
  barChart($('#monthlyChart'), monthlyCounts(scoped.flatMap(i => i.wears)));

  const rankRow = (i, val) => `<li data-id="${i.id}"><img src="${i.photo || ''}" alt="" /><span class="name">${esc(itemName(i))}</span><span class="val">${val}</span></li>`;
  const most = [...items].filter(i => i.wears.length).sort((a, b) => b.wears.length - a.wears.length).slice(0, 5);
  $('#mostWorn').innerHTML = most.length ? most.map(i => rankRow(i, `${i.wears.length}×`)).join('') : `<li class="none">No wears logged yet</li>`;
  const stale = items.filter(i => { const lw = lastWorn(i); return !lw || daysAgo(lw) > 90; })
    .sort((a, b) => (lastWorn(a) ?? '').localeCompare(lastWorn(b) ?? '')).slice(0, 5);
  $('#leastWorn').innerHTML = stale.length
    ? stale.map(i => rankRow(i, lastWorn(i) ? relDays(lastWorn(i)) : 'never')).join('')
    : `<li class="none">Everything's in rotation</li>`;

  const byCat = CATEGORIES.map(c => ({ ...c, n: items.filter(i => i.category === c.id).reduce((s, i) => s + i.wears.length, 0) }));
  const maxCat = Math.max(1, ...byCat.map(c => c.n));
  $('#byCategory').innerHTML = byCat.map(c => `<div class="hbar" data-tip="${c.label}: ${c.n} wear${c.n === 1 ? '' : 's'}">
    <span>${c.label}</span><div class="track"><div class="fill" style="width:${(c.n / maxCat) * 100}%"></div></div><span class="num">${c.n}</span></div>`).join('');
}
$('#insightCat').addEventListener('change', renderInsights);
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!$('#view-insights').hidden) renderInsights();
    if (currentId) renderDetail();
  }, 150);
});

// ---------- backup ----------
$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `closet-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = (data.items ?? []).filter(i => i.id && CATEGORIES.some(c => c.id === i.category));
    for (const i of incoming) { i.wears = Array.isArray(i.wears) ? i.wears : []; await putItem(i); }
    items = await getAll();
    toast(`Imported ${incoming.length} items`);
    renderAll();
  } catch { toast('That file is not a valid backup'); }
  e.target.value = '';
});

// ---------- wiring ----------
$('#addBtn').addEventListener('click', () => openEditor());
$('#filters').addEventListener('click', e => {
  const c = e.target.closest('[data-cat]');
  if (c) { filter = c.dataset.cat; renderFilters(); renderGrid(); }
});
$('#search').addEventListener('input', renderGrid);
$('#sort').addEventListener('change', renderGrid);
$('#grid').addEventListener('click', e => {
  const log = e.target.closest('[data-log]');
  if (log) { e.stopPropagation(); return logWear(log.dataset.log); }
  const card = e.target.closest('.card');
  if (card) openDetail(card.dataset.id);
});
$('#grid').addEventListener('keydown', e => {
  const card = e.target.closest('.card');
  if (card && e.key === 'Enter' && e.target === card) openDetail(card.dataset.id);
});
document.addEventListener('click', e => {
  const row = e.target.closest('.rank li[data-id]');
  if (row) openDetail(row.dataset.id);
  if (e.target.closest('[data-close]')) e.target.closest('dialog').close();
});
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  document.querySelectorAll('.view').forEach(v => (v.hidden = v.id !== `view-${t.dataset.view}`));
  if (t.dataset.view === 'insights') renderInsights();
}));

(async function init() {
  db = await openDB();
  items = await getAll();
  items.forEach(i => (i.wears ??= []));
  renderAll();
})();
