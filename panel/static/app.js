/* RamCraft panel */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  servers: [],
  host: {},
  players: {},          // id -> {online,max,names}
  pick: null,           // chosen modrinth pack
  pickVersions: [],
  mrOffset: 0,
  mrQuery: '',
  detailId: null,
  stream: null,
  busy: new Set(),
  mcVersions: [],
};

/* ---------- helpers ---------- */

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.detail || data.raw || res.statusText);
  return data;
}

function toast(title, msg = '', kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<b></b>${msg ? '<span></span>' : ''}`;
  el.querySelector('b').textContent = title;
  if (msg) el.querySelector('span').textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 320);
  }, kind === 'err' ? 8000 : 4200);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nfmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n ?? 0);

function meterClass(pct) { return pct > 90 ? 'hot' : pct > 75 ? 'warn' : ''; }

// Must match slugify() in servers.py, or the address shown while creating
// would not be the address the server actually gets.
const slugify = s => String(s || '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// A JVM deliberately fills its heap before collecting, so a Minecraft server
// sitting at 85% of its container is healthy, not in trouble. Only flag it
// once it is close enough to the limit to risk an OOM kill.
function heapClass(pct) { return pct > 96 ? 'hot' : pct > 88 ? 'warn' : ''; }

function copy(text, label) {
  const done = () => toast('Copied', label || text);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallback());
  } else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch { toast('Copy failed', text, 'warn'); }
    ta.remove();
  }
}

const STATE_LABEL = {
  online: 'Online', starting: 'Starting', stopped: 'Stopped',
  crashed: 'Crashed', unhealthy: 'Unhealthy', missing: 'Not built',
};

const KIND_LABEL = {
  modrinth: 'Modrinth pack', curseforge: 'CurseForge pack', ftb: 'FTB pack',
  serverpack: 'Server pack',
  vanilla: 'Vanilla', paper: 'Paper', purpur: 'Purpur', fabric: 'Fabric',
  forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', spigot: 'Spigot',
};

/* ---------- rendering ---------- */

function renderHost() {
  const h = state.host;
  if (!h.mem_total_mb) { $('#hostStats').innerHTML = ''; return; }
  const memPct = Math.round((h.mem_used_mb / h.mem_total_mb) * 100);
  const diskUsedPct = h.disk_total_gb
    ? Math.round(((h.disk_total_gb - h.disk_free_gb) / h.disk_total_gb) * 100) : 0;
  $('#hostStats').innerHTML = `
    <div class="hstat">
      <span class="k">Servers</span>
      <span class="v">${h.running} / ${h.servers} up</span>
    </div>
    <div class="hstat" title="RAM handed to running servers, against this machine's budget">
      <span class="k">RAM committed</span>
      <span class="v">${(h.mem_used_mb / 1024).toFixed(0)} / ${(h.mem_total_mb / 1024).toFixed(0)} GB</span>
      <span class="bar"><span class="${meterClass(memPct)}" style="width:${memPct}%"></span></span>
    </div>
    <div class="hstat">
      <span class="k">Disk free</span>
      <span class="v">${h.disk_free_gb} GB</span>
      <span class="bar"><span class="${meterClass(diskUsedPct)}" style="width:${diskUsedPct}%"></span></span>
    </div>`;
}

// Cards are built ONCE and then patched in place. Rebuilding the grid with
// innerHTML on every 5s poll destroyed whatever button the cursor was over, so
// a click landing in that window hit a detached node and did nothing - which is
// what "it gets stuck when I click Manage" actually was.
const CARD_TEMPLATE = `
  <div class="card-head">
    <span data-f="iconSlot"></span>
    <div class="card-title">
      <h3 data-f="name"></h3>
      <p class="card-sub" data-f="sub"></p>
    </div>
    <span class="state" data-f="state"><span class="dot"></span><span data-f="stateText"></span></span>
  </div>
  <div class="meters" data-f="meters">
    <div class="meter">
      <span class="label">RAM</span>
      <span class="track"><span class="fill" data-f="ramFill"></span></span>
      <span class="val" data-f="ramVal"></span>
    </div>
    <div class="meter">
      <span class="label">CPU</span>
      <span class="track"><span class="fill" data-f="cpuFill"></span></span>
      <span class="val" data-f="cpuVal"></span>
    </div>
  </div>
  <div class="players-row" data-f="players">
    <span>👤</span><b data-f="playerCount"></b>
    <span class="names" data-f="playerNames"></span>
  </div>
  <div class="addr">
    <span class="a" data-f="addr"></span>
    <span class="pill" data-f="pill" title="Also answers on the bare domain">default</span>
    <button data-f="copy">Copy</button>
  </div>
  <div class="card-actions">
    <button class="btn primary" data-act="start" data-f="btnStart"><span class="spinner" data-f="spinStart" hidden></span>Start</button>
    <button class="btn danger" data-act="stop" data-f="btnStop"><span class="spinner" data-f="spinStop" hidden></span>Stop</button>
    <button class="btn narrow" data-act="restart" data-f="btnRestart" title="Restart">↻</button>
    <button class="btn" data-act="open">Manage</button>
  </div>`;

function buildCard(s) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = s.id;
  el.innerHTML = CARD_TEMPLATE;
  el._f = {};
  $$('[data-f]', el).forEach(n => { el._f[n.dataset.f] = n; });

  const slot = el._f.iconSlot;
  if (s.icon) {
    const img = document.createElement('img');
    img.className = 'pack-icon';
    img.src = s.icon;
    img.alt = '';
    img.loading = 'lazy';
    slot.replaceWith(img);
  } else {
    const d = document.createElement('div');
    d.className = 'pack-icon';
    d.textContent = (s.name[0] || '?').toUpperCase();
    slot.replaceWith(d);
  }
  return el;
}

function patchCard(el, s) {
  const f = el._f;
  const st = s.status.state;
  const busy = state.busy.has(s.id);
  const stats = s.stats || {};
  const p = state.players[s.id];
  const running = st === 'online' || st === 'starting' || st === 'unhealthy';
  const addr = s.connect.public || s.connect.lan;

  f.name.textContent = s.name;
  f.sub.textContent = [KIND_LABEL[s.kind] || s.kind, s.mc_version, s.memory_gb + ' GB']
    .filter(Boolean).join(' · ');

  f.state.className = 'state ' + st;
  f.stateText.textContent = STATE_LABEL[st] || st;

  const showMeters = running && stats.mem_limit_mb;
  f.meters.hidden = !showMeters;
  if (showMeters) {
    const memPct = Math.round((stats.mem_used_mb / stats.mem_limit_mb) * 100);
    f.ramFill.className = 'fill ' + heapClass(memPct);
    f.ramFill.style.width = memPct + '%';
    f.ramVal.textContent =
      `${(stats.mem_used_mb / 1024).toFixed(1)}/${(stats.mem_limit_mb / 1024).toFixed(0)}G`;
    const cpu = stats.cpu_pct ?? 0;
    f.cpuFill.className = 'fill ' + meterClass(cpu);
    f.cpuFill.style.width = Math.min(cpu, 100) + '%';
    f.cpuVal.textContent = cpu + '%';
  }

  f.players.hidden = st !== 'online';
  if (st === 'online') {
    f.playerCount.textContent = p ? `${p.online} / ${p.max}` : '–';
    f.playerNames.textContent = p && p.names.length ? p.names.join(', ') : 'nobody online';
  }

  f.addr.textContent = addr;
  f.copy.dataset.copy = addr;
  f.pill.hidden = !s.connect.is_default;

  f.btnStart.hidden = running;
  f.btnStop.hidden = !running;
  f.btnStart.disabled = busy;
  f.btnStop.disabled = busy;
  f.btnRestart.disabled = busy || !running;
  f.spinStart.hidden = !busy;
  f.spinStop.hidden = !busy;
}

function addCardElement() {
  let el = $('#addCard');
  if (!el) {
    el = document.createElement('div');
    el.className = 'card add';
    el.id = 'addCard';
    el.innerHTML = `<span class="plus">+</span><strong>New server</strong>
      <span style="font-size:12.5px">Modpack, adventure map or vanilla</span>`;
    el.onclick = openCreate;
  }
  return el;
}

function renderServers() {
  const grid = $('#grid');

  if (!state.servers.length) {
    if (!$('.empty-state', grid)) {
      grid.innerHTML = `
        <div class="empty-state">
          <h3>No servers yet</h3>
          <p>Pick a modpack, drop in an adventure map, or spin up plain vanilla.
             RamCraft downloads everything and boots it for you.</p>
          <button class="btn primary" id="emptyCreate">+ Create your first server</button>
        </div>`;
      $('#emptyCreate').onclick = openCreate;
    }
    return;
  }
  const empty = $('.empty-state', grid);
  if (empty) empty.remove();

  const seen = new Set();
  for (const s of state.servers) {
    seen.add(s.id);
    let el = grid.querySelector(`.card[data-id="${CSS.escape(s.id)}"]`);
    if (!el) {
      el = buildCard(s);
      grid.appendChild(el);
    }
    patchCard(el, s);
  }
  // Drop cards for servers that no longer exist.
  $$('.card[data-id]', grid).forEach(el => {
    if (!seen.has(el.dataset.id)) el.remove();
  });
  grid.appendChild(addCardElement());   // keep it last
}

/* ---------- polling ---------- */

async function refresh(withPlayers = true) {
  try {
    const [srv, host] = await Promise.all([api('/servers'), api('/host')]);
    state.servers = srv.servers;
    state.host = host;
    renderHost();
    renderServers();
    if (withPlayers) {
      for (const s of state.servers) {
        if (s.status.state === 'online') {
          api(`/servers/${s.id}/players`)
            .then(p => { state.players[s.id] = p; renderServers(); })
            .catch(() => {});
        } else delete state.players[s.id];
      }
    }
  } catch (e) {
    console.error(e);
  }
}

/* ---------- actions ---------- */

async function act(id, action) {
  state.busy.add(id);
  renderServers();
  const verb = { start: 'Starting', stop: 'Stopping', restart: 'Restarting' }[action];
  toast(`${verb} ${state.servers.find(s => s.id === id)?.name || id}…`,
    action === 'start' ? 'First boot of a modpack can take several minutes.' : '');
  try {
    await api(`/servers/${id}/actions/${action}`, { method: 'POST' });
  } catch (e) {
    toast('That did not work', e.message, 'err');
  } finally {
    state.busy.delete(id);
    await refresh();
  }
}

$('#grid').addEventListener('click', e => {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) return copy(copyBtn.dataset.copy, 'Server address');
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.card').dataset.id;
  const action = btn.dataset.act;
  if (action === 'open') return openDetail(id);
  act(id, action);
});

/* ---------- modal plumbing ---------- */

function openModal(sel) { $(sel).hidden = false; }
function closeModal(sel) {
  $(sel).hidden = true;
  if (sel === '#detailModal') { state.stream?.close(); state.stream = null; state.detailId = null; }
}
$$('.modal-backdrop').forEach(bd => {
  bd.addEventListener('click', e => {
    if (e.target === bd || e.target.closest('[data-close]')) closeModal('#' + bd.id);
  });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') $$('.modal-backdrop:not([hidden])').forEach(bd => closeModal('#' + bd.id));
});

function wireTabs(navSel) {
  $(navSel).addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const root = tab.closest('.modal');
    $$('.tab', tab.parentElement).forEach(t => t.classList.toggle('active', t === tab));
    $$('.tab-panel', root).forEach(p => p.classList.toggle('active', p.dataset.panel === tab.dataset.tab));
    if (navSel === '#createTabs') updateSummary();
  });
}
wireTabs('#createTabs');
wireTabs('#detailTabs');

const activeCreateTab = () => $('#createTabs .tab.active').dataset.tab;

/* ---------- create ---------- */

// Grouped so nobody scrolls past 70 entries and silently builds a 1.8 server
// that no current client can join - which is exactly what happened once.
function versionOptions(releases) {
  const current = [], older = [], legacy = [];
  for (const r of releases) {
    const m = /^1\.(\d+)/.exec(r);
    if (!m) { current.push(r); continue; }          // 26.x-style names
    const minor = +m[1];
    (minor >= 20 ? current : minor >= 17 ? older : legacy).push(r);
  }
  const group = (label, list) => list.length
    ? `<optgroup label="${label}">${list.map(r => `<option value="${r}">${r}</option>`).join('')}</optgroup>`
    : '';
  return group('Current', current)
       + group('Older — still fine', older)
       + group('Legacy — needs a matching old client', legacy);
}

async function loadMcVersions() {
  if (state.mcVersions.length) return;
  try {
    const v = await api('/versions/minecraft');
    state.mcVersions = v.releases;
    const opts = versionOptions(v.releases);
    $('#plainVersion').innerHTML = `<option value="LATEST">Latest (${v.latest})</option>` + opts;
    $('#advVersion').innerHTML = opts;
    $('#advVersion').value = v.latest;
    $('#cfPackVersion').innerHTML = opts;
    $('#cfPackVersion').value = v.latest;
    $('#mrVersionFilter').innerHTML = '<option value="">Any MC version</option>' +
      v.releases.slice(0, 30).map(r => `<option value="${r}">${r}</option>`).join('');
  } catch { /* offline - the field just stays empty */ }
}

// Warn in the create summary when the chosen version predates what a current
// client can connect to.
function versionWarning(ver) {
  if (!ver || ver === 'LATEST') return '';
  const m = /^1\.(\d+)/.exec(ver);
  if (!m) return '';
  return +m[1] < 17
    ? ` &nbsp;·&nbsp; <b style="color:var(--amber)">your client must also be ${esc(ver)}</b>`
    : '';
}

async function openCreate() {
  state.pick = null; state.pickVersions = []; state.mrOffset = 0;
  subdomainTouched = false;
  $('#optSubdomain').value = '';
  const domain = state.host.router_domain;
  $('#domainSuffix').textContent = domain ? '.' + domain : '';
  $('.addr-field').hidden = !domain;
  openModal('#createModal');
  loadMcVersions();
  const s = await api('/settings').catch(() => ({}));
  $('#optMemory').value = String(s.default_memory_gb || 4);
  $('#cfKeyNote').innerHTML = s.cf_api_key_set
    ? 'CurseForge API key is set. Paste any modpack page URL below.'
    : '<strong>No CurseForge API key yet.</strong> Add one under Settings — CurseForge requires it. Modrinth packs (first tab) need nothing.';
  $('#cfKeyNote').classList.toggle('warn', !s.cf_api_key_set);
  searchModrinth(true);
  updateSummary();
}
$('#btnNew').onclick = openCreate;

let mrTimer;
$('#mrQuery').addEventListener('input', () => {
  clearTimeout(mrTimer);
  mrTimer = setTimeout(() => { state.mrOffset = 0; searchModrinth(true); }, 320);
});
$('#mrVersionFilter').addEventListener('change', () => { state.mrOffset = 0; searchModrinth(true); });
$('#mrMore').onclick = () => { state.mrOffset += 24; searchModrinth(false); };

async function searchModrinth(reset) {
  const q = $('#mrQuery').value.trim();
  const v = $('#mrVersionFilter').value;
  const box = $('#mrResults');
  if (reset) box.innerHTML = '<div class="list-empty"><span class="spinner"></span> Searching Modrinth…</div>';
  try {
    const r = await api(`/search/modrinth?q=${encodeURIComponent(q)}&offset=${state.mrOffset}&version=${encodeURIComponent(v)}&limit=24`);
    const html = r.hits.map(h => `
      <button class="pack" data-slug="${esc(h.slug)}" data-title="${esc(h.title)}" data-icon="${esc(h.icon || '')}">
        ${h.icon ? `<img src="${esc(h.icon)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
        <div class="info">
          <div class="name">${esc(h.title)}</div>
          <div class="desc">${esc(h.description)}</div>
          <div class="dl">${nfmt(h.downloads)} downloads</div>
        </div>
      </button>`).join('');
    if (reset) box.innerHTML = html || '<div class="list-empty">Nothing matched that search.</div>';
    else box.insertAdjacentHTML('beforeend', html);
    $('#mrMore').hidden = r.hits.length < 24;
  } catch (e) {
    box.innerHTML = `<div class="list-empty">Could not reach Modrinth — ${esc(e.message)}</div>`;
  }
}

$('#mrResults').addEventListener('click', async e => {
  const pack = e.target.closest('.pack');
  if (!pack) return;
  $$('.pack', $('#mrResults')).forEach(p => p.classList.toggle('selected', p === pack));
  state.pick = { slug: pack.dataset.slug, title: pack.dataset.title, icon: pack.dataset.icon };
  state.pickVersions = [];
  updateSummary();

  // Pull the version list so the user can pin one, defaulting to newest release.
  const old = $('#mrVersionPick'); if (old) old.remove();
  const holder = document.createElement('div');
  holder.className = 'version-pick';
  holder.id = 'mrVersionPick';
  holder.innerHTML = '<label>Pack version</label><div class="list-empty"><span class="spinner"></span> Loading versions…</div>';
  $('[data-panel=modpack]').appendChild(holder);
  try {
    const r = await api(`/modrinth/${encodeURIComponent(state.pick.slug)}/versions`);
    state.pickVersions = r.versions;
    if (!r.versions.length) { holder.innerHTML = '<p class="hint">No published versions found.</p>'; return; }
    holder.innerHTML = `<label for="mrVersion">Pack version</label>
      <select id="mrVersion">${r.versions.map((v, i) => `
        <option value="${esc(v.id)}" data-mc="${esc(v.game_versions[0] || '')}" ${i === 0 ? 'selected' : ''}>
          ${esc(v.version_number || v.name)} — MC ${esc(v.game_versions.join(', '))} ${v.type !== 'release' ? '(' + esc(v.type) + ')' : ''}
        </option>`).join('')}</select>`;
    $('#mrVersion').addEventListener('change', updateSummary);
    updateSummary();
  } catch (e) {
    holder.innerHTML = `<p class="hint">Could not load versions: ${esc(e.message)}. The latest will be used.</p>`;
  }
});

function currentPickVersion() {
  const sel = $('#mrVersion');
  if (!sel) return null;
  return state.pickVersions.find(v => v.id === sel.value) || null;
}

// The subdomain tracks the server name until the user types their own.
let subdomainTouched = false;
$('#optSubdomain').addEventListener('input', () => {
  subdomainTouched = true;
  const el = $('#optSubdomain');
  const clean = el.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (clean !== el.value) el.value = clean;
  updateSummary();
});

/* ---------- server pack upload (the no-API-key CurseForge route) ---------- */

state.uploadedPack = null;   // {path, name, size_mb}

function wirePackDrop() {
  const drop = $('#cfDrop'), input = $('#cfFile'), label = $('#cfDropText');
  if (!drop) return;

  drop.onclick = () => input.click();
  ['dragenter', 'dragover'].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => {
    const f = e.dataTransfer?.files?.[0];
    if (f) sendPack(f);
  });
  input.onchange = () => { if (input.files[0]) sendPack(input.files[0]); };

  async function sendPack(file) {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast('That is not a .zip', 'Use the pack’s Server Pack download.', 'err');
      return;
    }
    label.innerHTML = `<span class="spinner"></span> Uploading ${esc(file.name)}…`;
    const body = new FormData();
    body.append('file', file);
    try {
      // Not the api() helper: this is multipart, not JSON.
      const res = await fetch('/api/uploads', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'upload failed');
      state.uploadedPack = data;
      drop.classList.add('has-file');
      label.textContent = `${data.name} — ${data.size_mb} MB ✓`;
      if (!$('#cfName').value.trim()) {
        $('#cfName').value = data.name.replace(/\.zip$/i, '').replace(/[-_]/g, ' ').slice(0, 40);
      }
      updateSummary();
    } catch (e) {
      label.textContent = 'Drop the server pack .zip here, or click to choose';
      drop.classList.remove('has-file');
      toast('Upload failed', e.message, 'err');
    }
  }
}
wirePackDrop();

function currentCreateName() {
  const tab = activeCreateTab();
  if (tab === 'modpack') return state.pick ? state.pick.title : '';
  if (tab === 'adventure') return $('#advName').value.trim();
  if (tab === 'plain') return $('#plainName').value.trim();
  return $('#cfName').value.trim();
}

function updateSummary() {
  const tab = activeCreateTab();
  const btn = $('#btnCreate');
  const sum = $('#createSummary');

  if (!subdomainTouched) $('#optSubdomain').value = slugify(currentCreateName());

  let ok = false, text = '';
  if (tab === 'modpack') {
    if (state.pick) {
      const v = currentPickVersion();
      text = `<b>${esc(state.pick.title)}</b>${v ? ' · ' + esc(v.version_number) + ' · MC ' + esc(v.game_versions[0] || '?') : ''}`;
      ok = true;
    } else text = 'Pick a modpack to begin';
  } else if (tab === 'adventure') {
    ok = !!($('#advName').value.trim() && $('#advWorld').value.trim());
    text = ok ? `<b>${esc($('#advName').value.trim())}</b> · adventure map on ${esc($('#advType').value)} ${esc($('#advVersion').value)}`
              : 'Name the server and paste a world .zip link';
  } else if (tab === 'plain') {
    ok = !!$('#plainName').value.trim();
    const pv = $('#plainVersion').value;
    text = ok ? `<b>${esc($('#plainName').value.trim())}</b> · ${esc($('#plainType').value)} ${esc(pv)}${versionWarning(pv)}`
              : 'Give the server a name';
  } else if (tab === 'curseforge') {
    const name = $('#cfName').value.trim();
    const pack = state.uploadedPack ? state.uploadedPack.name
               : $('#cfZipUrl').value.trim() ? 'server pack URL'
               : $('#cfUrl').value.trim() ? 'via API key' : '';
    ok = !!(name && pack);
    text = ok ? `<b>${esc(name)}</b> · ${esc(pack)}`
              : 'Name the server, then upload the server pack zip';
  }
  const sub = $('#optSubdomain').value.trim();
  const domain = state.host.router_domain;
  if (ok && sub && domain) {
    text += ` &nbsp;→&nbsp; <b style="font-family:var(--mono)">${esc(sub)}.${esc(domain)}</b>`;
  }
  sum.innerHTML = text;
  btn.disabled = !ok || (!!domain && !sub);
}
['#advName', '#advWorld', '#advType', '#advVersion', '#plainName', '#plainType', '#cfZipUrl', '#cfPackVersion',
 '#plainVersion', '#cfName', '#cfUrl'].forEach(sel =>
  $(sel).addEventListener('input', updateSummary));
['#advType', '#advVersion', '#plainType', '#plainVersion'].forEach(sel =>
  $(sel).addEventListener('change', updateSummary));

function sharedSpec() {
  const spec = {
    memory_gb: Number($('#optMemory').value),
    max_players: Number($('#optPlayers').value) || 10,
    difficulty: $('#optDifficulty').value,
    gamemode: $('#optGamemode').value,
    view_distance: Number($('#optView').value) || 10,
    simulation_distance: Number($('#optSim').value) || 6,
    online_mode: $('#optOnline').checked,
    start_now: true,
  };
  const sub = $('#optSubdomain').value.trim();
  if (sub) spec.subdomain = sub;
  const port = $('#optPort').value.trim();
  if (port) spec.port = Number(port);
  const ops = $('#optOps').value.trim();
  if (ops) spec.ops = ops.split(',').map(s => s.trim()).filter(Boolean).join(',');
  const motd = $('#optMotd').value.trim();
  if (motd) spec.motd = motd;
  return spec;
}

$('#btnCreate').onclick = async () => {
  const tab = activeCreateTab();
  const spec = sharedSpec();
  if (tab === 'modpack') {
    const v = currentPickVersion();
    Object.assign(spec, {
      kind: 'modrinth',
      name: state.pick.title,
      modpack: state.pick.slug,
      icon: state.pick.icon || null,
      source_label: 'Modrinth: ' + state.pick.slug,
    });
    if (v) { spec.modpack_version = v.id; spec.mc_version = v.game_versions[0]; }
  } else if (tab === 'adventure') {
    Object.assign(spec, {
      kind: $('#advType').value,
      name: $('#advName').value.trim(),
      world_url: $('#advWorld').value.trim(),
      mc_version: $('#advVersion').value,
      source_label: 'Adventure map',
      gamemode: spec.gamemode,
    });
  } else if (tab === 'plain') {
    Object.assign(spec, {
      kind: $('#plainType').value,
      name: $('#plainName').value.trim(),
      mc_version: $('#plainVersion').value === 'LATEST' ? null : $('#plainVersion').value,
      source_label: $('#plainType').value,
    });
  } else {
    // Prefer the no-API-key route: an uploaded or linked server pack zip.
    const zip = state.uploadedPack ? state.uploadedPack.path : $('#cfZipUrl').value.trim();
    if (zip) {
      Object.assign(spec, {
        kind: 'serverpack',
        name: $('#cfName').value.trim(),
        server_pack: zip,
        mc_version: $('#cfPackVersion').value || null,
        source_label: 'Server pack: ' + (state.uploadedPack ? state.uploadedPack.name : zip),
      });
    } else {
      Object.assign(spec, {
        kind: 'curseforge',
        name: $('#cfName').value.trim(),
        cf_page_url: $('#cfUrl').value.trim(),
        source_label: 'CurseForge',
      });
    }
  }

  const btn = $('#btnCreate');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating…';
  try {
    const r = await api('/servers', { method: 'POST', body: spec });
    closeModal('#createModal');
    toast(`${r.server.name} is booting`,
      'Downloading and installing — watch the console for progress.');
    await refresh();
    openDetail(r.server.id);
  } catch (e) {
    toast('Could not create that server', e.message, 'err');
  } finally {
    btn.innerHTML = 'Create &amp; start';
    updateSummary();
  }
};

/* ---------- detail ---------- */

const LOG_CLASS = [
  [/\b(ERROR|SEVERE|Exception|FAILED|Caused by)\b/i, 'err'],
  [/\b(WARN|WARNING)\b/i, 'warn'],
  [/joined the game|left the game/i, 'join'],
  [/^\[init\]|Downloading|Installing|Unpacking|Resolved|mc-image-helper/i, 'sys'],
];

// The installer draws progress bars with ANSI colour and erase-line codes, and
// docker hands those straight through - strip them or the console fills with
// "[K" and ">...." noise.
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|[\x00-\x08\x0b-\x1f\x7f]/g;

function cleanLine(line) {
  return line.replace(ANSI_RE, '').replace(/^[>.\s]*\[K/, '').trimEnd();
}

// Log lines are buffered and flushed once per animation frame. Appending them
// one at a time cost a forced reflow per line (scrollHeight read + scrollTop
// write), which froze the main thread for ~29s when opening a modpack console.
const MAX_LOG_LINES = 600;
let logBuffer = [];
let logFlushQueued = false;

function flushLogs() {
  logFlushQueued = false;
  const box = $('#console');
  if (!box || !logBuffer.length) { logBuffer.length = 0; return; }

  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;  // one read
  const frag = document.createDocumentFragment();
  for (const line of logBuffer) {
    const div = document.createElement('div');
    const hit = LOG_CLASS.find(([re]) => re.test(line));
    if (hit) div.className = hit[1];
    div.textContent = line;
    frag.appendChild(div);
  }
  logBuffer.length = 0;
  box.appendChild(frag);

  let over = box.childElementCount - MAX_LOG_LINES;
  while (over-- > 0 && box.firstElementChild) box.firstElementChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;                             // one write
}

function appendLog(raw) {
  const line = cleanLine(raw);
  if (!line) return;
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES * 2) logBuffer.splice(0, logBuffer.length - MAX_LOG_LINES);
  if (!logFlushQueued) {
    logFlushQueued = true;
    // setTimeout, not requestAnimationFrame: rAF is paused entirely while the
    // window is hidden or minimised, so the buffer would never drain and the
    // console would just sit empty.
    setTimeout(flushLogs, 50);
  }
}

async function openDetail(id) {
  const s = state.servers.find(x => x.id === id);
  state.detailId = id;
  $('#detailTitle').textContent = s ? s.name : id;
  openModal('#detailModal');
  $('#console').innerHTML = '';
  logBuffer.length = 0;
  $$('#detailTabs .tab').forEach((t, i) => t.classList.toggle('active', i === 0));
  $$('#detailModal .tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === 'console'));

  // These are cheap and they are what the other two tabs show - populate them
  // before touching the console so Settings is never an empty pane.
  renderConfig(id);
  renderBackups(id);

  try {
    const text = await (await fetch(`/api/servers/${id}/logs?tail=250`)).text();
    text.split('\n').forEach(l => l && appendLog(l));
  } catch { /* nothing yet */ }

  // The stream starts at tail=0 server-side, so it only carries NEW lines -
  // otherwise its backlog duplicates everything the fetch above just drew.
  state.stream?.close();
  state.stream = new EventSource(`/api/servers/${id}/stream`);
  state.stream.onmessage = e => appendLog(e.data);
  state.stream.addEventListener('end', () => { state.stream?.close(); state.stream = null; });
  state.stream.onerror = () => { /* container stopped - keep the pane, drop the stream */ };
}

$('#cmdForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#cmdInput');
  const cmd = input.value.trim();
  if (!cmd || !state.detailId) return;
  input.value = '';
  appendLog('> /' + cmd);
  try {
    const r = await api(`/servers/${state.detailId}/command`, { method: 'POST', body: { command: cmd } });
    if (r.reply) r.reply.split('\n').forEach(l => appendLog(l));
  } catch (err) {
    appendLog('! ' + err.message);
  }
});

async function renderConfig(id) {
  const s = await api(`/servers/${id}`).catch(() => null);
  if (!s) return;
  const sp = s.spec || {};
  const c = s.connect;
  const dom = state.host.router_domain;
  $('#configForm').innerHTML = `
    <div class="field">
      <label>Join addresses</label>
      ${c.public ? `<div class="addr" style="margin-bottom:7px"><span class="a">${esc(c.public)}</span><button data-copy="${esc(c.public)}">Copy</button></div>` : ''}
      ${c.also ? `<div class="addr" style="margin-bottom:7px"><span class="a">${esc(c.also)}</span><span class="pill">default</span><button data-copy="${esc(c.also)}">Copy</button></div>` : ''}
      <div class="addr"><span class="a">${esc(c.lan)}</span><button data-copy="${esc(c.lan)}">Copy</button></div>
      <p class="hint">The first is what players outside the house use — no port needed.
        The last is the direct LAN address. Disk used: ${(s.disk_mb / 1024).toFixed(1)} GB ·
        Created ${esc((s.created || '').slice(0, 10))}</p>
    </div>
    ${dom ? `
    <div class="field">
      <label for="cfgSub">Server address</label>
      <div class="addr-compose">
        <input id="cfgSub" value="${esc(s.subdomain || s.id)}" autocomplete="off" spellcheck="false">
        <span class="domain-suffix">.${esc(dom)}</span>
      </div>
      <label class="check" style="margin-top:10px">
        <input type="checkbox" id="cfgDefault" ${s.is_default ? 'checked' : ''}>
        Also answer on plain <b style="font-family:var(--mono)">${esc(dom)}</b>
      </label>
      <p class="hint">Only one server can hold the bare domain — ticking this releases it from
        whichever server has it now.</p>
    </div>` : ''}
    <div class="field">
      <label for="cfgPublic">Override the public address</label>
      <input id="cfgPublic" value="${esc(s.public_address || '')}" placeholder="leave blank to use the address above">
      <p class="hint">Only needed for a tunnel that hands out its own host and port,
        such as playit.gg.</p>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="cfgMem">Memory (GB)</label>
        <select id="cfgMem">${[2,3,4,6,8,10,12,16].map(g =>
          `<option value="${g}" ${g === s.memory_gb ? 'selected' : ''}>${g} GB</option>`).join('')}</select>
      </div>
      <div class="field">
        <label for="cfgPlayers">Max players</label>
        <input id="cfgPlayers" type="number" min="1" max="200" value="${esc(sp.max_players ?? 10)}">
      </div>
      <div class="field">
        <label for="cfgDiff">Difficulty</label>
        <select id="cfgDiff">${['peaceful','easy','normal','hard'].map(d =>
          `<option value="${d}" ${d === (sp.difficulty || 'normal') ? 'selected' : ''}>${d[0].toUpperCase() + d.slice(1)}</option>`).join('')}</select>
      </div>
      <div class="field">
        <label for="cfgPort">Port</label>
        <input id="cfgPort" type="number" min="25565" max="25640" value="${esc(s.port)}">
      </div>
    </div>
    <p class="hint" style="margin:-8px 0 15px">Put a server on <b>25565</b> and players can join
      with the bare hostname — no <code>:port</code> to remember.</p>
    <div class="field">
      <label for="cfgMotd">MOTD</label>
      <input id="cfgMotd" value="${esc(sp.motd || '')}" placeholder="${esc(s.name)}">
    </div>
    <div class="field">
      <label for="cfgOps">Operators</label>
      <input id="cfgOps" value="${esc(sp.ops || '')}" placeholder="comma separated usernames">
    </div>
    <p class="panel-note warn">Changing memory, players, difficulty, MOTD or ops rebuilds the
      container. The world is kept — the server does restart, so do it when nobody is playing.</p>
    <div class="foot-actions" style="justify-content:flex-end">
      <button class="btn danger" id="cfgDelete">Delete server</button>
      <button class="btn primary" id="cfgSave">Save changes</button>
    </div>`;

  // onclick, not addEventListener: renderConfig runs on every open, and
  // addEventListener would stack a new handler each time.
  $('#configForm').onclick = e => {
    const cb = e.target.closest('[data-copy]');
    if (cb) copy(cb.dataset.copy, 'Server address');
  };

  $('#cfgSave').onclick = async () => {
    const btn = $('#cfgSave');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      await api(`/servers/${id}`, {
        method: 'PATCH',
        body: {
          public_address: $('#cfgPublic').value.trim(),
          ...(dom ? {
            subdomain: $('#cfgSub').value.trim(),
            is_default: $('#cfgDefault').checked,
          } : {}),
          memory_gb: Number($('#cfgMem').value),
          port: Number($('#cfgPort').value),
          max_players: Number($('#cfgPlayers').value) || 10,
          difficulty: $('#cfgDiff').value,
          motd: $('#cfgMotd').value.trim(),
          ops: $('#cfgOps').value.trim(),
        },
      });
      toast('Saved', 'The container was rebuilt with the new settings.');
      await refresh();
    } catch (e) {
      toast('Save failed', e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Save changes';
    }
  };

  $('#cfgDelete').onclick = async () => {
    if (!confirm(`Delete "${s.name}" and erase its world permanently?\n\nThis cannot be undone. Back it up first if you want to keep it.`)) return;
    if (!confirm('Really delete? The world files will be gone for good.')) return;
    try {
      await api(`/servers/${id}?wipe=true`, { method: 'DELETE' });
      closeModal('#detailModal');
      toast('Deleted', s.name);
      await refresh();
    } catch (e) { toast('Delete failed', e.message, 'err'); }
  };
}

async function renderBackups(id) {
  const box = $('#backupList');
  box.innerHTML = '<div class="list-empty"><span class="spinner"></span> Loading…</div>';
  try {
    const r = await api(`/servers/${id}/backups`);
    if (!r.backups.length) { box.innerHTML = '<div class="list-empty">No backups yet.</div>'; return; }
    box.innerHTML = r.backups.map(b => `
      <div class="bk" data-file="${esc(b.file)}">
        <div class="when">${esc(b.created.replace('T', ' ').replace('+00:00', ' UTC'))}<small>${esc(b.file)}</small></div>
        <span class="size">${b.size_mb} MB</span>
        <a class="btn sm ghost" href="/api/servers/${id}/backups/${encodeURIComponent(b.file)}/download">Download</a>
        <button class="btn sm" data-bk="restore">Restore</button>
        <button class="btn sm danger" data-bk="delete">Delete</button>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="list-empty">${esc(e.message)}</div>`;
  }
}

$('#backupList').addEventListener('click', async e => {
  const btn = e.target.closest('[data-bk]');
  if (!btn) return;
  const file = btn.closest('.bk').dataset.file;
  const id = state.detailId;
  if (btn.dataset.bk === 'restore') {
    if (!confirm(`Restore ${file}?\n\nThe current world will be replaced and the server restarted.`)) return;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try { await api(`/servers/${id}/backups/${encodeURIComponent(file)}/restore`, { method: 'POST' }); toast('Restored', file); }
    catch (err) { toast('Restore failed', err.message, 'err'); }
    renderBackups(id);
  } else {
    if (!confirm(`Delete backup ${file}?`)) return;
    try { await api(`/servers/${id}/backups/${encodeURIComponent(file)}`, { method: 'DELETE' }); }
    catch (err) { toast('Delete failed', err.message, 'err'); }
    renderBackups(id);
  }
});

$('#btnBackupNow').onclick = async () => {
  const btn = $('#btnBackupNow');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Backing up…';
  try {
    const r = await api(`/servers/${state.detailId}/actions/backup`, { method: 'POST' });
    toast('Backup complete', `${r.backup.file} — ${r.backup.size_mb} MB`);
    renderBackups(state.detailId);
  } catch (e) {
    toast('Backup failed', e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Back up now';
  }
};

/* ---------- settings ---------- */

$('#btnSettings').onclick = async () => {
  const s = await api('/settings').catch(() => ({}));
  $('#setCf').value = '';
  $('#setCf').placeholder = s.cf_api_key_set ? 'Stored — leave blank to keep it' : 'Paste your CurseForge API key';
  $('#setMem').value = s.default_memory_gb || 4;
  const dom = s.router_domain || state.host.router_domain || '';
  $('#setDomain').textContent = dom ? '*.' + dom : 'not configured';
  $('#setDomainEcho').textContent = dom;

  // What mc-router actually believes right now - the quickest way to tell a
  // DNS problem from a routing problem.
  const r = state.host.router || {};
  const routes = r.routes || {};
  const keys = Object.keys(routes);
  $('#setRoutes').innerHTML = !r.ok
    ? `<p class="hint">mc-router is not answering: ${esc(r.error || 'unknown')}</p>`
    : keys.length
      ? keys.sort().map(k => `<div class="route"><span>${esc(k)}</span><small>${esc(routes[k])}</small></div>`).join('')
      : '<p class="hint">No routes yet — start a server and it appears here automatically.</p>';

  $('#setStorage').textContent = 'Checking…';
  api('/maintenance').then(m => {
    const n = m.orphans.dirs.length + m.orphans.backups.length;
    $('#setStorage').textContent = n
      ? `${n} leftover item${n > 1 ? 's' : ''} from deleted servers — ${m.orphan_mb} MB. Also drops unused base images.`
      : `Nothing left over. ${state.host.disk_free_gb} GB free. Cleanup also drops unused base images.`;
  }).catch(() => { $('#setStorage').textContent = 'Could not check storage.'; });

  openModal('#settingsModal');
};

$('#btnCleanup').onclick = async () => {
  const btn = $('#btnCleanup');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Cleaning…';
  try {
    const r = await api('/maintenance/cleanup', { method: 'POST' });
    toast('Cleanup done', `${r.freed_mb} MB reclaimed · ${r.removed} leftover item(s)` +
      (r.images_removed?.length ? ` · ${r.images_removed.length} image(s)` : ''));
    $('#btnSettings').click();
  } catch (e) {
    toast('Cleanup failed', e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Clean up leftovers';
  }
};

$('#btnSaveSettings').onclick = async () => {
  try {
    await api('/settings', {
      method: 'PUT',
      body: {
        cf_api_key: $('#setCf').value.trim(),
        default_memory_gb: Number($('#setMem').value) || 4,
      },
    });
    closeModal('#settingsModal');
    toast('Settings saved');
    refresh();
  } catch (e) { toast('Could not save', e.message, 'err'); }
};

/* ---------- how to join ---------- */

$('#btnConnectHelp').onclick = () => {
  const h = state.host;
  $('#joinBody').innerHTML = `
    <p class="panel-note">In Minecraft: <b>Multiplayer → Add Server</b>, paste the address into
      <b>Server Address</b>, then Done → Join. Each card shows its own address — copy it from there.</p>
    <div class="field">
      <label>At home</label>
      <div class="addr"><span class="a">${esc(h.lan_host)}:PORT</span></div>
      <p class="hint">Works for anyone on your Wi-Fi with nothing installed.</p>
    </div>
    <div class="field">
      <label>From anywhere</label>
      <div class="addr"><span class="a">${esc(dom ? 'name.' + dom : 'no domain configured')}</span></div>
      <p class="hint">Every server gets its own name automatically — no port to remember and
        nothing to set up per server. It works because Minecraft sends the hostname it dialled
        inside its handshake, so one listener on 25565 routes each player to the right world.</p>
    </div>
    <p class="panel-note">This needs <b>two one-time steps</b>, then never again:<br>
      <b>1.</b> Cloudflare DNS → add an <b>A</b> record, name <code>*.${esc(dom || 'mc')}</code>,
      value = your home IP, <b>DNS only (grey cloud)</b>.<br>
      <b>2.</b> Router → forward TCP <b>25565</b> to <code>${esc(h.lan_host)}</code>.<br>
      Every server you create from then on is reachable the moment it starts.</p>
    <p class="panel-note warn">A Cloudflare <b>Tunnel</b> cannot carry the game itself: on the free
      plan cloudflared proxies HTTP only, and Minecraft speaks raw TCP. Arbitrary TCP through
      Cloudflare needs Spectrum, which is enterprise-only. Use the tunnel for <em>this panel</em>
      and plain Cloudflare <b>DNS</b> for the game.</p>
    <p class="hint">Prefer not to forward a port? Run a <a href="https://playit.gg" target="_blank"
      rel="noopener">playit.gg</a> agent pointed at <code>${esc(h.lan_host)}:25565</code> and put the
      address it gives you in each server's <b>Override the public address</b> field.</p>`;
  openModal('#joinModal');
};

/* ---------- boot ---------- */

refresh();
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
