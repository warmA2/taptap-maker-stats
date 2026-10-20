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
