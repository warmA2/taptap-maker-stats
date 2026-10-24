/* dashboard.js */
'use strict';

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? '–' : n.toLocaleString('zh-CN'));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// 批次到期时间：expiresTime 秒级时间戳 → "到期 YYYY-MM-DD"
function fmtExpiry(v) {
  if (v == null || v === '' || v === 0) return '长期有效';
  let t = v;
  if (typeof v === 'number' && v < 1e10) t = v * 1000;
  else if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      t = n < 1e10 ? n * 1000 : n;
    } else if (/\d{4}-\d{2}-\d{2}/.test(s)) {
      return `到期 ${s.slice(0, 10)}`;
    } else {
      return '长期有效';
    }
  }
  const d = new Date(t);
  if (isNaN(d.getTime())) return '长期有效';
  return `到期 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function query(what, extra, cb) {
  chrome.runtime.sendMessage({ kind: 'query', what, ...(extra || {}) }, cb);
}

function fmtTime(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---------- 总览 ---------- */
query('totals', null, (res) => {
  if (!res || !res.ok) return;
  const t = res.data;
  $('all-inputs').textContent = fmt(t.all.inputs);
  $('all-chars').textContent = fmt(t.all.outChars);
  $('all-tokens').textContent = fmt(t.all.inTokens + t.all.outTokens);
  $('all-credits').textContent = fmt(t.all.credits);
  $('week-inputs').textContent = fmt(t.week.inputs);
  $('today-inputs').textContent = fmt(t.today.inputs);
});

/* ---------- 按日趋势图 ---------- */
query('byDay', null, (res) => {
  if (!res || !res.ok) return;
  const rows = res.data;
  const canvas = $('day-chart');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = rect.width || 800;
  const H = 220;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  if (!rows.length) { $('day-note').textContent = '暂无按日数据'; return; }
  const pad = { l: 44, r: 12, t: 14, b: 28 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const maxInputs = Math.max(...rows.map((r) => r.inputs), 1);
  const maxCredits = Math.max(...rows.map((r) => r.credits), 1);
  const n = rows.length;
  const bw = iw / n;
  // 柱（输入次数）
  g.fillStyle = '#3b82f6';
  rows.forEach((r, i) => {
    const h = (r.inputs / maxInputs) * ih;
    const x = pad.l + i * bw + bw * 0.15;
    g.fillRect(x, pad.t + ih - h, bw * 0.7, h);
  });
  // 线（积分）
  g.strokeStyle = '#f59e0b';
  g.lineWidth = 2;
  g.beginPath();
  rows.forEach((r, i) => {
    const x = pad.l + i * bw + bw / 2;
    const y = pad.t + ih - (r.credits / maxCredits) * ih;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  });
  g.stroke();
  // 轴与标签
  g.fillStyle = '#6b7280';
  g.font = '11px sans-serif';
  for (let s = 0; s <= 3; s++) {
    const y = pad.t + ih - (s / 3) * ih;
    g.strokeStyle = '#e5e7eb'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke();
    g.fillText(Math.round(maxInputs * s / 3), 4, y + 4);
  }
  const step = Math.ceil(n / 14);
  rows.forEach((r, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    const x = pad.l + i * bw + bw / 2;
    g.textAlign = 'center';
    g.fillText(r.day.slice(5), x, H - 10);
  });
  g.textAlign = 'left';
});

/* ---------- 按会话排行 ---------- */
query('byChat', null, (res) => {
  const tbody = $('chat-body');
  if (!res || !res.ok) return;
  const rows = res.data;
  if (!rows.length) { $('chat-empty').style.display = 'block'; return; }
  const max = Math.max(...rows.map((r) => r.inputs), 1);
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.className = 'chat-row';
    tr.innerHTML = `
      <td title="${esc(r.title)}">${esc(r.title)}</td>
      <td><div class="bar-wrap"><span class="num">${fmt(r.inputs)}</span><div class="bar" style="width:${Math.round((r.inputs / max) * 120)}px"></div></div></td>
      <td class="num">${fmt(r.inTokens + r.outTokens)}</td>
      <td class="num">${fmt(r.credits)}</td>`;
    tbody.appendChild(tr);
  }
});

/* ---------- 余额快照 ---------- */
query('balances', null, (res) => {
  const canvas = $('balance-chart');
  const note = $('balance-note');
  if (!res || !res.ok) return;
  const rows = res.data;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = rect.width || 800, H = 220;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  if (rows.length < 2) { note.textContent = '尚未抓到积分余额快照（/api/v1/credits）。打开“我的积分”页面后会自动记录。'; return; }
  const pad = { l: 44, r: 12, t: 14, b: 28 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const max = Math.max(...rows.map((r) => r.credits), 1);
  const min = Math.min(...rows.map((r) => r.credits), 0);
  const span = Math.max(max - min, 1);
  g.strokeStyle = '#10b981'; g.lineWidth = 2; g.beginPath();
  rows.forEach((r, i) => {
    const x = pad.l + (i / Math.max(rows.length - 1, 1)) * iw;
    const y = pad.t + ih - ((r.credits - min) / span) * ih;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  });
  g.stroke();
  g.fillStyle = '#6b7280'; g.font = '11px sans-serif';
  for (let s = 0; s <= 3; s++) {
    const y = pad.t + ih - (s / 3) * ih;
    g.strokeStyle = '#e5e7eb'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke();
    g.fillText(Math.round(min + span * s / 3), 4, y + 4);
  }
  const step = Math.ceil(rows.length / 10);
  rows.forEach((r, i) => {
    if (i % step !== 0 && i !== rows.length - 1) return;
    const x = pad.l + (i / Math.max(rows.length - 1, 1)) * iw;
    g.textAlign = 'center';
    g.fillText(new Date(r.ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }), x, H - 10);
  });
  g.textAlign = 'left';
  note.textContent = `${rows.length} 条余额快照 · 最早 ${fmt(rows[0].credits)} → 最新 ${fmt(rows[rows.length - 1].credits)}`;
});

/* ---------- 输入明细 ---------- */
query('prompts', { limit: 100 }, (res) => {
  const tbody = $('prompt-body');
  if (!res || !res.ok) return;
  const rows = res.data;
  if (!rows.length) { $('prompt-empty').style.display = 'block'; return; }
  const titleCache = {};
  query('chats', null, (r2) => {
    if (r2 && r2.ok) for (const c of r2.data) titleCache[c.id] = c.title || '未命名会话';
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="white-space:nowrap;font-size:12px;">${fmtTime(r.ts)}</td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(titleCache[r.chatId] || r.chatId)}">${esc(titleCache[r.chatId] || r.chatId)}</td>
        <td class="prompt-text">${esc((r.text || '').slice(0, 300))}</td>
        <td class="num">${fmt((r.outText || '').length)}</td>
        <td class="num">${fmt((r.inTokens || 0) + (r.outTokens || 0))}</td>
        <td class="num">${fmt(r.credits)}</td>`;
      tbody.appendChild(tr);
    }
  });
});

/* ---------- 积分构成（最新快照） ---------- */
query('creditBreakdown', null, (res) => {
  const box = $('credit-breakdown');
  const tbody = $('credit-items');
  if (!res || !res.ok) return;
  const d = res.data;
  const latest = d.latest;
  if (!latest) {
    $('credit-empty').style.display = 'block';
    return;
  }
  const bd = latest.breakdown || {};
  const gen = (bd.general || 0) + (bd.memberGeneral || 0);
  const order = ['general', 'normal', 'paid', 'event', 'project'];
  const labels = {
    general: '通用积分', normal: '基础积分', paid: '付费积分', event: '活动积分', project: '项目包积分',
  };
  const cardVals = { general: gen, normal: bd.normal || 0, paid: bd.paid || 0, event: bd.event || 0, project: bd.project || 0 };
  const cards = order
    .filter((k) => cardVals[k] > 0)
    .map((k) => `<div class="card" style="min-width:120px;"><div class="v" style="color:#b45309;">${fmt(cardVals[k])}</div><div class="l">${labels[k]}</div></div>`);
  if (cards.length) box.innerHTML = cards.join('');
  if (latest.summary && latest.summary.accountBalance != null) {
    box.innerHTML += `<div class="card" style="min-width:120px;"><div class="v">${fmt(latest.summary.accountBalance)}</div><div class="l">账户总余额</div></div>`;
  }
  const mlist = (latest.membership || []).filter((m) =>
    m.memberGeneralCredits != null || m.memberFlashCredits != null || m.generalAmount != null || m.totalAmount != null);
  if (mlist.length) {
    const m = mlist[0];
    box.innerHTML += `<div class="card" style="min-width:180px;"><div class="v" style="color:#9ca3af;font-size:12px;">${esc(m.label)} 通用 ${fmt(m.memberGeneralCredits != null ? m.memberGeneralCredits : (m.generalAmount != null ? m.generalAmount : m.totalAmount))}</div><div class="l">会员卡权益（非当前余额）</div></div>`;
  }
  if (!latest.ok) {
    box.innerHTML += `<div style="color:#b45309;font-size:12px;width:100%;">⚠ ${esc(latest.debug ? latest.debug.reason : '解析失败')} · 余额字段 ${esc((latest.debug || {}).balanceFieldUsed || '未找到')} · 条目字段 ${esc(((latest.debug || {}).batchKeys || []).join(', '))}</div>`;
  }
  const items = latest.items || [];
  if (items.length) {
    for (const it of items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(it.kind === 'memberGeneral' ? '通用积分' : (it.label || it.kind))}</td>
        <td class="num">${fmt(it.amount)}</td>
        <td>${it.expiresTime != null ? esc(fmtExpiry(it.expiresTime)) : '长期有效'}</td>
        <td>${esc(it.source || '–')}</td>
        <td>${esc(it.projectId || (it.name || '–'))}</td>`;
      tbody.appendChild(tr);
    }
  } else {
    $('credit-empty').style.display = 'block';
  }
  if (latest.pending && latest.pending.length) {
    box.innerHTML += `<div style="width:100%;color:#9ca3af;font-size:12px;">待发放批次（未计入余额）：${latest.pending.map((p) => `${esc(p.name || '通用积分')} ${fmt(p.amount)}`).join(' · ')}</div>`;
  }
});

/* ---------- 项目积分消耗明细（transactions） ---------- */
query('transactions', { limit: 50 }, (res) => {
  const tbody = $('txn-body');
  if (!res || !res.ok) return;
  const rows = res.data;
  if (!rows.length) { $('txn-empty').style.display = 'block'; return; }
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(r.projectName || '–')}</td>
      <td>${esc(r.title || r.kind || '–')}</td>
      <td class="num" style="color:${r.amount < 0 ? '#dc2626' : '#059669'};font-weight:700;">${r.amount > 0 ? '+' : ''}${fmt(r.amount)}</td>
      <td>${r.createdAt ? esc(String(r.createdAt).slice(0, 16).replace('T', ' ')) : '–'}</td>`;
    tbody.appendChild(tr);
  }
});

/* ---------- 调试原始事件 ---------- */
query('raw', null, (res) => {
  const box = $('raw-box');
  if (!res || !res.ok) { box.textContent = '查询失败'; return; }
  const rows = res.data;
  if (!rows.length) { box.textContent = '暂无捕获事件。打开 maker.taptap.cn 对话几次后回来查看。'; return; }
  box.textContent = rows.map((r) => JSON.stringify(r)).join('\n');
});

/* ==================================================================
 * 项目收入 / 商店数据表现
 *
 * 数据来自 developer.taptap.cn（Cookie 会话，控制台的私有接口）。
 * 三条铁律：
 *   ① 拉不到就显示「—」和错误原文，绝不显示 0
 *   ② 广告（T+1）与曝光（含今天）区间口径不同，各走各的
 *   ③ 两块分别兜错，一个挂了另一个照常显示
 * ================================================================== */

const DEV = { apps: [], appId: '', adN: 7, devN: 7 };

// 折线取色：按固定顺序连续分配（相邻两色可辨性只对连续取用成立）
const DEV_PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];

const ymd = (d) => d.getFullYear() + '-'
  + String(d.getMonth() + 1).padStart(2, '0') + '-'
  + String(d.getDate()).padStart(2, '0');

function dayShift(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);   // 用正午，避开时区/夏令时边界
  d.setDate(d.getDate() + n);
  return d;
}

/* 广告是 T+1：区间终点固定是昨天，没有「今天」 */
function rangeOf(kind, n) {
  const endOff = kind === 'ad' ? -1 : 0;
  const startOff = kind === 'ad' ? -n : -(n - 1);
  return { start: ymd(dayShift(startOff)), end: ymd(dayShift(endOff)) };
}

const money = (n) => (n == null ? '–' : '¥' + Number(n).toFixed(2));

function resetCanvas(cv, text) {
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  const W = rect.width || 800;
  const H = rect.height || 200;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (text) {
    g.fillStyle = '#9ca3af';
    g.font = '12px "Microsoft YaHei", sans-serif';
    g.textAlign = 'center';
    g.fillText(text, W / 2, H / 2);
    g.textAlign = 'left';
  }
}

/* Y 轴上界取「好数字」：4 等分后刻度落在 1 / 2 / 5 的整数倍上 */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const raw = v / 4;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const f = raw / base;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return step * base * 4;
}

/* 多系列折线。opts: { unit, money } */
function drawLines(cv, labels, series, opts) {
  if (!cv) return;
  const o = opts || {};
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  const W = rect.width || 800;
  const H = rect.height || 200;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const n = labels.length;
  if (!n || !series.length) { resetCanvas(cv, '暂无数据'); return; }

  const pad = { l: 56, r: 14, t: 14, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  let maxY = 0;
  series.forEach((s) => s.values.forEach((v) => { if (v > maxY) maxY = v; }));
  maxY = niceMax(maxY);

  const x = (i) => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => pad.t + ih - (v / maxY) * ih;

  // 网格 + Y 轴刻度
  g.font = '11px "Microsoft YaHei", sans-serif';
  for (let s = 0; s <= 4; s++) {
    const yy = pad.t + ih - (s / 4) * ih;
    g.strokeStyle = '#eef2f7';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(pad.l, yy);
    g.lineTo(W - pad.r, yy);
    g.stroke();
    const val = (maxY * s) / 4;
    g.fillStyle = '#9ca3af';
    g.fillText(o.money ? '¥' + val.toFixed(val < 10 ? 2 : 0) : fmt(Math.round(val)), 4, yy + 4);
  }

  // 折线（单条时带面积）
  series.forEach((s) => {
    if (s.fill) {
      const grad = g.createLinearGradient(0, pad.t, 0, pad.t + ih);
      grad.addColorStop(0, s.color + '33');
      grad.addColorStop(1, s.color + '03');
      g.beginPath();
      g.moveTo(x(0), pad.t + ih);
      s.values.forEach((v, i) => g.lineTo(x(i), y(v)));
      g.lineTo(x(s.values.length - 1), pad.t + ih);
      g.closePath();
      g.fillStyle = grad;
      g.fill();
    }
    g.strokeStyle = s.color;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.beginPath();
    s.values.forEach((v, i) => { if (i === 0) g.moveTo(x(i), y(v)); else g.lineTo(x(i), y(v)); });
    g.stroke();
    // 点少的时候画点，否则线会像断的
    if (n <= 31) {
      g.fillStyle = s.color;
      s.values.forEach((v, i) => {
        g.beginPath();
        g.arc(x(i), y(v), 2.4, 0, Math.PI * 2);
        g.fill();
      });
    }
  });

  // X 轴日期
  g.fillStyle = '#9ca3af';
  g.textAlign = 'center';
  const step = Math.max(1, Math.ceil(n / 8));
  labels.forEach((d, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    g.fillText(String(d).slice(5), x(i), H - 8);
  });
  g.textAlign = 'left';
}

/* ---------------- 应用列表 ---------------- */
function curApp() {
  return DEV.apps.find((a) => String(a.id) === String(DEV.appId)) || null;
}

function fillAppSelects() {
  const opts = DEV.apps.map((a) =>
    '<option value="' + esc(String(a.id)) + '">' + esc(a.title)
    + (a.devName ? '（' + esc(a.devName) + '）' : '') + '</option>').join('');
  ['ad-app', 'dev-app'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.innerHTML = opts || '<option value="">没有可用应用</option>';
    el.value = DEV.appId;
  });
}

function loadDevApps() {
  query('devApps', {}, (res) => {
    const d = res && res.ok ? res.data : null;
    const list = (d && d.list) || [];
    if (!list.length) {
      const msg = (d && d.error) || (res && res.error) || '读不到开发者后台的应用列表';
      adError(msg);
      devError(msg);
      ['ad-app', 'dev-app'].forEach((id) => {
        const el = $(id);
        if (el) el.innerHTML = '<option value="">无应用</option>';
      });
      return;
    }
    DEV.apps = list;
    chrome.storage.local.get('devPick', (o) => {
      const saved = o && o.devPick;
      const hit = DEV.apps.find((a) => String(a.id) === String(saved)) || DEV.apps[0];
      DEV.appId = hit ? String(hit.id) : '';
      fillAppSelects();
      loadAd();
      loadDev();
    });
  });
}

function switchApp(id) {
  const v = $(id).value;
  if (!v || v === DEV.appId) return;
  DEV.appId = v;
  chrome.storage.local.set({ devPick: v });
  const other = id === 'ad-app' ? 'dev-app' : 'ad-app';
  if ($(other)) $(other).value = v;
  loadAd();
  loadDev();
}

/* ---------------- 广告收益 ---------------- */
function adError(msg) {
  ['ad-total', 'ad-perday', 'ad-settled', 'ad-pending'].forEach((id) => { $(id).textContent = '—'; });
  const note = $('ad-note');
  note.className = 'muted note err';
  note.innerHTML = esc(msg) + (/未登录/.test(msg)
    ? ' · <a href="https://developer.taptap.cn" target="_blank" rel="noreferrer">打开开发者后台登录</a>' : '');
  resetCanvas($('ad-chart'), '拉取失败，不显示数字');
}

function loadAd(force) {
  const app = curApp();
  if (!app) return;
  const r = rangeOf('ad', DEV.adN);
  ['ad-total', 'ad-perday', 'ad-settled', 'ad-pending'].forEach((id) => { $(id).textContent = '…'; });
  $('ad-note').className = 'muted note';
  $('ad-note').textContent = '读取中…';
  query('devAd', { appId: app.id, devId: app.devId, start: r.start, end: r.end, force: !!force }, (res) => {
    const d = res && res.ok ? res.data : null;
    if (!d || d.error) { adError((d && d.error) || (res && res.error) || '拉取失败'); return; }

    const has = d.values && d.values.length;
    // 没有已结算的天就显示「—」：¥0.00 会被读成「真的没赚到」，那不是同一件事
    $('ad-total').textContent = has ? money(d.total) : '–';
    $('ad-perday').textContent = has ? money(d.perDay) : '–';
    $('ad-settled').textContent = d.days == null ? '–' : d.days + ' 天';
    $('ad-pending').textContent = d.pendingDays == null ? '–' : d.pendingDays + ' 天';

    const note = $('ad-note');
    note.className = 'muted note';
    if (!has) {
      note.textContent = '这段时间没有已结算的收益（' + r.start + ' ~ ' + r.end + '）。'
        + (d.pendingDays ? '还有 ' + d.pendingDays + ' 天未结算。' : '');
      resetCanvas($('ad-chart'), '这段时间没有已结算的广告收益');
      return;
    }
    note.textContent = r.start + ' ~ ' + r.end + ' · 逐日预估之和；日均按已结算的 ' + d.days + ' 天算'
      + (d.pendingDays ? '，另有 ' + d.pendingDays + ' 天未结算（不计入）' : '') + '。';
    drawLines($('ad-chart'), d.dates, [{ name: '预估收益', values: d.values, color: DEV_PALETTE[0], fill: true }], { money: true });
  });
}

/* ---------------- 商店数据表现 ---------------- */
function devError(msg) {
  ['dev-imp', 'dev-pv', 'dev-ctr', 'dev-cvr'].forEach((id) => { $(id).textContent = '—'; });
  const note = $('dev-note');
  note.className = 'muted note err';
  note.innerHTML = esc(msg) + (/未登录/.test(msg)
    ? ' · <a href="https://developer.taptap.cn" target="_blank" rel="noreferrer">打开开发者后台登录</a>' : '');
  resetCanvas($('dev-chart'), '拉取失败，不显示数字');
}

function loadDev(force) {
  const app = curApp();
  if (!app) return;
  const r = rangeOf('dev', DEV.devN);
  ['dev-imp', 'dev-pv', 'dev-ctr', 'dev-cvr'].forEach((id) => { $(id).textContent = '…'; });
  $('dev-note').className = 'muted note';
  $('dev-note').textContent = '读取中…';
  query('devStats', { appId: app.id, devId: app.devId, start: r.start, end: r.end, force: !!force }, (res) => {
    const d = res && res.ok ? res.data : null;
    if (!d || d.error) { devError((d && d.error) || (res && res.error) || '拉取失败'); return; }
    const t = d.totals || {};
    const has = d.dates && d.dates.length;
    // 同样：接口返回空 ≠ 曝光为 0，显示「—」
    $('dev-imp').textContent = has ? fmt(t.impression) : '–';
    $('dev-pv').textContent = has ? fmt(t.detail) : '–';
    $('dev-ctr').textContent = has ? (t.clickRate || '–') : '–';
    $('dev-cvr').textContent = has ? (t.convertRate || '–') : '–';

    const note = $('dev-note');
    note.className = 'muted note';
    if (!has) {
      note.textContent = '这段时间没有曝光数据（' + r.start + ' ~ ' + r.end + '）。';
      resetCanvas($('dev-chart'), '这段时间没有曝光数据');
      return;
    }
    const series = (d.channels || []).map((ch, i) => ({
      name: ch.name, values: ch.values, color: DEV_PALETTE[i % DEV_PALETTE.length],
    }));
    drawLines($('dev-chart'), d.dates, series, {});
    note.className = 'muted note';
    note.innerHTML = '<div class="legend">' + (d.channels || []).map((ch, i) =>
      '<span><i style="background:' + DEV_PALETTE[i % DEV_PALETTE.length] + '"></i>' + esc(ch.name) + '</span>').join('')
      + '</div>' + r.start + ' ~ ' + r.end + ' · 曝光按渠道拆分；点击率与转化率是逐日比率的平均（和后台页面同口径）。';
  });
}

/* ---------------- 交互 ---------------- */
['ad-app', 'dev-app'].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener('change', () => switchApp(id));
});
['ad-seg', 'dev-seg'].forEach((id) => {
  const box = $(id);
  if (!box) return;
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-n]');
    if (!btn) return;
    box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    const n = Number(btn.dataset.n) || 7;
    if (id === 'ad-seg') { DEV.adN = n; loadAd(true); } else { DEV.devN = n; loadDev(true); }
  });
});

loadDevApps();

// 侧边栏里切了项目，这个页面跟着换（两边共用一个 devPick）
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.devPick) return;
    const nv = ch.devPick.newValue;
    if (!nv || String(nv) === String(DEV.appId)) return;
    if (!DEV.apps.some((a) => String(a.id) === String(nv))) return;   // 列表里没有就不动
    DEV.appId = String(nv);
    ['ad-app', 'dev-app'].forEach((id) => { const el = $(id); if (el) el.value = DEV.appId; });
    loadAd();
    loadDev();
  });
}
