/* archive.js — 会话归档页：按 项目 → 会话 浏览全部对话，支持搜索与 Markdown 导出 */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let DATA = null;          // queryArchive 的返回
let SEL = null;           // 当前选中的 chatId
let Q = '';               // 搜索词

/* ---------------- 格式化 ---------------- */
function fmtN(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return (v / 10000).toFixed(v >= 100000 ? 0 : 1) + ' 万';
  return v.toLocaleString('zh-CN');
}
function fmtTs(ts, withYear) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withYear ? `${d.getFullYear()}-${md} ${p(d.getHours())}:${p(d.getMinutes())}` : `${md} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDur(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}
function hl(text) {
  if (!Q) return esc(text);
  const escaped = esc(text);
  const needle = esc(Q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!needle) return escaped;
  return escaped.replace(new RegExp(needle, 'gi'), (m) => `<span class="hit">${m}</span>`);
}

/* ---------------- 数据 ---------------- */
function query(what, extra) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ kind: 'query', what, ...(extra || {}) }, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res && res.ok ? res.data : null);
      });
    } catch (e) { resolve(null); }
  });
}

function allChats() {
  if (!DATA) return [];
  const out = [];
  for (const p of DATA.projects) {
    for (const c of p.chats) out.push({ ...c, projName: p.name, projId: p.id });
  }
  return out;
}

function chatMatches(c) {
  if (!Q) return true;
  const q = Q.toLowerCase();
  if (String(c.title || '').toLowerCase().includes(q)) return true;
  if (String(c.projName || '').toLowerCase().includes(q)) return true;
  return c.turns.some((t) => String(t.text || '').toLowerCase().includes(q)
    || String(t.outText || '').toLowerCase().includes(q));
}

/* ---------------- 渲染 ---------------- */
function renderStats() {
  const s = DATA ? DATA.stats : null;
  $('s-proj').textContent = s ? s.projects : '–';
  $('s-chat').textContent = s ? s.chats : '–';
  $('s-turn').textContent = s ? s.inputs : '–';
  $('s-char').textContent = s ? fmtN(s.chars) : '–';
  $('s-credit').textContent = s ? fmtN(s.credits) : '–';
}

function renderTree() {
  const box = $('tree');
  if (!DATA) { box.innerHTML = '<div class="empty">读取失败，点右上角刷新</div>'; return; }
  if (!DATA.projects.length) {
    box.innerHTML = '<div class="empty">还没有记录<br>先打开 maker.taptap.cn 说几句话</div>';
    return;
  }
  const html = DATA.projects.map((p, pi) => {
    const chats = p.chats.filter(chatMatches);
    if (Q && !chats.length) return '';
    const open = Q ? ' open' : (pi === 0 ? ' open' : '');
    const items = chats.map((c) => `
      <div class="chat-item${c.chatId === SEL ? ' on' : ''}" data-chat="${esc(c.chatId)}">
        <div class="ci-t">${hl(c.title)}</div>
        <div class="ci-m">${c.inputs} 轮 · ${fmtN(c.chars)} 字${c.credits ? ' · ' + fmtN(c.credits) + ' 积分' : ''} · ${fmtTs(c.startTs)}</div>
      </div>`).join('');
    return `
      <div class="proj${open}" data-proj="${esc(p.id || '')}">
        <div class="proj-h"><span class="caret">▶</span><span class="nm">${hl(p.name)}</span><span class="cnt">${chats.length} 会话</span></div>
        <div class="proj-body">${items || '<div class="empty" style="padding:12px">无匹配会话</div>'}</div>
      </div>`;
  }).join('');
  box.innerHTML = html || '<div class="empty">没有匹配的内容</div>';

  box.querySelectorAll('.proj-h').forEach((h) => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('open'));
  });
  box.querySelectorAll('.chat-item').forEach((el) => {
    el.addEventListener('click', () => select(el.dataset.chat));
  });
}

function turnHtml(t, i) {
  const dur = t.endedTs && t.ts ? fmtDur(t.endedTs - t.ts) : '';
  const meta = [t.credits ? `${fmtN(t.credits)} 积分` : '', dur ? `耗时 ${dur}` : '', t.model || '']
    .filter(Boolean).join(' · ');
  const hasOut = (t.outText || '').trim().length > 0;
  const long = (t.outText || '').length > 900;
  return `
    <div class="turn">
      <div class="turn-h"><span class="idx">第 ${i + 1} 轮</span><span>${fmtTs(t.ts)}</span>${meta ? `<span>${esc(meta)}</span>` : ''}</div>
      <div class="blk u"><span class="who">我</span><div class="txt">${hl(t.text || '（这条没抓到输入文本）')}</div></div>
      <div class="blk a"><span class="who">模型</span>
        <div class="txt${long ? ' clip' : ''}">${hasOut ? hl(t.outText) : '<span style="color:#9aa3b2">（这一轮没有抓到模型输出）</span>'}</div>
      </div>
      ${long ? '<button class="more" data-more="1">展开全文</button>' : ''}
    </div>`;
}

function renderReader() {
  const box = $('reader');
  const c = allChats().find((x) => x.chatId === SEL);
  if (!c) { box.innerHTML = '<div class="empty">从左边选一个会话</div>'; return; }
  const withOut = c.turns.filter((t) => (t.outText || '').trim()).length;
  box.innerHTML = `
    <div class="rd-head">
      <h2>${esc(c.title)}</h2>
      <div class="rd-meta">
        <span>项目 <b>${esc(c.projName)}</b></span>
        <span>${c.inputs} 轮</span>
        <span>输出 <b>${fmtN(c.chars)}</b> 字</span>
        ${c.credits ? `<span>积分 <b>${fmtN(c.credits)}</b></span>` : ''}
        <span>${fmtTs(c.startTs, true)} → ${fmtTs(c.endTs)}</span>
      </div>
      <div class="rd-actions">
        <button class="btn-mini" id="btn-copy">复制这个会话</button>
        <button class="btn-mini" id="btn-open">去 maker 打开</button>
      </div>
    </div>
    <div class="turns">${c.turns.map(turnHtml).join('')}</div>`;

  box.querySelectorAll('[data-more]').forEach((b) => {
    b.addEventListener('click', () => {
      const txt = b.previousElementSibling.querySelector('.txt.clip');
      if (txt) { txt.classList.remove('clip'); b.remove(); }
    });
  });
  const copyBtn = $('btn-copy');
  if (copyBtn) copyBtn.addEventListener('click', () => copy(chatToMd(c), '会话已复制'));
  const openBtn = $('btn-open');
  if (openBtn) openBtn.addEventListener('click', () => {
    const appId = c.projId;
    const url = appId
      ? `https://maker.taptap.cn/app/${encodeURIComponent(appId)}?chatId=${encodeURIComponent(c.chatId)}`
      : 'https://maker.taptap.cn/';
    window.open(url, '_blank');
  });
  box.scrollTop = 0;
}

function select(chatId) {
  SEL = chatId;
  if (location.hash.slice(1) !== chatId) location.hash = chatId;
  renderTree();
  renderReader();
}

/* ---------------- Markdown ---------------- */
function chatToMd(c) {
  const lines = [`### ${c.title}`, '', `- 项目：${c.projName}`, `- 时间：${fmtTs(c.startTs, true)} → ${fmtTs(c.endTs, true)}`,
    `- 轮次：${c.inputs} · 输出 ${fmtN(c.chars)} 字${c.credits ? ` · 积分 ${fmtN(c.credits)}` : ''}`, ''];
  c.turns.forEach((t, i) => {
    lines.push(`**第 ${i + 1} 轮** · ${fmtTs(t.ts, true)}${t.credits ? ` · ${fmtN(t.credits)} 积分` : ''}`);
    lines.push('', '> 我：' + String(t.text || '').trim().replace(/\n/g, '\n> '));
    lines.push('', String(t.outText || '（无输出）').trim(), '');
  });
  return lines.join('\n');
}

function allToMd() {
  const s = DATA.stats;
  const head = [
    '# TapTap 制造 · 会话归档',
    '',
    `> 导出时间 ${fmtTs(Date.now(), true)} · ${s.projects} 个项目 / ${s.chats} 个会话 / ${s.inputs} 轮 / 输出 ${fmtN(s.chars)} 字`,
    '>',
    '> 使用方式：把这份文档作为素材交给模型，可直接让它做整合分析（梳理我在各项目里做过什么、卡在哪里、需求演进脉络、重复出现的返工点）。',
    '',
  ].join('\n');
  const body = DATA.projects.map((p) => {
    const sec = [`## 项目：${p.name}`, '', `${p.chats.length} 个会话 · ${p.inputs} 轮 · 输出 ${fmtN(p.chars)} 字${p.credits ? ` · 积分 ${fmtN(p.credits)}` : ''}`, ''];
    for (const c of p.chats) sec.push(chatToMd(c), '---', '');
    return sec.join('\n');
  }).join('\n');
  return head + body;
}

function download(text, name) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function copy(text, msg) {
  const done = () => toast(msg || '已复制');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallback());
  } else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择'); }
    ta.remove();
  }
}

let toastTimer = null;
function toast(text) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111827;color:#fff;'
      + 'padding:9px 16px;border-radius:8px;font-size:12.5px;z-index:99;opacity:0;transition:opacity .2s';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1600);
}

/* ---------------- 启动 ---------------- */
async function load() {
  $('tree').innerHTML = '<div class="empty">读取中…</div>';
  const d = await query('archive');
  DATA = d;
  if (!d) { renderTree(); return; }

  renderStats();
  const noOut = d.projects.reduce((a, p) => a + p.chats.reduce(
    (b, c) => b + c.turns.filter((t) => !(t.outText || '').trim()).length, 0), 0);
  if (noOut > 0) {
    $('warn').classList.add('on');
    $('warn').textContent = `有 ${noOut} 轮只抓到输入、没抓到模型回复（页面刷新或中途关掉都会这样）。这些轮次在页面里会标注出来。`;
  } else {
    $('warn').classList.remove('on');
  }

  const want = decodeURIComponent(location.hash.slice(1) || '');
  const list = allChats();
  const first = list.find((c) => c.chatId === want) || list[0];
  SEL = first ? first.chatId : null;
  if (SEL && location.hash.slice(1) !== SEL) location.hash = SEL;
  renderTree();
  renderReader();

  $('hdr-sub').textContent = `按项目 / 会话浏览全部对话 · 共 ${d.stats.inputs} 轮 · 数据只在本机`;
}

let searchTimer = null;
$('q').addEventListener('input', (e) => {
  Q = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { renderTree(); renderReader(); }, 120);
});

$('btn-refresh').addEventListener('click', load);
$('btn-md').addEventListener('click', () => {
  if (!DATA) return;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  download(allToMd(), `taptap-maker-archive-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.md`);
  toast('已导出 Markdown');
});
window.addEventListener('hashchange', () => {
  const id = decodeURIComponent(location.hash.slice(1) || '');
  if (id && id !== SEL) { SEL = id; renderTree(); renderReader(); }
});

load();
