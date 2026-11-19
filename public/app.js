const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  lang: 'en',
  view: 'overview',
  data: null,
  timer: null,
  filter: { log: 'all', keys: '' },
  busy: false
};

const TITLES = {
  overview: ['overview.title', 'overview.sub'],
  keys: ['keys.title', 'keys.sub'],
  access: ['access.title', 'access.sub'],
  logs: ['logs.title', 'logs.sub'],
  settings: ['settings.title', 'settings.sub']
};

function t(key, vars) {
  const dict = window.I18N[S.lang] || window.I18N.en;
  let value = dict[key] ?? window.I18N.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) value = value.replace(`{${k}}`, v);
  }
  return value;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function num(value, digits = 0) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1e6) return new Intl.NumberFormat(S.lang === 'ru' ? 'ru-RU' : 'en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  return new Intl.NumberFormat(S.lang === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: digits }).format(n);
}

function time(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString(S.lang === 'ru' ? 'ru-RU' : 'en-GB', { hour12: false });
}

function duration(ms) {
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' ' + t('common.seconds');
  return Math.round(ms / 60000) + ' min';
}

function applyLang() {
  document.documentElement.lang = S.lang;
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const btn of $$('#lang-switch button')) btn.classList.toggle('is-active', btn.dataset.lang === S.lang);
  renderTitles();
  if (S.data) renderAll();
}

function renderTitles() {
  const [titleKey, subKey] = TITLES[S.view] || TITLES.overview;
  $('#page-title').textContent = t(titleKey);
  $('#page-sub').textContent = t(subKey);
}

function setView(view) {
  S.view = view;
  for (const section of $$('.view')) section.classList.toggle('hidden', section.id !== `view-${view}`);
  for (const btn of $$('.nav-item')) btn.classList.toggle('is-active', btn.dataset.view === view);
  renderTitles();
  if (S.data) renderView();
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

/* ---------- canvas ---------- */

function fitCanvas(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function smoothPath(ctx, points) {
  if (!points.length) return;
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const cx = (x0 + x1) / 2;
    ctx.bezierCurveTo(cx, y0, cx, y1, x1, y1);
  }
}

function drawSpark(canvas, values, color) {
  if (!canvas) return;
  const { ctx, w, h } = fitCanvas(canvas);
  const data = values.slice(-90);
  const max = Math.max(1, ...data);
  ctx.clearRect(0, 0, w, h);
  const pts = data.map((v, i) => [(i / Math.max(1, data.length - 1)) * w, h - 3 - (v / max) * (h - 8)]);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + '4d');
  grad.addColorStop(1, color + '00');
  ctx.beginPath();
  smoothPath(ctx, pts);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  smoothPath(ctx, pts);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

function drawTraffic(canvas, reqSeries, tokSeries) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 6;
  const padR = 6;
  const padT = 10;
  const padB = 6;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (innerH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  const req = reqSeries.slice(-300);
  const tok = tokSeries.slice(-300);
  const maxReq = Math.max(1, ...req);
  const maxTok = Math.max(1, ...tok);

  const toPoints = (values, max) =>
    values.map((v, i) => [padL + (i / Math.max(1, values.length - 1)) * innerW, padT + innerH - (v / max) * innerH]);

  const reqPts = toPoints(req, maxReq);
  const grad = ctx.createLinearGradient(0, padT, 0, padT + innerH);
  grad.addColorStop(0, 'rgba(76,141,255,0.34)');
  grad.addColorStop(1, 'rgba(76,141,255,0)');
  ctx.beginPath();
  smoothPath(ctx, reqPts);
  ctx.lineTo(padL + innerW, padT + innerH);
  ctx.lineTo(padL, padT + innerH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  smoothPath(ctx, reqPts);
  ctx.strokeStyle = '#5f9bff';
  ctx.lineWidth = 1.7;
  ctx.stroke();

  ctx.beginPath();
  smoothPath(ctx, toPoints(tok, maxTok));
  ctx.strokeStyle = 'rgba(51,214,196,0.8)';
  ctx.lineWidth = 1.3;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/* ---------- render ---------- */

function renderAll() {
  renderShell();
  renderView();
}

function renderShell() {
  const s = S.data;
  $('#side-keys').textContent = s.summary.keys;
}

function renderView() {
  switch (S.view) {
    case 'overview':
      renderOverview();
      break;
    case 'keys':
      renderKeys();
      break;
    case 'access':
      renderAccess();
      break;
    case 'logs':
      renderLogs();
      break;
    case 'settings':
      fillSettings();
      break;
  }
}

function renderOverview() {
  const d = S.data;
  const totals = d.totals;
  const series = d.series || { req: [], tokens: [] };
  const lastReq = series.req[series.req.length - 1] || 0;
  const tokenWindow = (series.tokens || []).slice(-60).reduce((a, b) => a + b, 0);
  const successRate = totals.req ? (totals.ok / totals.req) * 100 : null;

  $('#m-rps').textContent = num(lastReq);
  $('#m-tpm').textContent = num(tokenWindow);
  $('#m-success').textContent = successRate === null ? '—' : successRate.toFixed(1) + '%';
  $('#m-healthy').textContent = `${d.summary.healthy}/${d.summary.keys}`;
  $('#m-capacity').textContent = `${num(d.summary.capacityRpm)} rpm · ${num(d.summary.capacityTpm)} tpm`;

  drawSpark($('[data-spark="req"]'), series.req || [], '#4c8dff');
  drawSpark($('[data-spark="tokens"]'), series.tokens || [], '#33d6c4');

  drawTraffic($('#traffic'), series.req || [], series.tokens || []);

  const poolList = $('#pool-list');
  const keys = [...d.keys].sort((a, b) => b.rpm - a.rpm).slice(0, 8);
  $('#pool-sub').textContent = d.keys.length
    ? `${d.summary.healthy} / ${d.summary.keys} active · ${num(d.summary.rpm)} rpm now`
    : '';
  if (!keys.length) {
    poolList.innerHTML = `<div class="empty">${esc(t('pool.empty'))}</div>`;
  } else {
    poolList.innerHTML = keys
      .map((k) => {
        const share = k.rpmLimit ? Math.min(100, (k.rpm / k.rpmLimit) * 100) : 0;
        const cls = share > 85 ? 'is-danger' : share > 60 ? 'is-warn' : '';
        const state = k.coolingMs > 0 ? 'chip-warn' : k.status === 'active' ? 'chip-ok' : 'chip-mut';
        const stateText = k.coolingMs > 0 ? t('status.cooling') : t(`status.${k.status}`) || k.status;
        return `<div class="pool-row">
          <div class="pool-name">${esc(k.label)}</div>
          <div class="pool-share"><span class="chip ${state}">${esc(stateText)}</span></div>
          <div class="pool-meta">${num(k.rpm)} / ${k.rpmLimit ? num(k.rpmLimit) : '∞'} rpm · ${num(k.tpm)} tpm</div>
          <div class="bar" style="grid-column:1/2"><i class="${cls}" style="width:${share}%"></i></div>
        </div>`;
      })
      .join('');
  }

  const logs = (d.logs || []).slice(0, 8);
  const recentBody = $('#recent-body');
  recentBody.innerHTML = logs.map(logRow).join('');
  $('#recent-empty').classList.toggle('hidden', logs.length > 0);
}

function statusChip(status, ok) {
  if (status === 0) return `<span class="chip chip-err">ERR</span>`;
  if (ok) return `<span class="chip chip-ok">${status}</span>`;
  return `<span class="chip chip-err">${status}</span>`;
}

function logRow(entry) {
  const ok = entry.status >= 200 && entry.status < 300;
  return `<tr>
    <td class="mono">${esc(time(entry.ts))}</td>
    <td>${esc(entry.client || '—')}</td>
    <td class="mono">${esc(entry.model || '—')}</td>
    <td>${statusChip(entry.status, ok)}</td>
    <td class="mono">${entry.ms ? duration(entry.ms) : '—'}</td>
    <td class="mono">${entry.tin || entry.tout ? `${num(entry.tin)} / ${num(entry.tout)}` : '—'}</td>
  </tr>`;
}

function logRowFull(entry) {
  const ok = entry.status >= 200 && entry.status < 300;
  return `<tr>
    <td class="mono">${esc(time(entry.ts))}</td>
    <td>${esc(entry.client || '—')}</td>
    <td class="mono">${esc(entry.model || '—')}</td>
    <td><span class="chip chip-mut">${esc(entry.provider || '—')}</span></td>
    <td class="td-key">${esc(entry.key || '—')}</td>
    <td>${statusChip(entry.status, ok)}</td>
    <td class="mono">${entry.ms ? duration(entry.ms) : '—'}</td>
    <td class="mono">${entry.tin || entry.tout ? `${num(entry.tin)} / ${num(entry.tout)}` : '—'}</td>
  </tr>`;
}

function renderKeys() {
  const d = S.data;
  const filter = S.filter.keys.trim().toLowerCase();
  const keys = d.keys.filter(
    (k) => !filter || k.label.toLowerCase().includes(filter) || k.masked.toLowerCase().includes(filter)
  );
  $('#keys-count').textContent = t('keys.count', { n: d.keys.length });
  $('#keys-empty').textContent = t('keys.empty');
  $('#keys-empty').classList.toggle('hidden', keys.length > 0);

  $('#keys-body').innerHTML = keys
    .map((k) => {
      const rpmShare = k.rpmLimit ? Math.min(100, (k.rpm / k.rpmLimit) * 100) : 0;
      const tpmShare = k.tpmLimit ? Math.min(100, (k.tpm / k.tpmLimit) * 100) : 0;
      const dot = k.coolingMs > 0 ? 'is-warn' : k.status === 'active' ? 'is-ok' : 'is-off';
      const title =
        k.coolingMs > 0
          ? `${t('status.cooling')} ${Math.ceil(k.coolingMs / 1000)}s`
          : t(`status.${k.status}`);
      return `<tr>
        <td>
          <div class="cell-label"><span class="status-dot ${dot}" title="${esc(title)}"></span>${esc(k.label)}</div>
          <div class="cell-sub">${esc(k.provider)}</div>
        </td>
        <td class="td-key">${esc(k.masked)}</td>
        <td>
          <div class="mono">${num(k.rpm)}<span class="muted"> / ${k.rpmLimit ? num(k.rpmLimit) : '∞'}</span></div>
          <div class="bar" style="width:72px"><i class="${rpmShare > 85 ? 'is-danger' : rpmShare > 60 ? 'is-warn' : ''}" style="width:${rpmShare}%"></i></div>
        </td>
        <td>
          <div class="mono">${num(k.tpm)}<span class="muted"> / ${k.tpmLimit ? num(k.tpmLimit) : '∞'}</span></div>
          <div class="bar" style="width:72px"><i class="${tpmShare > 85 ? 'is-danger' : tpmShare > 60 ? 'is-warn' : ''}" style="width:${tpmShare}%"></i></div>
        </td>
        <td class="mono">${k.avgLatency ? duration(k.avgLatency) : '—'}</td>
        <td>
          <div class="td-actions">
            <button class="btn btn-sm btn-icon" data-act="probe" data-id="${esc(k.id)}" title="${esc(t('action.probe'))}" aria-label="${esc(t('action.probe'))}">
              <svg viewBox="0 0 24 24"><path d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z"/></svg>
            </button>
            <button class="btn btn-sm btn-icon" data-act="toggle" data-id="${esc(k.id)}" data-status="${esc(k.status)}" title="${esc(k.status === 'active' ? t('action.disable') : t('action.enable'))}" aria-label="${esc(k.status === 'active' ? t('action.disable') : t('action.enable'))}">
              <svg viewBox="0 0 24 24"><path d="M11 3h2v9h-2V3Zm5.7 2.3 1.4 1.4a8 8 0 1 1-12.2 0l1.4-1.4a6 6 0 1 0 9.4 0Z"/></svg>
            </button>
            <button class="btn btn-sm btn-icon btn-danger-ghost" data-act="delete" data-id="${esc(k.id)}" title="${esc(t('action.delete'))}" aria-label="${esc(t('action.delete'))}">
              <svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

function renderAccess() {
  const d = S.data;
  $('#clients-count').textContent = `${d.clients.length}`;
  $('#clients-empty').classList.toggle('hidden', d.clients.length > 0);
  $('#client-list').innerHTML = d.clients
    .map(
      (c) => `<div class="client">
        <div>
          <div class="client-name">${esc(c.name)}</div>
          <div class="small muted">${esc(t('access.today'))}: <span class="mono">${num(c.day?.tokens || 0)}</span>
            ${c.dailyTokens ? ' / ' + num(c.dailyTokens) : ''} · ${num(c.totals.req)} req</div>
        </div>
        <div class="client-actions">
          <button class="btn btn-sm" data-client="copy" data-key="${esc(c.key)}">${esc(t('access.copy'))}</button>
          <button class="btn btn-sm" data-client="rotate" data-id="${esc(c.id)}">${esc(t('access.rotate'))}</button>
          <button class="btn btn-sm btn-danger-ghost" data-client="delete" data-id="${esc(c.id)}">${esc(t('action.delete'))}</button>
        </div>
        <div class="client-key"><span>${esc(c.key)}</span></div>
        <div class="client-stats">
          <span class="chip chip-mut">${esc(t('access.rpm'))}: ${c.rpm || t('common.unlimited')}</span>
          <span class="chip chip-mut">${esc(t('access.daily'))}: ${c.dailyTokens ? num(c.dailyTokens) : t('common.unlimited')}</span>
          ${c.status === 'disabled' ? `<span class="chip chip-err">${esc(t('status.disabled'))}</span>` : ''}
        </div>
      </div>`
    )
    .join('');
}

function renderLogs() {
  const d = S.data;
  const logs = (d.logs || []).filter((l) => {
    if (S.filter.log === 'ok') return l.status >= 200 && l.status < 300;
    if (S.filter.log === 'fail') return !(l.status >= 200 && l.status < 300);
    return true;
  });
  $('#logs-body').innerHTML = logs.map(logRowFull).join('');
  $('#logs-empty').classList.toggle('hidden', logs.length > 0);
}

function fillSettings() {
  const form = $('#settings-form');
  if (!form || form.contains(document.activeElement)) return;
  const s = S.data.settings;
  for (const field of ['maxAttempts', 'deadlineMs', 'cooldownBaseMs', 'cooldownMaxMs', 'sampleSize', 'upstreamTimeoutMs', 'streamIdleMs']) {
    const input = form.elements.namedItem(field);
    if (input && document.activeElement !== input) input.value = s[field] ?? '';
  }
  const lang = form.elements.namedItem('defaultLang');
  if (lang && document.activeElement !== lang) lang.value = s.defaultLang || 'en';
  const routes = form.elements.namedItem('routes');
  if (routes && document.activeElement !== routes) {
    routes.value = Object.entries(s.modelRoutes || {})
      .map(([k, v]) => `${k} = ${v}`)
      .join('\n');
  }
  const aliases = form.elements.namedItem('aliases');
  if (aliases && document.activeElement !== aliases) {
    aliases.value = Object.entries(s.aliases || {})
      .map(([k, v]) => `${k} = ${v}`)
      .join('\n');
  }
  const models = form.elements.namedItem('models');
  if (models && document.activeElement !== models) models.value = (s.models || []).join(', ');
}

/* ---------- api ---------- */

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) {
    location.reload();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || t('common.error'));
  return data;
}

async function load() {
  try {
    S.data = await api('/admin/api/state');
    renderShell();
    if (S.view === 'overview' || S.view === 'logs') {
      renderView();
    } else {
      const view = $(`#view-${S.view}`);
      if (view && !view.contains(document.activeElement)) renderView();
    }
  } catch (err) {
    if (err.message !== 'unauthorized') console.warn(err);
  }
}

/* ---------- ui helpers ---------- */

function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'err' ? 'toast-err' : 'toast-ok'}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'all .25s ease';
    setTimeout(() => el.remove(), 260);
  }, 2600);
}

let modalResolve = null;

function confirmAction(text) {
  $('#modal-text').textContent = text;
  $('#modal').classList.remove('hidden');
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

$('#modal-ok').addEventListener('click', () => {
  $('#modal').classList.add('hidden');
  modalResolve?.(true);
  modalResolve = null;
});

$('#modal-cancel').addEventListener('click', () => {
  $('#modal').classList.add('hidden');
  modalResolve?.(false);
  modalResolve = null;
});

$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') {
    $('#modal').classList.add('hidden');
    modalResolve?.(false);
  }
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(t('common.copied'));
}

/* ---------- events ---------- */

for (const btn of $$('.nav-item')) {
  btn.addEventListener('click', () => setView(btn.dataset.view));
}

for (const btn of $$('#lang-switch button')) {
  btn.addEventListener('click', () => {
    S.lang = btn.dataset.lang;
    localStorage.setItem('hydra_lang', S.lang);
    applyLang();
  });
}

for (const btn of $$('#log-filter button')) {
  btn.addEventListener('click', () => {
    S.filter.log = btn.dataset.filter;
    for (const b of $$('#log-filter button')) b.classList.toggle('is-active', b === btn);
    renderLogs();
  });
}

$('#keys-search').addEventListener('input', (e) => {
  S.filter.keys = e.target.value;
  renderKeys();
});

$('#keys-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.act === 'probe') {
      btn.disabled = true;
      btn.classList.add('is-loading');
      const result = await api(`/admin/api/keys/${id}/probe`, 'POST', {});
      toast(result.ok ? `OK · ${result.status} · ${result.ms} ms` : `FAIL · ${result.status || 'net'} · ${result.message || ''}`, result.ok ? 'ok' : 'err');
      btn.disabled = false;
      btn.classList.remove('is-loading');
      await load();
    } else if (btn.dataset.act === 'toggle') {
      await api(`/admin/api/keys/${id}`, 'PATCH', { status: btn.dataset.status === 'active' ? 'disabled' : 'active' });
      await load();
    } else if (btn.dataset.act === 'delete') {
      if (!(await confirmAction(t('common.deleteKey')))) return;
      await api(`/admin/api/keys/${id}`, 'DELETE');
      await load();
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#client-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-client]');
  if (!btn) return;
  try {
    if (btn.dataset.client === 'copy') {
      await copyText(btn.dataset.key);
    } else if (btn.dataset.client === 'rotate') {
      if (!(await confirmAction(t('common.rotateClient')))) return;
      const res = await api(`/admin/api/clients/${btn.dataset.id}`, 'PATCH', { rotate: true });
      toast(t('common.saved'));
      await copyText(res.key);
      await load();
    } else if (btn.dataset.client === 'delete') {
      if (!(await confirmAction(t('common.deleteClient')))) return;
      await api(`/admin/api/clients/${btn.dataset.id}`, 'DELETE');
      await load();
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#import-btn').addEventListener('click', async () => {
  const text = $('#import-text').value;
  if (!text.trim()) return;
  try {
    const res = await api('/admin/api/keys/bulk', 'POST', {
      text,
      provider: $('#import-provider').value,
      baseUrl: $('#import-baseurl').value.trim() || undefined
    });
    $('#import-text').value = '';
    toast(t('common.saved') + ` · ${res.created}`);
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#keys-clear').addEventListener('click', async () => {
  if (!(await confirmAction(t('common.deleteAllKeys')))) return;
  try {
    await api('/admin/api/keys', 'DELETE');
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#client-create').addEventListener('click', async () => {
  const models = $('#client-models').value.split(/[\s,]+/).filter(Boolean);
  try {
    await api('/admin/api/clients', 'POST', {
      name: $('#client-name').value.trim() || 'client',
      rpm: Number($('#client-rpm').value) || 0,
      dailyTokens: Number($('#client-daily').value) || 0,
      models
    });
    $('#client-name').value = '';
    $('#client-models').value = '';
    toast(t('common.saved'));
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = {};
  for (const field of ['maxAttempts', 'deadlineMs', 'cooldownBaseMs', 'cooldownMaxMs', 'sampleSize', 'upstreamTimeoutMs', 'streamIdleMs']) {
    payload[field] = Number(form.elements.namedItem(field).value) || 0;
  }
  payload.defaultLang = form.elements.namedItem('defaultLang').value;
  payload.modelRoutes = Object.fromEntries(
    form.elements
      .namedItem('routes')
      .value.split('\n')
      .map((line) => line.split('=').map((s) => s.trim()))
      .filter((parts) => parts[0] && parts[1])
  );
  payload.aliases = Object.fromEntries(
    form.elements
      .namedItem('aliases')
      .value.split('\n')
      .map((line) => line.split('=').map((s) => s.trim()))
      .filter((parts) => parts[0] && parts[1])
  );
  payload.models = form.elements
    .namedItem('models')
    .value.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    await api('/admin/api/settings', 'POST', payload);
    toast(t('common.saved'));
    await load();
    fillSettings();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    await api('/admin/api/password', 'POST', {
      current: form.elements.namedItem('current').value,
      next: form.elements.namedItem('next').value
    });
    toast(t('settings.pwChanged'));
    form.reset();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#logout').addEventListener('click', async () => {
  await fetch('/admin/api/logout', { method: 'POST' });
  location.reload();
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#login-password').value;
  const error = $('#login-error');
  error.textContent = '';
  try {
    const res = await fetch('/admin/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      error.textContent = data.error === 'invalid password' ? t('login.error') : data.error || t('common.error');
      return;
    }
    start();
  } catch {
    error.textContent = t('common.error');
  }
});

/* ---------- boot ---------- */

let started = false;

async function start() {
  if (started) {
    await load();
    return;
  }
  started = true;
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await load();
  clearInterval(S.timer);
  S.timer = setInterval(() => {
    if (!document.hidden) load();
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load();
  });
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (S.data && S.view === 'overview') renderOverview();
  }, 160);
});

(async function boot() {
  let session = { authed: false, defaultLang: 'en' };
  try {
    session = await fetch('/admin/api/session').then((r) => r.json());
  } catch {
    /* offline */
  }
  S.lang = localStorage.getItem('hydra_lang') || session.defaultLang || 'en';
  applyLang();
  if (session.authed) {
    start();
  } else {
    $('#login').classList.remove('hidden');
    $('#login-password').focus();
  }
})();