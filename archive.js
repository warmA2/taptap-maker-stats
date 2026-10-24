/* archive.js — 会话归档页
 * 渲染策略：
 *   1. 左侧树只在「数据变化 / 搜索词变化」时重建，点会话只切高亮，不重建 DOM；
 *      项目内会话在首次展开时才填充（懒渲染），几百个会话也不卡。
 *   2. 右侧对话流按批渲染（默认 12 轮），滚到底部自动续；每轮 HTML 缓存，
 *      来回切会话不重复解析。
 *   3. 模型输出做 Markdown 渲染（自写轻量解析，不引外部库，扩展 CSP 也安全）。
 */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const BATCH = 12;         // 每批渲染轮数

let DATA = null;          // queryArchive 的返回
let BYID = new Map();     // chatId -> chat（含 projName / projId）
let SEL = null;           // 当前选中的 chatId
let Q = '';               // 搜索词
let MD = true;            // Markdown 渲染开关

let CUR = null;           // 当前阅读的 chat
let CUR_I = 0;            // 已渲染到第几轮
let SEL_EL = null;        // 当前高亮的树节点（避免每次 querySelectorAll）
const OPEN = new Set();   // 展开中的项目 id
const TURN_CACHE = new Map(); // chatId|i -> html，切换会话时复用
let IO = null;

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

/* 对「已转义的文本」加搜索高亮；不打标签，只插 span，安全 */
function markTxt(s) {
  if (!Q) return s;
  const needle = esc(Q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!needle) return s;
  try { return s.replace(new RegExp(needle, 'gi'), (m) => `<span class="hit">${m}</span>`); }
  catch (e) { return s; }
}

/* ---------------- Markdown（轻量） ---------------- */
// 行内语法。行内代码先抽成占位符，避免 **粗体** 跨越 `代码` 时被拆断。
function inlineMd(raw) {
  const src = String(raw == null ? '' : raw);
  const codes = [];
  const masked = src.replace(/`([^`\n]+)`/g, (m, c) => {
    codes.push(c);
    return '\u0001' + (codes.length - 1) + '\u0002';
  });
  let t = markTxt(esc(masked));
  // [文字](链接)
  t = t.replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]+)\)/g, (m, txt, url) =>
    `<a href="${url.replace(/&amp;/g, '&')}" target="_blank" rel="noreferrer noopener">${txt}</a>`);
  // 裸链接（跳过 href="..." 内部）
  t = t.replace(/(^|[^"'=\w>])(https?:\/\/[^\s<>"'）)]+)/g, (m, pre, url) =>
    `${pre}<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // 占位符还原成行内代码
  t = t.replace(/\u0001(\d+)\u0002/g, (m, i) => '<code>' + markTxt(esc(codes[Number(i)] || '')) + '</code>');
  return t;
}

const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
const isTableSep = (l) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l || '') && (l || '').indexOf('-') >= 0;

function parseList(lines, start) {
  let i = start;
  const baseIndent = (lines[start].match(/^\s*/) || [''])[0].length;
  const ordered = /^\s*\d+[.)]\s+/.test(lines[start]);
  const items = [];
  let cur = null;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      const nx = lines[i + 1];
      if (nx && (/^\s*([-*+]|\d+[.)])\s+/.test(nx) || /^\s{2,}\S/.test(nx))) { i++; continue; }
      break;
    }
    const indent = (l.match(/^\s*/) || [''])[0].length;
    const m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    // 缩进回到本层之外：说明这一项属于上层列表，跳出交给上层处理
    if (m && indent < baseIndent) break;
    if (m && indent <= baseIndent + 1) {
      if (cur) items.push(cur);
      cur = { text: [m[3]], kids: [] };
      i++;
      continue;
    }
    if (cur && indent > baseIndent) {
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        const sub = parseList(lines, i);
        cur.kids.push(sub.html);
        i = sub.next;
        continue;
      }
      cur.text.push(l.trim());
      i++;
      continue;
    }
    break;
  }
  if (cur) items.push(cur);
  const tag = ordered ? 'ol' : 'ul';
  const html = `<${tag}>` + items.map((it) =>
    '<li>' + inlineMd(it.text.join('\n')).replace(/\n/g, '<br>') + it.kids.join('') + '</li>').join('') + `</${tag}>`;
  return { html, next: i };
}

function mdRender(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    out.push('<p>' + inlineMd(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 代码围栏
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
    if (fence) {
      flush();
      const mark = fence[1][0].repeat(3);
      const lang = fence[2] || '';
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp('^\\s*' + mark).test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // 跳过收尾围栏
      out.push(`<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${markTxt(esc(buf.join('\n')))}</code></pre>`);
      continue;
    }
    // 分隔线
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    // 标题（收敛到 h4-h6，避免正文里出现巨型标题）
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const lv = Math.min(h[1].length + 3, 6);
      out.push(`<h${lv}>${inlineMd(h[2])}</h${lv}>`);
      i++;
      continue;
    }
    // 引用
    if (/^\s*>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote>' + mdRender(buf.join('\n')) + '</blockquote>');
      continue;
    }
    // 表格
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      out.push('<table class="md-t"><thead><tr>' + head.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + head.map((_, ci) => `<td>${inlineMd(r[ci] || '')}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }
    // 列表
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const r = parseList(lines, i);
      out.push(r.html);
      i = r.next;
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line);
    i++;
  }
  flush();
  return out.join('\n');
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

function indexChats() {
  BYID = new Map();
  if (!DATA) return;
  for (const p of DATA.projects) {
    for (const c of p.chats) BYID.set(c.chatId, Object.assign({}, c, { projName: p.name, projId: p.id }));
  }
}

function chatMatches(c) {
  if (!Q) return true;
  const q = Q.toLowerCase();
  if (String(c.title || '').toLowerCase().indexOf(q) >= 0) return true;
  if (String(c.projName || '').toLowerCase().indexOf(q) >= 0) return true;
  return c.turns.some((t) => String(t.text || '').toLowerCase().indexOf(q) >= 0
    || String(t.outText || '').toLowerCase().indexOf(q) >= 0);
}

/* ---------------- 左树（骨架 + 懒填充） ---------------- */
function renderStats() {
  const s = DATA ? DATA.stats : null;
  $('s-proj').textContent = s ? s.projects : '–';
  $('s-chat').textContent = s ? s.chats : '–';
  $('s-turn').textContent = s ? s.inputs : '–';
  $('s-char').textContent = s ? fmtN(s.chars) : '–';
  $('s-credit').textContent = s ? fmtN(s.credits) : '–';
}

function chatItemHtml(c) {
  return `<div class="chat-item${c.chatId === SEL ? ' on' : ''}" data-chat="${esc(c.chatId)}">
    <div class="ci-t">${markTxt(esc(c.title))}</div>
    <div class="ci-m">${c.inputs} 轮 · ${fmtN(c.chars)} 字${c.credits ? ' · ' + fmtN(c.credits) + ' 积分' : ''} · ${fmtTs(c.startTs)}</div>
  </div>`;
}

function projBodyHtml(p) {
  const chats = p.chats.filter(chatMatches);
  if (!chats.length) return '<div class="empty" style="padding:12px">无匹配会话</div>';
  return chats.map(chatItemHtml).join('');
}

function fillProj(box) {
  if (box.dataset.filled === '1') return;
  const p = DATA.projects.find((x) => String(x.id || '') === box.dataset.proj);
  if (!p) return;
  box.innerHTML = projBodyHtml(p);
  box.dataset.filled = '1';
  SEL_EL = null; // body 重建过，旧的引用作废
  markSel(SEL, false);
}

function setOpen(projEl, on) {
  const body = projEl.querySelector('.proj-body');
  if (on) {
    projEl.classList.add('open');
    OPEN.add(body.dataset.proj);
    fillProj(body);
  } else {
    projEl.classList.remove('open');
    OPEN.delete(body.dataset.proj);
  }
}

function renderTree() {
  const box = $('tree');
  SEL_EL = null;
  if (!DATA) { box.innerHTML = '<div class="empty">读取失败，点右上角刷新</div>'; return; }
  if (!DATA.projects.length) {
    box.innerHTML = '<div class="empty">还没有记录<br>先打开 maker.taptap.cn 说几句话</div>';
    return;
  }
  const html = DATA.projects.map((p, pi) => {
    const n = Q ? p.chats.filter(chatMatches).length : p.chats.length;
    if (Q && !n) return '';
    const pid = String(p.id || '');
    const open = Q ? true : (OPEN.size ? OPEN.has(pid) : pi === 0);
    if (open) OPEN.add(pid);
    return `<div class="proj${open ? ' open' : ''}">
      <div class="proj-h"><span class="caret">▶</span><span class="nm">${markTxt(esc(p.name))}</span><span class="cnt">${n} 会话</span></div>
      <div class="proj-body" data-proj="${esc(pid)}"></div>
    </div>`;
  }).join('');
  box.innerHTML = html || '<div class="empty">没有匹配的内容</div>';

  // 只填充已展开的项目，其余等展开时再渲染
  box.querySelectorAll('.proj.open .proj-body').forEach(fillProj);
  markSel(SEL, false);
}

function onTreeClick(e) {
  const head = e.target.closest('.proj-h');
  if (head) { const el = head.parentElement; setOpen(el, !el.classList.contains('open')); return; }
  const item = e.target.closest('.chat-item');
  if (item) select(item.dataset.chat);
}

/* 只切高亮，不重建 DOM */
function markSel(chatId, scroll) {
  if (SEL_EL && SEL_EL.isConnected) SEL_EL.classList.remove('on');
  SEL_EL = null;
  if (!chatId) return;
  const el = document.querySelector(`.chat-item[data-chat="${CSS.escape(String(chatId))}"]`);
  if (!el) return;
  el.classList.add('on');
  SEL_EL = el;
  if (scroll && scroll !== false) {
    const r = el.getBoundingClientRect(), a = $('tree').getBoundingClientRect();
    if (r.top < a.top || r.bottom > a.bottom) el.scrollIntoView({ block: 'nearest' });
  }
}

/* 选中项在未展开的项目里时，按需展开它 */
function revealChat(chatId) {
  if (document.querySelector(`.chat-item[data-chat="${CSS.escape(String(chatId))}"]`)) return;
  const c = BYID.get(chatId);
  if (!c) return;
  const pid = String(c.projId || '');
  const projEl = [...document.querySelectorAll('.proj')].find((el) => el.querySelector('.proj-body').dataset.proj === pid);
  if (projEl && !projEl.classList.contains('open')) setOpen(projEl, true);
}

/* ---------------- 右阅读区（分批 + 缓存） ---------------- */
function turnHtml(t, i) {
  const key = `${t.__cid}|${i}`;
  const hit = TURN_CACHE.get(key);
  if (hit) return hit;

  const dur = t.endedTs && t.ts ? fmtDur(t.endedTs - t.ts) : '';
  const meta = [t.credits ? `${fmtN(t.credits)} 积分` : '', dur ? `耗时 ${dur}` : '', t.model || '']
    .filter(Boolean).join(' · ');
  const out = String(t.outText || '').trim();
  const body = out
    ? (MD ? mdRender(t.outText) : `<div class="plain">${markTxt(esc(t.outText))}</div>`)
    : '<span class="muted">（这一轮没有抓到模型输出）</span>';
  const html = `
    <div class="turn">
      <div class="turn-h"><span class="idx">第 ${i + 1} 轮</span><span>${fmtTs(t.ts)}</span>${meta ? `<span>${esc(meta)}</span>` : ''}</div>
      <div class="blk u"><span class="who">我</span><div class="txt">${markTxt(esc(t.text || '（这条没抓到输入文本）'))}</div></div>
      <div class="blk a"><span class="who">模型</span><div class="txt md">${body}</div></div>
    </div>`;
  TURN_CACHE.set(key, html);
  return html;
}

function applyClip(scope) {
  scope.querySelectorAll('.blk.a .txt').forEach((txt) => {
    if (txt.dataset.ck === '1') return;
    txt.dataset.ck = '1';
    if (txt.scrollHeight > 240) {
      txt.classList.add('clip');
      const btn = document.createElement('button');
      btn.className = 'more';
      btn.textContent = '展开全文';
      btn.addEventListener('click', () => { txt.classList.remove('clip'); btn.remove(); });
      txt.parentElement.after(btn);
    }
  });
}

function readerHead(c) {
  return `
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
        <button class="btn-mini" id="btn-mdmode" title="模型输出按 Markdown 渲染，或直接看原文">Markdown 渲染${MD ? ' ✓' : ''}</button>
      </div>
    </div>`;
}

function renderReader() {
  const box = $('reader');
  const c = SEL ? BYID.get(SEL) : null;
  CUR = c || null;
  if (!c) { box.innerHTML = '<div class="empty">从左边选一个会话</div>'; return; }

  if (IO) { IO.disconnect(); IO = null; }
  box.innerHTML = readerHead(c)
    + '<div class="turns" id="turns"></div>'
    + `<div id="sentinel" class="sentinel"></div>`;
  CUR_I = 0;

  const copyBtn = $('btn-copy');
  if (copyBtn) copyBtn.addEventListener('click', () => copy(chatToMd(c), '会话已复制'));
  const openBtn = $('btn-open');
  if (openBtn) openBtn.addEventListener('click', () => {
    const url = c.projId
      ? `https://maker.taptap.cn/app/${encodeURIComponent(c.projId)}?chatId=${encodeURIComponent(c.chatId)}`
      : 'https://maker.taptap.cn/';
    window.open(url, '_blank');
  });
  const mdBtn = $('btn-mdmode');
  if (mdBtn) mdBtn.addEventListener('click', () => {
    MD = !MD;
    TURN_CACHE.clear();
    const st = box.scrollTop;
    renderReader();
    box.scrollTop = st;
  });

  box.scrollTop = 0;
  appendTurns();
}

function appendTurns() {
  const c = CUR;
  if (!c) return;
  const turns = $('turns');
  const sent = $('sentinel');
  if (!turns || !sent || CUR_I >= c.turns.length) return;

  const end = Math.min(CUR_I + BATCH, c.turns.length);
  const tmp = document.createElement('div');
  let html = '';
  for (let i = CUR_I; i < end; i++) {
    const t = c.turns[i];
    t.__cid = c.chatId;
    html += turnHtml(t, i);
  }
  tmp.innerHTML = html;
  const nodes = [...tmp.childNodes];
  nodes.forEach((n) => turns.appendChild(n));
  CUR_I = end;
  applyClip(turns);

  if (CUR_I >= c.turns.length) {
    if (IO) { IO.disconnect(); IO = null; }
    sent.className = 'sentinel done';
    sent.textContent = `共 ${c.turns.length} 轮`;
  } else {
    sent.textContent = `继续滚动加载（还剩 ${c.turns.length - CUR_I} 轮）`;
  }
  watchSentinel();
}

function watchSentinel() {
  const sent = $('sentinel');
  const box = $('reader');
  if (!sent || !box || IO) return;
  IO = new IntersectionObserver((es) => {
    if (es.some((e) => e.isIntersecting)) appendTurns();
  }, { root: box, rootMargin: '400px' });
  IO.observe(sent);
}

function select(chatId) {
  if (SEL === chatId) return;
  SEL = chatId;
  if (decodeURIComponent(location.hash.slice(1) || '') !== chatId) location.hash = encodeURIComponent(chatId);
  markSel(chatId, true);          // 只切高亮
  renderReader();                  // 只重绘右侧
}

/* ---------------- Markdown 导出 ---------------- */
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
  TURN_CACHE.clear();
  if (!d) { renderTree(); return; }

  indexChats();
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
  const firstChat = (DATA.projects[0] && DATA.projects[0].chats[0]) || null;
  const first = BYID.get(want) || (firstChat && BYID.get(firstChat.chatId)) || null;
  SEL = first ? first.chatId : null;
  if (SEL) OPEN.add(String(first.projId || ''));

  renderTree();
  if (SEL) { revealChat(SEL); markSel(SEL, true); }
  renderReader();

  $('hdr-sub').textContent = `按项目 / 会话浏览全部对话 · 共 ${d.stats.inputs} 轮 · 数据只在本机`;
}

let searchTimer = null;
$('tree').addEventListener('click', onTreeClick);   // 只绑一次，树重建后依然有效
$('q').addEventListener('input', (e) => {
  Q = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    TURN_CACHE.clear();
    renderTree();
    renderReader();
  }, 140);
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
  if (id && id !== SEL && BYID.has(id)) select(id);
});

load();
