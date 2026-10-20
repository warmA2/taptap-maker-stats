/**
 * TapTap 制造统计 · background.js
 * Service Worker：接收 content 转发的捕获事件，解析入库（IndexedDB），
 * 并提供聚合查询接口给 popup / dashboard。
 *
 * 数据模型：
 *  - chats    : chatId -> { id, title, lastSeen }
 *  - prompts  : turnId -> 一轮对话 { ts, chatId, text(输入), outText(输出), inTokens, outTokens, credits, done, endedTs }
 *  - ctx      : 会话上下文用量快照 { chatId, ts, contextTokens }
 *  - balances : 积分余额快照 { ts, credits }
 *  - raw      : 最近原始事件（调试用，限量 300 条）
 */
'use strict';

const DB_NAME = 'tt-maker-stats';
const DB_VER = 2;

/* ---------------- IndexedDB helpers ---------------- */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('prompts')) db.createObjectStore('prompts', { keyPath: 'turnId' });
      if (!db.objectStoreNames.contains('ctx')) db.createObjectStore('ctx', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('balances')) db.createObjectStore('balances', { keyPath: 'ts' });
      if (!db.objectStoreNames.contains('txns')) db.createObjectStore('txns', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('raw')) db.createObjectStore('raw', { keyPath: 'seq', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let _dbPromise = null;
function db() {
  if (!_dbPromise) _dbPromise = openDb();
  return _dbPromise;
}

function txPut(store, value) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, 'readwrite');
    t.objectStore(store).put(value);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  }));
}

function txGet(store, key) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, 'readonly');
    const r = t.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

function txGetAll(store, query) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, 'readonly');
    let r;
    if (query) r = t.objectStore(store).getAll(query);
    else r = t.objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  }));
}

/* ---------------- 工具 ---------------- */
// 深度扫描 JSON，收集字段名匹配 token/credit/cost/usage/balance 的数字
function scanMetricFields(node, depth, out) {
  if (depth > 6 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const v of node) scanMetricFields(v, depth + 1, out);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'number' && /token|credit|usage|cost|balance/i.test(k)) {
        out.push({ field: k, value: v });
      } else {
        scanMetricFields(v, depth + 1, out);
      }
    }
  }
}

function sumBy(rows, fn) { return rows.reduce((a, r) => a + (fn(r) || 0), 0); }

/* ---------------- 事件解析 ---------------- */
// url -> { chatId, sessionId }（当前 WebSocket 对应会话）
const wsSession = new Map();

// 已注入页面的标签页（tabId -> {url, ts}），用于侧边栏状态指示
const injectedTabs = new Map();
// 主钩子（MAIN world）就绪时间
let hookReadyAt = null;
// 消息流最新"剩余通用积分"（页面每条消息自带扣减后的余额，比接口轮询更实时）
let wsGeneralLatest = null;
try { chrome.storage.local.get('wsGeneralLatest', (o) => { if (o && o.wsGeneralLatest) wsGeneralLatest = o.wsGeneralLatest; }); } catch (e) {}
// 项目名映射（projectId → 页面标题）与 会话→项目 映射（/app/{projectId}?chatid={chatId}）
const projectTitles = {};
const chatProject = {};
// 会话 → 页面地址：通知里的「打开会话」按钮要跳回去，就得知道那一轮是在哪个页面跑的。
// chatId 不一定出现在 URL 里，所以先记「最近一次 maker 页面地址」，发消息那一刻绑定给 chatId。
const chatUrlMap = {};
let lastMakerUrl = null;

// 从 maker 页面地址里取出 appId（/app/{appId}?chatId={chatId}）
function appIdFromUrl(u) {
  const m = String(u || '').match(/\/app\/([^/?#]+)/);
  return m ? m[1] : null;
}

function chatIdFromUrl(u) {
  const m = String(u || '').match(/[?&]chatid=([^&#]+)/i);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

// 会话页地址统一拼成官方格式：https://maker.taptap.cn/app/{appId}?chatId={chatId}
// 不直接复用 location.href —— 它可能带着 entering/from/tab 之类的临时参数，
// 也不保证 chatId 还在（同项目内切会话时前端可能只改内部状态）。自己拼只带必需的两个参数，必定指向那次会话。
function buildChatUrl(chatId) {
  if (!chatId) return null;
  const appId = chatProject[chatId] || appIdFromUrl(chatUrlMap[chatId]) || appIdFromUrl(lastMakerUrl);
  if (!appId) return null;
  return 'https://maker.taptap.cn/app/' + encodeURIComponent(appId) + '?chatId=' + encodeURIComponent(chatId);
}

// 积分分类（对照官方前端 vQ 函数：paid→event→project→normal→memberGeneral→general）
// 页面余额口径（截图核对）：通用积分=general类批次 current 之和；基础积分=normal类；付费=paid类；
// 活动=event类；项目包走 /credits/project-packages 的 balance。
const KIND_LABEL = {
  paid: '付费积分',
  event: '活动积分',
  project: '项目包积分',
  normal: '基础积分',
  memberGeneral: '会员通用积分',
  general: '通用积分',
};

function classifyBatch(b) {
  const source = b.source || '';
  const batchId = b.batchId || '';
  const code = b.code || 0;
  if (source === 'MakerCreditPack' || batchId.startsWith('paid:')) return 'paid';
  if ((code & 8) || source === 'Activity' || source === 'GameJam' || batchId.startsWith('event:')) return 'event';
  if (source === 'ProjectCreditPackage' || (code & 4)) return 'project';
  if (code & 1) return 'normal';
  if (source === 'MakerMemberCard' || b.memberPackage) return 'memberGeneral';
  return 'general';
}

// 数值兼容：number 或数字字符串（官方用宽松比较 current>0，字符串数字也能过）
function numOrNull(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  return null;
}

// 条目余额字段：官方用 remaining（当前剩余）；状态需已生效、未过期
// 官方按"余额字段 remaining>0"计入（截图实测：到期批次如 14,215 也计入余额）；
// 只有明确的"待发放/已失效"状态才排除（PENDING/FROZEN/EXPIRED/VOID/CANCELLED）
function isActiveBatch(b, nowSec) {
  const rem = numOrNull(b.remaining);
  if (rem == null || rem <= 0) return false;
  const eff = numOrNull(b.effectiveTime);
  if (eff != null && eff > nowSec) return false;
  const exp = numOrNull(b.expiresTime);
  if (exp != null && exp !== 0 && exp <= nowSec) return false;
  const st = String(b.status || '').toUpperCase();
  if (st === 'PENDING' || st === 'FROZEN' || st === 'EXPIRED' || st === 'VOID' || st === 'CANCELLED') return false;
  return true;
}

// 批次到期时间：官方字段为 expiresTime（秒级时间戳，0=长期有效），兼容 expiresAt
function batchExpiry(b) {
  return b.expiresTime != null ? b.expiresTime : (b.expiresAt != null ? b.expiresAt : null);
}

function EMPTY_BREAKDOWN() {
  return { paid: 0, event: 0, project: 0, normal: 0, memberGeneral: 0, general: 0 };
}

// 解析 /api/v1/credits/batches（官方“我的积分”页唯一数据源）
// 官方前端逻辑：所有批次一律按 vQ 分类聚合 balanceOf() 取到的余额字段；
// 没有余额字段的（纯会员卡权益条目）不计入余额，仅探测其卡额度字段供展示。
function parseCreditsPayload(data) {
  const json = data.json;
  if (!json || typeof json !== 'object') {
    return {
      ok: false, breakdown: EMPTY_BREAKDOWN(), items: [], summary: null, membership: [],
      debug: { reason: '响应不是对象', url: data.url }, url: data.url, ts: data.ts || Date.now(),
    };
  }
  let rawBatches = null;
  let foundIn = '';
  if (Array.isArray(json)) { rawBatches = json; foundIn = '顶层数组'; }
  else if (Array.isArray(json.batches)) { rawBatches = json.batches; foundIn = 'batches'; }
  else if (Array.isArray(json.data)) { rawBatches = json.data; foundIn = 'data'; }
  else if (Array.isArray(json.items)) { rawBatches = json.items; foundIn = 'items'; }
  else if (Array.isArray(json.list)) { rawBatches = json.list; foundIn = 'list'; }
  else if (Array.isArray(json.records)) { rawBatches = json.records; foundIn = 'records'; }
  else if (Array.isArray(json.result)) { rawBatches = json.result; foundIn = 'result'; }

  const breakdown = EMPTY_BREAKDOWN();
  const items = [];
  const membership = [];
  const pending = [];
  let sampleKeys = null;
  let noBalanceKeys = [];
  const nowSec = Math.floor(Date.now() / 1000);
  if (Array.isArray(rawBatches)) {
    for (const b of rawBatches) {
      if (!b || typeof b !== 'object') continue;
      if (!sampleKeys) sampleKeys = Object.keys(b).slice(0, 24);
      if (isActiveBatch(b, nowSec)) {
        // 官方口径：ACTIVE + remaining>0 + 已生效 + 未过期 → 计入当前余额
        const kind = classifyBatch(b);
        const amount = numOrNull(b.remaining);
        breakdown[kind] += amount;
        items.push({
          kind, amount,
          label: KIND_LABEL[kind] || kind,
          expiresTime: batchExpiry(b),
          effectiveTime: b.effectiveTime != null ? b.effectiveTime : null,
          status: b.status,
          source: b.source || null,
          projectId: b.projectId || null,
          name: b.name || null,
        });
      } else {
        // 未计入余额：会员发放批次（带发放额度 amount）→ 待发放展示
        const pendingAmt = numOrNull(b.amount);
        if (pendingAmt != null && pendingAmt > 0 && (b.memberPackage || b.source === 'MakerMemberCard')) {
          pending.push({
            amount: pendingAmt,
            name: b.name || null,
            status: b.status || null,
            expiresTime: batchExpiry(b),
            effectiveTime: b.effectiveTime != null ? b.effectiveTime : null,
            source: b.source || null,
          });
          continue;
        }
        // 其余无余额条目：探测卡权益额度字段（仅展示）
        const ent = b.entitlement && typeof b.entitlement === 'object' ? b.entitlement : null;
        const m = {
          label: b.name || (b.kind === 'membership' ? '会员卡权益' : '无余额条目'),
          totalAmount: typeof b.totalAmount === 'number' ? b.totalAmount : null,
          generalAmount: typeof b.generalAmount === 'number' ? b.generalAmount : null,
          memberGeneralCredits: b.memberGeneralCredits != null ? b.memberGeneralCredits : (ent ? ent.memberGeneralCredits : null),
          memberFlashCredits: b.memberFlashCredits != null ? b.memberFlashCredits : (ent ? ent.memberFlashCredits : null),
          expiresTime: batchExpiry(b),
          source: b.source || null,
          keys: Object.keys(b).slice(0, 14),
        };
        const hasValue = m.totalAmount != null || m.generalAmount != null || m.memberGeneralCredits != null || m.memberFlashCredits != null;
        if (hasValue || b.entitlement || b.source === 'MakerMemberCard') {
          membership.push(m);
        } else {
          noBalanceKeys.push(m.keys);
        }
      }
    }
  }
  const summary = json.summary && typeof json.summary === 'object' ? json.summary : null;
  // 无批次数组时，用 summary 的分类合计（general/normal/memberGeneral…）补齐 breakdown，
  // 避免"只拉到 summary 的响应"把基础积分等分类覆盖成 0
  if (rawBatches == null && summary) {
    for (const [k, sk] of [['general', 'general'], ['normal', 'normal'], ['memberGeneral', 'memberGeneral'], ['paid', 'paid'], ['event', 'event'], ['project', 'project']]) {
      if (typeof summary[sk] === 'number' && summary[sk] > 0) breakdown[k] += summary[sk];
    }
  }
  // 余额字段探测（官方：remaining）
  let balanceFieldUsed = items.length ? 'remaining' : null;
  const ok = items.length > 0 || (summary && (typeof summary.accountBalance === 'number' || typeof summary.normal === 'number'));
  return {
    ok,
    breakdown, items, pending,
    summary: summary ? {
      accountBalance: typeof summary.accountBalance === 'number' ? summary.accountBalance : null,
      normal: typeof summary.normal === 'number' ? summary.normal : null,
    } : null,
    membership,
    debug: {
      reason: ok ? '解析成功' : (Array.isArray(rawBatches) ? '未识别到余额字段' : '未找到批次数组'),
      foundIn,
      topKeys: Object.keys(json).slice(0, 20),
      batchKeys: sampleKeys,
      balanceFieldUsed,
      noBalanceKeys: noBalanceKeys.slice(0, 2),
    },
    url: data.url, ts: data.ts || Date.now(),
  };
}

// 解析 /api/v1/credits/transactions（积分明细：项目对话/素材生成消耗）
// 官方记录标题自带项目名，如“项目 (神剑伏魔录) 对话消耗”；另抓候选名称字段供展示
function parseTransactions(data) {
  const json = data.json;
  if (!json || typeof json !== 'object') return null;
  let arr = Array.isArray(json) ? json : null;
  if (!arr) for (const k of ['transactions', 'items', 'list', 'records']) {
    if (Array.isArray(json[k])) { arr = json[k]; break; }
  }
  if (!arr) return null;
  const items = [];
  for (const t of arr) {
    if (!t || typeof t !== 'object') continue;
    const amount = typeof t.amount === 'number' ? t.amount
      : typeof t.delta === 'number' ? t.delta
      : typeof t.value === 'number' ? t.value : null;
    if (amount == null) continue;
    const pick = (ks) => { for (const k of ks) { const v = t[k]; if (typeof v === 'string' && v.trim()) return v; } return null; };
    items.push({
      amount,
      projectName: pick(['projectName', 'project_name', 'project', 'appName', 'gameName', 'app_name', 'productName']),
      title: pick(['title', 'description', 'name', 'materialName', 'prompt', 'type', 'kind']),
      kind: pick(['type', 'kind', 'category']),
      model: pick(['model', 'modelName', 'model_name', 'agent', 'driver']) || (typeof t.model === 'string' ? t.model : null),
      createdAt: pick(['createdAt', 'created_at', 'time', 'date']) || t.createdAt || null,
    });
  }
  if (!items.length) return null;
  return { items, url: data.url, ts: data.ts || Date.now() };
}

function ingest(type, data) {
  try {
    switch (type) {
      case 'ws-send': return onWsSend(data);
      case 'ws-message': return onWsMessage(data);
      case 'fetch-response':
      case 'xhr-response': return onHttpResponse(data);
      case 'fetch-request':
      case 'xhr-request': {
        // 只记录带 body 的发送（POST 等）——GET 轮询（notifications/unread-counts 等）不记日志，避免噪音挤占
        const m = String(data.method || 'GET').toUpperCase();
        if (m === 'GET') return undefined;
        saveRaw({ ts: data.ts || Date.now(), url: data.url, method: data.method, body: data.body, json: data.body, note: type });
        if (data.body && typeof data.body === 'object') {
          const hit = extractInput(data.body);
          if (hit) return saveInput({ ...hit, via: type + ':' + (hit.method || 'unknown') });
        }
        return undefined;
      }
      case 'credits-pull':
        pullState = { lastAt: Date.now(), ok: true, msg: '同步成功' };
        return onCreditsPull(data);
      case 'credits-pull-error':
        {
          const errMsg = data.status === 401
            ? '登录态未就绪，等待页面自动同步'
            : (data.error ? '：' + data.error : (data.status ? '（HTTP ' + data.status + '）' : ''));
          pullState = { lastAt: data.ts || Date.now(), ok: false, msg: '同步失败' + errMsg };
          return undefined;
        }
      case 'transactions-pull': return onTransactionsPull(data);
      case 'project-list': {
        // 项目列表页：名称↔ID 官方映射（项目名 + /app/{pid} 链接）
        try {
          for (const it of (data.items || [])) {
            if (it && it.pid && it.name) projectTitles[it.pid] = it.name;
          }
        } catch (e) { /* ignore */ }
        return undefined;
      }
      case 'dom-scan': {
        // 页面已渲染文本 → 存 raw + 解析其中数字（账户总余额/各类积分/剩余积分/消息消耗）
        saveRaw({ ts: data.ts || Date.now(), url: data.url, json: { texts: data.texts || [] }, note: 'dom-scan' });
        // 建立 chatId→项目Id 映射 + 项目Id→官方项目名
        // 注意：页面标题（document.title）是"会话标题"，不能当项目名；
        // 项目名只取积分明细里的官方名"项目 (云效动效演示) 对话消耗"（app 页也渲染，第一条通常即当前项目）
        try {
          const url = data.url || '';
          const pid = (url.match(/\/app\/([^/?]+)/) || [])[1] || null;
          const cid = (url.match(/[?&]chatid=([^&]+)/i) || [])[1] || null;
          if (pid) {
            if (cid) chatProject[cid] = pid;
            const names = (data.texts || [])
              .map((t) => (String(t).match(/项目\s*\(\s*([^)]{1,40}?)\s*\)\s*(?:对话|生成|消耗|图片)/) || [])[1])
              .filter(Boolean);
            if (names.length) projectTitles[pid] = names[0];
          }
        } catch (e) { /* ignore */ }
        const parsed = parseDomTexts(data.texts || []);
        if (parsed && Object.keys(parsed).length) {
          // 消息流"剩余 X 通用积分"→ 实时余额（比接口快照新）
          // 余额差分：连续两次"剩余通用积分"的下降 = 一次真实扣费（余额变化是页面权威，与页面绝对一致）
          if (parsed.remaining != null) {
            const now = data.ts || Date.now();
            const url = data.url || '';
            const chatId = (url.match(/[?&]chatid=([^&]+)/i) || [])[1] || null;
            const projectId = (url.match(/\/app\/([^/?]+)/) || [])[1] || null;
            const prev = wsGeneralLatest && wsGeneralLatest.general != null ? wsGeneralLatest.general : null;
            const next = parsed.remaining;
            if (prev != null && next < prev) {
              const diff = prev - next;
              recordDiffCost({ diff, remaining: next, chatId, projectId, ts: now, url });
              // 归因：同会话最近一条未完成消息（长任务多轮时每轮结算都会触发一次差分）
              updateLatestPrompt({ credits: diff }, 'diff-' + now, now, chatId).catch(() => {});
            }
            wsGeneralLatest = { ts: now, general: next, source: 'dom' };
            try { chrome.storage.local.set({ wsGeneralLatest }); } catch (e) {}
          }
          // 旧的"消耗X积分"文本解析 msg-cost 已停用：余额差分才是权威（文本解析会漏/重复/错配），
          // 这里只保留 remaining 实时更新（上面）+ balances 快照存储（下面）
          return txPut('balances', { ...parsed, kind: 'dom', url: data.url, ts: data.ts || Date.now() });
        }
        return undefined;
      }
      case 'hook-ready':
        hookReadyAt = Date.now();
        return saveRaw({ ts: data.ts || Date.now(), url: data.url || 'hook-ready', json: { ready: true }, note: 'hook-ready' });
      default: return;
    }
  } catch (e) {
    console.error('[tt-stats] ingest error', e);
  }
}

// 主动拉取的积分数据：无论是否解析到余额都存快照（带 debug 探测信息）
// 同步状态（数据主要来自页面自身请求截获；已移除主动拉取，避免 401）
let pullState = { lastAt: 0, ok: null, msg: '等待页面请求积分接口' };

function onCreditsPull(data) {
  const parsed = parseCreditsPayload(data);
  if (!parsed) return saveRaw({ ts: data.ts || Date.now(), url: data.url, json: data.json });
  const total = Object.values(parsed.breakdown).reduce((a, v) => a + v, 0);
  // batches 响应无条件存 raw，供侧边栏“排障”区直接查看原始 JSON
  if (/\/batches/.test(data.url)) saveRaw({ ts: data.ts || Date.now(), url: data.url, json: data.json, note: 'credits-batches' });
  else if (!parsed.ok) saveRaw({ ts: data.ts || Date.now(), url: data.url, json: data.json, note: 'credits-parse-fail' });
  return txPut('balances', { ...parsed, kind: 'api', total });
}

// 主动拉取的积分明细（transactions）
function onTransactionsPull(data) {
  const parsed = parseTransactions(data);
  // 原始响应无条件存 raw（note: txn-raw），供排障查看真实字段
  saveRaw({ ts: data.ts || Date.now(), url: data.url, json: data.json, note: 'txn-raw' });
  if (!parsed) return undefined;
  return txPut('txns', { id: String(data.ts || Date.now()), ...parsed });
}

/* ---------------- 通用输入识别与保存 ---------------- */
// 从任意消息对象里找“用户输入文本 + 会话标识”（不依赖具体方法名）
function extractInput(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const p = obj.params && typeof obj.params === 'object' ? obj.params : obj;
  let text = null;
  for (const k of ['prompt', 'text', 'content', 'message', 'question', 'input']) {
    if (typeof p[k] === 'string' && p[k].trim()) { text = p[k]; break; }
  }
  if (text == null) {
    const stack = [obj];
    let guard = 0;
    while (stack.length && text == null && guard++ < 200) {
      const cur = stack.pop();
      if (cur && typeof cur === 'object') {
        for (const [k, v] of Object.entries(cur)) {
          if (['prompt', 'text', 'content', 'message', 'question'].includes(k) && typeof v === 'string' && v.trim()) { text = v; break; }
          if (v && typeof v === 'object') stack.push(v);
        }
      }
    }
  }
  if (text == null) return null;
  return {
    text,
    chatId: p.chatId || p.chat_id || null,
    sessionId: p.sessionId || p.session_id || p.chatId || null,
    method: obj.method || obj.type || null,
  };
}

function saveInput({ text, chatId, sessionId, via, turnId }) {
  const id = turnId || String(Date.now()) + Math.random().toString(16).slice(2);
  const now = Date.now();
  const p = txPut('prompts', {
    turnId: id,
    ts: now,
    chatId: chatId || sessionId || 'unknown',
    text: typeof text === 'string' ? text : '',
    chatRound: null, outText: '', inTokens: null, outTokens: null, credits: null,
    done: false, endedTs: null, via: via || 'auto',
    // lastActive：本轮最后一次有动静的时间（发出 / 收到流式片段 / 收到用量回包），
    // 用于区分"真的正在处理"和"没收到结束信号的遗留轮次"
    lastActive: now,
  });
  return p;
}

// 回扫 raw 里已抓到的消息，补录输入（只对非标准通道/请求通道；turnId 用 raw.seq 保证不重复）
async function backfillInputs() {
  const all = await txGetAll('raw');
  let added = 0;
  for (const e of all) {
    if (!e || e.seq == null) continue;
    if (e.note === 'ws-send' && e.json && typeof e.json === 'object') {
      const msg = e.json;
      if (msg.method === '_taptap/session/prompt') continue; // 标准通道已实时处理
      const hit = extractInput(msg);
      if (hit) {
        await saveInput({ ...hit, via: 'backfill:ws:' + (hit.method || 'unknown'), turnId: 'bf-ws-' + e.seq });
        added++;
      }
    } else if ((e.note === 'fetch-request' || e.note === 'xhr-request') && e.body && typeof e.body === 'object') {
      const hit = extractInput(e.body);
      if (hit) {
        await saveInput({ ...hit, via: 'backfill:' + e.note, turnId: 'bf-' + e.note + '-' + e.seq });
        added++;
      }
    }
  }
  return added;
}

let backfillPromise = null;
function ensureBackfill() {
  if (!backfillPromise) {
    backfillPromise = backfillInputs()
      .then((n) => { if (n) console.log('[tt-stats] backfill added', n); })
      .catch(() => { backfillPromise = null; });
  }
  return backfillPromise;
}

// 用户输入：_taptap/session/prompt（标准通道）
function onWsSend(data) {
  const msg = data.message;
  if (!msg || typeof msg !== 'object') {
    return undefined;
  }
  // 兜底：非 JSON / 二进制发送（__raw/__blob/__other）→ 尝试解析，提取输入
  if (msg.__raw !== undefined || msg.__blob !== undefined || msg.__other !== undefined) {
    const rawText = typeof msg.__raw === 'string' ? msg.__raw : (typeof msg.__other === 'string' ? msg.__other : '');
    if (rawText) {
      let parsed = null;
      try { parsed = JSON.parse(rawText); } catch (e) { parsed = null; }
      if (parsed && typeof parsed === 'object') {
        const hit = extractInput(parsed);
        if (hit) return saveInput({ ...hit, via: 'ws:raw:' + (parsed.method || 'unknown') });
      }
    }
    return saveRaw({ ts: data.ts || Date.now(), url: data.url, json: msg, note: 'ws-send-raw' });
  }
  saveRaw({ ts: data.ts || Date.now(), url: data.url, json: msg, note: 'ws-send' });
  if (msg.method !== '_taptap/session/prompt') {
    // 非标准通道：通用兜底识别，尽量保存
    const hit = extractInput(msg);
    if (hit) {
      wsSession.set(data.url, { chatId: hit.chatId, sessionId: hit.sessionId });
      return saveInput({ ...hit, via: 'ws:' + (hit.method || 'unknown') });
    }
    return undefined;
  }
  const p = msg.params || {};
  const chatId = p.chatId || null;
  const sessionId = p.sessionId || null;
  // 发消息的这一刻，用户就在对应会话页上 → 把当前页面地址绑给这个会话，供通知回跳。
  // 顺手从地址里补 chatId→appId，这样通知里能直接拼出规范链接，不必等 dom-scan。
  if (chatId && lastMakerUrl) {
    chatUrlMap[chatId] = lastMakerUrl;
    const aid = appIdFromUrl(lastMakerUrl);
    if (aid && !chatProject[chatId]) chatProject[chatId] = aid;
  }
  const turnId = msg.id || String(Date.now()) + Math.random().toString(16).slice(2);
  // 文本字段可能是 prompt/text/content/message 等任意位置，通用提取兜底
  const hit = extractInput(msg);
  const text = (hit && hit.text) ? hit.text : '';
  wsSession.set(data.url, { chatId, sessionId });
  const put = txPut('prompts', {
    turnId,
    ts: data.ts || Date.now(),
    chatId: chatId || sessionId || (hit && (hit.chatId || hit.sessionId)) || 'unknown',
    text,
    chatRound: p.chatRound != null ? p.chatRound : null,
    outText: '',
    inTokens: null, outTokens: null, credits: null,
    done: false, endedTs: null,
    sentId: turnId, // 发送请求 id（≠ 服务端最终 turnId，用于后续关联）
  });
  return put;
}

function onWsMessage(data) {
  const msg = data.message;
  if (!msg) return;
  // 消息级扣费真值：turn 事件 params.extras.credits（页面"消耗X积分|剩余Y通用积分"的渲染数据源，
  // 字段 consumed=本次消耗 / generalRemains=剩余通用 / remains=总剩余）→ 直接写 msg-cost + 回填 prompt
  const exCredits = msg.params && msg.params.extras && msg.params.extras.credits;
  if (exCredits && typeof exCredits === 'object') {
    const consumed = Number(exCredits.consumed);
    if (isFinite(consumed) && consumed > 0) {
      return onTurnCredits({ msg, credits: exCredits, data });
    }
  }
  // RPC 回包：jsonrpc + id + result/error（存 raw 供诊断用量字段）
  if (msg.jsonrpc && (msg.result !== undefined || msg.error !== undefined)) {
    saveRaw({ ts: data.ts || Date.now(), url: data.url, json: msg, note: 'ws-rpc' });
    const id = msg.id;
    const result = msg.result && typeof msg.result === 'object' ? msg.result : null;
    const hasUsageResult = !!result && (
      result.turnId != null || result.inTokens != null || result.outTokens != null ||
      result.credits != null || result.contextWindowTokens != null
    );
    if (id != null) {
      return txGet('prompts', id).then((row) => {
        if (!row) return;
        const fields = [];
        if (msg.result) scanMetricFields(msg.result, 0, fields);
        if (msg.error) scanMetricFields(msg.error, 0, fields);
        const tokens = fields.filter((f) => /token/i.test(f.field));
        const credits = fields.filter((f) => /credit/i.test(f.field));
        const remains = fields.filter((f) => /balance|remaining/i.test(f.field));
        const patch = {};
        // 服务端最终 turnId（发送请求 id ≠ 最终 turnId）→ 建立映射，供历史消息/用量回填配对
        if (result && result.turnId != null) {
          patch.turnId = String(result.turnId);
          patch.wsTurnId = String(result.turnId);
        }
        if (tokens.length) patch.outTokens = sumBy(tokens, (f) => f.value);
        if (credits.length) patch.credits = sumBy(credits, (f) => f.value);
        // 剩余余额（页面“剩余XX通用积分”）→ 更新"我的积分"实时通用余额（随消耗扣减）
        if (remains.length) {
          const remaining = sumBy(remains, (f) => f.value);
          patch.remaining = remaining;
          wsGeneralLatest = { ts: data.ts || Date.now(), general: remaining };
          try { chrome.storage.local.set({ wsGeneralLatest }); } catch (e) {}
        }
        // 消耗的积分类型（creditType/creditKind/creditName/creditPool 等）→ 展示用
        if (msg.result && typeof msg.result === 'object') {
          for (const k of ['creditType', 'creditKind', 'creditName', 'creditPool', 'creditClass', 'type']) {
            const v = msg.result[k];
            if (typeof v === 'string' && v.trim()) { patch.creditType = v; break; }
          }
        }
        return txPut('prompts', { ...row, ...patch, lastActive: Date.now() });
      });
    }
    // 服务端推送式回包（无 id）：run_state 等 → 按 turnId 精确匹配；匹配不到则补最近未完成轮次
    if (hasUsageResult) {
      return onUsageResult(result, data);
    }
    return;
  }
  // 事件推送：session/update
  if (msg.method === 'session/update') {
    const upd = msg.params && msg.params.update;
    if (!upd) return;
    const cur = wsSession.get(data.url);
    const chatId = cur ? cur.chatId : null;
    const sessionId = cur ? cur.sessionId : null;
    if (upd.sessionUpdate === 'agent_message_chunk' && upd.content && upd.content.type === 'text' && typeof upd.content.text === 'string') {
      // 追加到最近一轮（当前会话内未完成的一轮）
      return appendOutput(chatId || sessionId, upd.content.text);
    }
    if (upd.sessionUpdate === 'context_compacted' && upd.contextSnapshot) {
      // 上下文压缩：记录快照中的 token 数
      const tokens = typeof upd.contextSnapshot.contextTokens === 'number' ? upd.contextSnapshot.contextTokens : null;
      if (tokens != null && chatId) {
        return txPut('ctx', { id: `${chatId}|${data.ts}`, chatId, ts: data.ts, contextTokens: tokens, note: 'compacted' });
      }
    }
    if (typeof upd.contextTokens === 'number' && chatId) {
      return txPut('ctx', { id: `${chatId}|${data.ts}`, chatId, ts: data.ts, contextTokens: upd.contextTokens });
    }
    return;
  }
  // prompt/stopped：一轮结束
  if (msg.method === 'prompt/stopped') {
    const turnId = msg.turnId || null;
    if (turnId != null) {
      return txGet('prompts', turnId).then((row) => {
        if (!row) return;
        return txPut('prompts', { ...row, done: true, endedTs: data.ts || Date.now() })
          .then(() => maybeNotifyDone(turnId));
      });
    }
  }
  // 其他未知 WS 事件：只记录疑似带数据的（turn/prompt/message/usage/credit 类），供确认是否有扣费推送
  if (typeof msg.method === 'string' && /turn|prompt|message|usage|credit/i.test(msg.method)) {
    saveRaw({ ts: data.ts || Date.now(), url: data.url, json: msg, note: 'ws-other:' + msg.method.slice(0, 40) });
  }
}

// 页面"消耗X积分|剩余Y通用积分"的真实数据源：turn 的 params.extras.credits
// { consumed, remains, generalRemains, projectRemains } → 写 msg-cost（扣费真值）+ 回填 prompt
function onTurnCredits({ msg, credits, data }) {
  const consumed = Math.abs(Number(credits.consumed) || 0);
  if (consumed <= 0) return;
  const generalRemains = (credits.generalRemains != null && isFinite(Number(credits.generalRemains)))
    ? Number(credits.generalRemains)
    : ((credits.remains != null && isFinite(Number(credits.remains))) ? Number(credits.remains) : null);
  const params = msg.params || {};
  const turnId = msg.turnId || params.turnId || msg.id || null;
  const sessionId = params.sessionId || null;
  const chatId = params.chatId || params.chat_id || null;
  const cur = wsSession.get(data.url) || {};
  // 会话标识优先级：显式 chatId > 当前 URL 关联会话 > sessionId（sessionId 可能与 chatId 不同值）
  const cid = chatId || cur.chatId || sessionId || cur.sessionId || null;
  const now = data.ts || Date.now();
  const projectId = cid ? (chatProject[cid] || null) : null;
  const projName = projectId ? (projectTitles[projectId] || projectId.slice(0, 8)) : null;
  const putCost = txGetAll('txns').then((all) => {
    // 有 turnId：永久去重（历史消息每次进会话都会重复拉取，turnId 稳定）；无 turnId：60 秒窗口
    const dup = (all || []).some((t) => t.kind === 'msg-cost' &&
      (turnId ? (t.turnId || null) === turnId : Math.abs((t.ts || 0) - now) < 60000 && t.amount === -consumed && (t.chatId || null) === cid));
    if (!dup) {
      return txPut('txns', {
        id: 'cost-' + now + '-' + Math.random().toString(16).slice(2, 6),
        kind: 'msg-cost', chatId: cid, projectName: projectId || null,
        ts: now, createdAt: new Date(now).toISOString(),
        amount: -consumed, remaining: generalRemains,
        title: projName ? '项目 (' + projName + ') 对话消耗' : '对话消耗',
        turnId: turnId || null,
      });
    }
  }).catch(() => {});
  // 回填 prompt：turnId 精确匹配；匹配不到则补同会话最近未完成轮（时间窗口归因兜底，限定 chatId 防跨会话错配）
  const patchPrompt = (turnId
    ? matchPromptByTurn(String(turnId)).then((row) => {
        if (row) return txPut('prompts', { ...row, credits: consumed, done: true, endedTs: now });
        return updateLatestPrompt({ credits: consumed }, String(turnId), now, cid);
      })
    : updateLatestPrompt({ credits: consumed }, null, now, cid)).catch(() => {});
  // 结算落地 ⇒ 这一轮基本结束，补一次完成通知（与 prompt/stopped 共用去重集合）
  if (turnId) patchPrompt.then(() => maybeNotifyDone(turnId)).catch(() => {});
  return Promise.all([putCost, patchPrompt]).then(() => undefined).catch(() => undefined);
}

// 从历史消息/轮次记录里提取用户输入文本（prompt 数组 / text / content 字段）
function extractInputText(node) {
  const params = node.params && typeof node.params === 'object' ? node.params : null;
  const prompt = params ? params.prompt : node.prompt;
  if (Array.isArray(prompt)) {
    const t = prompt.find((p) => p && p.type === 'text' && typeof p.text === 'string' && p.text.trim());
    if (t) return t.text.slice(0, 2000);
    const any = prompt.find((p) => p && typeof p.text === 'string' && p.text.trim());
    if (any) return any.text.slice(0, 2000);
  }
  if (typeof prompt === 'string' && prompt.trim()) return prompt.slice(0, 2000);
  if (typeof node.text === 'string' && node.text.trim()) return node.text.slice(0, 2000);
  if (typeof node.content === 'string' && node.content.trim()) return node.content.slice(0, 2000);
  return '';
}

// 余额差分消耗：两次"剩余通用积分"快照的下降 = 一次真实扣费（页面余额变化是权威）
function recordDiffCost({ diff, remaining, chatId, projectId, ts, url }) {
  if (!diff || diff <= 0 || !isFinite(diff)) return;
  txGetAll('txns').then((all) => {
    const dup = (all || []).some((t) => t.kind === 'msg-cost' && t.via === 'diff' &&
      Math.abs((t.ts || 0) - ts) < 90000 && Math.abs(t.amount || 0) === diff && (t.chatId || null) === chatId);
    if (dup) return;
    return txPut('txns', {
      id: 'cost-d' + ts + '-' + Math.random().toString(16).slice(2, 6),
      kind: 'msg-cost', via: 'diff',
      chatId: chatId || null, projectName: projectId || null,
      ts, createdAt: new Date(ts).toISOString(),
      amount: -diff, remaining: remaining != null ? remaining : null,
      title: '对话消耗（余额变化）',
    });
  }).catch(() => {});
}

// 历史消息/轮次 API 响应 → 每条 turn 的 params.extras.credits → msg-cost + prompts 回填
// 不依赖精确顶层结构：递归在 items/messages/turns/prompts/result 等容器里找 credits 对象
let historyStats = { pulls: 0, hits: 0, noTurnId: 0, lastTs: null };
function onChatHistory({ url, json, ts }) {
  const m = url.match(/\/api\/v1\/chats\/([^/?#]+)\/(messages|prompts)/);
  const chatIdFallback = m ? m[1] : null;
  const note = m && m[2] === 'messages' ? 'chat-messages' : 'chat-prompts';
  saveRaw({ ts: ts || Date.now(), url, json, note });
  historyStats.pulls++;
  historyStats.lastTs = ts || Date.now();
  const found = [];
  // 携带祖先上下文：消息记录顶层 { id, timestamp }，params 在 data.params 里（页面 qL 转换已证实）
  const walk = (node, depth, ctx) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1, ctx); return; }
    const nextCtx = {
      id: node.id || (ctx && ctx.id) || null,
      ts: node.timestamp || node.ts || (ctx && ctx.ts) || null,
      chatId: node.chatId || (ctx && ctx.chatId) || null,
    };
    const ex = node.extras && typeof node.extras === 'object' ? node.extras.credits : null;
    const dir = node.credits && typeof node.credits === 'object' ? node.credits : null;
    const cred = (ex && typeof ex === 'object') ? ex : ((dir && typeof dir === 'object') ? dir : null);
    if (cred) {
      const consumed = Math.abs(Number(cred.consumed) || 0);
      if (consumed > 0) {
        const params = node.params && typeof node.params === 'object' ? node.params : null;
        const turnId = node.turnId || node.id || (params && (params.turnId || params.id)) || nextCtx.id || null;
        // 会话标识：URL 里的 {id} 是权威 chatId（/chats/{id}/messages 的 {id}）；
        // 响应里的 sessionId 可能与 chatId 不同值（页面渲染时两者独立），不能用它归因
        const cid = chatIdFallback || node.chatId || (params && params.chatId) || nextCtx.chatId || null;
        const tsv = node.timestamp || node.ts || (typeof node.createdAt === 'string' ? Date.parse(node.createdAt) : null) || nextCtx.ts || ts;
        found.push({
          consumed, turnId, chatId: cid, ts: tsv,
          remaining: cred.generalRemains != null ? Number(cred.generalRemains) : (cred.remains != null ? Number(cred.remains) : null),
          text: extractInputText(node),
        });
        historyStats.hits++;
        if (!turnId) historyStats.noTurnId++;
      }
    }
    for (const k of ['params', 'extras', 'result', 'items', 'messages', 'turns', 'prompts', 'data', 'turn', 'records']) {
      if (node[k] && typeof node[k] === 'object') walk(node[k], depth + 1, nextCtx);
    }
  };
  walk(json, 0, null);
  if (!found.length) { try { chrome.storage.local.set({ historyStats }); } catch (e) {} return; }
  return Promise.all(found.map((f) => {
    // 历史补录输入（turnId 无重复、且同会话近 2 分钟内无同文本才存，避免发送时已存的记录重复）
    const p1 = (f.text && f.turnId)
      ? txGetAll('prompts').then((all) => {
          const dup = (all || []).some((r) =>
            r.turnId === String(f.turnId) || r.sentId === String(f.turnId) || r.wsTurnId === String(f.turnId) ||
            (f.chatId && r.chatId === f.chatId && r.text && f.text && r.text === f.text && Math.abs((r.ts || 0) - f.ts) < 120000));
          if (dup) return null;
          return saveInput({ text: f.text, chatId: f.chatId, via: 'history:' + note, turnId: f.turnId });
        }).catch(() => {})
      : null;
    const p2 = onTurnCredits({
      msg: { turnId: f.turnId, params: { turnId: f.turnId, chatId: f.chatId, sessionId: f.chatId } },
      credits: { consumed: f.consumed, generalRemains: f.remaining, remains: f.remaining },
      data: { ts: f.ts || ts, url },
    });
    return Promise.all([p1, p2].filter(Boolean));
  })).then(() => { try { chrome.storage.local.set({ historyStats }); } catch (e) {} return undefined; }).catch(() => { try { chrome.storage.local.set({ historyStats }); } catch (e) {} return undefined; });
}

/* ---------------- 用量回填（服务端推送式回包，无 id） ---------------- */
// 解析页面 DOM 文本里的积分数字（页面显示什么就解析什么）
function parseDomTexts(texts) {
  const num = (s) => { const n = Number(String(s).replace(/,/g, '')); return isFinite(n) ? n : null; };
  const out = {};
  const KIND = { '通用积分': 'general', '基础积分': 'normal', '付费积分': 'paid', '活动积分': 'event', '项目包积分': 'project' };
  for (const t of texts) {
    if (!t || typeof t !== 'string') continue;
    let m = t.match(/账户总余额[:：\s]*([\d,]+)/);
    if (m && num(m[1]) != null) out.accountBalance = num(m[1]);
    for (const [label, key] of Object.entries(KIND)) {
      m = t.match(new RegExp(label + '[:：\\s]*([\\d,]+)'));
      if (m && num(m[1]) != null) out[key] = num(m[1]);
    }
    m = t.match(/剩余可用\s*([\d,]+)\s*积分/);
    if (m && num(m[1]) != null) out.available = num(m[1]);
    m = t.match(/剩余\s*([\d,]+)\s*通用积分/) || t.match(/剩余通用积分[:：\s]*([\d,]+)/);
    if (m && num(m[1]) != null) out.remaining = num(m[1]);
    // 消息流"消耗 X 积分"（每轮对话结算）→ 消息级消耗流水
    m = t.match(/消耗\s*([\d,]+)\s*积分/);
    if (m && num(m[1]) != null) out.cost = num(m[1]);
  }
  return out;
}
// 按 turnId 匹配输入记录：先按主键，再按 wsTurnId / sentId 字段（发送 id ≠ 服务端 turnId）
async function matchPromptByTurn(turnId) {
  if (turnId == null) return null;
  const row = await txGet('prompts', turnId);
  if (row) return row;
  const all = await txGetAll('prompts');
  return all.find((r) => r.turnId === String(turnId) || r.wsTurnId === String(turnId) || r.sentId === String(turnId)) || null;
}

// 更新最近一条未完成的输入记录（限定同一会话内按时间序最后一条），并建立 wsTurnId 关联避免重复补填
function updateLatestPrompt(patch, turnId, ts, chatId) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction('prompts', 'readwrite');
    const store = t.objectStore('prompts');
    const all = store.getAll();
    all.onsuccess = () => {
      const rows = (all.result || [])
        .filter((r) => !r.done && (!chatId || !r.chatId || r.chatId === chatId))
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (!rows.length) { resolve(); return; }
      const target = rows[rows.length - 1];
      store.put({ ...target, ...patch, wsTurnId: turnId, done: true, endedTs: ts || Date.now() });
      resolve();
    };
    t.onerror = () => reject(t.error);
  }));
}

// 处理带用量的服务端推送回包（run_state 等）：回填 inTokens/outTokens/credits 到对应轮次
function onUsageResult(result, data) {
  const turnId = result.turnId != null ? String(result.turnId) : null;
  // credits 若是对象（{consumed, remains, ...} 结构）→ 走消息级扣费真值通道
  if (result.credits && typeof result.credits === 'object') {
    const consumed = Number(result.credits.consumed);
    if (isFinite(consumed) && consumed > 0) {
      return onTurnCredits({ msg: { params: { turnId: result.turnId }, turnId: result.turnId }, credits: result.credits, data });
    }
  }
  const patch = {};
  if (typeof result.inTokens === 'number') patch.inTokens = result.inTokens;
  if (typeof result.outTokens === 'number') patch.outTokens = result.outTokens;
  if (typeof result.credits === 'number') patch.credits = result.credits;
  if (typeof result.contextWindowTokens === 'number') patch.contextWindowTokens = result.contextWindowTokens;
  if (typeof result.outText === 'string') patch.outText = result.outText;
  const sessionId = result.sessionId || result.chatId || null;
  if (sessionId) patch.chatId = sessionId;
  // 剩余通用积分（若响应自带）→ 消息流实时余额
  if (typeof result.remaining === 'number') {
    patch.remaining = result.remaining;
    wsGeneralLatest = { ts: data.ts || Date.now(), general: result.remaining, source: 'rpc' };
    try { chrome.storage.local.set({ wsGeneralLatest }); } catch (e) {}
  }
  if (turnId) {
    return matchPromptByTurn(turnId).then((row) => {
      if (row) {
        return txPut('prompts', { ...row, ...patch, done: true, endedTs: data.ts || Date.now() });
      }
      return updateLatestPrompt(patch, turnId, data.ts);
    });
  }
  if (Object.keys(patch).length) return updateLatestPrompt(patch, null, data.ts);
  return undefined;
}

function appendOutput(chatId, text) {
  if (!chatId) return Promise.resolve();
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction('prompts', 'readwrite');
    const store = t.objectStore('prompts');
    // 找该 chatId 下最近一条未完成记录
    const all = store.getAll();
    all.onsuccess = () => {
      const rows = (all.result || [])
        .filter((r) => r.chatId === chatId && !r.done)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
      if (!rows.length) { resolve(); return; }
      const target = rows[0];
      target.outText = (target.outText || '') + text;
      target.lastActive = Date.now();
      store.put(target);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  }));
}

function onHttpResponse(data) {
  const url = data.url || '';
  const json = data.json;
  if (!json || typeof json !== 'object') return;
  // 项目列表：/api/v1/apps（GET 列表，无子路径）→ 官方项目名映射
  if (/\/api\/v1\/apps$/.test(url) || /\/api\/v1\/apps\?/.test(url)) {
    try {
      const items = Array.isArray(json.items) ? json.items : (Array.isArray(json) ? json : null);
      if (items) {
        for (const it of items) {
          const id = it && (it.id || it.appId || it.projectId || it.uid);
          const name = it && (it.name || it.title || it.appName);
          if (id && name) projectTitles[String(id)] = String(name);
        }
        saveRaw({ ts: data.ts || Date.now(), url, json: { names: Object.keys(projectTitles).length }, note: 'project-list-api' });
      }
    } catch (e) { /* ignore */ }
    return undefined;
  }
  // 会话详情：/api/v1/chats/{id}（带 query 参数也能匹配，去掉结尾 $）
  const chatMatch = url.match(/\/api\/v1\/chats\/([^/?#]+)/);
  if (chatMatch) {
    const chatId = chatMatch[1];
    const chat = json.chat && typeof json.chat === 'object' ? json.chat : null;
    if (chat) {
      const title = typeof chat.title === 'string' && chat.title.trim() ? chat.title : null;
      return txGet('chats', chatId).then((old) => {
        const now = Date.now();
        return txPut('chats', {
          id: chatId,
          title: title || (old && old.title) || '未命名会话',
          createdAt: (old && old.createdAt) || now,
          lastSeen: now,
        });
      });
    }
  }
  // 上下文用量：/api/v1/chats/{id}/context-usage
  const ctxMatch = url.match(/\/api\/v1\/chats\/([^/?#]+)\/context-usage/);
  if (ctxMatch) {
    const chatId = ctxMatch[1];
    const snap = json.snapshot || json;
    const tokens = typeof snap.contextTokens === 'number' ? snap.contextTokens : null;
    if (tokens != null) {
      return txPut('ctx', { id: `${chatId}|${data.ts}`, chatId, ts: data.ts, contextTokens: tokens, note: 'usage' });
    }
  }
  // 历史消息/轮次：/api/v1/chats/{id}/messages 与 /prompts
  // 页面消息流"消耗X积分|剩余Y通用积分"的官方数据源 = 每条 turn 的 params.extras.credits
  //（页面渲染组件 dB({consumed, remains, generalRemains, projectRemains})，consumed>0 才显示）
  if (/\/api\/v1\/chats\/[^/?#]+\/(messages|prompts)\b/.test(url)) {
    return onChatHistory({ url, json, ts: data.ts || Date.now() });
  }
  // 积分明细：/api/v1/credits/transactions（此前被误送进积分解析器，从未入库）
  if (/\/api\/v1\/credits\/transactions/.test(url)) {
    const parsed = parseTransactions(data);
    if (parsed) return txPut('txns', { id: String(data.ts || Date.now()), ...parsed });
    return undefined;
  }
  // 积分余额：/api/v1/credits 及其子端点（页面自身请求，同样解析入库）
  if (/\/api\/v1\/credits/.test(url)) {
    const parsed = parseCreditsPayload(data);
    if (parsed) {
      const hasVals = Object.values(parsed.breakdown).some((v) => v > 0) ||
        (parsed.summary && (parsed.summary.accountBalance != null || parsed.summary.normal != null));
      if (parsed.ok && hasVals) {
        pullState = { lastAt: data.ts || Date.now(), ok: true, msg: '页面自动同步' };
        return txPut('balances', { ...parsed, kind: 'api', total: Object.values(parsed.breakdown).reduce((a, v) => a + v, 0) });
      }
      // 解析成功但分类全空：不覆盖旧的完整快照（只记录，避免基础积分等被刷成 0）
      return saveRaw({ ts: data.ts || Date.now(), url, status: data.status, json, note: 'credits-empty' });
    }
  }
  // 其他 API 响应：扫描 token/credit 字段，尽力关联会话
  const fields = [];
  scanMetricFields(json, 0, fields);
  if (fields.length) {
    const tokens = fields.filter((f) => /token/i.test(f.field));
    const credits = fields.filter((f) => /credit/i.test(f.field));
    if (tokens.length || credits.length) {
      return saveRaw({ ts: data.ts || Date.now(), url, status: data.status, fields: fields.slice(0, 30) });
    }
  }
  return undefined;
}

// 调试原始事件（限量，seq 由 IDB 自增；串行化保证 cap 严格生效）
let rawQueue = Promise.resolve();
function saveRaw(entry) {
  rawQueue = rawQueue.then(async () => {
    const all = await txGetAll('raw');
    if (all.length >= 300) {
      const oldest = all.sort((a, b) => (a.seq || 0) - (b.seq || 0))[0];
      if (oldest && oldest.seq != null) {
        await db().then((d) => new Promise((res, rej) => {
          const t = d.transaction('raw', 'readwrite');
          t.objectStore('raw').delete(oldest.seq);
          t.oncomplete = res; t.onerror = () => rej(t.error);
        }));
      }
    }
    await txPut('raw', { ...entry });
  });
  return rawQueue.catch(() => {});
}

/* ---------------- 查询 ---------------- */
async function getRate() {
  const cfg = await chrome.storage.sync.get({ tokenRate: 1 });
  return (cfg.tokenRate > 0) ? cfg.tokenRate : 1;
}

async function queryTotals() {
  const [prompts, chats, balances, ctx, txns, rate] = await Promise.all([
    txGetAll('prompts'), txGetAll('chats'), txGetAll('balances'), txGetAll('ctx'), txGetAll('txns'), getRate(),
  ]);
  const now = Date.now();
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - 6); weekStart.setHours(0, 0, 0, 0);
  const inDay = (ts) => ts >= dayStart.getTime();
  const inWeek = (ts) => ts >= weekStart.getTime();
  // 消息级消耗流水（真实扣费），按时间归集
  const costs = txns.filter((t) => t.kind === 'msg-cost' && t.ts);
  const costSum = (rows) => sumBy(rows, (t) => Math.abs(t.amount || 0));
  // 权威消耗 = 余额差分：dom 快照（页面"剩余X通用积分"）的下降 = 真实扣费，与页面余额变化一致
  const snaps = balances.filter((b) => b.kind === 'dom' && b.general != null && b.general > 0).sort((a, b) => a.ts - b.ts);
  const diffSince = (fromTs) => {
    const seg = snaps.filter((s) => s.ts >= fromTs);
    if (seg.length < 2) return null;
    const d = seg[0].general - seg[seg.length - 1].general;
    return d > 0 ? d : null;
  };
  const calc = (rows, crows, diff) => {
    const inTokens = sumBy(rows, (r) => r.inTokens || 0);
    const outTokens = sumBy(rows, (r) => r.outTokens || 0);
    return {
      inputs: rows.length,
      outChars: sumBy(rows, (r) => (r.outText || '').length),
      inTokens, outTokens,
      // 余额差分优先（与页面一致）；无差分数据时回退消息级解析（旧数据兼容）
      credits: diff != null ? diff : (sumBy(rows, (r) => r.credits || 0) + costSum(crows)),
      estCredits: Math.round((inTokens + outTokens) * rate),
    };
  };
  const balanceDelta = snaps.length >= 2 ? Math.max(0, snaps[0].general - snaps[snaps.length - 1].general) : null;
  return {
    all: calc(prompts, costs, balanceDelta),
    today: calc(prompts.filter((r) => inDay(r.ts)), costs.filter((t) => inDay(t.ts)), diffSince(dayStart.getTime())),
    week: calc(prompts.filter((r) => inWeek(r.ts)), costs.filter((t) => inWeek(t.ts)), diffSince(weekStart.getTime())),
    chatCount: chats.length,
    balanceSnapshots: balances.length,
    balanceDelta,
    lastBalance: balances.length ? balances[balances.length - 1].credits : null,
  };
}

async function queryByChat() {
  const [prompts, chats, txns, rate] = await Promise.all([txGetAll('prompts'), txGetAll('chats'), txGetAll('txns'), getRate()]);
  const titleMap = {};
  for (const c of chats) titleMap[c.id] = c.title || '未命名会话';
  const byChat = {};
  for (const r of prompts) {
    const key = r.chatId || 'unknown';
    const row = byChat[key] || (byChat[key] = {
      chatId: key,
      title: titleMap[key] || '未命名会话',
      inputs: 0, outChars: 0, inTokens: 0, outTokens: 0, credits: 0, estCredits: 0, lastTs: 0,
    });
    row.inputs += 1;
    row.outChars += (r.outText || '').length;
    row.inTokens += r.inTokens || 0;
    row.outTokens += r.outTokens || 0;
    row.credits += r.credits || 0;
    row.estCredits += Math.round(((r.inTokens || 0) + (r.outTokens || 0)) * rate);
    if (r.ts > row.lastTs) row.lastTs = r.ts;
  }
  // 合并消息级消耗流水（按会话归集）——真实扣费
  for (const t of txns) {
    if (t.kind === 'msg-cost' && t.chatId) {
      const row = byChat[t.chatId] || (byChat[t.chatId] = {
        chatId: t.chatId,
        title: titleMap[t.chatId] || '未命名会话',
        inputs: 0, outChars: 0, inTokens: 0, outTokens: 0, credits: 0, estCredits: 0, lastTs: t.ts || 0,
      });
      row.credits += Math.abs(t.amount || 0);
      if ((t.ts || 0) > row.lastTs) row.lastTs = t.ts;
    }
  }
  return Object.values(byChat).sort((a, b) => b.lastTs - a.lastTs);
}

async function queryByDay() {
  const [prompts, txns, balances] = await Promise.all([txGetAll('prompts'), txGetAll('txns'), txGetAll('balances')]);
  const dayMap = {};
  for (const r of prompts) {
    const d = new Date(r.ts || Date.now());
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const row = dayMap[key] || (dayMap[key] = { day: key, inputs: 0, inTokens: 0, outTokens: 0, credits: 0, estCredits: 0 });
    row.inputs += 1;
    row.inTokens += r.inTokens || 0;
    row.outTokens += r.outTokens || 0;
    row.credits += r.credits || 0;
    row.estCredits += Math.round(((r.inTokens || 0) + (r.outTokens || 0)) * 1);
  }
  // 余额差分（权威）：dom 快照每天"首余额 - 末余额" = 当天真实消耗
  const snaps = balances.filter((b) => b.kind === 'dom' && b.general != null && b.general > 0).sort((a, b) => a.ts - b.ts);
  const dayDiff = {};
  for (const b of snaps) {
    const d = new Date(b.ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const e = dayDiff[key] || (dayDiff[key] = { first: b.general, last: b.general });
    e.last = b.general;
  }
  for (const [key, e] of Object.entries(dayDiff)) {
    const d = e.first - e.last;
    if (d > 0) {
      const row = dayMap[key] || (dayMap[key] = { day: key, inputs: 0, inTokens: 0, outTokens: 0, credits: 0, estCredits: 0 });
      row.credits = d;
    }
  }
  return Object.values(dayMap).sort((a, b) => a.day.localeCompare(b.day));
}

async function queryCostSeries(hours) {
  // 按小时聚合消耗曲线：最近 N 小时的余额差分（dom 快照"剩余通用积分"下降）→ 每小时消耗（对齐整点）
  // 口径与 totals 一致：余额变化是权威，与页面余额变化绝对一致
  const h = hours || 24;
  const [balances] = await Promise.all([txGetAll('balances')]);
  const cutoff = Date.now() - h * 3600e3;
  const snaps = balances.filter((b) => b.kind === 'dom' && b.general != null && b.general > 0 && b.ts >= cutoff).sort((a, b) => a.ts - b.ts);
  const buckets = new Map();
  for (const b of snaps) {
    const bk = Math.floor(b.ts / 3600e3) * 3600e3;
    const e = buckets.get(bk) || { first: b.general, last: b.general };
    e.last = b.general;
    buckets.set(bk, e);
  }
  return Array.from(buckets.entries())
    .map(([ts, e]) => ({ ts, amount: Math.max(0, e.first - e.last) }))
    .filter((x) => x.amount > 0)
    .sort((a, b) => a.ts - b.ts);
}

// 一轮对话超过这么久没有任何动静（流出片段 / 用量回包 / 结束信号），
// 就当成"没收到结束信号的遗留轮次"，不再算进"正在处理"。
// 页面刷新、关标签、断网都会留下这种 !done 的记录，如果只按 done 判断，
// 它们会永远挂在"进行中"里，看起来像一堆项目一直在跑。
const ACTIVE_STALE_MS = 3 * 60 * 1000;

async function querySessions() {
  // 会话监控：开始/结束时间、总耗时、真正正在处理的轮次
  const [prompts, chats] = await Promise.all([txGetAll('prompts'), txGetAll('chats')]);
  const titleMap = {};
  for (const c of chats) titleMap[c.id] = c.title || null;
  const now = Date.now();
  const byChat = {};
  for (const p of prompts) {
    if (!p.chatId) continue;
    const r = byChat[p.chatId] || (byChat[p.chatId] = {
      chatId: p.chatId, inputs: 0, running: 0, done: 0, stale: 0,
      start: Infinity, end: 0, lastActive: 0, runSince: null, lastText: '', lastTextTs: 0,
    });
    r.inputs++;
    if (p.ts && p.ts < r.start) r.start = p.ts;
    if (p.endedTs && p.endedTs > r.end) r.end = p.endedTs;
    const last = p.endedTs || p.lastActive || p.ts || 0;
    if (last > r.lastActive) r.lastActive = last;
    if (p.done) { r.done++; continue; }
    // 未结算的轮次：只有最近 ACTIVE_STALE_MS 内还有动静，才算"正在处理"
    if (now - (p.lastActive || p.ts || 0) < ACTIVE_STALE_MS) {
      r.running++;
      if (!r.runSince || (p.ts && p.ts < r.runSince)) r.runSince = p.ts || now;
      if (p.text && (p.ts || 0) >= r.lastTextTs) { r.lastText = p.text; r.lastTextTs = p.ts || 0; }
    } else {
      r.stale++;
    }
  }
  const sessions = Object.values(byChat).map((r) => {
    const pid = chatProject[r.chatId] || null;
    return {
      chatId: r.chatId,
      title: titleMap[r.chatId] || ('会话 ' + String(r.chatId).slice(0, 8)),
      project: pid ? (projectTitles[pid] || ('项目 ' + String(pid).slice(0, 6))) : null,
      startTs: r.start === Infinity ? null : r.start,
      endTs: r.end || null,
      lastActive: r.lastActive || null,
      runSince: r.runSince || null,
      lastText: r.lastText || '',
      running: r.running,
      done: r.done,
      stale: r.stale,
      inputs: r.inputs,
      durationMs: (r.end && r.start !== Infinity) ? Math.max(0, r.end - r.start) : null,
    };
  }).sort((a, b) => {
    // 正在处理的排最前，其次按最近活动时间倒序
    if ((b.running > 0) !== (a.running > 0)) return (b.running > 0) - (a.running > 0);
    if (b.running !== a.running) return b.running - a.running;
    return (b.lastActive || 0) - (a.lastActive || 0);
  });
  const runningTotal = sessions.reduce((a, s) => a + s.running, 0);
  const staleTotal = sessions.reduce((a, s) => a + s.stale, 0);
  // 顶部"正在处理"用：只含真有消息在跑的会话，最多 5 条
  const active = sessions.filter((s) => s.running > 0).slice(0, 5);
  return { runningTotal, staleTotal, activeCount: active.length, active, sessions: sessions.slice(0, 10) };
}

/* ---------------- 完成通知：一轮跑完推送到手机 ---------------- */
// 三种通道都由扩展直接请求用户自己填的服务，没有中间服务器，也没有账号体系：
//   ntfy   —— 手机装 App 订阅一个 topic，扩展 POST 到 ntfy 服务器
//   bark   —— iPhone 装 Bark，扩展 POST 到 api.day.app/<key>
//   webhook —— 任意能收 JSON POST 的地址（Server酱 / 飞书 / 企微机器人 / 自建）
const NOTIFY_DEFAULTS = {
  notifyEnabled: false,
  notifyChannel: 'ntfy',        // ntfy | bark | webhook
  notifyNtfyServer: 'https://ntfy.sh',
  notifyNtfyTopic: '',
  notifyBarkKey: '',
  notifyWebhook: '',
  notifyFeishuSecret: '',       // 飞书自定义机器人开了「签名校验」才需要
  notifyOnlyAway: true,         // 只在 maker 页面不在前台时推，避免人就在电脑前还响
  notifyMinSec: 20,             // 一轮短于这个秒数就不推，免得每句闲聊都弹
};

function getNotifyCfg() {
  return new Promise((resolve) => {
    try { chrome.storage.sync.get(NOTIFY_DEFAULTS, (cfg) => resolve({ ...NOTIFY_DEFAULTS, ...cfg })); }
    catch (e) { resolve({ ...NOTIFY_DEFAULTS }); }
  });
}

// 去重：同一轮只推一次（stopped 和结算回包都可能触发）。
// service worker 会被回收，所以集合要落盘，只留最近 200 条。
const _notified = new Set();
let _notifiedLoaded = false;
function loadNotified() {
  if (_notifiedLoaded) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ notifiedIds: [] }, (o) => {
        for (const id of (o.notifiedIds || [])) _notified.add(String(id));
        _notifiedLoaded = true;
        resolve();
      });
    } catch (e) { _notifiedLoaded = true; resolve(); }
  });
}
function saveNotified() {
  try { chrome.storage.local.set({ notifiedIds: Array.from(_notified).slice(-200) }); } catch (e) {}
}

function fmtNotifyDur(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}

// 人是否不在 maker 页面（浏览器窗口没聚焦，或聚焦的不是 maker 标签页）
async function isAwayFromMaker() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (!win || !win.focused) return true;
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.url) return true;
    return !tab.url.startsWith('https://maker.taptap.cn');
  } catch (e) {
    return true; // 查不到就当作不在，宁可多推
  }
}

// 会话标题常常就是用户第一句话。有人第一句粘的就是链接，
// 直接照搬会让通知里出现一条看着像"我们塞的外链"的东西 —— 这里压成 "域名/路径…"
function fmtChatTitle(t) {
  const s = String(t || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const tail = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
      return u.hostname.replace(/^www\./i, '') + (tail ? '/' + tail.slice(0, 16) : '') + '…';
    } catch (e) {
      return s.replace(/^https?:\/\//i, '').slice(0, 28) + '…';
    }
  }
  return s.length > 36 ? s.slice(0, 36) + '…' : s;
}

// 通知里带一行余额：优先用最新 API 快照的分类，通用余额用消息流里的实时值覆盖
async function notifyBalanceLine() {
  try {
    const d = await queryCreditBreakdown();
    const b = (d.latest && d.latest.breakdown) || null;
    const ws = d.wsLatest || null;
    const num = (v) => (v == null ? null : Number(v).toLocaleString('zh-CN'));
    let general = b && b.general != null ? b.general : null;
    // wsGeneralLatest 是随每条消息扣减的实时通用余额，比快照更新鲜
    if (ws && ws.general != null && (general == null || (ws.ts || 0) > ((d.latest && d.latest.ts) || 0))) general = ws.general;
    const parts = [];
    if (general != null) parts.push('通用 ' + num(general));
    if (b && b.normal != null && b.normal > 0) parts.push('基础 ' + num(b.normal));
    if (b) {
      const total = ['general', 'memberGeneral', 'normal', 'paid', 'event', 'project']
        .reduce((a, k) => a + (Number(b[k]) || 0), 0);
      if (total > 0) parts.push('合计 ' + num(total));
    }
    return parts.length ? '余额：' + parts.join(' · ') : null;
  } catch (e) {
    return null;
  }
}

// 通知里带一段"其他正在处理的会话"：复用 querySessions 的判定（未结束 + 3 分钟内有动静），
// 排除本条通知自己的会话。没有别的在跑就不输出这段，免得每一条通知都多一行废话。
async function notifyOtherRunning(excludeChatId) {
  try {
    const { active } = await querySessions();
    const list = (active || []).filter((s) => s.chatId !== excludeChatId);
    if (!list.length) return null;
    const now = Date.now();
    const out = [`其他在跑（${list.length} 个）：`];
    for (const s of list.slice(0, 3)) {
      let title = fmtChatTitle(s.title) || ('会话 ' + String(s.chatId).slice(0, 8));
      if (title.length > 26) title = title.slice(0, 26) + '…';
      // 项目名只认平台给的真名，取不到就只写会话名，不拿 "项目 xx3f2a" 之类占位凑数
      const pid = chatProject[s.chatId] || null;
      const proj = pid ? (projectTitles[pid] || null) : null;
      const name = [proj, title].filter(Boolean).join(' · ');
      const ran = s.runSince ? fmtNotifyDur(now - s.runSince) : null;
      out.push('· ' + name + (ran ? ' · 已跑 ' + ran : ''));
    }
    if (list.length > 3) out.push('· 另有 ' + (list.length - 3) + ' 个会话…');
    return out.join('\n');
  } catch (e) {
    return null;
  }
}

async function buildNotifyMsg(row, chatTitle) {
  const pid = row.chatId ? (chatProject[row.chatId] || null) : null;
  const proj = pid ? (projectTitles[pid] || null) : null;
  const title = fmtChatTitle(chatTitle);
  const dur = row.endedTs && row.ts ? (row.endedTs - row.ts) : null;
  const spent = (row.credits != null && row.credits > 0) ? row.credits : null;

  // 结构化输出：项目 / 会话 各有前缀，避免把会话标题误认成别的东西
  const lines = [];
  lines.push('项目：' + (proj || '未识别'));
  lines.push('会话：' + (title || '未命名会话'));
  const meta = ['耗时 ' + fmtNotifyDur(dur)];
  if (spent != null) meta.push(`消耗 ${spent} 积分`);
  if (row.outTokens != null) meta.push(`${row.outTokens} tokens`);
  lines.push(meta.join(' · '));
  const bal = await notifyBalanceLine();
  if (bal) lines.push(bal);
  const txt = String(row.text || '').replace(/\s+/g, ' ').trim();
  if (txt) lines.push('「' + txt.slice(0, 60) + (txt.length > 60 ? '…' : '') + '」');
  // 本条之外还有哪些会话在跑 —— 长任务常常是几个并行，通知里一并说明
  const others = await notifyOtherRunning(row.chatId);
  if (others) lines.push(others);

  // 回跳地址：按官方格式拼 /app/{appId}?chatId={chatId}，确保落到那一轮所在的会话
  const exact = row.chatId ? (buildChatUrl(row.chatId) || chatUrlMap[row.chatId] || null) : null;
  const url = exact || lastMakerUrl || 'https://maker.taptap.cn/';
  return {
    title: 'TapTap 制造 · 任务完成',
    body: lines.join('\n'),
    url,
    actionLabel: exact ? '打开这个会话' : '打开 TapTap 制造',
  };
}

async function sendNotify(cfg, msg) {
  const ch = cfg.notifyChannel;
  if (ch === 'ntfy') {
    const topic = String(cfg.notifyNtfyTopic || '').trim();
    if (!topic) throw new Error('没填 ntfy topic');
    const server = String(cfg.notifyNtfyServer || 'https://ntfy.sh').trim().replace(/\/+$/, '');
    const payload = {
      topic, title: msg.title, message: msg.body, priority: 3, tags: ['white_check_mark'],
      // 点开通知直接跳到会话；actions 是 ntfy 上的按钮
      click: msg.url,
      actions: [{ action: 'view', label: msg.actionLabel || '打开', url: msg.url, clear: false }],
    };
    const res = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 走 JSON publish：标题/正文是中文，用 header 传会撞 ByteString 限制
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('ntfy 返回 ' + res.status);
    return;
  }
  if (ch === 'bark') {
    const key = String(cfg.notifyBarkKey || '').trim();
    if (!key) throw new Error('没填 Bark key');
    const base = /^https?:\/\//i.test(key) ? key.replace(/\/+$/, '') : ('https://api.day.app/' + key);
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // url：点通知本体直接跳会话
      body: JSON.stringify({ title: msg.title, body: msg.body, group: 'TapTap制造', sound: 'bell', isArchive: 1, url: msg.url }),
    });
    if (!res.ok) throw new Error('Bark 返回 ' + res.status);
    return;
  }
  const url = String(cfg.notifyWebhook || '').trim();
  if (!url) throw new Error('没填 Webhook 地址');
  // 各家的文本消息体格式不通用，按域名分派；认不出来的就走通用结构
  //   飞书   { msg_type:'text', content:{ text } }   + 可选 timestamp/sign
  //   企微   { msgtype:'text',  text:{ content } }
  const plain = msg.title + '\n' + msg.body;
  const kind = /open\.feishu\.cn|open\.larksuite\.com/i.test(url) ? 'feishu'
    : /qyapi\.weixin\.qq\.com/i.test(url) ? 'wecom'
    : 'generic';
  let payload;
  if (kind === 'feishu') {
    // 用消息卡片，才能带「打开会话」按钮（text 消息只能放纯文本）
    payload = {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: { template: 'green', title: { tag: 'plain_text', content: msg.title } },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: msg.body } },
          {
            tag: 'action',
            actions: [{
              tag: 'button',
              text: { tag: 'plain_text', content: msg.actionLabel || '打开' },
              type: 'primary',
              url: msg.url,
            }],
          },
        ],
      },
    };
    const secret = String(cfg.notifyFeishuSecret || '').trim();
    if (secret) {
      const ts = Math.floor(Date.now() / 1000);
      payload.timestamp = String(ts);
      payload.sign = await feishuSign(secret, ts);
    }
  } else if (kind === 'wecom') {
    // 企微 text 消息不支持链接，markdown 才带得动
    payload = { msgtype: 'markdown', markdown: { content: `${plain}\n[${msg.actionLabel || '打开'}](${msg.url})` } };
  } else {
    payload = {
      title: msg.title,
      body: msg.body,
      text: plain,
      url: msg.url,
      link: msg.url,
      msg_type: 'text',
      msgtype: 'text',
      content: { text: plain },
      source: 'taptap-maker-stats',
    };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Webhook 返回 ' + res.status);
  // 飞书/企微失败时 HTTP 也可能是 200，真错误在 body 里（code / errcode 不为 0）
  let j = null;
  try { j = await res.clone().json(); } catch (e) { j = null; }
  if (j) {
    if (typeof j.code === 'number' && j.code !== 0) throw new Error('飞书返回 code=' + j.code + ' ' + (j.msg || ''));
    if (typeof j.errcode === 'number' && j.errcode !== 0) throw new Error('企微返回 errcode=' + j.errcode + ' ' + (j.errmsg || ''));
  }
}

// 飞书自定义机器人签名：以 `${timestamp}\n${secret}` 为密钥，对空串做 HMAC-SHA256 再 base64
async function feishuSign(secret, ts) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(String(ts) + '\n' + secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(''));
  let bin = '';
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// 一轮结束时调用。延迟 900ms 再读记录：结算/用量回包常在结束信号之后落地，
// 等一下通知里才能带上真实积分。
async function maybeNotifyDone(turnId) {
  if (turnId == null) return;
  const cfg = await getNotifyCfg();
  if (!cfg.notifyEnabled) return;
  await loadNotified();
  const id = String(turnId);
  if (_notified.has(id)) return;
  _notified.add(id);
  saveNotified();
  await new Promise((r) => setTimeout(r, 900));
  let row = null;
  try { row = await txGet('prompts', turnId); } catch (e) { return; }
  if (!row) return;
  const minMs = Math.max(0, Number(cfg.notifyMinSec) || 0) * 1000;
  if (minMs && row.ts && (Date.now() - row.ts) < minMs) return;
  if (cfg.notifyOnlyAway && !(await isAwayFromMaker())) return;
  let chatTitle = '';
  try { const c = await txGet('chats', row.chatId); chatTitle = (c && c.title) || ''; } catch (e) {}
  const msg = await buildNotifyMsg(row, chatTitle);
  try {
    await sendNotify(cfg, msg);
    saveRaw({ ts: Date.now(), note: 'notify-sent', json: { channel: cfg.notifyChannel, turnId: String(turnId) } });
  } catch (e) {
    console.warn('[tt-stats] notify failed', e);
    saveRaw({ ts: Date.now(), note: 'notify-failed', json: { channel: cfg.notifyChannel, error: String(e && e.message || e) } });
  }
}


async function queryByModel() {
  const all = await txGetAll('txns');
  const byM = {};
  for (const t of all) {
    for (const it of (t.items || [])) {
      if (!it || !it.model) continue;
      const a = it.amount || 0;
      // 只统计扣费记录（amount<0）：模型使用 = 次数 + 扣费积分。
      // 发放（amount>0）是会员卡发积分，与模型使用无关，不计入。
      if (a >= 0) continue;
      const row = byM[it.model] || (byM[it.model] = { model: it.model, count: 0, spent: 0, projects: {} });
      row.count += 1;
      row.spent += Math.abs(a);
      if (it.projectName) row.projects[it.projectName] = 1;
    }
  }
  return Object.values(byM)
    .map((r) => ({ model: r.model, count: r.count, spent: r.spent, projects: Object.keys(r.projects) }))
    .sort((a, b) => b.spent - a.spent);
}

async function queryByProject() {
  const [prompts, txns, chats] = await Promise.all([txGetAll('prompts'), txGetAll('txns'), txGetAll('chats')]);
  const titleMap = {};
  for (const c of chats) titleMap[c.id] = c.title || null;
  const byProj = {};
  const rowFor = (pid) => byProj[pid] || (byProj[pid] = {
    projectId: pid || '',
    name: pid ? (projectTitles[pid] || ('项目 ' + pid.slice(0, 8))) : '未分类',
    inputs: 0, credits: 0, lastTs: 0, startTs: Infinity, endTs: 0, chats: {},
  });
  for (const r of prompts) {
    const pid = (r.chatId && chatProject[r.chatId]) || null;
    const row = rowFor(pid);
    row.inputs += 1;
    if ((r.ts || 0) < row.startTs) row.startTs = r.ts || 0;
    if (r.endedTs && r.endedTs > row.endTs) row.endTs = r.endedTs;
    if (!r.endedTs && (r.ts || 0) > row.endTs) row.endTs = r.ts || 0;
    const c = row.chats[r.chatId] || (row.chats[r.chatId] = { chatId: r.chatId, inputs: 0, credits: 0, lastTs: 0, startTs: Infinity, endTs: 0 });
    c.inputs += 1;
    // 消息自带的消耗（与今日概览 totals 口径一致：prompts.credits + msg-cost）
    row.credits += r.credits || 0;
    c.credits += r.credits || 0;
    if ((r.ts || 0) < c.startTs) c.startTs = r.ts || 0;
    if (r.endedTs && r.endedTs > c.endTs) c.endTs = r.endedTs;
    if (!r.endedTs && (r.ts || 0) > c.endTs) c.endTs = r.ts || 0;
    if ((r.ts || 0) > c.lastTs) c.lastTs = r.ts;
    if ((r.ts || 0) > row.lastTs) row.lastTs = r.ts;
  }
  for (const t of txns) {
    if (t.kind === 'msg-cost') {
      const pid = t.projectId || (t.chatId && chatProject[t.chatId]) || null;
      const row = rowFor(pid);
      row.credits += Math.abs(t.amount || 0);
      if (t.chatId) {
        const c = row.chats[t.chatId] || (row.chats[t.chatId] = { chatId: t.chatId, inputs: 0, credits: 0, lastTs: 0 });
        c.credits += Math.abs(t.amount || 0);
        if ((t.ts || 0) > c.lastTs) c.lastTs = t.ts;
      }
      if ((t.ts || 0) > row.lastTs) row.lastTs = t.ts;
    }
  }
  return Object.values(byProj)
    .map((r) => {
      const chats = Object.values(r.chats).sort((a, b) => b.lastTs - a.lastTs)
        .map((c) => ({ chatId: c.chatId, title: titleMap[c.chatId] || null, inputs: c.inputs, credits: c.credits,
          startTs: c.startTs === Infinity ? null : c.startTs,
          endTs: c.endTs || null,
          durationMs: (c.endTs && c.startTs !== Infinity) ? Math.max(0, c.endTs - c.startTs) : null }));
      const dur = chats.reduce((a, c) => a + (c.durationMs || 0), 0);
      return { projectId: r.projectId, name: r.name, inputs: r.inputs, credits: r.credits, lastTs: r.lastTs,
        startTs: r.startTs === Infinity ? null : r.startTs,
        endTs: r.endTs || null,
        durationMs: dur || null,
        chats };
    })
    .sort((a, b) => b.lastTs - a.lastTs);
}

async function queryChats() {
  const chats = await txGetAll('chats');
  return chats.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

async function queryRaw() {
  const raw = await txGetAll('raw');
  return raw.sort((a, b) => b.seq - a.seq).slice(0, 50);
}

async function queryBalances() {
  const b = await txGetAll('balances');
  return b.sort((a, b) => a.ts - b.ts).map((r) => ({
    ...r,
    // 统一补 credits 数值（图表用）：优先 total / breakdown 求和 / general
    credits: r.credits != null ? r.credits
      : (r.total != null ? r.total
        : ((r.breakdown && (r.breakdown.general || 0) + (r.breakdown.normal || 0)) || r.general || 0)),
  }));
}

async function queryCreditBreakdown() {
  const b = await queryBalances();
  // 优先最新 API 快照（含完整分类 breakdown：general/memberGeneral/normal/paid/event/project）
  // dom 快照只有页面显示的"剩余X通用积分"（=general），会员卡分类缺失，不能作为主数据；
  // 用 API 快照补全缺失分类，避免会员卡积分被"最新 dom 快照"覆盖掉
  // 兼容历史记录：kind==='api' 或 带 items/breakdown 且非 dom 的都视为接口快照
  const api = b.length
    ? [...b].reverse().find((x) => x && (x.kind === 'api' || (x.kind !== 'dom' && x.items && x.items.length)) && x.breakdown && Object.values(x.breakdown).some((v) => v > 0))
    : null;
  // 全部接口快照分类都为空（早期版本被污染/本地尚无完整数据）→ 退回含 summary 的或 null
  const api2 = b.length ? [...b].reverse().find((x) => x && (x.kind === 'api' || x.kind !== 'dom') && x.summary && (x.summary.normal != null || x.summary.accountBalance != null)) : null;
  const apiFinal = api || api2;
  const dom = b.length ? [...b].reverse().find((x) => x && x.kind === 'dom') : null;
  let latest = apiFinal || dom;
  if (latest && latest.kind === 'dom') {
    const rem = latest.remaining != null ? latest.remaining : 0;
    const ab = (apiFinal && apiFinal.breakdown) || {};
    let normal = latest.normal != null ? latest.normal : (ab.normal || 0);
    // 基础积分等分类本地缺失（页面只显示了通用）：标 null → 侧边栏显示"待同步"，不显示误导性的 0
    if (normal <= 0 && latest.available != null && latest.available > rem) normal = null;
    latest.breakdown = {
      general: latest.general || rem,
      memberGeneral: latest.memberGeneral || ab.memberGeneral || 0,
      normal,
      paid: latest.paid || ab.paid || 0,
      event: latest.event || ab.event || 0,
      project: latest.project || ab.project || 0,
    };
    // 会话页底部"剩余可用 X 积分"= 完整总计（含基础/付费等全部分类），保留供合计显示
    if (latest.available == null) latest.available = ab.total || null;
  }
  return {
    count: b.length,
    latest,
    wsLatest: wsGeneralLatest, // 消息流实时通用余额（随每次消息扣减）
    lastTs: latest ? latest.ts : null,
    pullState, // 云端同步状态（成功/失败/尚未同步）
    historyStats, // 历史消息解析统计（pulls/hits/noTurnId）
  };
}

async function queryTransactions(limit) {
  const all = await txGetAll('txns');
  const items = [];
  for (const t of all) {
    if (t.kind === 'msg-cost') {
      items.push({ amount: t.amount, title: t.title || '对话消耗', createdAt: t.createdAt, remaining: t.remaining, kind: 'msg-cost', ts: t.ts, chatId: t.chatId, projectName: t.projectId ? (projectTitles[t.projectId] || t.projectId.slice(0, 8)) : null });
    } else if (t.items) {
      items.push(...t.items);
    }
  }
  items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || ((b.ts || 0) - (a.ts || 0)));
  return items.slice(0, limit || 30);
}

async function queryInjectStatus() {
  // 每次查询都先确保页面已注入（SW 重启/扩展重载后 content 断开，自动重新注入）
  // 等待注入完成再返回，避免"打开侧边栏先看到未连接、下个周期才恢复"
  try { await ensureInjected(); } catch (e) { /* 忽略 */ }
  const now = Date.now();
  const entries = [...injectedTabs.values()];
  const fresh = entries.filter((e) => now - e.ts < 10 * 60 * 1000);
  const latest = fresh.length ? fresh.sort((a, b) => b.ts - a.ts)[0] : null;
  return {
    injected: fresh.length > 0,
    count: fresh.length,
    hookReady: hookReadyAt != null,
    hookReadyTs: hookReadyAt,
    lastUrl: latest ? latest.url : null,
    lastTs: latest ? latest.ts : null,
  };
}

// 确保 maker 页面已注入 content + main-hook；断开了就重新注入（无需用户刷新页面）
let ensuring = null;
async function ensureInjected() {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://maker.taptap.cn/*' });
      for (const t of tabs) {
        if (t.id == null) continue;
        let alive = false;
        try {
          const resp = await chrome.tabs.sendMessage(t.id, { kind: 'ping' });
          alive = !!(resp && resp.ok);
        } catch (e) { alive = false; }
        if (!alive) {
          try {
            await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] });
            await chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', files: ['main-hook.js'] });
            injectedTabs.set(t.id, { url: t.url || 'https://maker.taptap.cn', ts: Date.now() });
            hookReadyAt = Date.now();
          } catch (e) { /* 注入失败忽略 */ }
        }
      }
    } catch (e) { /* 无标签页或权限不足，忽略 */ }
  })().finally(() => { ensuring = null; });
  return ensuring;
}

async function queryPrompts(chatId, limit) {
  const prompts = await txGetAll('prompts');
  const rows = (chatId ? prompts.filter((r) => r.chatId === chatId) : prompts)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return rows.slice(0, limit || 50);
}

/* ---------------- 消息路由 ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.kind === 'tt-hello') {
    // content script 注入成功心跳
    if (sender && sender.tab && sender.tab.id != null) {
      injectedTabs.set(sender.tab.id, { url: msg.data && msg.data.url, ts: Date.now() });
    }
    sendResponse({ ok: true });
    return;
  }
  if (msg.kind === 'tt-event') {
    // 任何页面事件都证明页面存活 → 刷新注入状态（SW 重启后也能恢复"已注入"）
    if (sender && sender.tab && sender.tab.id != null) {
      injectedTabs.set(sender.tab.id, { url: sender.tab.url || (msg.data && msg.data.url), ts: Date.now() });
    }
    // 记下最近一次 maker 页面地址，供通知里的「打开会话」按钮回跳
    const pageUrl = (msg.data && msg.data.url) || (sender && sender.tab && sender.tab.url) || null;
    if (pageUrl && /^https:\/\/maker\.taptap\.cn\//.test(pageUrl)) {
      lastMakerUrl = pageUrl;
      // 地址里带着 /app/{appId}?chatId={chatId} 时，顺便把这两个 id 记下来，通知就能直接拼规范链接
      const cid = chatIdFromUrl(pageUrl) || (msg.data && msg.data.chatId) || null;
      if (cid) {
        chatUrlMap[cid] = pageUrl;
        const aid = appIdFromUrl(pageUrl);
        if (aid && !chatProject[cid]) chatProject[cid] = aid;
      }
    }
    ingest(msg.type, msg.data);
    sendResponse({ ok: true });
    return;
  }
  if (msg.kind === 'notifyTest') {
    // 设置页「发送测试通知」：用当前配置真发一条，把失败原因原样返回
    getNotifyCfg().then(async (cfg) => {
      if (!cfg.notifyEnabled) { sendResponse({ ok: false, error: '先勾选「启用完成通知」并保存' }); return; }
      try {
        // 有其他会话在跑就显示真实的，没有就用示例，确保能看到这段的排版
        const live = await notifyOtherRunning(null);
        await sendNotify(cfg, {
          title: 'TapTap 制造 · 测试通知',
          body: [
            '项目：示例项目',
            '会话：示例会话',
            '耗时 2 分 18 秒 · 消耗 12 积分',
            '余额：通用 1,234 · 基础 500 · 合计 1,734',
            live || '其他在跑（示例）：\n· 示例项目 · 另一个会话 · 已跑 41 秒',
            '这是一条测试消息，不影响任何统计。',
          ].join('\n'),
          url: 'https://maker.taptap.cn/',
          actionLabel: '打开 TapTap 制造',
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    });
    return true;
  }
  if (msg.kind === 'export') {
    // 收集诊断数据返回给侧边栏（侧边栏负责创建 blob 下载；SW 无 URL.createObjectURL）
    Promise.all([txGetAll('raw'), txGetAll('prompts'), txGetAll('balances'), txGetAll('txns'), txGetAll('chats')])
      .then(([raw, prompts, balances, txns, chats]) => {
        sendResponse({
          ok: true,
          payload: {
            exportedAt: new Date().toISOString(),
            hookReady: hookReadyAt != null,
            counts: { raw: raw.length, prompts: prompts.length, balances: balances.length, txns: txns.length, chats: chats.length },
            raw: (raw || []).slice(-80),
            prompts: (prompts || []).slice(-30),
            balances: (balances || []).slice(-5),
            txns: (txns || []).slice(-10),
            chats: (chats || []).slice(-20),
          },
        });
      }).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.kind === 'query') {
    const q = msg.what;
    const needBackfill = q === 'totals' || q === 'byChat' || q === 'prompts' || q === 'byDay';
    const run = () => (q === 'totals' ? queryTotals()
      : q === 'byChat' ? queryByChat()
      : q === 'byDay' ? queryByDay()
      : q === 'chats' ? queryChats()
      : q === 'byProject' ? queryByProject()
      : q === 'byModel' ? queryByModel()
      : q === 'sessions' ? querySessions()
      : q === 'costSeries' ? queryCostSeries(msg.hours)
      : q === 'raw' ? queryRaw()
      : q === 'balances' ? queryBalances()
      : q === 'creditBreakdown' ? queryCreditBreakdown()
      : q === 'transactions' ? queryTransactions(msg.limit)
      : q === 'injectStatus' ? queryInjectStatus()
      : q === 'prompts' ? queryPrompts(msg.chatId, msg.limit)
      : null);
    const p = needBackfill ? ensureBackfill().then(run) : run();
    if (p) {
      p.then((res) => sendResponse({ ok: true, data: res })).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true; // async
    }
  }
  return undefined;
});

// 初始化 DB（预创建，避免首次访问延迟）
db().catch((e) => console.error('[tt-stats] db init failed', e));

// 主动注入：扩展安装/浏览器启动/切换标签页时立即重注入，不等侧边栏打开
chrome.runtime.onInstalled.addListener(() => { ensureInjected().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { ensureInjected().catch(() => {}); });
chrome.tabs.onActivated.addListener((info) => {
  chrome.tabs.get(info.tabId).then((t) => {
    if (t && t.url && t.url.startsWith('https://maker.taptap.cn')) {
      ensureInjected().catch(() => {});
    }
  }).catch(() => {});
});

// 点击扩展图标 → 打开浏览器侧边栏（Chrome/Edge 114+）
if (chrome.sidePanel) {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) { /* 老版本浏览器忽略 */ }
}
