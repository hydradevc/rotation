const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  lang: 'en',
  view: 'overview',
  data: null,
  timer: null,
  paused: false,
  busy: false,
  filter: { log: 'all', keys: '', sort: 'default' },
  selected: new Set(),
  settingsTab: 'engine',
  session: null,
  warnedSecrets: false
};

const TITLES = {
  overview: ['overview.title', 'overview.sub'],
  playground: ['play.title', 'play.sub'],
  keys: ['keys.title', 'keys.sub'],
  access: ['access.title', 'access.sub'],
  logs: ['logs.title', 'logs.sub'],
  analytics: ['an.title', 'an.sub'],
  settings: ['settings.title', 'settings.sub'],
  docs: ['docs.title', 'docs.sub']
};

const ENDPOINTS = [
  ['POST', '/v1/chat/completions', 'OpenAI chat, streaming'],
  ['POST', '/v1/embeddings', 'OpenAI embeddings'],
  ['POST', '/v1/messages', 'Anthropic messages, streaming'],
  ['POST', '/v1/messages/count_tokens', 'Anthropic token count'],
  ['GET', '/v1/models', 'Advertised models'],
  ['GET', '/healthz', 'Liveness'],
  ['GET', '/metrics', 'Prometheus'],
  ['GET', '/openapi.json', 'OpenAPI 3.1']
];

function t(key, vars) {
  const dict = window.I18N[S.lang] || window.I18N.en;
  let value = dict[key] ?? window.I18N.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) value = value.replace(`{${k}}`, v);
  return value;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function num(value, digits = 0) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1e6) {
    return new Intl.NumberFormat(S.lang === 'ru' ? 'ru-RU' : 'en-US', {
      notation: 'compact',
      maximumFractionDigits: 1
    }).format(n);
  }
  return new Intl.NumberFormat(S.lang === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: digits }).format(n);
}

function time(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString(S.lang === 'ru' ? 'ru-RU' : 'en-GB', { hour12: false });
}

function duration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' ' + t('common.seconds');
  return Math.round(ms / 60000) + ' min';
}

function applyLang() {
  document.documentElement.lang = S.lang;
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const btn of $$('#lang-switch button')) btn.classList.toggle('is-active', btn.dataset.lang === S.lang);
  $('#logs-pause').textContent = S.paused ? t('logs.resume') : t('logs.pause');
  renderTitles();
  renderDocs();
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
  window.scrollTo({ top: 0 });
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
  if (!canvas) return;
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
  $('#side-keys').textContent = S.data.summary.keys;
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
    case 'analytics':
      renderAnalytics();
      break;
    case 'settings':
      renderSettings();
      break;
    case 'docs':
      renderDocs();
      break;
    case 'playground':
      renderPlaygroundOptions();
      break;
  }
}

function renderOverview() {
  const d = S.data;
  const series = d.series || { req: [], tokens: [] };
  const metrics = d.metrics || { p50: 0, p95: 0, p99: 0, errorRate: 0, errors: 0 };
  const lastReq = series.req[series.req.length - 1] || 0;
  const tokenWindow = (series.tokens || []).slice(-60).reduce((a, b) => a + b, 0);
  const successRate = d.totals.req ? (d.totals.ok / d.totals.req) * 100 : null;

  $('#m-rps').textContent = num(lastReq);
  $('#m-tpm').textContent = num(tokenWindow);
  $('#m-success').textContent = successRate === null ? '—' : successRate.toFixed(1) + '%';
  $('#m-latency').textContent = metrics.p95 ? metrics.p95 + ' ms' : '—';
  $('#m-healthy').textContent = `${d.summary.healthy}/${d.summary.keys}`;
  $('#m-capacity').textContent = `${num(d.summary.capacityRpm)} rpm · ${num(d.summary.capacityTpm)} tpm`;
  $('#m-errors').textContent = num(metrics.errors || 0);
  $('#m-errors-hint').textContent = `${(metrics.errorRate || 0).toFixed(1)}% ${t('m.errors.hint')}`;

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
  $('#recent-body').innerHTML = logs.map(logRow).join('');
  $('#recent-empty').classList.toggle('hidden', logs.length > 0);
  const wrap = $('#recent-body').closest('.table-wrap');
  if (wrap) wrap.classList.toggle('hidden', logs.length === 0);
}

function statusChip(status, ok) {
  if (status === 0) return `<span class="chip chip-err">ERR</span>`;
  return `<span class="chip ${ok ? 'chip-ok' : 'chip-err'}">${status}</span>`;
}

function logRow(entry) {
  const ok = entry.status >= 200 && entry.status < 300;
  return `<tr>
    <td class="mono">${esc(time(entry.ts))}</td>
    <td>${esc(entry.client || '—')}</td>
    <td class="mono">${esc(entry.model || '—')}</td>
    <td>${statusChip(entry.status, ok)}</td>
    <td class="mono">${duration(entry.ms)}</td>
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
    <td class="mono">${duration(entry.ms)}</td>
    <td class="mono">${entry.tin || entry.tout ? `${num(entry.tin)} / ${num(entry.tout)}` : '—'}${entry.err ? ` <span class="err-dot" title="${esc(entry.err)}"></span>` : ''}</td>
  </tr>`;
}

function sortedKeys(list) {
  const arr = [...list];
  switch (S.filter.sort) {
    case 'rpm':
      arr.sort((a, b) => b.rpm - a.rpm);
      break;
    case 'latency':
      arr.sort((a, b) => b.avgLatency - a.avgLatency);
      break;
    case 'fails':
      arr.sort((a, b) => b.fails - a.fails);
      break;
    case 'label':
      arr.sort((a, b) => a.label.localeCompare(b.label));
      break;
  }
  return arr;
}

function renderKeys() {
  const d = S.data;
  const filter = S.filter.keys.trim().toLowerCase();
  const all = sortedKeys(
    d.keys.filter((k) => !filter || k.label.toLowerCase().includes(filter) || k.masked.toLowerCase().includes(filter))
  );

  $('#keys-count').textContent = t('keys.count', { n: d.keys.length });
  $('#keys-empty').textContent = t('keys.empty');
  $('#keys-empty').classList.toggle('hidden', all.length > 0);
  $('#keys-body').closest('.table-wrap').classList.toggle('hidden', all.length === 0);

  $('#keys-body').innerHTML = all
    .map((k) => {
      const rpmShare = k.rpmLimit ? Math.min(100, (k.rpm / k.rpmLimit) * 100) : 0;
      const tpmShare = k.tpmLimit ? Math.min(100, (k.tpm / k.tpmLimit) * 100) : 0;
      const dot = k.coolingMs > 0 ? 'is-warn' : k.status === 'active' ? 'is-ok' : 'is-off';
      const title =
        k.coolingMs > 0 ? `${t('status.cooling')} ${Math.ceil(k.coolingMs / 1000)}s` : t(`status.${k.status}`);
      return `<tr class="${S.selected.has(k.id) ? 'is-selected' : ''}">
        <td class="th-check"><input type="checkbox" data-select="${esc(k.id)}" ${S.selected.has(k.id) ? 'checked' : ''} /></td>
        <td>
          <div class="cell-label"><span class="status-dot ${dot}" title="${esc(title)}"></span>${esc(k.label)}</div>
          <div class="cell-sub">${esc(k.provider)}${k.model ? ' · ' + esc(k.model) : ''}${k.lastError ? ' · <span class="err-text" title="' + esc(k.lastError) + '">' + esc(k.lastError.slice(0, 28)) + '</span>' : ''}</div>
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
            <button class="btn btn-sm btn-icon" data-act="edit" data-id="${esc(k.id)}" title="${esc(t('action.edit'))}" aria-label="${esc(t('action.edit'))}">
              <svg viewBox="0 0 24 24"><path d="M4 20h4l10-10-4-4L4 16v4Zm14.7-13.3 1.6 1.6a1 1 0 0 1 0 1.4L19 11l-4-4 1.3-1.3a1 1 0 0 1 1.4 0Z"/></svg>
            </button>
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

  renderBulkbar();
}

function renderBulkbar() {
  const bar = $('#keys-bulkbar');
  bar.classList.toggle('hidden', S.selected.size === 0);
  $('#keys-selected-count').textContent = t('keys.selected', { n: S.selected.size });
  const all = $$('#keys-body input[data-select]');
  const allChecked = all.length > 0 && all.every((el) => el.checked);
  $('#keys-select-all').checked = allChecked;
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
            ${c.dailyTokens ? ' / ' + num(c.dailyTokens) : ''} · ${num(c.totals.req)} req
            ${c.rpm ? `· ${num(c.rpmUsed)} / ${num(c.rpm)} rpm` : ''}</div>
        </div>
        <div class="client-actions">
          <button class="btn btn-sm" data-client="copy" data-id="${esc(c.id)}">${esc(t('access.copy'))}</button>
          <button class="btn btn-sm" data-client="edit" data-id="${esc(c.id)}">${esc(t('action.edit'))}</button>
          <button class="btn btn-sm" data-client="rotate" data-id="${esc(c.id)}">${esc(t('access.rotate'))}</button>
          <button class="btn btn-sm btn-danger-ghost" data-client="delete" data-id="${esc(c.id)}">${esc(t('action.delete'))}</button>
        </div>
        <div class="client-key"><span>${esc(c.key)}</span></div>
        <div class="client-stats">
          <span class="chip chip-mut">${esc(t('access.rpm'))}: ${c.rpm || t('common.unlimited')}</span>
          <span class="chip chip-mut">${esc(t('access.daily'))}: ${c.dailyTokens ? num(c.dailyTokens) : t('common.unlimited')}</span>
          ${c.models.length ? c.models.map((m) => `<span class="chip chip-accent">${esc(m)}</span>`).join('') : ''}
          ${c.status === 'disabled' ? `<span class="chip chip-err">${esc(t('status.disabled'))}</span>` : ''}
        </div>
      </div>`
    )
    .join('');
}

function renderLogs() {
  const d = S.data;
  const query = (S.filter.logQuery || '').trim();
  const logs = (d.logs || []).filter((l) => {
    if (S.filter.log === 'ok') return l.status >= 200 && l.status < 300;
    if (S.filter.log === 'fail') return !(l.status >= 200 && l.status < 300);
    return true;
  }).filter((l) => {
    if (!query) return true;
    return [l.client, l.model, l.key, l.provider, l.err]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(query));
  });
  $('#logs-body').innerHTML = logs.map(logRowFull).join('');
  $('#logs-empty').classList.toggle('hidden', logs.length > 0);
  $('#logs-body').closest('.table-wrap').classList.toggle('hidden', logs.length === 0);
}

function renderAnalytics() {
  const d = S.data;
  const m = d.metrics || { p50: 0, p95: 0, p99: 0, requests: 0, errors: 0, topModels: [], topClients: [], topErrors: [] };
  $('#an-p50').textContent = m.p50 ? m.p50 + ' ms' : '—';
  $('#an-p95').textContent = m.p95 ? m.p95 + ' ms' : '—';
  $('#an-p99').textContent = m.p99 ? m.p99 + ' ms' : '—';
  $('#an-requests').textContent = `${num(m.requests)} req · ${num(m.errors)} err`;

  drawTraffic($('#analytics-chart'), d.series.req || [], d.series.tokens || []);

  const max = Math.max(m.p50, m.p95, m.p99, 1);
  $('#an-bars').innerHTML = ['p50', 'p95', 'p99']
    .map((key) => {
      const value = m[key] || 0;
      const width = Math.max(2, Math.round((value / max) * 100));
      return `<div class="pbar">
        <span class="pbar-label">${esc(t('an.' + key))}</span>
        <div class="bar"><i style="width:${width}%"></i></div>
        <span class="pbar-value mono">${value} ms</span>
      </div>`;
    })
    .join('');

  const listHtml = (items) =>
    items && items.length
      ? items
          .map(
            (item) => `<div class="list-row">
              <span class="list-name">${esc(item.name)}</span>
              <span class="list-count mono">${num(item.count)}</span>
            </div>`
          )
          .join('')
      : `<div class="empty">${esc(t('an.empty'))}</div>`;

  $('#an-models').innerHTML = listHtml(m.topModels);
  $('#an-clients').innerHTML = listHtml(m.topClients);
  $('#an-errors').innerHTML = listHtml(m.topErrors);
}

function renderSettings() {
  fillSettings();
  renderSessions();
  renderSecurity();
}

function renderSecurity() {
  const sec = S.data?.security || {};
  const tls = Boolean(sec.tls);
  const rows = [
    {
      label: t('settings.sealed'),
      value: sec.sealedState ? t('settings.sealedYes') : t('settings.sealedNo'),
      ok: Boolean(sec.sealedState)
    },
    {
      label: t('settings.unreadable'),
      value: String(sec.unreadableSecrets || 0),
      ok: !sec.unreadableSecrets
    },
    {
      label: t('settings.transport'),
      value: tls ? t('settings.transportTls') : t('settings.transportPlain'),
      ok: tls,
      hint: tls ? '' : t('settings.transportHint')
    }
  ];
  $('#security-list').innerHTML = rows
    .map(
      (row) => `<div class="list-row">
        <div>
          <span class="list-name">${esc(row.label)}</span>
          ${row.hint ? `<div class="small muted">${esc(row.hint)}</div>` : ''}
        </div>
        <span class="chip ${row.ok ? 'chip-ok' : 'chip-warn'}">${esc(row.value)}</span>
      </div>`
    )
    .join('');
}

async function renderSessions() {
  try {
    const res = await fetch('/admin/api/sessions');
    if (!res.ok) return;
    const data = await res.json();
    $('#session-list').innerHTML = data.sessions
      .map(
        (s) => `<div class="list-row">
          <div>
            <span class="mono">${esc(s.id)}…</span>
            <span class="chip ${s.current ? 'chip-ok' : 'chip-mut'}">${esc(s.ip)}</span>
            <div class="small muted">${esc(new Date(s.created).toLocaleString())}</div>
          </div>
          ${s.current ? '' : `<button class="btn btn-sm btn-danger-ghost" data-revoke="${esc(s.id)}">${esc(t('settings.revoke'))}</button>`}
        </div>`
      )
      .join('');
  } catch {
    /* sessions are best-effort */
  }
}

function fillSettings() {
  const form = $('#settings-form');
  if (!form || form.contains(document.activeElement)) return;
  const s = S.data.settings;
  const numeric = [
    'maxAttempts',
    'deadlineMs',
    'queueWaitMs',
    'cooldownBaseMs',
    'cooldownMaxMs',
    'circuitThreshold',
    'circuitCooldownMs',
    'sampleSize',
    'upstreamTimeoutMs',
    'streamIdleMs',
    'autoDisableAfterAuthFails'
  ];
  for (const field of numeric) {
    const input = form.elements.namedItem(field);
    if (input && document.activeElement !== input) input.value = s[field] ?? '';
  }
  const policy = form.elements.namedItem('policy');
  if (policy) policy.value = s.policy || 'smart';
  const lang = form.elements.namedItem('defaultLang');
  if (lang) lang.value = s.defaultLang || 'en';
  const routes = form.elements.namedItem('routes');
  if (routes) {
    routes.value = Object.entries(s.modelRoutes || {})
      .map(([k, v]) => `${k} = ${v}`)
      .join('\n');
  }
  const aliases = form.elements.namedItem('aliases');
  if (aliases) {
    aliases.value = Object.entries(s.aliases || {})
      .map(([k, v]) => `${k} = ${v}`)
      .join('\n');
  }
  const models = form.elements.namedItem('models');
  if (models) models.value = (s.models || []).join(', ');
  const cors = form.elements.namedItem('cors');
  if (cors) cors.checked = Boolean(s.cors);
  const origin = form.elements.namedItem('corsOrigin');
  if (origin) origin.value = s.corsOrigin || '*';
  const webhook = form.elements.namedItem('webhookUrl');
  if (webhook) webhook.value = s.webhookUrl || '';
}

function renderDocs() {
  const base = location.origin;
  const curl = `curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer hydra_sk_..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'`;
  const python = `from openai import OpenAI

client = OpenAI(base_url="${base}/v1", api_key="hydra_sk_...")

print(client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "hello"}],
).choices[0].message.content)`;

  const curlEl = $('#doc-curl');
  if (curlEl) curlEl.textContent = curl;
  const pyEl = $('#doc-python');
  if (pyEl) pyEl.textContent = python;
  const bo = $('#doc-base-openai');
  if (bo) bo.textContent = base + '/v1';
  const ba = $('#doc-base-anthropic');
  if (ba) ba.textContent = base;
  const m = $('#doc-metrics');
  if (m) m.textContent = base + '/metrics';
  const o = $('#doc-openapi');
  if (o) o.textContent = base + '/openapi.json';

  const endpoints = $('#doc-endpoints');
  if (endpoints) {
    endpoints.innerHTML = ENDPOINTS.map(
      ([method, path, desc]) => `<tr>
        <td><span class="chip ${method === 'GET' ? 'chip-mut' : 'chip-accent'}">${method}</span></td>
        <td class="mono">${esc(path)}</td>
        <td class="muted">${esc(desc)}</td>
      </tr>`
    ).join('');
  }
}

function renderPlaygroundOptions() {
  const ids = new Set([
    ...(S.data?.settings?.models || []),
    ...Object.keys(S.data?.settings?.aliases || {}),
    ...(S.data?.keys || []).map((k) => k.model).filter(Boolean)
  ]);
  $('#play-models').innerHTML = [...ids].map((id) => `<option value="${esc(id)}"></option>`).join('');
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
  if (S.paused) return;
  try {
    S.data = await api('/admin/api/state');
    if (!S.warnedSecrets && S.data.security?.unreadableSecrets > 0) {
      S.warnedSecrets = true;
      toast(`${t('settings.unreadable')}: ${S.data.security.unreadableSecrets}`, 'err');
    }
    renderShell();
    const view = $(`#view-${S.view}`);
    const focused = view && view.contains(document.activeElement);
    if (S.view === 'overview' || S.view === 'logs' || S.view === 'analytics') {
      renderView();
    } else if (!focused) {
      renderView();
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
  }, 2800);
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

function openKeyModal(key) {
  const form = $('#key-form');
  form.elements.namedItem('provider').value = key.provider;
  form.elements.namedItem('label').value = key.label;
  form.elements.namedItem('key').value = '';
  form.elements.namedItem('baseUrl').value = key.baseUrl;
  form.elements.namedItem('weight').value = key.weight;
  form.elements.namedItem('rpm').value = key.rpmLimit;
  form.elements.namedItem('tpm').value = key.tpmLimit;
  form.elements.namedItem('model').value = key.model || '';
  form.dataset.keyId = key.id;
  $('#key-modal').classList.remove('hidden');
  form.elements.namedItem('label').focus();
}

function openClientModal(client) {
  const form = $('#client-form');
  form.elements.namedItem('name').value = client.name;
  form.elements.namedItem('rpm').value = client.rpm;
  form.elements.namedItem('dailyTokens').value = client.dailyTokens;
  form.elements.namedItem('models').value = (client.models || []).join(', ');
  form.elements.namedItem('active').checked = client.status !== 'disabled';
  form.dataset.clientId = client.id;
  $('#client-modal').classList.remove('hidden');
}

for (const btn of $$('[data-close-modal]')) {
  btn.addEventListener('click', () => btn.closest('.modal').classList.add('hidden'));
}

/* ---------- events ---------- */

for (const btn of $$('.nav-item')) btn.addEventListener('click', () => setView(btn.dataset.view));
for (const btn of $$('[data-view-jump]')) btn.addEventListener('click', () => setView(btn.dataset.viewJump));

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

$('#logs-search').addEventListener('input', (e) => {
  S.filter.logQuery = e.target.value.toLowerCase();
  const logs = (S.data.logs || []).filter((l) => {
    const ok = l.status >= 200 && l.status < 300;
    if (S.filter.log === 'ok' && !ok) return false;
    if (S.filter.log === 'fail' && ok) return false;
    if (!S.filter.logQuery) return true;
    return [l.client, l.model, l.key, l.provider, l.err]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(S.filter.logQuery));
  });
  $('#logs-body').innerHTML = logs.map(logRowFull).join('');
  $('#logs-empty').classList.toggle('hidden', logs.length > 0);
});

$('#logs-pause').addEventListener('click', () => {
  S.paused = !S.paused;
  $('#logs-pause').textContent = S.paused ? t('logs.resume') : t('logs.pause');
  $('#live-pill').classList.toggle('pill-paused', S.paused);
  $('#live-pill span:last-child').textContent = S.paused ? t('top.paused') : t('top.live');
  if (!S.paused) load();
});

$('#logs-csv').addEventListener('click', () => {
  window.location.href = '/admin/api/logs.csv';
});

$('#keys-search').addEventListener('input', (e) => {
  S.filter.keys = e.target.value;
  renderKeys();
});

$('#keys-sort').addEventListener('change', (e) => {
  S.filter.sort = e.target.value;
  renderKeys();
});

$('#keys-select-all').addEventListener('change', (e) => {
  const ids = $$('#keys-body input[data-select]').map((el) => el.dataset.select);
  if (e.target.checked) ids.forEach((id) => S.selected.add(id));
  else S.selected.clear();
  renderKeys();
});

$('#keys-body').addEventListener('change', (e) => {
  const box = e.target.closest('input[data-select]');
  if (!box) return;
  if (box.checked) S.selected.add(box.dataset.select);
  else S.selected.delete(box.dataset.select);
  renderBulkbar();
});

$('#keys-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const key = S.data.keys.find((k) => k.id === id);
  try {
    if (btn.dataset.act === 'edit') {
      openKeyModal(key);
    } else if (btn.dataset.act === 'probe') {
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
      S.selected.delete(id);
      await load();
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#keys-bulkbar').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-bulk]');
  if (!btn) return;
  const action = btn.dataset.bulk;
  if (action === 'delete' && !(await confirmAction(t('common.deleteAllKeys')))) return;
  try {
    const res = await api('/admin/api/keys/bulk-action', 'POST', { action, ids: [...S.selected] });
    S.selected.clear();
    toast(`${action}: ${res.affected}`);
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#keys-probe-all').addEventListener('click', async () => {
  const btn = $('#keys-probe-all');
  btn.disabled = true;
  try {
    toast(t('keys.probing', { n: S.data.keys.length }));
    const res = await api('/admin/api/keys/probe-all', 'POST', {});
    toast(t('keys.probeResult', { ok: res.ok, failed: res.failed }), res.failed ? 'err' : 'ok');
    await load();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('#keys-export').addEventListener('click', () => {
  window.location.href = '/admin/api/export';
});

$('#keys-restore').addEventListener('click', () => $('#keys-file').click());
$('#keys-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (!(await confirmAction(t('common.deleteAllKeys')))) return;
    const res = await api('/admin/api/import', 'POST', payload);
    toast(`${t('common.imported')}: ${res.keys} keys, ${res.clients} clients`);
    await load();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    e.target.value = '';
  }
});

$('#keys-clear').addEventListener('click', async () => {
  if (!(await confirmAction(t('common.deleteAllKeys')))) return;
  try {
    await api('/admin/api/keys', 'DELETE');
    S.selected.clear();
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = form.dataset.keyId;
  const payload = {
    provider: form.elements.namedItem('provider').value,
    label: form.elements.namedItem('label').value,
    baseUrl: form.elements.namedItem('baseUrl').value,
    weight: Number(form.elements.namedItem('weight').value) || 1,
    rpm: Number(form.elements.namedItem('rpm').value) || 0,
    tpm: Number(form.elements.namedItem('tpm').value) || 0,
    model: form.elements.namedItem('model').value
  };
  const key = form.elements.namedItem('key').value.trim();
  if (key) payload.key = key;
  try {
    await api(`/admin/api/keys/${id}`, 'PATCH', payload);
    $('#key-modal').classList.add('hidden');
    toast(t('common.saved'));
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#client-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = form.dataset.clientId;
  try {
    await api(`/admin/api/clients/${id}`, 'PATCH', {
      name: form.elements.namedItem('name').value,
      rpm: Number(form.elements.namedItem('rpm').value) || 0,
      dailyTokens: Number(form.elements.namedItem('dailyTokens').value) || 0,
      models: form.elements.namedItem('models').value,
      status: form.elements.namedItem('active').checked ? 'active' : 'disabled'
    });
    $('#client-modal').classList.add('hidden');
    toast(t('common.saved'));
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#client-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-client]');
  if (!btn) return;
  try {
    if (btn.dataset.client === 'copy') {
      const res = await api(`/admin/api/clients/${btn.dataset.id}/reveal`, 'POST', {});
      await copyText(res.key);
    } else if (btn.dataset.client === 'edit') {
      const client = S.data.clients.find((c) => c.id === btn.dataset.id);
      openClientModal(client);
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
    toast(`${t('common.saved')} · ${res.created}`);
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#client-create').addEventListener('click', async () => {
  try {
    await api('/admin/api/clients', 'POST', {
      name: $('#client-name').value.trim() || 'client',
      rpm: Number($('#client-rpm').value) || 0,
      dailyTokens: Number($('#client-daily').value) || 0,
      models: $('#client-models').value.split(/[\s,]+/).filter(Boolean)
    });
    $('#client-name').value = '';
    $('#client-models').value = '';
    toast(t('common.saved'));
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#play-run').addEventListener('click', async () => {
  const prompt = $('#play-prompt').value.trim();
  if (!prompt) return;
  const btn = $('#play-run');
  const out = $('#play-out');
  btn.disabled = true;
  out.innerHTML = `<span class="muted">${esc(t('play.running'))}</span>`;
  try {
    const res = await fetch('/admin/api/playground', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: $('#play-model').value.trim(),
        prompt,
        maxTokens: Number($('#play-max').value) || 256,
        temperature: Number($('#play-temp').value)
      })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'request failed');
    out.textContent = data.text || '(empty)';
    $('#play-meta').innerHTML = `${esc(t('play.servedBy'))} <b>${esc(data.key)}</b> · ${data.ms} ms · ${num(data.usage?.tin || 0)} / ${num(data.usage?.tout || 0)} ${esc(t('play.usage'))}`;
    await load();
  } catch (err) {
    out.innerHTML = `<span class="err-text">${esc(err.message)}</span>`;
    $('#play-meta').textContent = '—';
  } finally {
    btn.disabled = false;
  }
});

for (const btn of $$('#settings-tabs button')) {
  btn.addEventListener('click', () => {
    S.settingsTab = btn.dataset.tab;
    for (const b of $$('#settings-tabs button')) b.classList.toggle('is-active', b === btn);
    for (const panel of $$('.tab-panel')) panel.classList.toggle('hidden', panel.dataset.tab !== S.settingsTab);
  });
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = {};
  for (const field of [
    'maxAttempts',
    'deadlineMs',
    'queueWaitMs',
    'cooldownBaseMs',
    'cooldownMaxMs',
    'circuitThreshold',
    'circuitCooldownMs',
    'sampleSize',
    'upstreamTimeoutMs',
    'streamIdleMs',
    'autoDisableAfterAuthFails'
  ]) {
    const input = form.elements.namedItem(field);
    if (input) payload[field] = Number(input.value) || 0;
  }
  payload.policy = form.elements.namedItem('policy').value;
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
  payload.cors = form.elements.namedItem('cors').checked;
  payload.corsOrigin = form.elements.namedItem('corsOrigin').value.trim() || '*';
  payload.webhookUrl = form.elements.namedItem('webhookUrl').value.trim();
  try {
    await api('/admin/api/settings', 'POST', payload);
    toast(t('common.saved'));
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#change-password').addEventListener('click', async () => {
  const form = $('#settings-form');
  try {
    await api('/admin/api/password', 'POST', {
      current: form.elements.namedItem('current').value,
      next: form.elements.namedItem('next').value
    });
    toast(t('settings.pwChanged'));
    form.elements.namedItem('current').value = '';
    form.elements.namedItem('next').value = '';
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#revoke-all').addEventListener('click', async () => {
  try {
    await api('/admin/api/sessions/revoke', 'POST', { all: true });
    location.reload();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#session-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-revoke]');
  if (!btn) return;
  try {
    await api('/admin/api/sessions/revoke', 'POST', { id: btn.dataset.revoke });
    renderSessions();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#data-export').addEventListener('click', () => {
  window.location.href = '/admin/api/export';
});

$('#data-import').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const res = await api('/admin/api/import', 'POST', payload);
      toast(`${t('common.imported')}: ${res.keys} keys, ${res.clients} clients`);
      await load();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  input.click();
});

$('#data-reset').addEventListener('click', async () => {
  if (!(await confirmAction(t('settings.reset') + '?'))) return;
  try {
    await api('/admin/api/reset-stats', 'POST', {});
    toast(t('common.saved'));
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const el = document.getElementById(btn.dataset.copy);
  if (el) await copyText(el.textContent);
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
    if (!S.data) return;
    if (S.view === 'overview' || S.view === 'analytics') renderView();
  }, 160);
});

(async function boot() {
  let session = { authed: false, defaultLang: 'en' };
  try {
    session = await fetch('/admin/api/session').then((r) => r.json());
  } catch {
    /* offline */
  }
  S.session = session;
  S.lang = localStorage.getItem('hydra_lang') || session.defaultLang || 'en';
  applyLang();
  if (session.authed) {
    start();
  } else {
    $('#login').classList.remove('hidden');
    $('#login-password').focus();
  }
})();