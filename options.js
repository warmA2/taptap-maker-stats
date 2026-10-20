/* options.js */
'use strict';
const input = document.getElementById('token-rate');
const okEl = document.getElementById('ok');

chrome.storage.sync.get({ tokenRate: 1 }, (cfg) => {
  input.value = cfg.tokenRate;
});

document.getElementById('save').addEventListener('click', () => {
  let v = parseFloat(input.value);
  if (!(v > 0)) v = 1;
  chrome.storage.sync.set({ tokenRate: v }, () => {
    okEl.textContent = '已保存';
    setTimeout(() => { okEl.textContent = ''; }, 1500);
  });
});
