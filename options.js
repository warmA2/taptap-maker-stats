/* options.js — 设置页：完成通知 + 积分倍率 */
'use strict';

const $ = (id) => document.getElementById(id);
const msgEl = $('msg');

const DEFAULTS = {
  tokenRate: 1,
  notifyEnabled: false,
  notifyChannel: 'ntfy',
  notifyNtfyServer: 'https://ntfy.sh',
  notifyNtfyTopic: '',
  notifyBarkKey: '',
  notifyWebhook: '',
  notifyOnlyAway: true,
  notifyMinSec: 20,
};

let currentChannel = 'ntfy';

function showMsg(text, ok) {
  msgEl.textContent = text;
  msgEl.className = 'msg ' + (ok ? 'ok' : 'bad');
  if (ok) setTimeout(() => { if (msgEl.textContent === text) msgEl.textContent = ''; }, 2500);
}

function setChannel(ch) {
  currentChannel = ch;
  document.querySelectorAll('.chip').forEach((el) => {
    el.classList.toggle('on', el.dataset.ch === ch);
  });
  document.querySelectorAll('.ch-block').forEach((el) => {
    el.classList.toggle('on', el.dataset.for === ch);
  });
}

/* ---------- 载入 ---------- */
chrome.storage.sync.get(DEFAULTS, (cfg) => {
  $('token-rate').value = cfg.tokenRate;
  $('notify-enabled').checked = !!cfg.notifyEnabled;
  $('ntfy-topic').value = cfg.notifyNtfyTopic || '';
  $('ntfy-server').value = (cfg.notifyNtfyServer && cfg.notifyNtfyServer !== 'https://ntfy.sh') ? cfg.notifyNtfyServer : '';
  $('bark-key').value = cfg.notifyBarkKey || '';
  $('webhook-url').value = cfg.notifyWebhook || '';
  $('notify-only-away').checked = !!cfg.notifyOnlyAway;
  $('notify-min-sec').value = cfg.notifyMinSec;
  setChannel(cfg.notifyChannel || 'ntfy');
});

document.querySelectorAll('.chip').forEach((el) => {
  el.addEventListener('click', () => setChannel(el.dataset.ch));
});

/* ---------- 权限：自建服务器 / 自定义 webhook 需要额外域名授权 ---------- */
function originOf(url) {
  try { return new URL(url).origin + '/*'; } catch (e) { return null; }
}

async function ensureOrigins() {
  const need = new Set();
  if (currentChannel === 'ntfy') {
    const srv = ($('ntfy-server').value || '').trim() || 'https://ntfy.sh';
    const o = originOf(srv);
    if (o && !/^https:\/\/ntfy\.sh\/\*$/.test(o)) need.add(o);
  } else if (currentChannel === 'bark') {
    const k = ($('bark-key').value || '').trim();
    if (/^https?:\/\//i.test(k)) {
      const o = originOf(k);
      if (o && o !== 'https://api.day.app/*') need.add(o);
    }
  } else {
    const u = ($('webhook-url').value || '').trim();
    if (!u) return true;
    const o = originOf(u);
    if (o) need.add(o);
  }
  if (!need.size) return true;
  try {
    return await chrome.permissions.request({ origins: Array.from(need) });
  } catch (e) {
    return false;
  }
}

/* ---------- 保存 ---------- */
async function save(silent) {
  const rate = parseFloat($('token-rate').value);
  const cfg = {
    tokenRate: (rate > 0 ? rate : 1),
    notifyEnabled: $('notify-enabled').checked,
    notifyChannel: currentChannel,
    notifyNtfyServer: ($('ntfy-server').value || '').trim() || 'https://ntfy.sh',
    notifyNtfyTopic: ($('ntfy-topic').value || '').trim(),
    notifyBarkKey: ($('bark-key').value || '').trim(),
    notifyWebhook: ($('webhook-url').value || '').trim(),
    notifyOnlyAway: $('notify-only-away').checked,
    notifyMinSec: Math.max(0, parseInt($('notify-min-sec').value, 10) || 0),
  };
  const granted = await ensureOrigins();
  if (!granted) {
    showMsg('没有授予该域名的访问权限，通知发不出去', false);
    return null;
  }
  await new Promise((r) => chrome.storage.sync.set(cfg, r));
  if (!silent) showMsg('已保存', true);
  return cfg;
}

$('save').addEventListener('click', () => { save(false); });

/* ---------- 测试 ---------- */
$('test').addEventListener('click', async () => {
  showMsg('发送中…', true);
  const cfg = await save(true);
  if (!cfg) return;
  if (!cfg.notifyEnabled) { showMsg('先勾选「启用完成通知」再测试', false); return; }
  const channelFilled = currentChannel === 'ntfy' ? !!cfg.notifyNtfyTopic
    : currentChannel === 'bark' ? !!cfg.notifyBarkKey
    : !!cfg.notifyWebhook;
  if (!channelFilled) { showMsg('先把当前通道的必填项填完', false); return; }
  chrome.runtime.sendMessage({ kind: 'notifyTest' }, (res) => {
    if (chrome.runtime.lastError) { showMsg('后台没响应：' + chrome.runtime.lastError.message, false); return; }
    if (res && res.ok) showMsg('测试已发出，看看手机', true);
    else showMsg('发送失败：' + ((res && res.error) || '未知原因'), false);
  });
});
