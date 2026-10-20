/**
 * TapTap 制造统计 · content.js
 * isolated world：
 *  1) 接收 main-hook 的 postMessage 事件，转发给 background；
 *  2) 主动拉取当前登录用户的积分余额（页面同源、带登录 cookie）；
 *  3) 上报本页注入状态（用于侧边栏显示"扩展是否生效"）。
 */
(() => {
  'use strict';

  // 接管策略：扩展重载后，页面里旧 content 实例的 context 已失效，但其定时器残影仍会
  // 继续运行并反复报 "Extension context invalidated"（旧版代码没有兜底时无法自我清理）。
  // 新实例注入时直接重置标志接管；旧实例若是新版代码，下一次 sendMessage 失败会走
  // safeSend → markDead 自行清掉自身定时器（最老的旧版实例仍需页面刷新一次彻底清除）。
  window.__ttMakerStatsInjected = false;
  window.__ttMakerStatsDead = false;
  window.__ttMakerStatsInjected = true;

  const timers = [];

  // 安全发送：扩展重载导致 context invalidated 时，sendMessage 返回的 Promise 会 reject，
  // 不处理就是 Uncaught (in promise) 噪音；此处统一兜底，并触发失效自停
  function safeSend(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') {
        // .catch 回调必须 try/catch：回调本身抛错会让 .catch 返回的新 Promise reject → 又一条 Uncaught
        p.catch(() => { try { markDead(); } catch (e) { /* ignore */ } });
      }
    } catch (e) { try { markDead(); } catch (e2) { /* ignore */ } }
  }

  // 全局兜底：任何遗漏的未处理 Promise 拒绝（如扩展重载瞬间的竞态）都静默吞掉，不刷控制台
  window.addEventListener('unhandledrejection', (e) => { e.preventDefault(); });

  // 失效自停：chrome API 已不可用 → 停掉所有定时器并释放注入标志，
  // 让重载后的新 content 脚本能干净接管（否则新旧两份定时器共存、持续报错）
  function markDead() {
    try {
      if (window.__ttMakerStatsDead) return;
      window.__ttMakerStatsDead = true;
      timers.forEach((t) => { try { clearInterval(t); clearTimeout(t); } catch (e) { /* ignore */ } });
      window.__ttMakerStatsInjected = false;
    } catch (e) { /* ignore */ }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'tt-maker-stats') return;
    const { type, data } = d;
    if (!type || !data) return;
    safeSend({ kind: 'tt-event', type, data });
  });

  // 心跳：页面注入成功，通知 background（用于侧边栏状态指示）
  // 定时重发——SW 重启会丢内存态，页面没刷新时靠心跳续命
  function heartbeat() {
    safeSend({ kind: 'tt-hello', data: { url: location.href, ts: Date.now() } });
  }
  heartbeat();
  timers.push(setInterval(heartbeat, 30000));

  // 积分数据不主动拉取：页面自身请求（带完整登录凭证）由 main-hook 截获入库。
  // 扩展自己 fetch 会因缺认证 token 返回 401，改为纯截获后 100% 走页面凭证。

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.kind === 'pull-credits') {
      sendResponse({ ok: true, note: '不再主动拉取，等待页面自身请求截获' });
      return true;
    }
    if (msg && msg.kind === 'ping') {
      sendResponse({ ok: true });
      return undefined;
    }
    return undefined;
  });

  // ---- DOM 扫描：直接读取页面已渲染的积分/用量文本（页面显示什么就抓什么） ----
  // 命中关键词后向上找"含数字"的最近容器（消息行的"消耗2积分|剩余40225通用积分"数字在独立节点里）
  function closestRichText(node) {
    let el = node.parentElement;
    for (let i = 0; el && i < 6; i++, el = el.parentElement) {
      const t = (el.innerText || '').trim();
      if (t && t.length <= 300 && /\d/.test(t)) return t;
    }
    return (node.textContent || '').trim();
  }
  // 项目名：优先取页面标题（"云效动效演示" 这类），其次是 h1/导航内标题
  function guessProjectTitle() {
    try {
      const dt = (document.title || '').replace(/[|｜\-—_·].*$/, '').trim();
      if (dt && dt !== 'TapTap制造' && dt !== 'TapTap 制造') return dt;
      const cands = [
        document.querySelector('h1'),
        document.querySelector('header h1'),
        document.querySelector('nav h1'),
        document.querySelector('[class*="project"] h1'),
        document.querySelector('[class*="name"] h1'),
      ];
      for (const el of cands) {
        if (!el) continue;
        const t = (el.textContent || '').trim();
        if (t && t.length > 1 && t.length < 40) return t;
      }
      return dt || '';
    } catch (e) { return ''; }
  }
  function scanDomCredits() {
    if (!document.body) return;
    const found = [];
    const seen = new Set();
    const settlements = []; // 结算行 + 它前面那条消息的文本（按页面顺序 = 真实返回关联）
    const needle = /积分|余额|剩余|消耗|tokens|Token|会话/i;
    let seqNodes = []; // 最近遍历的文本节点序列，用于"结算行前一条消息"
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && found.length < 16) {
        const t = (node.textContent || '').trim();
        if (!t || t.length > 80) continue;
        if (!needle.test(t)) continue;
        const rich = closestRichText(node);
        if (rich && !seen.has(rich)) { seen.add(rich); found.push(rich); }
        // 结算行："消耗X积分|剩余Y..." → 前序消息文本尽量取（用于辅助），取不到也照常上报——
        // 结算行本身是扣费真值，背景端按"会话内时间窗口"归因到对应消息，不依赖文本配对
        if (/消耗\s*[\d,]+\s*积分/.test(rich)) {
          let msgText = '';
          for (let i = seqNodes.length - 1; i >= 0; i--) {
            const pt = (seqNodes[i].textContent || '').trim();
            if (!pt || pt.length < 4) continue;
            // 只排除"状态行"（已工作/已停止/暂停/正在思考/剩余X/消耗X）；
            // 用户消息里可能本身含"积分"二字（如"最低积分"），不能按关键词一刀切
            if (/已工作|已停止|已暂停|暂停了|正在思考|正在生成|剩余\s*[\d,]+|消耗\s*[\d,]+/.test(pt)) continue;
            msgText = pt.slice(0, 120).replace(/\s+/g, '');
            break;
          }
          settlements.push({ text: rich.slice(0, 120), msgText });
        }
        seqNodes.push(node);
        if (seqNodes.length > 200) seqNodes.splice(0, 100);
      }
    } catch (e) { /* ignore */ }
    if (found.length || settlements.length) {
      safeSend({
        kind: 'tt-event',
        type: 'dom-scan',
        data: { url: location.href, texts: found, settlements, ts: Date.now(), title: guessProjectTitle() },
      });
    }
  }
  timers.push(setTimeout(scanDomCredits, 1200));
  timers.push(setInterval(scanDomCredits, 5000));

  // ---- 项目列表：从"项目名 + /app/{pid} 链接"直接建立 项目ID→项目名 映射（官方权威来源） ----
  function scanProjectList() {
    try {
      const links = document.querySelectorAll('a[href*="/app/"]');
      const seen = new Set();
      const items = [];
      for (const a of links) {
        const m = (a.getAttribute('href') || '').match(/\/app\/([^/?]+)/);
        const name = (a.textContent || '').trim();
        if (!m || !name || name.length < 1 || name.length > 40) continue;
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        items.push({ pid: m[1], name });
      }
      if (items.length) {
        safeSend({ kind: 'tt-event', type: 'project-list', data: { items, url: location.href, ts: Date.now() } });
      }
    } catch (e) { /* ignore */ }
  }
  timers.push(setTimeout(scanProjectList, 1500));
  timers.push(setInterval(scanProjectList, 30000));
})();
