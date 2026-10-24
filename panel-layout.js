/* panel-layout.js — 侧边栏模块的「折叠 + 长按拖动排序」
 *
 * 交互：
 *   - 点模块标题：收起 / 展开，状态记在本地
 *   - 长按标题约 0.4 秒：进入拖拽，上下挪动换位置；松手落定并记住顺序
 *   - 设置模块（data-mod="set"）有自己的展开逻辑，这里只管拖动、不管折叠
 *
 * 存储：chrome.storage.local['panelLayout'] = { order: [id...], collapsed: { id: bool } }
 *       同时在 localStorage 留一份镜像，用于首帧同步恢复（避免闪一下原始顺序）
 */
(function () {
  'use strict';

  const KEY = 'panelLayout';
  const MIRROR = 'panelLayoutMirror';
  const HOLD_MS = 400;     // 长按判定时长
  const MOVE_TOL = 8;      // 长按未到就移动超过这个距离 → 取消（当作滚动）

  const STATE = { order: [], collapsed: {} };

  const panels = () => Array.prototype.slice.call(document.querySelectorAll('body > section.panel[data-mod]'));
  const panelOf = (el) => (el && el.closest ? el.closest('section.panel[data-mod]') : null);

  /* ---------------- 存取 ---------------- */
  function readMirror() {
    try { return JSON.parse(localStorage.getItem(MIRROR) || 'null'); } catch (e) { return null; }
  }
  function normalize(st) {
    const out = { order: [], collapsed: {} };
    if (!st || typeof st !== 'object') return out;
    if (Array.isArray(st.order)) out.order = st.order.filter((x) => typeof x === 'string');
    if (st.collapsed && typeof st.collapsed === 'object') out.collapsed = st.collapsed;
    return out;
  }
  function persist() {
    const payload = { order: STATE.order, collapsed: STATE.collapsed };
    try { localStorage.setItem(MIRROR, JSON.stringify(payload)); } catch (e) { /* 隐私模式忽略 */ }
    try {
      chrome.storage.local.set({ [KEY]: payload });
    } catch (e) { /* 扩展上下文失效时忽略 */ }
  }

  /* ---------------- 应用布局 ---------------- */
  function applyOrder(order) {
    const list = panels();
    if (!list.length) return;
    const map = new Map(list.map((p) => [p.dataset.mod, p]));
    // 锚点：页脚；没有就退回 body 末尾
    const foot = document.querySelector('.foot');
    const parent = foot ? foot.parentNode : document.body;
    const before = foot || null;

    (order || []).forEach((id) => {
      const el = map.get(id);
      if (!el) return;
      parent.insertBefore(el, before);
      map.delete(id);
    });
    // 新增的 / 没记录的模块排到最后
    map.forEach((el) => parent.insertBefore(el, before));
  }

  function applyCollapsed(map) {
    panels().forEach((p) => {
      const id = p.dataset.mod;
      if (id === 'set') return;             // 设置沿用自身的展开逻辑
      p.classList.toggle('collapsed', !!map[id]);
    });
  }

  /* ---------------- 折叠 ---------------- */
  // 折叠时画布宽度归 0，展开后要主动让它重画（sidepanel.js 暴露的入口）
  const CHART_KEYS = {
    credits: ['donut'],
    projects: ['byProject'],
    hourly: ['costSeries'],
    days: ['byDay'],
    models: ['byModel'],
  };

  function redraw(id) {
    const keys = CHART_KEYS[id];
    if (!keys) return;
    // 同步调用即可：读 canvas 尺寸会强制回流，拿到的是展开后的真实宽度
    if (typeof window.__panelRedraw === 'function') window.__panelRedraw(keys);
  }

  function toggle(panel, force) {
    const id = panel.dataset.mod;
    if (!id || id === 'set') return;
    const want = force == null ? !panel.classList.contains('collapsed') : !!force;
    panel.classList.toggle('collapsed', want);
    STATE.collapsed[id] = want;
    persist();
    if (!want) redraw(id);
  }

  /* ---------------- 拖拽 ---------------- */
  let holdTimer = null;
  let dragEl = null;
  let startX = 0;
  let startY = 0;
  let baseY = 0;
  let longPressed = false;
  let listening = false;

  function listen(on) {
    if (on === listening) return;
    listening = on;
    const m = on ? 'addEventListener' : 'removeEventListener';
    window[m]('pointermove', onMove, on ? { passive: false } : undefined);
    window[m]('pointerup', onUp);
    window[m]('pointercancel', onUp);
  }

  function beginDrag(panel, y) {
    longPressed = true;
    dragEl = panel;
    baseY = y;
    document.body.classList.add('panel-sorting');
    panel.classList.add('dragging');
    panel.classList.remove('pressed');
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) { /* 忽略 */ } }
  }

  function onDown(e) {
    if (e.button != null && e.button !== 0) return;
    const title = e.target.closest && e.target.closest('.panel-title');
    if (!title) return;
    // 标题行里的开关 / 链接 / 输入框不参与长按
    if (e.target.closest('input, a, button, label, .switch')) return;
    const panel = panelOf(title);
    if (!panel) return;

    startX = e.clientX;
    startY = e.clientY;
    longPressed = false;
    holdTimer = setTimeout(() => beginDrag(panel, startY), HOLD_MS);
    panel.classList.add('pressed');
    listen(true);
  }

  function onMove(e) {
    if (!dragEl) {
      // 长按还没成立就已经动了 —— 当成正常滚动，撤掉这次长按
      if (Math.abs(e.clientY - startY) > MOVE_TOL || Math.abs(e.clientX - startX) > MOVE_TOL) {
        clearTimeout(holdTimer);
        const p = document.querySelector('.panel.pressed');
        if (p) p.classList.remove('pressed');
        listen(false);
      }
      return;
    }
    if (e.cancelable) e.preventDefault();

    dragEl.style.transform = 'translateY(' + (e.clientY - baseY) + 'px)';

    // 找指针下面真正的那块面板（拖拽块本身已 pointer-events:none）
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = panelOf(under);
    if (!target || target === dragEl) return;

    const r = target.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    if (after) {
      if (target.nextElementSibling === dragEl) return;
      target.parentNode.insertBefore(dragEl, target.nextSibling);
    } else {
      if (target.previousElementSibling === dragEl) return;
      target.parentNode.insertBefore(dragEl, target);
    }
    // 位置换完了，把基准拉回指针，避免下一次 move 叠加造成跳变
    baseY = e.clientY;
    dragEl.style.transform = 'translateY(0px)';
  }

  function onUp() {
    clearTimeout(holdTimer);
    const pressed = document.querySelector('.panel.pressed');
    if (pressed) pressed.classList.remove('pressed');

    if (dragEl) {
      dragEl.style.transform = '';
      dragEl.classList.remove('dragging');
      document.body.classList.remove('panel-sorting');
      STATE.order = panels().map((p) => p.dataset.mod);
      persist();
      dragEl = null;
      // 松手后浏览器还会补一个 click，压住它，别把面板折叠了
      setTimeout(() => { longPressed = false; }, 80);
    }
    listen(false);
  }

  /* ---------------- 交互绑定 ---------------- */
  function bind() {
    document.addEventListener('pointerdown', onDown, true);

    document.addEventListener('click', (e) => {
      const title = e.target.closest && e.target.closest('.panel-title');
      if (!title) return;
      const panel = panelOf(title);
      if (!panel) return;
      if (panel.dataset.mod === 'set') return;   // 设置走自己的展开
      if (longPressed) { e.preventDefault(); e.stopPropagation(); return; }
      if (e.target.closest('input, a, button, label, .switch')) return;
      toggle(panel);
    }, true);

    // 键盘可访问：标题行回车/空格也能收起
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const title = e.target.closest && e.target.closest('.panel-title');
      const panel = panelOf(title);
      if (!panel) return;
      if (e.target.closest('input, a, button, label')) return;
      e.preventDefault();
      toggle(panel);
    });
  }

  /* ---------------- 启动 ---------------- */
  function boot(state) {
    const st = normalize(state);
    STATE.order = st.order;
    STATE.collapsed = st.collapsed;
    applyCollapsed(STATE.collapsed);
    applyOrder(STATE.order);
    bind();
    // chrome.storage 里的最新值可能比镜像新（换了窗口 / 设备），异步对齐一次
    try {
      chrome.storage.local.get(KEY, (o) => {
        if (!o || !o[KEY]) return;
        const s2 = normalize(o[KEY]);
        STATE.order = s2.order;
        STATE.collapsed = s2.collapsed;
        applyCollapsed(s2.collapsed);
        applyOrder(s2.order);
      });
    } catch (e) { /* 忽略 */ }
  }

  boot(readMirror());
})();
