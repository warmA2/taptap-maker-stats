/**
 * TapTap 制造统计 · main-hook.js
 * 以 MAIN world 注入到 maker.taptap.cn，挂钩 WebSocket / fetch / XMLHttpRequest，
 * 捕获用户输入（_taptap/session/prompt）与用量、积分等响应字段，
 * 通过 postMessage 传给 content script（isolated world）。
 * 不改动页面任何行为，全部 try/catch 兜底。
 */
(() => {
  'use strict';
  if (window.__ttMakerStatsHooked) return;
  window.__ttMakerStatsHooked = true;

  const SOURCE = 'tt-maker-stats';
  const API_PREFIX = '/api/v1/';

  function post(type, data) {
    try {
      window.postMessage({ source: SOURCE, type, data }, '*');
    } catch (e) { /* ignore */ }
  }

  // 主钩子已就绪信号（用于侧边栏区分“content 注入”与“主钩子运行”）
  post('hook-ready', { ts: Date.now() });

  function safeParse(text) {
    if (typeof text !== 'string' || !text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  /* ---------------- WebSocket ---------------- */
  const NativeWS = window.WebSocket;
  const wsCtx = new WeakMap(); // ws -> { url }

  function captureWsSend(ws, data) {
    const meta = { url: wsCtx.get(ws)?.url || ws.url || '', ts: Date.now() };
    if (typeof data === 'string') {
      const parsed = safeParse(data);
      // JSON 消息按原样上报；非 JSON 字符串也上报（可能是用户输入走文本通道）
      post('ws-send', { ...meta, message: parsed || { __raw: data.slice(0, 3000) } });
      return;
    }
    if (typeof ArrayBuffer !== 'undefined' && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
      let text = '';
      try { text = new TextDecoder().decode(data).slice(0, 3000); } catch (e) { /* ignore */ }
      post('ws-send', { ...meta, message: { __raw: text, __binary: true } });
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      post('ws-send', { ...meta, message: { __blob: true, size: data.size, type: data.type } });
      return;
    }
    post('ws-send', { ...meta, message: { __other: String(data).slice(0, 3000) } });
  }

  function captureWsMessage(ws, ev) {
    let text = ev && ev.data;
    if (text instanceof Blob) return; // 文本协议足够，跳过二进制
    if (typeof text !== 'string') return;
    const parsed = safeParse(text);
    if (!parsed || typeof parsed !== 'object') return;
    const method = parsed.method;
    // 全部 WS 事件都转发（background 按 method 分类；不再用白名单过滤，
    // 避免把可能携带扣费数据的 turn/update 事件漏掉）
    post('ws-message', { url: wsCtx.get(ws)?.url || ws.url || '', message: parsed, ts: Date.now() });
  }

  // hook 构造函数：new WebSocket(...) 时登记 url
  function PatchedWS(...args) {
    const ws = new NativeWS(...args);
    wsCtx.set(ws, { url: String(args[0] || '') });
    return ws;
  }
  PatchedWS.prototype = NativeWS.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    try { PatchedWS[k] = NativeWS[k]; } catch (e) {}
  }
  try { Object.defineProperty(PatchedWS, 'name', { value: 'WebSocket' }); } catch (e) {}

  // hook send
  const origSend = NativeWS.prototype.send;
  NativeWS.prototype.send = function (data) {
    try { captureWsSend(this, data); } catch (e) {}
    return origSend.call(this, data);
  };

  // hook addEventListener('message')
  const origAddEventListener = NativeWS.prototype.addEventListener;
  NativeWS.prototype.addEventListener = function (type, listener, options) {
    if (type === 'message' && typeof listener === 'function') {
      const wrapped = function (ev) {
        try { captureWsMessage(this, ev); } catch (e) {}
        return listener.apply(this, arguments);
      };
      return origAddEventListener.call(this, type, wrapped, options);
    }
    return origAddEventListener.apply(this, arguments);
  };

  // hook onmessage 赋值
  try {
    const desc = Object.getOwnPropertyDescriptor(NativeWS.prototype, 'onmessage') ||
      { configurable: true, enumerable: true, writable: true, value: null };
    Object.defineProperty(NativeWS.prototype, 'onmessage', {
      configurable: true,
      enumerable: true,
      get() { return desc.get ? desc.get.call(this) : this.__ttOnMessage; },
      set(fn) {
        const self = this;
        const wrapped = function (ev) {
          try { captureWsMessage(self, ev); } catch (e) {}
          if (typeof fn === 'function') return fn.call(self, ev);
          return undefined;
        };
        this.__ttOnMessage = wrapped;
        if (desc.set) desc.set.call(this, wrapped);
        else this.__ttNativeOnMessage = wrapped;
      }
    });
  } catch (e) { /* ignore */ }

  window.WebSocket = PatchedWS;

  /* ---------------- fetch ---------------- */
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const isApi = url.includes(API_PREFIX);
    if (isApi) {
      let body = null;
      try {
        if (init && typeof init.body === 'string') body = safeParse(init.body);
        else if (typeof input === 'string' && !init) body = null;
      } catch (e) {}
      post('fetch-request', { url, method: (init && init.method) || 'GET', body, ts: Date.now() });
    }
    const res = await origFetch.apply(this, arguments);
    if (isApi) {
      try {
        const ct = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
        if (ct.includes('text/event-stream') || ct.includes('application/octet-stream')) {
          // 流式/二进制响应跳过正文读取，避免阻塞
          return res;
        }
        const clone = res.clone();
        const text = await clone.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        // 只转发 JSON 或可能含数据的文本响应
        if (json !== null) {
          post('fetch-response', { url, status: res.status, json, ts: Date.now() });
        }
      } catch (e) { /* ignore */ }
    }
    return res;
  };

  /* ---------------- 主动拉取（仅兜底，非定期） ----------------
     积分批次/项目映射都是稳定数据：已获取过就不再主动拉；
     余额不主动拉——页面自身请求（打开积分页/刷新）会被截获入库，消息流"剩余X通用积分"实时更新。
     localStorage 记拉取时间做 TTL：批次 24h（批次金额随消耗微变，给个安全窗口）、项目映射 30 天。 */
  const PULL_TTL = { batches: 24 * 3600 * 1000, apps: 30 * 24 * 3600 * 1000 };
  function needPull(key) {
    try {
      const raw = localStorage.getItem('tt_stats_pull_' + key);
      if (raw && (Date.now() - Number(raw)) < PULL_TTL[key]) return false;
      localStorage.setItem('tt_stats_pull_' + key, String(Date.now()));
      return true;
    } catch (e) { return true; }
  }
  function pullCredits() {
    if (needPull('batches')) {
      try { window.fetch('/api/v1/credits/batches', { headers: { 'Accept': 'application/json' } }).catch(() => {}); } catch (e) { /* ignore */ }
    }
    if (needPull('apps')) {
      try { window.fetch('/api/v1/apps', { headers: { 'Accept': 'application/json' } }).catch(() => {}); } catch (e) { /* ignore */ }
    }
    // 积分余额：不主动拉（页面自身请求会带完整凭证，截获即可）
  }
  setTimeout(pullCredits, 1200);

  /* ---------------- XMLHttpRequest ---------------- */
  const origOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ttMeta = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const meta = this.__ttMeta || {};
    if (meta.url && meta.url.includes(API_PREFIX)) {
      post('xhr-request', { url: meta.url, method: meta.method, body: safeParse(body), ts: Date.now() });
      this.addEventListener('load', () => {
        try {
          const text = this.responseText;
          let json = null;
          try { json = JSON.parse(text); } catch (e) { json = null; }
          if (json !== null) {
            post('xhr-response', { url: meta.url, status: this.status, json, ts: Date.now() });
          }
        } catch (e) { /* ignore */ }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
