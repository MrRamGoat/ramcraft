/* RamCraft panel */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  servers: [],
  host: {},
  players: {},          // id -> {online,max,names}
  pick: null,           // chosen pack: {slug} Modrinth, {ftb} FTB, {cf} CurseForge
  pickVersions: [],
  mrOffset: 0,
  mrQuery: '',
  mrSeq: 0,             // drops search answers that arrive after a newer search
  cfKey: false,         // a CurseForge API key is stored
  cfWorld: null,        // chosen CurseForge world
  cwFiles: [],
  cwOffset: 0,
  cwSeq: 0,
  detailId: null,
  stream: null,
  busy: new Set(),
  mcVersions: [],
  worldFilter: 'all',
  worldQuery: '',
};

/* ---------- helpers ---------- */

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  signedOutGuard(res);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.detail || data.raw || res.statusText);
  return data;
}

// A session can end under an open tab (expired, or the password was changed
// elsewhere). Go to the sign-in page rather than failing every poll.
function signedOutGuard(res) {
  if (res.status === 401) {
    location.replace('/login');
    throw new Error('Signed out');
  }
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

// "Asleep / Wake" rather than "Stopped / Start" because that is literally what
// happens now: mc-router starts a stopped server when someone tries to join.
const STATE_LABEL = {
  online: 'Live', starting: 'Waking', stopped: 'Asleep',
  crashed: 'Crashed', unhealthy: 'Struggling', missing: 'Not built',
};
const STATE_ICON = {
  online: 'i-bolt', starting: 'i-restart', stopped: 'i-moon',
  crashed: 'i-alert', unhealthy: 'i-alert', missing: 'i-cube',
};

const LOADER_LABEL = { forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric', quilt: 'Quilt' };

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
      <span class="stat-icon"><svg class="ico"><use href="#i-server"/></svg></span>
      <div><span class="k">Worlds online</span>
      <span class="v">${h.running} <i>/ ${h.servers} worlds</i></span></div>
    </div>
    <div class="hstat" title="RAM handed to running servers, against this machine's budget">
      <span class="stat-icon"><svg class="ico"><use href="#i-chip"/></svg></span>
      <div><span class="k">Memory allocated</span>
      <span class="v">${(h.mem_used_mb / 1024).toFixed(0)} <i>of</i> ${(h.mem_total_mb / 1024).toFixed(0)} GB</span>
      <span class="bar"><span class="${meterClass(memPct)}" style="width:${Math.min(memPct,100)}%"></span></span></div>
    </div>
    <div class="hstat">
      <span class="stat-icon"><svg class="ico"><use href="#i-disk"/></svg></span>
      <div><span class="k">Storage available</span>
      <span class="v">${h.disk_free_gb} GB <i>free</i></span>
      <span class="bar"><span class="${meterClass(diskUsedPct)}" style="width:${Math.min(diskUsedPct,100)}%"></span></span></div>
    </div>`;
}

// Cards are built ONCE and then patched in place. Rebuilding the grid with
// innerHTML on every 5s poll destroyed whatever button the cursor was over, so
// a click landing in that window hit a detached node and did nothing - which is
// what "it gets stuck when I click Manage" actually was.
const CARD_TEMPLATE = `
  <div class="world-art" aria-hidden="true"><span class="world-art-label">Your next chapter</span><svg class="world-cube" viewBox="0 0 24 24"><use href="#i-box"/></svg></div>
  <div class="card-head">
    <span data-f="iconSlot"></span>
    <div class="card-title">
      <h3 data-f="name"></h3>
      <p class="card-sub" data-f="sub"></p>
    </div>
    <span class="state" data-f="state">
      <svg class="ico" data-f="stateIcon"><use data-f="stateUse" href="#i-moon"/></svg><span data-f="stateText"></span>
    </span>
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
    <svg class="ico"><use href="#i-users"/></svg><b data-f="playerCount"></b>
    <span class="names" data-f="playerNames"></span>
  </div>
  <div class="addr">
    <svg class="ico dim"><use href="#i-link"/></svg>
    <span class="a" data-f="addr"></span>
    <span class="pill" data-f="pill" title="Also answers on the bare domain">main</span>
    <button data-f="copy">Copy</button>
  </div>
  <div class="card-actions">
    <button class="btn primary" data-act="start" data-f="btnStart">
      <span class="spinner" data-f="spinStart" hidden></span><svg class="ico" data-f="startIcon"><use href="#i-play"/></svg><span data-f="startText">Wake</span></button>
    <button class="btn danger" data-act="stop" data-f="btnStop">
      <span class="spinner" data-f="spinStop" hidden></span><svg class="ico"><use href="#i-stop"/></svg>Stop</button>
    <button class="btn narrow" data-act="restart" data-f="btnRestart" title="Restart" aria-label="Restart">
      <svg class="ico"><use href="#i-restart"/></svg></button>
    <button class="btn" data-act="open"><svg class="ico"><use href="#i-sliders"/></svg>Manage</button>
    <button class="btn narrow danger" data-act="delete" title="Delete this world" aria-label="Delete world">
      <svg class="ico"><use href="#i-trash"/></svg></button>
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
  f.stateUse.setAttribute('href', '#' + (STATE_ICON[st] || 'i-cube'));
  // The card itself carries the state so CSS can tint its edge and accent bar.
  el.className = 'card is-' + st;

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
  // A crashed server needs restarting, not waking - say which.
  f.startText.textContent = st === 'crashed' ? 'Retry' : st === 'missing' ? 'Build' : 'Wake';
  f.btnStart.disabled = busy;
  f.btnStop.disabled = busy;
  f.btnRestart.disabled = busy || !running;
  f.spinStart.hidden = !busy;
  f.spinStop.hidden = !busy;
}

function addCardElement() {
  let el = $('#addCard');
  if (!el) {
    el = document.createElement('button');
    el.type = 'button';
    el.className = 'card add';
    el.id = 'addCard';
    el.innerHTML = `<span class="plus"><svg class="ico"><use href="#i-plus"/></svg></span>
      <strong>Room for one more adventure.</strong>
      <span>Vanilla, modpacks, or something<br>entirely your own.</span><span class="add-world-label">Create a world <span aria-hidden="true">↗</span></span>`;
    el.onclick = openCreate;
  }
  return el;
}

function renderServers() {
  const grid = $('#grid');
  $('#navWorldCount').textContent = state.servers.length;
  $('#worldCount').textContent = state.servers.length;
  const online = state.servers.filter(s => s.status.state === 'online').length;
  $('#worldSummary').textContent = `${online} live · ${state.servers.length} total`;
  $('#noMatches').hidden = true;
  // With nothing to list, centre the quick-start block in the space between
  // the two bars instead of leaving it stranded at the top.
  grid.classList.toggle('is-empty', !state.servers.length);

  if (!state.servers.length) {
    if (!$('.empty-state', grid)) {
      const dom = state.host.router_domain;
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-art"><svg class="ico"><use href="#i-box"/></svg></div>
          <h3>Let's build a world</h3>
          <p>Pick a route below. RamCraft downloads everything, picks the right Java,
             boots it, and hands you an address${dom ? ' under <b>' + esc(dom) + '</b>' : ''}.</p>
          <div class="start-grid">
            <button class="start-tile" data-start="modpack">
              <span class="t-ico"><svg class="ico"><use href="#i-box"/></svg></span>
              <b>Modpack</b>
              <span>Browse CurseForge, Modrinth and FTB, and install one in two clicks.</span>
            </button>
            <button class="start-tile" data-start="adventure">
              <span class="t-ico"><svg class="ico"><use href="#i-map"/></svg></span>
              <b>Adventure map</b>
              <span>Pick one from CurseForge, or drop in a world .zip.</span>
            </button>
            <button class="start-tile" data-start="mods">
              <span class="t-ico"><svg class="ico"><use href="#i-sliders"/></svg></span>
              <b>Pick your own mods</b>
              <span>Build a custom pack, then export it for your client.</span>
            </button>
            <button class="start-tile" data-start="plain">
              <span class="t-ico"><svg class="ico"><use href="#i-cube"/></svg></span>
              <b>Plain world</b>
              <span>Vanilla, Paper or Fabric — clean and fast.</span>
            </button>
          </div>
        </div>`;
      $$('.start-tile', grid).forEach(t => {
        t.onclick = async () => {
          await openCreate();
          openCreateAt(t.dataset.start);
        };
      });
    }
    return;
  }
  // Both placeholders must go: the loading one ships in the HTML and the empty
  // one is added below, and leaving either leaves a stray line above the cards.
  $$('.empty-state, .loading-state', grid).forEach(el => el.remove());

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
  applyWorldFilters();
}

function applyWorldFilters() {
  let visible = 0;
  for (const s of state.servers) {
    const el = $('#grid').querySelector(`.card[data-id="${CSS.escape(s.id)}"]`);
    if (!el) continue;
    const matches = (state.worldFilter === 'all' || s.status.state === state.worldFilter)
      && `${s.name} ${KIND_LABEL[s.kind] || s.kind} ${s.connect.public || s.connect.lan}`.toLowerCase().includes(state.worldQuery);
    el.hidden = !matches;
    if (matches) visible++;
  }
  const filtering = state.worldFilter !== 'all' || !!state.worldQuery;
  if ($('#addCard')) $('#addCard').hidden = filtering;
  $('#noMatches').hidden = !state.servers.length || visible > 0 || !filtering;
}
$('#worldSearch').addEventListener('input', e => {state.worldQuery = e.target.value.trim().toLowerCase();applyWorldFilters();});
$$('[data-filter]').forEach(btn => btn.addEventListener('click', () => {
  state.worldFilter = btn.dataset.filter;
  $$('[data-filter]').forEach(b => {b.classList.toggle('active', b === btn);b.setAttribute('aria-pressed', String(b === btn));});
  applyWorldFilters();
}));
$('#clearFilters').onclick = () => {$('#worldSearch').value = '';state.worldQuery = ''; $('[data-filter="all"]').click();};
$('#retryDashboard').onclick = () => refresh();

/* ---------- polling ---------- */

async function refresh(withPlayers = true) {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    // One request, not two: each round trip through the tunnel costs 150-300ms.
    const d = await api('/dashboard', {signal: AbortSignal.timeout(20000)});
    state.servers = d.servers;
    state.host = d.host;
    $('#dashboardError').hidden = true;
    $('#connectionStatus').classList.remove('disconnected');
    $('#connectionStatus').lastElementChild.textContent = 'Connected to host';
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
    $('#dashboardError').hidden = false;
    $('#connectionStatus').classList.add('disconnected');
    $('#connectionStatus').lastElementChild.textContent = 'Host unavailable';
    const loading = $('.loading-state');
    if (loading) loading.textContent = 'Your worlds will appear when the connection is restored.';
    console.error(e);
  } finally {
    state.refreshing = false;
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
  if (action === 'delete') return deleteServer(id);
  act(id, action);
});

async function deleteServer(id) {
  const s = state.servers.find(x => x.id === id);
  const name = s ? s.name : id;
  // Exactly one confirmation. This wipes the world AND its backups, and there
  // is no undo - so it is one click to reach, never one click to destroy.
  if (!confirm(`Delete "${name}"?\n\nThis erases the world and every backup of it, permanently. There is no undo.`)) return;
  state.busy.add(id);
  renderServers();
  try {
    const r = await api(`/servers/${id}?wipe=true`, { method: 'DELETE' });
    toast(`Deleted ${name}`, r.freed_mb ? `${r.freed_mb} MB reclaimed` : '');
  } catch (e) {
    toast('Delete failed', e.message, 'err');
  } finally {
    state.busy.delete(id);
    await refresh();
  }
}

/* ---------- modal plumbing ---------- */

function openModal(sel) {
  const modal = $(sel);
  modal._returnFocus = document.activeElement;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  $('.sidebar').inert = true;
  $('.workspace-main').inert = true;
  modal.querySelector('button, input, select, [tabindex]')?.focus();
}
function closeModal(sel) {
  const modal = $(sel);
  modal.hidden = true;
  if (!$('.modal-backdrop:not([hidden])')) {
    document.body.classList.remove('modal-open');
    $('.sidebar').inert = false;
    $('.workspace-main').inert = false;
  }
  modal._returnFocus?.focus();
  if (sel === '#detailModal') { state.stream?.close(); state.stream = null; state.detailId = null; }
}
$$('.modal-backdrop').forEach(bd => {
  bd.addEventListener('click', e => {
    if (e.target === bd || e.target.closest('[data-close]')) closeModal('#' + bd.id);
  });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') $$('.modal-backdrop:not([hidden])').forEach(bd => closeModal('#' + bd.id));
  if (e.key === 'Tab') {
    const modal = $('.modal-backdrop:not([hidden])');
    if (!modal) return;
    const items = $$('button, a[href], input, select, textarea, summary, [tabindex="0"]', modal).filter(el => !el.disabled && el.getClientRects().length);
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) {e.preventDefault();last?.focus();}
    else if (!e.shiftKey && document.activeElement === last) {e.preventDefault();first?.focus();}
  }
});

function wireTabs(navSel) {
  $(navSel).addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const root = tab.closest('.modal');
    $$('.tab', tab.parentElement).forEach(t => t.classList.toggle('active', t === tab));
    $$('.tab-panel', root).forEach(p => p.classList.toggle('active', p.dataset.panel === tab.dataset.tab));
    if (navSel === '#createTabs') {
      applyTabMemoryDefault(tab.dataset.tab);
      // The mods grid is populated on demand: without this the tab opens empty
      // even though thousands of mods match, because nothing had fired a search.
      if (tab.dataset.tab === 'mods' && !modHits.length) { state.modsOffset = 0; searchMods(true); }
      updateSummary();
    }
  });
}
wireTabs('#createTabs');
wireTabs('#detailTabs');

const activeCreateTab = () => $('#createTabs .tab.active').dataset.tab;
const activeInstallMode = () => ($('#installSeg .seg-btn.active') || {}).dataset?.mode || 'modpack';

// Modpack / adventure / plain live under one "Install a world" tab now, so the
// rest of the form logic asks for the effective choice rather than the tab.
function effectiveTab() {
  const t = activeCreateTab();
  return t === 'install' ? activeInstallMode() : t;
}

$('#installSeg').addEventListener('click', e => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  $$('#installSeg .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
  $$('#createModal .install-mode').forEach(p =>
    p.classList.toggle('active', p.dataset.mode === btn.dataset.mode));
  if (btn.dataset.mode === 'adventure') ensureWorlds();
  applyTabMemoryDefault(btn.dataset.mode);
  updateSummary();
});

// Modpacks are heavy and a plain world is not, so each tab starts at a sane
// amount rather than one global default. Stops overriding once you pick a value.
const TAB_MEMORY = { modpack: 12, curseforge: 12, mods: 8, adventure: 6, plain: 6, install: 12 };
let memoryTouched = false;
$('#optMemory').addEventListener('change', () => { memoryTouched = true; });

function applyTabMemoryDefault(tab) {
  if (memoryTouched) return;
  const want = String(TAB_MEMORY[tab] || 6);
  if ([...$('#optMemory').options].some(o => o.value === want)) $('#optMemory').value = want;
}

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
    syncWorldVersion();   // a map picked before this list arrived keeps its version
    $('#cfPackVersion').innerHTML = opts;
    $('#cfPackVersion').value = v.latest;
    $('#modsVersion').innerHTML = opts;
    $('#modsVersion').value = v.latest;
    const filter = '<option value="">Any MC version</option>' +
      v.releases.slice(0, 30).map(r => `<option value="${r}">${r}</option>`).join('');
    $('#mrVersionFilter').innerHTML = filter;
    $('#cwVersion').innerHTML = filter;
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
  // The basket used to survive between opens, so a new world silently
  // inherited the previous one's mods and the tick marks went stale.
  state.basket.clear();
  renderBasket();
  syncAllModTiles();
  modHits = [];
  $('#modsResults').innerHTML = '';
  clearPick($('#mrPick'));
  clearWorldPick();
  $('#cwResults').innerHTML = '';
  $('#cwQuery').value = '';
  $('#advOwn').open = false;
  // Clear the form too. These persist in the DOM, so the previous world's
  // MOTD, ops and uploads were silently applied to the next one.
  ['#optOps', '#optPort', '#advName', '#advWorld', '#plainName',
   '#cfName', '#cfUrl', '#cfZipUrl', '#modsName', '#modsQuery', '#mrQuery'
  ].forEach(sel => { const el = $(sel); if (el) el.value = ''; });
  state.uploadedPack = null;
  state.uploadedWorld = null;
  [['#cfDrop', '#cfDropText', 'Drop the server pack .zip here, or click to choose'],
   ['#advDrop', '#advDropText', 'Drop the map .zip here, or click to choose']
  ].forEach(([drop, label, idle]) => {
    const d = $(drop), l = $(label);
    if (d) d.classList.remove('has-file', 'over');
    if (l) l.textContent = idle;
  });

  // Always start a new world on "Install a world" rather than wherever the
  // last one was abandoned.
  $$('#createTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'install'));
  $$('#createModal .tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === 'install'));
  subdomainTouched = false;
  $('#optSubdomain').value = '';
  const domain = state.host.router_domain;
  $('#domainSuffix').textContent = domain ? '.' + domain : '';
  $('.addr-field').hidden = !domain;
  openModal('#createModal');
  loadMcVersions();
  memoryTouched = false;
  applyTabMemoryDefault(activeCreateTab());
  const s = await api('/settings').catch(() => ({}));
  state.cfKey = !!s.cf_api_key_set;
  $('#cfKeyNote').innerHTML = s.cf_api_key_set
    ? 'CurseForge is connected. Paste any modpack page URL below.'
    : '<strong>No CurseForge API key yet.</strong> Add one under Settings — CurseForge requires it. Modrinth and FTB packs need nothing.';
  $('#cfKeyNote').classList.toggle('warn', !s.cf_api_key_set);
  // CurseForge has the most packs, so it leads whenever it can be searched.
  $('#mrSource').value = state.cfKey ? 'curseforge' : 'modrinth';
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
['#cfSort', '#cfLoader', '#cfCategory'].forEach(sel =>
  $(sel).addEventListener('change', () => { state.mrOffset = 0; searchModrinth(true); }));
$('#mrMore').onclick = () => { state.mrOffset += 24; searchModrinth(false); };

const SOURCE_LABEL = { curseforge: 'CurseForge', modrinth: 'Modrinth', ftb: 'FTB' };

// One tile for every source, so the three catalogues look and behave alike.
function packTile(h, attrs, meta, blocked = false) {
  return `
    <button class="pack${blocked ? ' blocked' : ''}" ${attrs} data-title="${esc(h.title)}" data-icon="${esc(h.icon || '')}">
      ${h.icon ? `<img src="${esc(h.icon)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
      <div class="info">
        <div class="name">${esc(h.title)}</div>
        <div class="desc">${esc(h.description)}</div>
        <div class="dl">${meta}</div>
      </div>
    </button>`;
}

function cfTile(h, kind = 'modpack') {
  const meta = [nfmt(h.downloads) + ' downloads', h.versions[0] && 'MC ' + h.versions[0],
                h.loaders.map(l => LOADER_LABEL[l] || l).join(' / ')]
    .filter(Boolean).map(esc).join(' · ')
    + (h.auto ? '' : '<span class="tag" title="The author blocks automatic downloads">manual download</span>');
  return packTile(h, `data-cf="${h.id}" data-kind="${kind}" data-url="${esc(h.url || '')}" data-auto="${h.auto ? 1 : 0}" data-mc="${esc(h.versions[0] || '')}"`,
                  meta, !h.auto);
}

function searchError(src, e) {
  // Without a key CurseForge cannot be searched at all - say where to fix that.
  const needsKey = src === 'curseforge' && /API key/i.test(e.message);
  return `<div class="list-empty">${esc(e.message)}${needsKey
    ? '<br><button class="btn sm" data-open-settings style="margin-top:10px">Open Settings</button>' : ''}</div>`;
}

let cfCatsLoaded = false;
async function loadCfCategories() {
  if (cfCatsLoaded) return;
  cfCatsLoaded = true;
  try {
    const r = await api('/curseforge/categories?kind=modpack');
    $('#cfCategory').innerHTML = '<option value="">All categories</option>' +
      r.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  } catch { cfCatsLoaded = false; }
}

async function searchModrinth(reset) {
  const q = $('#mrQuery').value.trim();
  const v = $('#mrVersionFilter').value;
  const src = $('#mrSource').value;
  const box = $('#mrResults');
  // Typing fires a search per pause; an older, slower answer must not land
  // on top of a newer one.
  const seq = ++state.mrSeq;
  // FTB's catalogue is ~100 packs served whole, so it has no paging or
  // version facet - hide the controls that would do nothing there.
  $('#mrVersionFilter').hidden = src === 'ftb';
  $('#cfFilters').hidden = src !== 'curseforge';
  if (reset) {
    box.innerHTML = `<div class="list-empty"><span class="spinner"></span> Searching ${SOURCE_LABEL[src]}…</div>`;
    $('#mrMore').hidden = true;
  }

  let html = '', more = false;
  try {
    if (src === 'curseforge') {
      loadCfCategories();
      const p = new URLSearchParams({
        q, version: v, loader: $('#cfLoader').value, category: $('#cfCategory').value || 0,
        sort: $('#cfSort').value, offset: state.mrOffset, limit: 24,
      });
      const r = await api('/search/curseforge?' + p);
      if (seq !== state.mrSeq) return;
      html = r.hits.map(h => cfTile(h)).join('');
      more = r.hits.length === 24 && state.mrOffset + 24 < r.total;
      $('#mrCount').textContent = r.total >= 10000 ? '10,000+ packs'
        : `${r.total.toLocaleString()} pack${r.total === 1 ? '' : 's'}`;
    } else if (src === 'ftb') {
      const r = await api(`/search/ftb?q=${encodeURIComponent(q)}`);
      if (seq !== state.mrSeq) return;
      html = r.hits.map(h => packTile(h,
        `data-ftb="${h.id}" data-versions='${esc(JSON.stringify(h.versions))}'`,
        `${nfmt(h.downloads)} installs`)).join('');
    } else {
      const r = await api(`/search/modrinth?q=${encodeURIComponent(q)}&offset=${state.mrOffset}&version=${encodeURIComponent(v)}&limit=24`);
      if (seq !== state.mrSeq) return;
      html = r.hits.map(h => packTile(h, `data-slug="${esc(h.slug)}"`, `${nfmt(h.downloads)} downloads`)).join('');
      more = r.hits.length === 24;
    }
  } catch (e) {
    if (seq !== state.mrSeq) return;
    box.innerHTML = searchError(src, e);
    return;
  }
  if (reset) box.innerHTML = html || '<div class="list-empty">Nothing matched that search.</div>';
  else box.insertAdjacentHTML('beforeend', html);
  $('#mrMore').hidden = !more;
  markPicked();
}

// Keep the chosen pack highlighted when a new page or search brings it back.
function markPicked() {
  const p = state.pick;
  $$('#mrResults .pack').forEach(el => el.classList.toggle('selected', !!p && (
    (p.cf && el.dataset.cf === String(p.cf)) ||
    (p.ftb && el.dataset.ftb === String(p.ftb)) ||
    (p.slug && el.dataset.slug === p.slug))));
}

// The chosen pack, pinned above the grid. `sub` and `version` are HTML the
// caller has already escaped; `note` is a warning shown beneath them.
function showPick(bar, { icon, title, sub = '', version = '', note = '' }) {
  bar.hidden = false;
  bar.innerHTML = `
    ${icon ? `<img src="${esc(icon)}" alt="">` : '<div class="ph"></div>'}
    <div class="pick-main"><b>${esc(title)}</b><span class="pick-sub">${sub}</span></div>
    ${version ? `<div class="pick-version">${version}</div>` : ''}
    ${note ? `<div class="panel-note warn">${note}</div>` : ''}`;
}

function clearPick(bar) {
  bar.hidden = true;
  bar.innerHTML = '';
}

const LOADING_VERSIONS = '<label>Version</label><span class="pick-sub"><span class="spinner"></span> Loading versions…</span>';

$('#mrResults').addEventListener('click', async e => {
  if (e.target.closest('[data-open-settings]')) return $('#btnSettings').click();
  const pack = e.target.closest('.pack');
  if (!pack) return;
  $$('.pack', $('#mrResults')).forEach(p => p.classList.toggle('selected', p === pack));
  const bar = $('#mrPick');

  if (pack.dataset.cf) return pickCurseForge(pack);

  // FTB packs carry their version list inline - no second request needed.
  if (pack.dataset.ftb) {
    const versions = JSON.parse(pack.dataset.versions || '[]');
    state.pick = { ftb: Number(pack.dataset.ftb), title: pack.dataset.title, icon: pack.dataset.icon };
    state.pickVersions = [];
    showPick(bar, {
      icon: state.pick.icon, title: state.pick.title, sub: 'FTB',
      version: `<label for="mrVersion">Pack version</label>
        <select id="mrVersion">${versions.map((v, i) =>
          `<option value="${v.id}" ${i === 0 ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>`,
    });
    $('#mrVersion').addEventListener('change', updateSummary);
    updateSummary();
    return;
  }

  const pick = { slug: pack.dataset.slug, title: pack.dataset.title, icon: pack.dataset.icon };
  state.pick = pick;
  state.pickVersions = [];
  showPick(bar, { icon: pick.icon, title: pick.title, sub: 'Modrinth', version: LOADING_VERSIONS });
  updateSummary();

  // Pull the version list so the user can pin one, defaulting to newest release.
  let version;
  try {
    const r = await api(`/modrinth/${encodeURIComponent(pick.slug)}/versions`);
    if (state.pick !== pick) return;
    state.pickVersions = r.versions;
    version = r.versions.length
      ? `<label for="mrVersion">Pack version</label>
        <select id="mrVersion">${r.versions.map((v, i) => `
          <option value="${esc(v.id)}" ${i === 0 ? 'selected' : ''}>
            ${esc(v.version_number || v.name)} — MC ${esc(v.game_versions.join(', '))} ${v.type !== 'release' ? '(' + esc(v.type) + ')' : ''}
          </option>`).join('')}</select>`
      : '<span class="pick-sub">No published versions — the latest will be used.</span>';
  } catch (e) {
    if (state.pick !== pick) return;
    version = `<span class="pick-sub">Could not load versions: ${esc(e.message)}. The latest will be used.</span>`;
  }
  showPick(bar, { icon: pick.icon, title: pick.title, sub: 'Modrinth', version });
  $('#mrVersion')?.addEventListener('change', updateSummary);
  updateSummary();
});

function blockedNote(url, what = 'pack') {
  const page = url ? `<a href="${esc(url)}/files" target="_blank" rel="noopener">its CurseForge page</a>` : 'CurseForge';
  return what === 'pack'
    ? `<b>The author blocks automatic downloads</b>, so RamCraft cannot fetch this pack itself.
       Download its <b>Server Pack</b> from the Files tab on ${page}, then drop the zip in
       <b>Upload a pack</b>.<br><button class="btn sm" data-go-upload>Go to Upload a pack</button>`
    : `<b>The author blocks automatic downloads</b>, so RamCraft cannot fetch this map itself.
       Download it from ${page} and drop the .zip in instead.
       <br><button class="btn sm" data-go-own>Drop a map instead</button>`;
}

function cfPickSub(pick, f, label = 'CurseForge') {
  const bits = [label, f?.loader && LOADER_LABEL[f.loader], f?.size_mb && f.size_mb + ' MB download']
    .filter(Boolean).map(esc);
  if (pick.url) {
    bits.push(`<a href="${esc(pick.url)}${f ? '/files/' + f.id : ''}" target="_blank" rel="noopener">View on CurseForge ↗</a>`);
  }
  return bits.join(' · ');
}

async function pickCurseForge(pack) {
  const pick = {
    cf: Number(pack.dataset.cf), title: pack.dataset.title, icon: pack.dataset.icon,
    url: pack.dataset.url, auto: pack.dataset.auto === '1', mc: pack.dataset.mc,
  };
  state.pick = pick;
  state.pickVersions = [];
  const bar = $('#mrPick');
  if (!pick.auto) {
    showPick(bar, { icon: pick.icon, title: pick.title, sub: cfPickSub(pick), note: blockedNote(pick.url) });
    updateSummary();
    return;
  }
  showPick(bar, { icon: pick.icon, title: pick.title, sub: cfPickSub(pick), version: LOADING_VERSIONS });
  updateSummary();

  let files = [];
  try {
    files = (await api(`/curseforge/${pick.cf}/files`)).files;
  } catch (e) {
    if (state.pick !== pick) return;
    showPick(bar, {
      icon: pick.icon, title: pick.title, sub: cfPickSub(pick),
      version: `<span class="pick-sub">Could not load versions: ${esc(e.message)}. The newest release will be used.</span>`,
    });
    return;
  }
  if (state.pick !== pick) return;
  state.pickVersions = files;
  if (!files.length) {
    showPick(bar, { icon: pick.icon, title: pick.title, sub: cfPickSub(pick),
                    version: '<span class="pick-sub">No versions to install.</span>' });
    return;
  }
  // Same default the server picks: the newest stable release, not a beta.
  const def = files.find(f => f.type === 'release') || files[0];
  showPick(bar, {
    icon: pick.icon, title: pick.title, sub: cfPickSub(pick, def),
    version: `<label for="mrVersion">Pack version</label>
      <select id="mrVersion">${files.map(f => `
        <option value="${f.id}" ${f === def ? 'selected' : ''}>${esc(f.name)} — MC ${esc(f.mc || '?')}${f.type !== 'release' ? ' (' + esc(f.type) + ')' : ''}</option>`).join('')}</select>`,
    note: def.auto ? '' : blockedNote(pick.url),
  });
  // Only the details line changes; rebuilding the bar would steal focus from
  // the select mid-choice.
  $('#mrVersion').addEventListener('change', () => {
    $('#mrPick .pick-sub').innerHTML = cfPickSub(pick, currentCfFile());
    updateSummary();
  });
  updateSummary();
}

$('#mrPick').addEventListener('click', e => {
  if (!e.target.closest('[data-go-upload]')) return;
  const { title, mc } = state.pick || {};
  $('#createTabs [data-tab="curseforge"]').click();
  if (title && !$('#cfName').value.trim()) $('#cfName').value = title.slice(0, 40);
  // The server pack needs its Minecraft version to get the right Java, and
  // CurseForge already said which it is.
  if (mc && [...$('#cfPackVersion').options].some(o => o.value === mc)) $('#cfPackVersion').value = mc;
  $('#createModal .modal-scroll').scrollTop = 0;
  updateSummary();
});

function currentPickVersion() {
  const sel = $('#mrVersion');
  if (!sel) return null;
  return state.pickVersions.find(v => v.id === sel.value) || null;
}

// CurseForge file ids are numbers; the select hands back strings.
function currentCfFile() {
  const sel = $('#mrVersion');
  return sel ? state.pickVersions.find(f => String(f.id) === sel.value) || null : null;
}

/* ---------- CurseForge worlds ---------- */

let cwTimer;
$('#cwQuery').addEventListener('input', () => {
  clearTimeout(cwTimer);
  cwTimer = setTimeout(() => { state.cwOffset = 0; searchWorlds(true); }, 320);
});
$('#cwVersion').addEventListener('change', () => { state.cwOffset = 0; searchWorlds(true); });
$('#cwMore').onclick = () => { state.cwOffset += 12; searchWorlds(false); };

// Runs when the Adventure map mode opens. Without a key the map has to come
// from elsewhere, so that route is shown open instead.
function ensureWorlds() {
  $('#cwBrowser').hidden = !state.cfKey;
  if (!state.cfKey) { $('#advOwn').open = true; return; }
  if (!$('#cwResults').childElementCount) { state.cwOffset = 0; searchWorlds(true); }
}

async function searchWorlds(reset) {
  const box = $('#cwResults');
  const seq = ++state.cwSeq;
  if (reset) {
    box.innerHTML = '<div class="list-empty"><span class="spinner"></span> Searching CurseForge worlds…</div>';
    $('#cwMore').hidden = true;
  }
  try {
    const p = new URLSearchParams({
      kind: 'world', q: $('#cwQuery').value.trim(), version: $('#cwVersion').value,
      offset: state.cwOffset, limit: 12,
    });
    const r = await api('/search/curseforge?' + p);
    if (seq !== state.cwSeq) return;
    const html = r.hits.map(h => cfTile(h, 'world')).join('');
    if (reset) box.innerHTML = html || '<div class="list-empty">Nothing matched that search.</div>';
    else box.insertAdjacentHTML('beforeend', html);
    $('#cwMore').hidden = !(r.hits.length === 12 && state.cwOffset + 12 < r.total);
    $$('.pack', box).forEach(el =>
      el.classList.toggle('selected', !!state.cfWorld && el.dataset.cf === String(state.cfWorld.id)));
  } catch (e) {
    if (seq !== state.cwSeq) return;
    box.innerHTML = searchError('curseforge', e);
  }
}

$('#cwResults').addEventListener('click', e => {
  if (e.target.closest('[data-open-settings]')) return $('#btnSettings').click();
  const tile = e.target.closest('.pack');
  if (tile) pickWorld(tile);
});

$('#cwPick').addEventListener('click', e => {
  if (!e.target.closest('[data-go-own]')) return;
  // They are about to upload this same map, so its name and version stay.
  const { title, mc } = state.cfWorld || {};
  clearWorldPick();
  if (title && !$('#advName').value.trim()) $('#advName').value = title.slice(0, 40);
  if (mc) {
    const sel = $('#advVersion');
    if (![...sel.options].some(o => o.value === mc)) sel.insertAdjacentHTML('afterbegin', `<option value="${esc(mc)}">${esc(mc)}</option>`);
    sel.value = mc;
  }
  $('#advOwn').open = true;
  $('#advDrop').scrollIntoView({ block: 'center' });
  updateSummary();
});

async function pickWorld(tile) {
  const w = {
    id: Number(tile.dataset.cf), title: tile.dataset.title, icon: tile.dataset.icon,
    url: tile.dataset.url, auto: tile.dataset.auto === '1', mc: tile.dataset.mc,
  };
  state.cfWorld = w;
  state.cwFiles = [];
  $$('#cwResults .pack').forEach(el => el.classList.toggle('selected', el === tile));
  // A picked world replaces any map that was uploaded or pasted.
  clearOwnMap();
  const nameEl = $('#advName');
  if (!nameEl.value.trim() || nameEl.dataset.auto === '1') {
    nameEl.value = w.title.slice(0, 40);
    nameEl.dataset.auto = '1';
  }
  const bar = $('#cwPick');
  const sub = f => cfPickSub(w, f, 'CurseForge world');
  if (!w.auto) {
    showPick(bar, { icon: w.icon, title: w.title, sub: sub(), note: blockedNote(w.url, 'world') });
    updateSummary();
    return;
  }
  showPick(bar, { icon: w.icon, title: w.title, sub: sub(), version: LOADING_VERSIONS });
  updateSummary();

  let files = [];
  try {
    files = (await api(`/curseforge/${w.id}/files`)).files;
  } catch (e) {
    if (state.cfWorld !== w) return;
    showPick(bar, { icon: w.icon, title: w.title, sub: sub(),
      version: `<span class="pick-sub">Could not load versions: ${esc(e.message)}. The newest will be used.</span>` });
    return;
  }
  if (state.cfWorld !== w) return;
  state.cwFiles = files;
  if (!files.length) {
    showPick(bar, { icon: w.icon, title: w.title, sub: sub(),
                    version: '<span class="pick-sub">No versions to install.</span>' });
    return;
  }
  const def = files.find(f => f.type === 'release') || files[0];
  showPick(bar, {
    icon: w.icon, title: w.title, sub: sub(def),
    version: `<label for="cwFile">Map version</label>
      <select id="cwFile">${files.map(f => `
        <option value="${f.id}" ${f === def ? 'selected' : ''}>${esc(f.name)} — MC ${esc(f.mc || '?')}</option>`).join('')}</select>`,
    note: def.auto ? '' : blockedNote(w.url, 'world'),
  });
  $('#cwFile').addEventListener('change', () => {
    $('#cwPick .pick-sub').innerHTML = sub(currentCwFile());
    syncWorldVersion();
    updateSummary();
  });
  syncWorldVersion();
  updateSummary();
}

function currentCwFile() {
  const sel = $('#cwFile');
  return sel ? state.cwFiles.find(f => String(f.id) === sel.value) || null : null;
}

// Adventure maps are built for one exact version, and CurseForge says which -
// so set it rather than leave the user to read it off the map's page.
function syncWorldVersion() {
  const f = currentCwFile();
  if (!f?.mc) return;
  const sel = $('#advVersion');
  if (![...sel.options].some(o => o.value === f.mc)) {
    sel.insertAdjacentHTML('afterbegin', `<option value="${esc(f.mc)}">${esc(f.mc)}</option>`);
  }
  sel.value = f.mc;
}

function clearWorldPick() {
  state.cfWorld = null;
  state.cwFiles = [];
  clearPick($('#cwPick'));
  $$('#cwResults .pack').forEach(el => el.classList.remove('selected'));
  // Only a name that came from the pick goes with it; a typed one stays.
  const nameEl = $('#advName');
  if (nameEl.dataset.auto === '1') nameEl.value = '';
  delete nameEl.dataset.auto;
}

function clearOwnMap() {
  state.uploadedWorld = null;
  $('#advWorld').value = '';
  $('#advDrop').classList.remove('has-file', 'over');
  $('#advDropText').textContent = 'Drop the map .zip here, or click to choose';
}

$('#advName').addEventListener('input', () => { delete $('#advName').dataset.auto; });
$('#advWorld').addEventListener('input', () => {
  if ($('#advWorld').value.trim() && state.cfWorld) clearWorldPick();
});

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

state.uploadedPack = null;   // server pack zip  {path, name, size_mb}
state.uploadedWorld = null;  // adventure map zip

function wireDrop({ drop, input, label, idle, nameField, onDone }) {
  const dropEl = $(drop), inputEl = $(input), labelEl = $(label);
  if (!dropEl) return;

  dropEl.onclick = () => inputEl.click();
  ['dragenter', 'dragover'].forEach(ev =>
    dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev =>
    dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.remove('over'); }));
  dropEl.addEventListener('drop', e => {
    const f = e.dataTransfer?.files?.[0];
    if (f) send(f);
  });
  inputEl.onchange = () => { if (inputEl.files[0]) send(inputEl.files[0]); };

  async function send(file) {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast('That is not a .zip', 'It needs to be a zip archive.', 'err');
      return;
    }
    labelEl.innerHTML = `<span class="spinner"></span> Uploading ${esc(file.name)}…`;
    const body = new FormData();
    body.append('file', file);
    try {
      // Not the api() helper: this is multipart, not JSON.
      const res = await fetch('/api/uploads', { method: 'POST', body });
      signedOutGuard(res);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'upload failed');
      onDone(data);
      dropEl.classList.add('has-file');
      labelEl.textContent = `${data.name} — ${data.size_mb} MB ✓`;
      if (nameField && !$(nameField).value.trim()) {
        $(nameField).value = data.name.replace(/\.zip$/i, '').replace(/[-_]/g, ' ').slice(0, 40);
      }
      updateSummary();
    } catch (e) {
      labelEl.textContent = idle;
      dropEl.classList.remove('has-file');
      onDone(null);
      toast('Upload failed', e.message, 'err');
    }
  }
}

wireDrop({
  drop: '#cfDrop', input: '#cfFile', label: '#cfDropText', nameField: '#cfName',
  idle: 'Drop the server pack .zip here, or click to choose',
  onDone: d => { state.uploadedPack = d; },
});
wireDrop({
  drop: '#advDrop', input: '#advFile', label: '#advDropText', nameField: '#advName',
  idle: 'Drop the map .zip here, or click to choose',
  // Your own map replaces a picked CurseForge one.
  onDone: d => { state.uploadedWorld = d; if (d) clearWorldPick(); },
});

/* ---------- pick-your-own-mods ---------- */

state.basket = new Map();   // slug -> {slug, title, icon}
state.modsOffset = 0;

function renderBasket() {
  const box = $('#modsBasket');
  const n = state.basket.size;
  box.hidden = !n;
  // Empty it rather than just hiding it, or the previous world's chips sit
  // in the DOM waiting to reappear.
  if (!n) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="basket-head"><b>${n}</b> mod${n > 1 ? 's' : ''} picked
      <button class="btn sm ghost" id="basketClear">Clear</button></div>
    <div class="basket-items">${[...state.basket.values()].map(m => `
      <span class="chip" data-slug="${esc(m.slug)}">
        ${m.icon ? `<img src="${esc(m.icon)}" alt="">` : ''}${esc(m.title)}
        <button aria-label="Remove">&times;</button>
      </span>`).join('')}</div>`;
  $('#basketClear').onclick = () => { state.basket.clear(); renderBasket(); syncAllModTiles(); updateSummary(); };
}

$('#modsBasket').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (chip && e.target.tagName === 'BUTTON') {
    state.basket.delete(chip.dataset.slug);
    renderBasket(); syncAllModTiles(); updateSummary();
  }
});

let modHits = [];
function renderModHits() {
  $('#modsResults').innerHTML = modHits.map(h => {
    const picked = state.basket.has(h.slug);
    const clientOnly = h.server_side === 'unsupported';
    return `
      <button class="pack ${picked ? 'selected' : ''}" data-slug="${esc(h.slug)}"
              data-title="${esc(h.title)}" data-icon="${esc(h.icon || '')}">
        ${h.icon ? `<img src="${esc(h.icon)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
        <div class="info">
          <div class="name">${esc(h.title)}${picked ? ' ✓' : ''}</div>
          <div class="desc">${esc(h.description)}</div>
          <div class="dl">${nfmt(h.downloads)} downloads${clientOnly ? ' · client-side only' : ''}</div>
        </div>
      </button>`;
  }).join('') || '<div class="list-empty">Nothing matched that search.</div>';
}

let modsTimer;
$('#modsQuery').addEventListener('input', () => {
  clearTimeout(modsTimer);
  modsTimer = setTimeout(() => { state.modsOffset = 0; searchMods(true); }, 320);
});
$('#modsLoader').addEventListener('change', () => { state.modsOffset = 0; searchMods(true); updateSummary(); });
$('#modsVersion').addEventListener('change', () => { state.modsOffset = 0; searchMods(true); updateSummary(); });
$('#modsName').addEventListener('input', updateSummary);
$('#modsMore').onclick = () => { state.modsOffset += 24; searchMods(false); };

async function searchMods(reset) {
  const q = $('#modsQuery').value.trim();
  const v = $('#modsVersion').value;
  const l = $('#modsLoader').value;
  const box = $('#modsResults');
  if (reset) box.innerHTML = '<div class="list-empty"><span class="spinner"></span> Searching mods…</div>';
  try {
    const r = await api(`/search/mods?q=${encodeURIComponent(q)}&offset=${state.modsOffset}` +
                        `&version=${encodeURIComponent(v)}&loader=${encodeURIComponent(l)}&limit=24`);
    modHits = reset ? r.hits : modHits.concat(r.hits);
    renderModHits();
    $('#modsMore').hidden = r.hits.length < 24;
  } catch (e) {
    box.innerHTML = `<div class="list-empty">Could not reach Modrinth — ${esc(e.message)}</div>`;
  }
}

$('#modsResults').addEventListener('click', e => {
  const el = e.target.closest('.pack');
  if (!el) return;
  const slug = el.dataset.slug;
  if (state.basket.has(slug)) state.basket.delete(slug);
  else state.basket.set(slug, { slug, title: el.dataset.title, icon: el.dataset.icon });
  // Toggle this one tile in place. Re-rendering the whole grid would detach
  // every other tile mid-click, so rapid picks land on dead nodes.
  syncModTile(el, state.basket.has(slug));
  renderBasket(); updateSummary();
});

function syncModTile(el, picked) {
  el.classList.toggle('selected', picked);
  const name = el.querySelector('.name');
  const base = el.dataset.title;
  if (name) name.textContent = picked ? base + ' ✓' : base;
}

// Keep tiles in sync when the basket is changed from outside the grid
// (a chip's × or Clear), without rebuilding it.
function syncAllModTiles() {
  $$('#modsResults .pack').forEach(el => syncModTile(el, state.basket.has(el.dataset.slug)));
}

function currentCreateName() {
  const tab = effectiveTab();
  if (tab === 'modpack') return state.pick ? state.pick.title : '';
  if (tab === 'mods') return $('#modsName').value.trim();
  if (tab === 'adventure') return $('#advName').value.trim();
  if (tab === 'plain') return $('#plainName').value.trim();
  return $('#cfName').value.trim();
}

function updateSummary() {
  const tab = effectiveTab();
  const btn = $('#btnCreate');
  const sum = $('#createSummary');

  if (!subdomainTouched) $('#optSubdomain').value = slugify(currentCreateName());

  let ok = false, text = '';
  if (tab === 'modpack') {
    const p = state.pick;
    if (p?.cf) {
      const f = currentCfFile();
      const blocked = !p.auto || (f && !f.auto);
      ok = !blocked;
      text = `<b>${esc(p.title)}</b> · CurseForge${f ? ' · ' + esc(f.name) + ' · MC ' + esc(f.mc || '?') : ''}`
        + (blocked ? ' &nbsp;·&nbsp; <b style="color:var(--amber)">needs a manual download</b>' : '');
    } else if (p) {
      const v = currentPickVersion();
      const sel = $('#mrVersion');
      text = p.ftb
        ? `<b>${esc(p.title)}</b> · FTB${sel ? ' · ' + esc(sel.selectedOptions[0].textContent.trim()) : ''}`
        : `<b>${esc(p.title)}</b>${v ? ' · ' + esc(v.version_number) + ' · MC ' + esc(v.game_versions[0] || '?') : ''}`;
      ok = true;
    } else text = 'Pick a modpack to begin';
  } else if (tab === 'adventure' && state.cfWorld) {
    const w = state.cfWorld;
    const f = currentCwFile();
    const name = $('#advName').value.trim();
    if (!w.auto || (f && !f.auto)) {
      text = `<b>${esc(w.title)}</b> &nbsp;·&nbsp; <b style="color:var(--amber)">needs a manual download</b>`;
    } else {
      ok = !!name;
      text = ok ? `<b>${esc(name)}</b> · CurseForge world · ${esc($('#advType').value)} ${esc($('#advVersion').value)}`
                : 'Give the server a name';
    }
  } else if (tab === 'mods') {
    const n = state.basket.size;
    ok = !!($('#modsName').value.trim() && n);
    text = ok
      ? `<b>${esc($('#modsName').value.trim())}</b> · ${n} mod${n > 1 ? 's' : ''} · ${esc($('#modsLoader').value)} ${esc($('#modsVersion').value)}`
      : (n ? 'Give the server a name' : 'Pick at least one mod');
  } else if (tab === 'adventure') {
    const typed = $('#advWorld').value.trim();
    const world = state.uploadedWorld ? state.uploadedWorld.name : typed;
    ok = !!($('#advName').value.trim() && world);
    text = ok ? `<b>${esc($('#advName').value.trim())}</b> · ${esc($('#advType').value)} ${esc($('#advVersion').value)}`
              : 'Name the server and add a world .zip';
    // Map sites hand out page links, not files, and block server-side fetches -
    // pasting one downloads an HTML page and the server dies on "Unsupported
    // archive type: text/html". Catch it here instead.
    if (!state.uploadedWorld && typed) {
      const looksDirect = /\.zip(\?|$)/i.test(typed);
      if (!looksDirect) {
        text += ' &nbsp;·&nbsp; <b style="color:var(--amber)">that is a page link, not a .zip — download it and drop it above</b>';
        ok = false;
      }
    }
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
['#advName', '#advWorld', '#advType', '#advVersion', '#plainName', '#plainType', '#cfZipUrl', '#cfPackVersion', '#modsName',
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
  return spec;
}

$('#btnCreate').onclick = async () => {
  const tab = effectiveTab();
  const spec = sharedSpec();
  if (tab === 'modpack' && state.pick?.cf) {
    // The server re-reads the file from CurseForge and takes the Minecraft
    // version from it, so a stale page can never pick the wrong Java.
    const f = currentCfFile();
    Object.assign(spec, {
      kind: 'curseforge',
      name: state.pick.title,
      cf_mod_id: state.pick.cf,
      cf_file_id: f ? f.id : null,
      icon: state.pick.icon || null,
    });
    if (f?.mc) spec.mc_version = f.mc;
  } else if (tab === 'modpack' && state.pick?.ftb) {
    Object.assign(spec, {
      kind: 'ftb',
      name: state.pick.title,
      ftb_id: state.pick.ftb,
      ftb_version_id: $('#mrVersion') ? Number($('#mrVersion').value) : null,
      icon: state.pick.icon || null,
      source_label: 'FTB: ' + state.pick.title,
    });
  } else if (tab === 'modpack') {
    const v = currentPickVersion();
    Object.assign(spec, {
      kind: 'modrinth',
      name: state.pick.title,
      modpack: state.pick.slug,
      icon: state.pick.icon || null,
      source_label: 'Modrinth: ' + state.pick.slug,
    });
    if (v) { spec.modpack_version = v.id; spec.mc_version = v.game_versions[0]; }
  } else if (tab === 'mods') {
    Object.assign(spec, {
      kind: 'custom',
      name: $('#modsName').value.trim(),
      loader: $('#modsLoader').value,
      mc_version: $('#modsVersion').value,
      mods: [...state.basket.keys()],
      source_label: `${state.basket.size} hand-picked mods`,
    });
  } else if (tab === 'adventure' && state.cfWorld) {
    // Resolved to a download link on the server, where the API key lives.
    const f = currentCwFile();
    Object.assign(spec, {
      kind: $('#advType').value,
      name: $('#advName').value.trim(),
      cf_world_id: state.cfWorld.id,
      cf_world_file_id: f ? f.id : null,
      mc_version: $('#advVersion').value,
      icon: state.cfWorld.icon || null,
    });
  } else if (tab === 'adventure') {
    Object.assign(spec, {
      kind: $('#advType').value,
      name: $('#advName').value.trim(),
      world_url: state.uploadedWorld ? state.uploadedWorld.path : $('#advWorld').value.trim(),
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
    ${((sp.mods && sp.mods.length) || s.kind === 'modrinth') ? `
    <div class="field">
      <label>Play this world</label>
      <p class="hint" style="margin:0 0 9px">${sp.mods && sp.mods.length
        ? `This world runs ${sp.mods.length} hand-picked mods.`
        : 'This world runs a Modrinth modpack.'}
        Download the pack and open it in the <b>Modrinth app</b> (or Prism, ATLauncher,
        MultiMC). It installs the exact mods the server runs <b>and adds this server to your
        Multiplayer list</b>, so there is nothing to type.</p>
      <a class="btn primary sm" href="/api/servers/${id}/mrpack" download>
        <svg class="ico"><use href="#i-archive"/></svg>Download &amp; play</a>
    </div>` : ''}
    ${s.kind === 'curseforge' && sp.cf_mod_id && sp.cf_file_id ? `
    <div class="field">
      <label>Play this world</label>
      <p class="hint" style="margin:0 0 9px">This world runs <b>${esc(sp.cf_file_name || 'a CurseForge pack')}</b>.
        Download the pack and import it in the <b>CurseForge app</b> (Create Custom Profile →
        Import) or Prism. It installs that exact version <b>and adds this server to your
        Multiplayer list</b>, so there is nothing to type. The first download pulls the pack
        from CurseForge, so give it a minute.</p>
      <a class="btn primary sm" href="/api/servers/${id}/cfpack" download>
        <svg class="ico"><use href="#i-archive"/></svg>Download &amp; play</a>
      ${sp.cf_url ? `<a class="btn sm ghost" href="${esc(sp.cf_url)}/files/${esc(sp.cf_file_id)}" target="_blank" rel="noopener">Open on CurseForge ↗</a>` : ''}
    </div>` : ''}
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
        <input id="cfgPort" type="number" min="25566" max="25640" value="${esc(s.port)}">
      </div>
    </div>
    <p class="hint" style="margin:-8px 0 15px">This port is for direct LAN connections.
      Your server hostname already works without a port; 25565 is reserved for the router.</p>
    <div class="field">
      <label for="cfgOps">Operators</label>
      <input id="cfgOps" value="${esc(sp.ops || '')}" placeholder="comma separated — the owner is always op">
    </div>
    <p class="panel-note warn">Changing memory, players, difficulty or ops rebuilds the
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
      ? keys.sort().map(k => `<div class="route"><span>${esc(k)}</span><small>${esc(typeof routes[k] === 'string' ? routes[k] : routes[k]?.backend || 'Route available')}</small></div>`).join('')
      : '<p class="hint">No routes yet — start a server and it appears here automatically.</p>';

  api('/me').then(m => { $('#setUser').textContent = m.user; }).catch(() => {});

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

$('#btnChangePw').onclick = async () => {
  const current = $('#pwCurrent').value;
  const next = $('#pwNew').value;
  if (!current || !next) return toast('Fill in both passwords', '', 'warn');
  if (next.length < 10) return toast('Too short', 'Use at least 10 characters.', 'warn');
  if (next !== $('#pwAgain').value) return toast('The new passwords differ', 'Type the same one twice.', 'warn');
  const btn = $('#btnChangePw');
  btn.disabled = true;
  try {
    await api('/account/password', { method: 'PUT', body: { current, new: next } });
    ['#pwCurrent', '#pwNew', '#pwAgain'].forEach(s => { $(s).value = ''; });
    toast('Password changed', 'Every other device is now signed out.');
  } catch (e) {
    toast('Password not changed', e.message, 'err');
  } finally {
    btn.disabled = false;
  }
};

$('#btnSignOut').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.replace('/login');
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
    <p class="panel-note">Open <b>Minecraft Java Edition → Multiplayer → Add Server</b>.
      Paste your world’s address, select <b>Done</b>, then join.</p>
    <h3 class="join-heading">Choose your connection</h3>
    <p class="hint">At home, the LAN address connects directly. Use the hostname when playing from outside your home, or when local DNS is configured.</p>
    <div class="join-worlds">${state.servers.map(s => `
      <section class="join-world"><h3>${esc(s.name)}</h3>
        <label>On your home network</label><div class="addr"><span class="a">${esc(s.connect.lan)}</span><button data-join-copy="${esc(s.connect.lan)}">Copy LAN</button></div>
        ${s.connect.public ? `<label>Server hostname / public address</label><div class="addr"><span class="a">${esc(s.connect.public)}</span><button data-join-copy="${esc(s.connect.public)}">Copy address</button></div>` : ''}
      </section>`).join('') || '<p class="hint">Create a world first. Its connection addresses will appear here.</p>'}</div>
    <p class="panel-note">Playing a modpack? CurseForge, Modrinth and hand-built packs have <b>Download &amp; play</b> under <b>Manage → Settings</b> — it installs the exact pack the server runs and puts the server in your Multiplayer list. For other packs, install the same pack and version in your launcher.</p>
    <details class="join-troubleshooting"><summary>Hostname not working at home?</summary><p>Your router may not support connecting to its public address from inside the house. Use the LAN address above, or configure your computer to use a working local DNS resolver.</p><p>The host is <code>${esc(h.lan_host || 'not available')}</code>. Keep your normal router as the default gateway.</p></details>`;
  $$('[data-join-copy]', $('#joinBody')).forEach(btn => btn.onclick = () => copy(btn.dataset.joinCopy, 'Server address'));
  openModal('#joinModal');
};

/* ---------- boot ---------- */

// Shortcuts around the page ("Discover modpacks", the banner, the guide cards)
// still name the old flat tabs. Modpack / adventure / plain are now modes
// inside "Install a world", so resolve those to tab + segment.
const INSTALL_MODES = new Set(['modpack', 'adventure', 'plain']);

function openCreateAt(target) {
  const tab = INSTALL_MODES.has(target) ? 'install' : target;
  $(`#createTabs [data-tab="${tab}"]`)?.click();
  if (tab === 'install') $(`#installSeg [data-mode="${target}"]`)?.click();
}

$$('[data-create-tab]').forEach(btn => btn.addEventListener('click', async () => {
  await openCreate();
  openCreateAt(btn.dataset.createTab);
}));
$('[data-guide="join"]').onclick = () => $('#btnConnectHelp').click();
$('[data-guide="backups"]').onclick = () => {
  toast('Snapshots live with each world', 'Choose Manage on a world, then open Snapshots to create, download, or restore a backup.');
  $('#worldsTitle').scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block:'center'});
};
$$('.modal').forEach((modal, i) => {
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const title = $('h2', modal);
  if (title) {if (!title.id) title.id = `dialog-title-${i}`;modal.setAttribute('aria-labelledby', title.id);}
});
$$('.icon-btn[data-close]').forEach(btn => btn.setAttribute('aria-label','Close dialog'));

refresh();
// Nothing running means nothing changes, so poll lazily; speed up only when
// something is live or mid-transition. Saves a tunnel round trip every 5s.
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  const busy = state.busy.size ||
    state.servers.some(s => ['online', 'starting', 'unhealthy'].includes(s.status.state));
  if (busy || Date.now() - (state.lastPoll || 0) > 15000) {
    state.lastPoll = Date.now();
    refresh();
  }
}, 5000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });

// Switching source resets paging and re-runs the search.
$('#mrSource').addEventListener('change', () => {
  state.mrOffset = 0; state.pick = null; clearPick($('#mrPick'));
  searchModrinth(true); updateSummary();
});
