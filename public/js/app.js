(() => {
  const $ = id => document.getElementById(id);
  // API authentication handles protected requests. Avoid a redirect
  // based only on localStorage when a valid HttpOnly cookie may exist.
  // Register the local PWA service worker. It never proxies API/Socket.IO traffic.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }
  if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark');
  const theme = $('themeBtn');
  const syncTheme = () => { if (theme) theme.textContent = document.body.classList.contains('dark') ? '☀' : '☾'; };
  syncTheme();
  theme?.addEventListener('click', () => { document.body.classList.toggle('dark'); localStorage.setItem('theme', document.body.classList.contains('dark') ? 'dark' : 'light'); syncTheme(); });

  const sidebar = $('sidebar'), backdrop = $('backdrop'), menu = $('menuBtn');
  const closeMenu = () => { sidebar?.classList.remove('open'); backdrop?.classList.remove('open'); };
  menu?.addEventListener('click', () => { sidebar?.classList.toggle('open'); backdrop?.classList.toggle('open'); });
  backdrop?.addEventListener('click', closeMenu);
  sidebar?.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMenu));
  window.addEventListener('pageshow', closeMenu);
  window.addEventListener('orientationchange', () => setTimeout(() => window.dispatchEvent(new Event('resize')), 120));

  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) {}
    localStorage.removeItem('token');
    location.href = '/';
  }
  $('logoutBtn')?.addEventListener('click', logout);
  $('logoutLink')?.addEventListener('click', e => { e.preventDefault(); logout(); });

  if (!window.__personalBotFetch) {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? new URL(input, location.origin) : new URL(input.url, location.origin);
      const same = url.origin === location.origin;
      const currentToken = localStorage.getItem('token');
      if (same) {
        const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
        if (currentToken && !headers.has('Authorization')) {
          headers.set('Authorization', `Bearer ${currentToken}`);
        }
        // Include the HttpOnly login cookie on same-origin requests.
        init = { ...init, headers, credentials: 'same-origin' };
      }
      const response = await nativeFetch(input, init);
      if (response.status === 401 && same && !location.pathname.startsWith('/login') && !location.pathname.endsWith('/login.html')) {
        localStorage.removeItem('token'); location.replace('/login');
      }
      return response;
    };
    window.__personalBotFetch = true;
  }

  window.App = {
    $,
    esc(value) { return String(value ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); },
    async api(url, options = {}) {
      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({ success:false, message:'Invalid server response' }));
      if (!res.ok || data.success === false && res.status >= 400) throw new Error(data.message || `Request failed (${res.status})`);
      return data;
    },
    toast(message, error = false) {
      document.querySelector('.toast')?.remove();
      const el = document.createElement('div'); el.className = `toast${error ? ' error' : ''}`; el.textContent = message;
      document.body.appendChild(el); setTimeout(() => el.remove(), 3000);
    },
    accountId() { return localStorage.getItem('waAccountId') || 'default'; },
    setAccount(id) { localStorage.setItem('waAccountId', id); },
    async accounts() { const d = await App.api('/api/whatsapp/accounts'); return d.accounts || []; },
    setupAccountSelect(select, accounts, selected, onChange) {
      select.innerHTML = accounts.map(a => `<option value="${App.esc(a.accountId)}">${App.esc(a.name || a.accountId)}</option>`).join('') || '<option value="default">WhatsApp default</option>';
      select.value = selected;
      select.onchange = async () => { App.setAccount(select.value); if (onChange) await onChange(select.value); };
    }
  };
  if (!location.pathname.endsWith('/login.html') && location.pathname !== '/') {
    const loadInstall = () => {
      if (document.querySelector('script[data-install-app]')) return;
      const script = document.createElement('script');
      script.src = '/js/install.js'; script.async = true; script.dataset.installApp = 'true';
      document.body.appendChild(script);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadInstall, { once:true });
    else loadInstall();

    const loadNotifications = () => {
      if (document.querySelector('script[data-notification-center]')) return;
      const script = document.createElement('script');
      script.src = '/js/notifications.js'; script.async = true; script.dataset.notificationCenter = 'true';
      document.body.appendChild(script);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadNotifications, { once:true });
    else loadNotifications();
  }

})();
