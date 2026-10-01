(() => {
  const { $, api, esc, toast, accountId } = window.App || {};
  if (!$ || !api) return;

  const state = {
    accountId: accountId ? accountId() : (localStorage.getItem('waAccountId') || 'default'),
    items: [],
    unread: 0,
    filter: 'all',
    panelOpen: false,
    socket: null,
    settings: loadSettings()
  };

  function loadSettings() {
    try {
      return { inApp: true, desktop: true, sound: true, ...(JSON.parse(localStorage.getItem('notificationSettings') || '{}')) };
    } catch (_) {
      return { inApp: true, desktop: true, sound: true };
    }
  }

  function saveSettings() {
    localStorage.setItem('notificationSettings', JSON.stringify(state.settings));
  }

  function escAttr(v) {
    return esc(v).replace(/`/g, '&#96;');
  }

  function currentAccount() {
    return localStorage.getItem('waAccountId') || 'default';
  }

  function ensureButton() {
    document.querySelectorAll('.top-actions').forEach(actions => {
      if (actions.querySelector('#notificationBtn')) return;
      const btn = document.createElement('button');
      btn.className = 'icon notification-btn';
      btn.id = 'notificationBtn';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Open Notifications');
      btn.setAttribute('title', 'Notifications');
      btn.innerHTML = '<span class="notification-bell" aria-hidden="true">🔔</span><span class="notification-badge" id="notificationBadge" hidden>0</span>';
      actions.insertBefore(btn, actions.firstChild);
      btn.addEventListener('click', e => {
        e.stopPropagation();
        togglePanel();
      });
    });
  }

  function ensureBackdrop() {
    let backdrop = $('notificationBackdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'notificationBackdrop';
      backdrop.className = 'notification-backdrop';
      document.body.appendChild(backdrop);
      backdrop.addEventListener('click', closePanel);
      backdrop.addEventListener('touchstart', e => {
        e.preventDefault();
        closePanel();
      }, { passive: false });
    }
    return backdrop;
  }

  function ensurePanel() {
    ensureBackdrop();
    if ($('notificationPanel')) return $('notificationPanel');
    const panel = document.createElement('aside');
    panel.id = 'notificationPanel';
    panel.className = 'notification-panel';
    panel.setAttribute('aria-label', 'Notification center');
    panel.innerHTML = `
      <div class="notification-panel-head">
        <div>
          <strong>Activity & Notifications</strong>
          <small id="notificationSummary">Your latest activity</small>
        </div>
        <button class="icon notification-close" id="notificationClose" type="button" aria-label="Close">✕</button>
      </div>
      <div class="notification-toolbar">
        <div class="notification-filters">
          <button class="notification-filter active" data-filter="all" type="button">All</button>
          <button class="notification-filter" data-filter="unread" type="button">Unread</button>
        </div>
        <div style="display:flex;gap:6px">
          <button class="notification-action" id="notificationReadAll" type="button">Mark all read</button>
          <button class="notification-action" id="notificationClear" type="button">Clear</button>
        </div>
      </div>
      <div class="notification-list" id="notificationList">
        <div class="notification-empty">
          <span>◌</span>
          <strong>No notifications</strong>
          <small>New messages and system events will appear here.</small>
        </div>
      </div>
      <div class="notification-panel-foot">
        <a href="/notifications.html">View all history →</a>
        <button id="notificationTest" type="button">⚡ Test</button>
      </div>`;
    document.body.appendChild(panel);

    panel.querySelector('#notificationClose').addEventListener('click', e => {
      e.stopPropagation();
      closePanel();
    });

    panel.querySelectorAll('.notification-filter').forEach(btn => btn.addEventListener('click', () => {
      panel.querySelectorAll('.notification-filter').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      render();
    }));

    panel.querySelector('#notificationReadAll').addEventListener('click', markAllRead);
    panel.querySelector('#notificationClear').addEventListener('click', clearAll);
    panel.querySelector('#notificationTest').addEventListener('click', () => {
      const n = {
        _id: 'test-' + Date.now(),
        title: '🔔 Test Notification',
        body: 'Your notification center is running perfectly across all devices.',
        type: 'system',
        createdAt: new Date().toISOString(),
        read: false,
        accountId: state.accountId,
        url: '/notifications.html'
      };
      showIncoming(n, { persist: false });
    });

    return panel;
  }

  function togglePanel() {
    ensurePanel();
    if (state.panelOpen) closePanel();
    else openPanel();
  }

  function openPanel() {
    const panel = ensurePanel();
    const backdrop = ensureBackdrop();
    panel.classList.add('open');
    backdrop.classList.add('open');
    state.panelOpen = true;
    load();
  }

  function closePanel() {
    const panel = $('notificationPanel');
    const backdrop = $('notificationBackdrop');
    if (panel) panel.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
    state.panelOpen = false;
  }

  function formatTime(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const diff = Math.max(0, Date.now() - d.getTime());
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
  }

  function iconFor(type) {
    return ({ message: '💬', ai_reply: '🤖', account: '📱', error: '⚠️', system: '🔔' })[type] || '🔔';
  }

  function render() {
    const list = $('notificationList');
    if (!list) return;
    const rows = state.items.filter(n => state.filter === 'all' || !n.read);
    if (!rows.length) {
      list.innerHTML = `
        <div class="notification-empty">
          <span>${state.filter === 'unread' ? '✓' : '◌'}</span>
          <strong>${state.filter === 'unread' ? 'All caught up' : 'No notifications'}</strong>
          <small>${state.filter === 'unread' ? 'There are no unread notifications.' : 'New messages and system events will appear here.'}</small>
        </div>`;
    } else {
      list.innerHTML = rows.map(n => `
        <button class="notification-row ${n.read ? 'read' : 'unread'}" data-id="${escAttr(n._id || n.id || '')}" type="button">
          <span class="notification-icon">${iconFor(n.type)}</span>
          <span class="notification-copy">
            <strong>${esc(n.title || 'Personal Bot')}</strong>
            <span>${esc(n.body || '')}</span>
            <small>${esc(formatTime(n.createdAt))}</small>
          </span>
          <span class="notification-dot" aria-hidden="true"></span>
        </button>`).join('');

      list.querySelectorAll('.notification-row').forEach(row => {
        row.addEventListener('click', () => activate(row.dataset.id));
      });
    }

    const badge = $('notificationBadge');
    if (badge) {
      badge.hidden = !state.unread;
      badge.textContent = state.unread > 99 ? '99+' : String(state.unread);
    }
    const summary = $('notificationSummary');
    if (summary) {
      summary.textContent = state.unread ? `${state.unread} unread notification${state.unread > 1 ? 's' : ''}` : 'You are all caught up';
    }
  }

  async function load() {
    state.accountId = currentAccount();
    try {
      const d = await api(`/api/notifications?accountId=${encodeURIComponent(state.accountId)}&limit=50`);
      state.items = Array.isArray(d.notifications) ? d.notifications : [];
      state.unread = Number(d.unread || 0);
      render();
    } catch (_) {
      render();
    }
  }

  async function activate(id) {
    const item = state.items.find(n => String(n._id || n.id) === String(id));
    if (!item) return;
    if (!item.read && item._id) {
      await api(`/api/notifications/${encodeURIComponent(item._id)}/read`, { method: 'PATCH' }).catch(() => {});
      item.read = true;
      state.unread = Math.max(0, state.unread - 1);
    }
    render();
    closePanel();
    if (item.url && item.url !== '#') {
      window.location.href = item.url;
    }
  }

  async function clearAll() {
    if (!confirm('Clear all notifications for this account?')) return;
    await api(`/api/notifications?accountId=${encodeURIComponent(currentAccount())}`, { method: 'DELETE' }).catch(() => {});
    state.items = [];
    state.unread = 0;
    render();
    if (toast) toast('Notifications cleared');
  }

  async function markAllRead() {
    await api('/api/notifications/read-all', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: currentAccount() })
    }).catch(() => {});
    state.items.forEach(n => { n.read = true; });
    state.unread = 0;
    render();
    if (toast) toast('All notifications marked as read');
  }

  function browserNotify(n) {
    if (!state.settings.desktop || !('Notification' in window) || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
    try {
      const notification = new Notification(n.title || 'Personal Bot', {
        body: n.body || '',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: `personal-bot-${n._id || Date.now()}`
      });
      notification.onclick = () => {
        window.focus();
        if (n.url) location.href = n.url;
        notification.close();
      };
    } catch (_) {}
  }

  function sound() {
    if (!state.settings.sound) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 720;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.045, ctx.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.17);
    } catch (_) {}
  }

  function showIncoming(n, opts = {}) {
    if (state.settings.inApp) {
      const existing = state.items.find(x => String(x._id || '') === String(n._id || ''));
      if (!existing) state.items.unshift(n);
      if (!n.read) state.unread += 1;
      render();
      if (toast) toast(`${n.title || 'Notification'}${n.body ? ` — ${String(n.body).slice(0, 90)}` : ''}`);
    }
    if (opts.persist !== false) {
      browserNotify(n);
      sound();
    }
  }

  async function requestDesktop() {
    if (!('Notification' in window)) {
      if (toast) toast('Desktop notifications are not supported in this browser.', true);
      return false;
    }
    const p = await Notification.requestPermission();
    if (p === 'granted') {
      state.settings.desktop = true;
      saveSettings();
      if (toast) toast('Desktop notifications enabled');
      return true;
    }
    state.settings.desktop = false;
    saveSettings();
    if (toast) toast('Notification permission was not granted.', true);
    return false;
  }

  async function subscribePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    try {
      const key = await api('/api/notifications/vapid-public-key');
      if (!key.configured || !key.publicKey) return false;
      const registration = await navigator.serviceWorker.ready;
      let sub = await registration.pushManager.getSubscription();
      if (!sub) {
        sub = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64ToUint8Array(key.publicKey)
        });
      }
      await api('/api/notifications/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: sub.toJSON(),
          accountId: currentAccount(),
          deviceLabel: navigator.userAgent.slice(0, 100)
        })
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  function base64ToUint8Array(base64) {
    const padding = '='.repeat((4 - base64.length % 4) % 4);
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function connectSocket() {
    const attach = () => {
      if (!window.io || state.socket) return;
      state.socket = window.io({ transports: ['websocket', 'polling'] });
      state.socket.on('notification', n => {
        if (n.accountId && n.accountId !== currentAccount()) return;
        showIncoming(n);
      });
      state.socket.on('connect', () => load());
    };
    if (window.io) return attach();
    const s = document.createElement('script');
    s.src = '/socket.io/socket.io.js';
    s.async = true;
    s.onload = attach;
    document.head.appendChild(s);
  }

  function exposeSettings() {
    window.PersonalNotifications = {
      state,
      load,
      openPanel,
      closePanel,
      togglePanel,
      requestDesktop,
      subscribePush,
      markAllRead,
      setSetting(key, value) {
        state.settings[key] = !!value;
        saveSettings();
      }
    };
  }

  ensureButton();
  ensureBackdrop();
  ensurePanel();
  exposeSettings();
  connectSocket();
  load();

  document.addEventListener('click', e => {
    if (!state.panelOpen) return;
    const panel = $('notificationPanel');
    const btn = $('notificationBtn');
    if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) {
      closePanel();
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.panelOpen) closePanel();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load();
  });

  window.addEventListener('storage', e => {
    if (e.key === 'waAccountId') {
      state.accountId = currentAccount();
      load();
    }
  });
})();
