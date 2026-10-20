/* sidepanel.js — 侧边栏常驻视图，每 10 秒自动刷新 */
'use strict';

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? '–' : n.toLocaleString('zh-CN'));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function query(what, extra, cb) {
  chrome.runtime.sendMessage({ kind: 'query', what, ...(extra || {}) }, cb);
}

function fmtTime(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 相对时间：今天内显示"HH:MM"，否则"MM-DD HH:MM"
function fmtRelTime(ts) {
  if (!ts) return '–';
  const d = new Date(ts), now = new Date();
  const same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (same) return `今天 ${hm}`;
  return fmtTime(ts);
}

// 数字滚动动画：从当前值平滑滚到目标值
function animateNum(el, to, dur) {
  if (!el) return;
  dur = dur || 500;
  const cur = el.dataset.v;
  const from = cur == null ? 0 : parseFloat(String(cur).replace(/[,，\s]/g, ''));
  const target = to || 0;
  if (isNaN(from) || from === target) {
    el.textContent = fmt(to == null ? 0 : to);
    el.dataset.v = String(target);
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(Math.round(from + (target - from) * eased));
    if (p < 1) requestAnimationFrame(step);
    else { el.textContent = fmt(to == null ? 0 : to); el.dataset.v = String(target); }
  };
  requestAnimationFrame(step);
}

// 动画绘制器：drawFn(p) 按进度 0→1 绘制
function rafDraw(drawFn, dur) {
  const t0 = performance.now();
  const loop = (t) => {
    const p = Math.min(1, (t - t0) / (dur || 600));
    drawFn(p);
    if (p < 1) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// 内部记录通道 → 用户友好的来源标签（backfill:fetch-request 这类技术名不直接展示）
function friendlyVia(via) {
  if (!via) return '页面记录';
  let raw = String(via);
  if (raw.startsWith('backfill:')) return '会话补录';
  const map = {
    'fetch-request:chat': '对话提交',
    'fetch-request': '页面提交',
    'ws:prompt': '即时对话',
    'ws-send': '即时对话',
    'ws:raw': '页面记录',
    'dom': '页面扫描',
    'dom-scan': '页面扫描',
  };
  return map[raw] || '页面记录';
}

// 批次到期时间：expiresTime 秒级时间戳 → "到期 YYYY-MM-DD"；无则为"长期有效"
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

/* ---------- 注入状态 ---------- */
function refreshInjectStatus() {
  query('injectStatus', null, (res) => {
    const el = $('inject-status');
    if (!res || !res.ok) return;
    const st = res.data;
    if (st.injected) {
      const hook = st.hookReady ? '<span class="pill hook"><span class="dot"></span>主钩子正常</span>' : '<span class="pill hook"><span class="dot"></span>主钩子未运行</span>';
      el.innerHTML = `<span class="pill ok"><span class="dot"></span>运行中 · ${st.count} 个页面</span>${hook}<a href="https://maker.taptap.cn/credits" target="_blank">查看积分页 ↗</a>`;
    } else {
      el.innerHTML = `<span class="pill bad"><span class="dot"></span>未连接 · 打开 maker 页面即可自动连接</span><a href="https://maker.taptap.cn/credits" target="_blank">查看积分页 ↗</a>`;
    }
  });
}

/* ---------- 导出诊断 ---------- */
function initExport() {
  const btn = $('export-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = '导出中…';
    chrome.runtime.sendMessage({ kind: 'export' }, (res) => {
      btn.disabled = false;
      btn.textContent = '导出诊断数据';
      if (!res || !res.ok) {
        $('export-hint').textContent = '导出失败：' + ((res && res.error) || '未知错误');
        return;
      }
      try {
        // 在侧边栏页面创建 blob 并下载（SW 无 createObjectURL，放这里做）
        const blob = new Blob([JSON.stringify(res.payload, null, 1)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({ url, filename: 'taptap-diagnostic.json', saveAs: false }, () => {
          URL.revokeObjectURL(url);
          $('export-hint').textContent = '已导出到下载目录：taptap-diagnostic.json';
        });
      } catch (e) {
        $('export-hint').textContent = '导出失败：' + e.message;
      }
    });
  });
}

/* ---------- 实时捕获：最近捕获到的发送消息 ---------- */
function clientExtractText(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const p = obj.params && typeof obj.params === 'object' ? obj.params : obj;
  for (const k of ['prompt', 'text', 'content', 'message', 'question', 'input']) {
    if (typeof p[k] === 'string' && p[k].trim()) return p[k];
  }
  const stack = [obj];
  let guard = 0;
  while (stack.length && guard++ < 200) {
    const cur = stack.pop();
    if (cur && typeof cur === 'object') {
      for (const [k, v] of Object.entries(cur)) {
        if (['prompt', 'text', 'content', 'message', 'question'].includes(k) && typeof v === 'string' && v.trim()) return v;
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return null;
}

// 进行中 & 会话耗时监控（紧凑格式：1时20分 / 20分5秒 / 5秒）
function fmtDur(ms) {
  if (ms == null || ms < 0 || !isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}时${m}分`;
  if (m > 0) return `${m}分${sec}秒`;
  return `${sec}秒`;
}

// 顶部「正在处理」：只列真的有消息在跑（未结束 + 近 3 分钟有流式活动）的会话，
// 不是"最近打开过的项目"。没有正在处理的会话时整块收起，不占位置。
let _actTimer = null; // 时长秒级跳动
let _actSig = '';     // 只在集合变化时重建 DOM，避免脉冲动画被打断

function renderActive(d) {
  const panel = $('act-panel'), box = $('act-list'), cnt = $('act-count');
  if (!panel || !box) return;
  const list = (d && d.active) || [];
  if (!list.length) {
    panel.hidden = true;
    box.innerHTML = '';
    _actSig = '';
    return;
  }
  panel.hidden = false;
  if (cnt) cnt.textContent = `${list.length} 个会话在跑`;
  const sig = list.map((s) => `${s.chatId}|${s.runSince}|${s.inputs}|${s.lastText}`).join(',');
  if (sig !== _actSig) {
    _actSig = sig;
    const now = Date.now();
    box.innerHTML = list.map((s) => {
      const since = s.runSince || now;
      return `<div class="act-row">
        <div class="act-h"><span class="dot"></span><span class="ell" title="${esc(s.chatId)}">${esc(s.title)}</span>${s.project ? `<span class="proj">${esc(s.project)}</span>` : ''}</div>
        <div class="act-meta"><span>已跑 <b class="act-since" data-since="${since}">${fmtDur(now - since)}</b></span><span>本会话第 ${s.inputs} 条</span><span>最近活动 ${fmtTime(s.lastActive)}</span></div>
        ${s.lastText ? `<div class="act-txt" title="${esc(s.lastText)}">${esc(String(s.lastText).slice(0, 80))}</div>` : ''}
      </div>`;
    }).join('');
  }
  if (!_actTimer) {
    _actTimer = setInterval(() => {
      document.querySelectorAll('.act-since').forEach((el) => {
        const st = parseInt(el.dataset.since, 10);
        if (st) el.textContent = fmtDur(Date.now() - st);
      });
    }, 1000);
  }
}

function renderSessions() {
  query('sessions', null, (res) => {
    const box = $('sessions');
    if (!box) return;
    if (!res || !res.ok) { box.innerHTML = '<div class="muted">查询失败</div>'; return; }
    const d = res.data;
    renderActive(d); // 顶部置顶块独立渲染（无进行中时自行隐藏）
    if (!d.sessions || !d.sessions.length) { box.innerHTML = '<div class="muted">暂无会话记录 · 发消息后自动出现</div>'; return; }
    // 增量刷新：会话状态/耗时都相同则跳过（进行中会话耗时在变化，会自然触发更新）
    const sig = d.sessions.map((s) => `${s.chatId}|${s.running}|${s.done}|${s.startTs}|${s.endTs}|${s.inputs}`).join(',');
    if (!sigChanged('sessions', sig)) return;
    const now = Date.now();
    const staleHint = d.staleTotal
      ? `<span class="act-hint">另有 ${d.staleTotal} 条未收到结束信号</span>`
      : '';
    box.innerHTML = `<div class="sess-stat">正在执行的任务：<b>${d.runningTotal}</b>${staleHint}</div>` +
      d.sessions.map((s) => {
        const running = s.running > 0;
        const endTxt = running ? '<span class="live">进行中…</span>' : (s.endTs ? fmtTime(s.endTs) : '—');
        const durHtml = running && s.startTs
          ? `<b class="dur-run" data-start="${s.startTs}">${fmtDur(now - s.startTs)}</b>`
          : `<b>${esc(fmtDur(s.durationMs))}</b>`;
        return `<div class="sess-row${running ? ' run' : ''}">
          <div class="sess-h"><span class="ell" title="${esc(s.chatId)}">${esc(s.title)}</span>${running ? '<span class="live">● 进行中</span>' : ''}</div>
          <div class="sess-t">开始 ${s.startTs ? fmtTime(s.startTs) : '—'} · 结束 ${endTxt}</div>
          <div class="sess-d">总耗时 ${durHtml} · ${s.inputs} 条消息</div>
        </div>`;
      }).join('');
    // 进行中会话的耗时：轻量动态更新（只改耗时文本，不重查不重渲染）
    if (box.querySelector('.dur-run') && !_durTimer) {
      _durTimer = setInterval(() => {
        document.querySelectorAll('.sess-d .dur-run').forEach((el) => {
          const st = parseInt(el.dataset.start, 10);
          if (st) el.textContent = fmtDur(Date.now() - st);
        });
      }, 10000);
    }
  });
}

function refreshCapture() {
  // 最近消息从 prompts 读（真正保存的输入记录，不会被原始流量日志滚动覆盖）
  query('prompts', { limit: 20 }, (res) => {
    const box = $('capture-list');
    if (!box) return;
    if (!res || !res.ok) { box.innerHTML = '<div class="muted">查询失败</div>'; return; }
    const rows = (res.data || []).filter((r) => r.text && String(r.text).trim().length > 0).slice(0, 20);
    if (!rows.length) { box.innerHTML = '<div class="muted">暂无消息 · 在 maker.taptap.cn 发一句话试试</div>'; return; }
    // 消息级消耗：结算行（msg-cost，页面"消耗X积分"真实扣费）按会话内时间窗口归因——
    // 消息 i 的消耗 = ts 落在 [本消息, 下一条消息) 内的结算行金额之和（长任务多次结算自动累积）。
    // 不依赖文本配对：结算行前序文本常取到 AI 回复片段，24 字符精确相等永远配不上。
    query('transactions', { limit: 300 }, (txRes) => {
      const costs = ((txRes && txRes.data) || []).filter((r) => r.kind === 'msg-cost' && r.ts);
      const sorted = rows.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const costOf = (r, i) => {
        const nextTs = i + 1 < sorted.length ? (sorted[i + 1].ts || Infinity) : Infinity;
        let sum = 0;
        for (const c of costs) {
          if (!c.ts || c.ts < (r.ts || 0) || c.ts >= nextTs) continue;
          if (r.chatId && c.chatId && c.chatId !== r.chatId) continue;
          sum += Math.abs(c.amount || 0);
        }
        if (sum > 0) return sum;
        return (r.credits != null && r.credits > 0) ? r.credits : null;
      };
      // 只显示：已成功匹配到真实消耗的 + 正在运行（未结算/未结束）的消息；
      // 未匹配到消耗的旧消息不显示，绝不乱配对。最新消息排最上方。
      const visible = sorted
        .map((r, i) => ({ r, cost: costOf(r, i), i }))
        .filter(({ r, cost }) => cost != null || !r.done)
        .sort((a, b) => (b.r.ts || 0) - (a.r.ts || 0));
      if (!visible.length) { box.innerHTML = '<div class="muted">暂无已结算消息 · 发消息等结算后显示</div>'; return; }
      // 增量刷新：消息与归因消耗都相同则跳过（动画不重复播放）
      const sig = visible.map(({ r, cost }) => `${r.ts}|${(r.text || '').slice(0, 24)}|${cost ?? ''}`).join(',');
      if (!sigChanged('capture', sig)) return;
      box.innerHTML = visible.map(({ r, cost }) => {
        const rem = r.remaining != null ? ` · 剩余 ${fmt(r.remaining)}` : '';
        const via = r.via ? ' · <span class="via">' + esc(friendlyVia(r.via)) + '</span>' : '';
        const running = !r.done ? ' · <span class="run">运行中</span>' : '';
        const costLine = cost != null ? ` · <span class="est">消耗 ${fmt(cost)} 积分</span>` : '';
        return `
        <div class="msg">
          <div class="t">${fmtRelTime(r.ts)} · ${esc((r.text || '').length)} 字${via}${running}${costLine}${rem}</div>
          <div class="c">${esc((r.text || '').slice(0, 80))}</div>
        </div>`;
      }).join('');
    });
  });
}

/* ---------- 我的积分（友好面板） ---------- */
function refreshCredits() {
  query('creditBreakdown', null, (res) => {
    const box = $('credits');
    const upd = $('credit-updated');
    if (!res || !res.ok) { box.innerHTML = '<div class="muted" style="flex:1">查询失败</div>'; return; }
    const latest = res.data.latest;
    const ps = res.data.pullState;
    const syncEl = $('sync-state');
    if (syncEl && ps) {
      syncEl.textContent = '本地读取 · ' + (ps.ok === null ? '等待页面请求积分接口（刷新 maker 页面即同步）' : (ps.ok ? '页面自动同步：成功 ' + fmtTime(ps.lastAt) : '同步失败' + (ps.lastAt ? ' ' + fmtTime(ps.lastAt) : '') + (ps.msg ? '（' + ps.msg + '）' : '')));
      syncEl.className = 'sync-state ' + (ps.ok === true ? 'ok' : (ps.ok === false ? 'fail' : ''));
    }
    if (!latest) {
      box.innerHTML = '<div class="muted" style="flex:1">暂无数据 · 打开 maker.taptap.cn 后自动出现</div>';
      return;
    }
    // 消息流实时余额（页面每条消息显示"剩余X通用积分"，比接口快照新）用它
    const bd = latest.breakdown || {};
    const ws = res.data.wsLatest;
    const useWs = ws && ws.ts > latest.ts && ws.general != null;
    // 积分页 DOM 的"通用积分 N"是官方合并值（general+memberGeneral），优先级最高
    const domGen = (latest.kind === 'dom' && latest.general != null && latest.general > 0) ? latest.general : null;
    let gen;
    if (useWs) {
      gen = ws.general + (bd.memberGeneral || 0);
    } else if (domGen != null) {
      gen = domGen;
    } else {
      gen = (bd.general || 0) + (bd.memberGeneral || 0);
    }
    const normal = bd.normal == null ? null : (bd.normal || 0);
    // 合计：优先用页面底部"剩余可用 X 积分"（完整总计），否则按分类相加
    const sum = (latest.available != null && latest.available > 0) ? latest.available : (gen + (normal || 0));
    const src = useWs ? '消息流实时' : (latest.kind === 'dom' ? '页面显示' : '接口');
    // 增量刷新：余额显示值与批次都相同则跳过（动画不重复播放）
    const bSig = (latest.items || []).map((i) => `${i.kind}|${i.amount}|${i.expiresTime}`).join(',');
    const pSig = (latest.pending || []).map((i) => `${i.amount}|${i.expiresTime}`).join(',');
    const sig = [latest.kind, gen, normal, sum, src, (ps && ps.ok), bSig, pSig].join('|');
    if (!sigChanged('credits', sig)) return;
    let html = '';
    if (gen != null && gen > 0) {
      html = `<div class="hero">
        <div class="lbl">通用积分${useWs ? ' · 实时' : ''}</div>
        <div class="num" data-num="${gen}">${fmt(gen)}</div>
        <div class="src">来源：${esc(src)}</div>
      </div>
      <div class="hero-mini"><div class="v" data-num="${sum}">${fmt(sum)}</div><div class="l">合计</div></div>`;
    } else if (latest.remaining != null) {
      html = `<div class="hero">
        <div class="lbl">剩余通用积分</div>
        <div class="num" data-num="${latest.remaining}">${fmt(latest.remaining)}</div>
        <div class="src">来源：页面显示</div>
      </div>`;
    } else {
      html = '<div class="muted" style="flex:1">未解析到余额，可展开下方诊断查看</div>';
    }
    // 批次：结构化分条——金额 + 分类 + 到期/长期（按类型着色）
    const batches = latest.items || [];
    if (batches.length) {
      const expKey = (it) => (it.expiresTime == null || it.expiresTime === 0) ? Infinity : Number(it.expiresTime);
      const colorOf = (kind) => ({ general: '#6366f1', memberGeneral: '#6366f1', normal: '#10b981', paid: '#f59e0b', event: '#ec4899', project: '#8b5cf6' }[kind] || '#94a3b8');
      const nameOf = (kind) => ({ general: '通用', memberGeneral: '通用', normal: '基础', paid: '付费', event: '活动', project: '项目包' }[kind] || kind);
      const rows = batches.slice().sort((a, b) => expKey(a) - expKey(b)).map((it) => {
        const exp = fmtExpiry(it.expiresTime);
        const isLong = exp === '长期有效';
        const expCls = isLong ? 'long' : (it.expiresTime ? 'warn' : '');
        return `<div class="bal-row">
          <span class="b-ic" style="background:${colorOf(it.kind)}"></span>
          <span class="b-name">${esc(nameOf(it.kind))}</span>
          <b style="color:${colorOf(it.kind)}">${fmt(it.amount)}</b>
          <span class="b-exp ${expCls}">${esc(exp)}</span>
        </div>`;
      }).join('');
      const pendTag = (latest.pending && latest.pending.length)
        ? `<div class="bal-legend">另有 ${latest.pending.length} 批待发放（未计入余额）</div>` : '';
      html += `<div class="bal-list">${rows}${pendTag}</div>`;
    }
    box.innerHTML = html;
    // 历史消息解析状态（一行小字，说明消耗是否来自官方消息数据）
    const hs = res.data.historyStats;
    if (hs && hs.pulls > 0) {
      const hsLine = `历史消息解析 ${hs.pulls} 次 · 命中消耗 ${hs.hits} 条${hs.noTurnId ? ` · ${hs.noTurnId} 条未匹配会话` : ''}`;
      box.innerHTML += `<div class="bal-legend" style="margin-top:8px">${esc(hsLine)}</div>`;
    }
    // 数字滚动动画
    box.querySelectorAll('[data-num]').forEach((el) => {
      const target = parseFloat(el.dataset.num || '0');
      if (el.textContent === '待同步') return;
      animateNum(el, target, 600);
    });
    if (upd) upd.textContent = '更新于 ' + fmtTime(latest.ts);
  });
}

/* ---------- 排障：最近原始流量 ---------- */
function refreshRawCredits() {
  query('raw', { limit: 60 }, (res) => {
    const box = $('raw-credits');
    if (!res || !res.ok) { box.innerHTML = '<div class="muted">查询失败</div>'; return; }
    const all = res.data || [];
    const keyed = (e) => (e.note || '') + '|' + (e.url || '');
    const entries = all.filter((e) =>
      e.note === 'ws-send' || e.note === 'fetch-request' || e.note === 'xhr-request' ||
      e.note === 'ws-rpc' || e.note === 'dom-scan' || (e.url && /\/api\/v1\/credits/.test(e.url)));
    if (!entries.length) { box.innerHTML = '<div class="muted">暂无流量记录（在页面发一条消息后再看）</div>'; return; }
    box.innerHTML = entries.slice(0, 8).map((e) => {
      const j = e.json || e.body || e.fields;
      let body;
      try {
        body = typeof j === 'object' ? JSON.stringify(j).slice(0, 900) : String(j);
      } catch (err) { body = String(err); }
      const label = (e.note === 'ws-send' ? '📤 发送' : e.note === 'fetch-request' ? '📤 fetch' : e.note === 'xhr-request' ? '📤 xhr' : e.note === 'ws-rpc' ? '📥 回包' : e.note === 'dom-scan' ? '🔍 页面文本' : '💰 积分');
      return `<details class="raw-item"><summary>${label} · ${esc((e.url || '').replace('https://maker.taptap.cn', ''))} · ${e.ts ? fmtTime(e.ts) : ''}</summary>
        <pre style="font-size:11px;white-space:pre-wrap;word-break:break-all;">${esc(body)}</pre></details>`;
    }).join('');
  });
}

/* ---------- 最近消耗 ---------- */
function refreshTxns() {
  query('transactions', { limit: 5 }, (res) => {
    const box = $('txns');
    if (!res || !res.ok) { box.innerHTML = '<div class="muted">查询失败</div>'; return; }
    const rows = res.data;
    if (!rows.length) { box.innerHTML = '<div class="muted">暂无消耗记录</div>'; return; }
    box.innerHTML = rows.map((r) => {
      const t = r.createdAt ? String(r.createdAt).slice(0, 16).replace('T', ' ') : '';
      const proj = r.projectName || '';
      const title = r.title || '';
      if (r.kind === 'msg-cost') {
        // 消息级消耗：页面消息流"消耗 X 积分 | 剩余 Y 通用积分"
        const pname = r.projectName ? `项目 · ${esc(r.projectName)}` : (r.title || '对话消耗');
        return `<div class="msg">
          <div class="t">${pname}${r.chatId ? ` · ${esc(String(r.chatId).slice(0, 8))}` : ''} · ${esc(t)}</div>
          <div class="cost">${fmt(r.amount)} 积分${r.remaining != null ? ` · 剩余 ${fmt(r.remaining)} 通用` : ''}</div>
        </div>`;
      }
      return `<div class="msg">
        <div class="t">${esc(proj)}${proj && title ? ' · ' : ''}${esc(title)} · ${esc(t)}</div>
        <div class="c" style="color:${r.amount < 0 ? '#dc2626' : '#059669'};font-weight:700;">${r.amount > 0 ? '+' : ''}${fmt(r.amount)}</div>
      </div>`;
    }).join('');
  });
}

/* ---------- 对话统计 ---------- */
// 增量刷新：数据指纹相同则跳过重渲染（避免每次定时刷新都重画 + 重播动画）
const _caches = {};
let _durTimer = null; // 进行中会话耗时的轻量更新定时器（只改文本，不重渲染）
function sigChanged(key, sig) {
  if (_caches[key] === sig) return false;
  _caches[key] = sig;
  return true;
}

function refresh() {
  query('totals', null, (res) => {
    if (!res || !res.ok) return;
    const t = res.data;
    const sig = [t.today.inputs, t.today.credits, t.today.estCredits, t.all.inputs, t.all.credits, t.all.estCredits].join('|');
    if (!sigChanged('totals', sig)) return;
    animateNum($('today-inputs'), t.today.inputs, 500);
    const todayCredits = t.today.credits || t.today.estCredits;
    animateNum($('today-credits'), todayCredits, 500);
    $('today-credits').title = `测得 ${fmt(t.today.credits)} · 估算 ${fmt(t.today.estCredits)}`;
    animateNum($('all-inputs'), t.all.inputs, 500);
    animateNum($('all-credits'), t.all.credits || t.all.estCredits, 500);
  });
}

/* ---------- 图形化图表（Canvas） ---------- */
const CHART_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];
const BAL_SEGS = [
  { key: 'general', label: '通用', color: '#6366f1' },
  { key: 'normal', label: '基础', color: '#10b981' },
  { key: 'paid', label: '付费', color: '#f59e0b' },
  { key: 'event', label: '活动', color: '#ec4899' },
  { key: 'project', label: '项目包', color: '#8b5cf6' },
];
function setupCanvas(id) {
  const cv = document.getElementById(id);
  if (!cv) return null;
  const dpr = window.devicePixelRatio || 1;
  // 高度下限 60px：窄侧边栏布局可能把画布挤到 <40px，导致柱高/半径变负（arcTo IndexSizeError）
  const w = cv.clientWidth || 300, h = Math.max(60, cv.clientHeight || 140);
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}
function short(s, n) { return (s == null ? '' : String(s)).length > n ? String(s).slice(0, n) + '…' : String(s || ''); }

// 环形图：余额构成（增量过渡——弧从旧角度平滑变到新角度，首次才从 0 生长）
let _prevDonut = {}; // label -> value
function drawDonut(segs, centerText, centerSub) {
  const c = setupCanvas('chart-balance');
  if (!c) return;
  const { ctx, w, h } = c;
  const cx = w / 2, cy = h / 2 - 4, R = Math.max(12, Math.min(w, h) / 2 - 16);
  const prev = { ..._prevDonut };
  const hasPrev = Object.keys(prev).length > 0;
  _prevDonut = {};
  segs.forEach((s) => { _prevDonut[s.label] = Math.max(0, Number(s.value) || 0); });
  const safe = (v) => Math.max(0, Number(v) || 0);
  const segsSafe = segs.map((s) => ({ ...s, value: safe(s.value) }));
  const total = segsSafe.reduce((a, s) => a + s.value, 0);
  const legend = segsSafe.filter((s) => s.value > 0)
    .map((s) => `<span><i style="background:${s.color}"></i>${s.label} ${fmt(s.value)}</span>`).join('');
  const lg = document.getElementById('balance-legend');
  if (lg) lg.innerHTML = legend;
  rafDraw((p) => {
    const e = 1 - Math.pow(1 - p, 3);
    ctx.clearRect(0, 0, w, h);
    if (total <= 0) {
      ctx.fillStyle = '#9ca3af'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('暂无余额数据', cx, cy);
      return;
    }
    // 每段从旧值过渡到新值
    const vals = segsSafe.map((s) => {
      const old = hasPrev ? (prev[s.label] || 0) : 0;
      return old + (s.value - old) * e;
    });
    const iTotal = vals.reduce((a, b) => a + b, 0);
    let start = -Math.PI / 2;
    vals.forEach((v, i) => {
      if (v <= 0) return;
      const ang = (v / iTotal) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, start, start + ang); ctx.closePath();
      ctx.fillStyle = segs[i].color; ctx.fill();
      start += ang;
    });
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cy, R * 0.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1f2937'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(fmt(Math.round(iTotal)), cx, cy - 3);
    ctx.fillStyle = '#94a3b8'; ctx.font = '10px sans-serif';
    ctx.fillText(centerSub || '积分余额', cx, cy + 15);
  }, 650);
}

// 柱状图：各项目消耗（增量过渡——柱子从旧高度平滑变到新高度，新增项目才从底部升起；轴随数据自适应）
let _prevBars = {}; // key -> credits
function drawBars(projects) {
  const c = setupCanvas('chart-projects');
  if (!c) return;
  const { ctx, w, h } = c;
  const safe = (v) => Math.max(0, Number(v) || 0);
  const rows = (projects || []).map((p) => ({ ...p, credits: safe(p.credits) }))
    .filter((p) => p.credits > 0).slice(0, 6);
  const prev = { ..._prevBars };
  const hasPrev = Object.keys(prev).length > 0;
  _prevBars = {};
  rows.forEach((r) => { _prevBars[r.projectId || r.name] = r.credits; });
  const max = Math.max(1, ...rows.map((r) => r.credits));
  const bw = w / rows.length;
  rafDraw((p) => {
    const e = 1 - Math.pow(1 - p, 3);
    ctx.clearRect(0, 0, w, h);
    if (!rows.length) {
      ctx.fillStyle = '#9ca3af'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('暂无项目消耗', w / 2, h / 2);
      return;
    }
    rows.forEach((row, i) => {
      const key = row.projectId || row.name;
      const old = hasPrev ? (prev[key] || 0) : 0;
      const v = old + (row.credits - old) * e;
      const bh = Math.max(0, (v / max) * (h - 40));
      const x = i * bw + bw * 0.2, wd = bw * 0.6, y = h - 30 - bh;
      const r = Math.max(0, Math.min(6, wd / 2, bh));
      const grad = ctx.createLinearGradient(0, y, 0, h - 30);
      grad.addColorStop(0, CHART_COLORS[i % CHART_COLORS.length]);
      grad.addColorStop(1, shade(CHART_COLORS[i % CHART_COLORS.length], -18));
      ctx.beginPath();
      ctx.moveTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.arcTo(x + wd, y, x + wd, y + r, r);
      ctx.lineTo(x + wd, h - 30);
      ctx.lineTo(x, h - 30);
      ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      ctx.fillStyle = '#475569'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(fmt(row.credits), x + wd / 2, y - 4);
      ctx.fillStyle = '#64748b'; ctx.font = '10px sans-serif';
      ctx.fillText(short(row.name, 6), x + wd / 2, h - 14);
    });
  }, 720);
}

// 颜色加深/减淡：hex → rgb 偏移
function shade(hex, amt) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amt));
  const b = Math.max(0, Math.min(255, (n & 0xff) + amt));
  return `rgb(${r},${g},${b})`;
}

// 折线图：近 7 天消耗（增量过渡——曲线从旧位置平滑变到新位置，新增点才从底部升起；轴随数据自适应）
let _prevDays = {}; // day -> credits
function drawLine(days) {
  const c = setupCanvas('chart-days');
  if (!c) return;
  const { ctx, w, h } = c;
  const safe = (v) => Math.max(0, Number(v) || 0);
  const pts = (days || []).map((d) => ({ ...d, credits: safe(d.credits) }))
    .filter((d) => d && d.credits != null).slice(-7);
  const prev = { ..._prevDays };
  const hasPrev = Object.keys(prev).length > 0;
  _prevDays = {};
  pts.forEach((d) => { _prevDays[d.day] = d.credits; });
  const max = Math.max(1, ...pts.map((d) => d.credits));
  const stepX = (w - 20) / Math.max(1, pts.length - 1);
  rafDraw((p) => {
    const e = 1 - Math.pow(1 - p, 3);
    ctx.clearRect(0, 0, w, h);
    if (!pts.length) {
      ctx.fillStyle = '#9ca3af'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('暂无消耗记录', w / 2, h / 2);
      return;
    }
    const coords = pts.map((d, i) => {
      const old = hasPrev ? (prev[d.day] || 0) : 0;
      const v = old + (d.credits - old) * e;
      return { x: 10 + i * stepX, y: h - 28 - (v / max) * (h - 42) };
    });
    // 面积渐变
    if (coords.length > 1) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(16,185,129,.28)'); g.addColorStop(1, 'rgba(16,185,129,0)');
      ctx.beginPath();
      ctx.moveTo(coords[0].x, h - 28);
      coords.forEach((c2) => ctx.lineTo(c2.x, c2.y));
      ctx.lineTo(coords[coords.length - 1].x, h - 28);
      ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
    }
    // 折线
    ctx.strokeStyle = '#10b981'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    coords.forEach((c2, i) => { if (i === 0) ctx.moveTo(c2.x, c2.y); else ctx.lineTo(c2.x, c2.y); });
    ctx.stroke();
    // 点 + 标签（标签用终值位置，避免数字跟着抖）
    pts.forEach((d, i) => {
      const x = 10 + i * stepX, y = h - 28 - (d.credits / max) * (h - 42);
      ctx.fillStyle = '#10b981'; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#64748b'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(String(d.day).slice(5), x, h - 12);
      ctx.fillStyle = '#475569';
      ctx.fillText(fmt(d.credits), x, y - 7);
    });
  }, 650);
}

// 每日消耗曲线（按小时）：折线连接每小时消耗值，不打点（增量过渡——曲线从旧位置滑到新位置，新增点才从底部升起；轴随数据自适应）
let _prevLive = {}; // ts -> amount
function drawLiveLine(points) {
  const c = setupCanvas('chart-live');
  if (!c) return;
  const { ctx, w, h } = c;
  const note = $('live-note');
  if (!points || !points.length) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#9ca3af'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('暂无消耗记录 · 发消息后自动出现', w / 2, h / 2);
    if (note) note.textContent = '';
    return;
  }
  const safe = (v) => Math.max(0, Number(v) || 0);
  const clean = points.map((q) => ({ ...q, amount: safe(q.amount) }));
  const prev = { ..._prevLive };
  const hasPrev = Object.keys(prev).length > 0;
  _prevLive = {};
  clean.forEach((q) => { _prevLive[q.ts] = q.amount; });
  const maxAmt = Math.max(1, ...clean.map((q) => q.amount));
  // X 轴固定为"最近 24 小时"、右端 = 当前时间：每个点 = 该小时的消耗量（非累计），
  // 当前正在进行的这一小时显示在最右端
  const span = 24 * 3600e3;
  const t0 = Date.now() - span;
  const px = (ts) => 10 + ((ts - t0) / span) * (w - 20);
  const py = (v) => h - 28 - (v / maxAmt) * (h - 44);
  const peak = clean.reduce((a, b) => (b.amount > a.amount ? b : a));
  rafDraw((p) => {
    const e = 1 - Math.pow(1 - p, 3);
    ctx.clearRect(0, 0, w, h);
    // 横向网格
    ctx.strokeStyle = '#eef2f7'; ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = h - 28 - ((i / 3) * (h - 44));
      ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(w - 10, y); ctx.stroke();
    }
    // 各点从旧值过渡到新值
    const coords = clean.map((q) => {
      const old = hasPrev ? (prev[q.ts] || 0) : 0;
      const v = old + (q.amount - old) * e;
      return { x: px(q.ts), y: py(v) };
    });
    // 面积渐变
    if (coords.length > 1) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(99,102,241,.30)'); g.addColorStop(1, 'rgba(99,102,241,0)');
      ctx.beginPath();
      ctx.moveTo(coords[0].x, h - 28);
      coords.forEach((q) => ctx.lineTo(q.x, q.y));
      ctx.lineTo(coords[coords.length - 1].x, h - 28);
      ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
    }
    // 折线（无点）
    ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    coords.forEach((q, i) => {
      if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
    });
    ctx.stroke();
    // 峰值标注（过渡接近完成时显示，位置用终值）
    if (p >= 0.8) {
      ctx.fillStyle = '#1f2937'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(`峰值 ${fmt(peak.amount)}`, Math.min(px(peak.ts) + 8, w - 70), Math.max(12, py(peak.amount) - 6));
    }
    // X 轴整点标签（覆盖最近 24 小时）
    const H = 3600e3;
    const startHour = Math.ceil(t0 / H) * H;
    ctx.fillStyle = '#94a3b8'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    for (let ts = startHour; ts <= t0 + span; ts += H) {
      if (ts < t0 || ts > t0 + span) continue;
      const d = new Date(ts);
      ctx.fillText(`${String(d.getHours()).padStart(2, '0')}:00`, px(ts), h - 12);
    }
  }, 700);
  if (note) note.textContent = `每个点 = 该小时消耗 · 峰值 ${fmt(peak.amount)} 积分/小时`;
}

function refreshCharts() {
  query('byProject', null, (res) => {    if (res && res.ok) {
      const rows = res.data || [];
      const sig = rows.map((r) => `${r.projectId}|${r.credits}|${r.inputs}|${r.durationMs}|${r.name}`).join(',');
      if (!sigChanged('byProject', sig)) return;
      drawBars(rows);
      const listEl = $('project-list');
      if (listEl) {
        const list = rows.filter((r) => r.credits > 0).slice(0, 6).map((r) => {
          const chatRows = (r.chats || []).map((c) =>
            `<div class="proj-chat"><span class="ell" title="${esc(c.chatId)}">${esc(c.title || ('会话 ' + String(c.chatId).slice(0, 8)))}</span><b>${fmt(c.credits)}</b><span class="l">${c.durationMs ? fmtDur(c.durationMs) + ' · ' : ''}${fmt(c.inputs)} 条消息</span></div>`).join('');
          return `<details class="proj-card"${r.chats && r.chats.length <= 1 ? ' open' : ''}>
            <summary><span class="ell">${esc(r.name)}</span><b class="pc-cost">${fmt(r.credits)}</b><span class="pc-meta">${r.durationMs ? fmtDur(r.durationMs) + ' · ' : ''}${r.inputs} 条消息</span></summary>
            ${chatRows || '<div class="muted">暂无会话明细</div>'}
          </details>`;
        }).join('');
        listEl.innerHTML = list || '<div class="muted">暂无项目消耗 · 发消息后自动统计</div>';
      }
    }
  });
  query('byModel', null, (res) => {
    const box = $('model-list');
    if (!box) return;
    if (res && res.ok && res.data.length) {
      const rows = res.data.slice(0, 8);
      const sig = rows.map((r) => `${r.model}|${r.spent}|${r.count}`).join(',');
      if (!sigChanged('byModel', sig)) return;
      const mColor = (m) => {
        let h = 0;
        for (const ch of String(m || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
        return `hsl(${h},72%,55%)`;
      };
      box.innerHTML = rows.map((r) => `<div class="model-row">
        <span class="m-dot" style="background:${mColor(r.model)}"></span>
        <span class="ell" title="${esc((r.projects || []).join(', '))}">${esc(r.model)}</span>
        <b title="消耗积分">${fmt(r.spent)}</b>
        <span class="l">${fmt(r.count)} 次</span>
      </div>`).join('');
    } else if (sigChanged('byModel', 'empty')) {
      box.innerHTML = '<div class="muted">暂无模型记录 · 打开积分页后自动统计</div>';
    }
  });
  query('byDay', null, (res) => {
    if (res && res.ok) {
      const days = res.data || [];
      const sig = days.map((d) => `${d.day}|${d.credits}`).join(',');
      if (sigChanged('byDay', sig)) drawLine(days);
    }
  });
  query('costSeries', { hours: 24 }, (res) => {
    if (res && res.ok) {
      const pts = res.data || [];
      const sig = pts.map((p) => `${p.ts}|${p.amount}`).join(',');
      if (sigChanged('costSeries', sig)) drawLiveLine(pts);
    }
  });
  query('creditBreakdown', null, (res) => {
    if (res && res.ok) {
      const bd = (res.data.latest && res.data.latest.breakdown) || {};
      const gen = (bd.general || 0) + (bd.memberGeneral || 0);
      const normal = bd.normal == null ? null : (bd.normal || 0);
      const sig = `${gen}|${normal}|${bd.paid || 0}|${bd.event || 0}|${bd.project || 0}`;
      if (!sigChanged('donut', sig)) return;
      const normalLabel = normal == null ? '待同步' : fmt(normal);
      drawDonut([
        { label: '通用', value: gen, color: '#6366f1' },
        { label: '基础', value: normal || 0, color: '#10b981' },
        { label: '付费', value: bd.paid || 0, color: '#f59e0b' },
        { label: '活动', value: bd.event || 0, color: '#ec4899' },
        { label: '项目包', value: bd.project || 0, color: '#8b5cf6' },
      ], fmt(gen + (normal || 0)), normalLabel);
    }
  });
}

refresh();
refreshInjectStatus();
refreshCredits();
refreshCapture();
renderSessions();
refreshCharts();
// 分级刷新：10 秒刷实时项（状态/积分/最近消息/今日概览），5 秒刷「正在处理」，
// 30 秒刷统计图表——不做全量刷新
setInterval(() => { refresh(); refreshInjectStatus(); refreshCredits(); refreshCapture(); }, 10000);
setInterval(() => { renderSessions(); }, 5000);
setInterval(() => { refreshCharts(); }, 30000);
