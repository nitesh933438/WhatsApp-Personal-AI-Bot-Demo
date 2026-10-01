(() => {
  const { $, api, esc, toast, accountId } = window.App || {};
  if (!$ || !api) return;
  const state = { id: accountId(), items: [], filter: 'all' };
  const list = $('pageNotificationList');
  const fmt = v => { const d = new Date(v); if (Number.isNaN(d.getTime())) return ''; return d.toLocaleString([], { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }); };
  const icon = t => ({message:'💬', ai_reply:'🤖', account:'📱', error:'⚠️', system:'🔔'})[t] || '🔔';
  const currentAccount = () => state.id || accountId();
  function render() {
    const rows = state.items.filter(n => state.filter === 'all' || !n.read);
    $('statTotal').textContent = String(state.items.length);
    $('statUnread').textContent = String(state.items.filter(n => !n.read).length);
    $('statAccount').textContent = currentAccount();
    if (!rows.length) { list.innerHTML = `<div class="notification-empty"><span>${state.filter === 'unread' ? '✓' : '◌'}</span><strong>${state.filter === 'unread' ? 'All caught up' : 'No notifications yet'}</strong><small>${state.filter === 'unread' ? 'There are no unread notifications.' : 'New WhatsApp and system activity will appear here.'}</small></div>`; return; }
    list.innerHTML = rows.map(n => `<button class="notification-page-row ${n.read?'read':'unread'}" data-id="${esc(String(n._id||''))}" type="button"><span class="notification-icon">${icon(n.type)}</span><span class="notification-copy"><strong>${esc(n.title||'Personal Bot')}</strong><span>${esc(n.body||'')}</span><small>${esc(fmt(n.createdAt))}</small></span><span class="notification-dot"></span></button>`).join('');
    list.querySelectorAll('.notification-page-row').forEach(row => row.addEventListener('click', () => open(row.dataset.id)));
  }
  async function load() { try { const d = await api(`/api/notifications?accountId=${encodeURIComponent(currentAccount())}&limit=100`); state.items = Array.isArray(d.notifications) ? d.notifications : []; render(); } catch(e) { list.innerHTML = '<div class="empty">Could not load notifications.</div>'; } }
  async function open(id) { const n = state.items.find(x => String(x._id) === String(id)); if (!n) return; if (!n.read) { await api(`/api/notifications/${encodeURIComponent(id)}/read`, {method:'PATCH'}).catch(()=>{}); n.read=true; render(); } if (n.url && n.url !== '#') location.href=n.url; }
  async function markAll() { await api('/api/notifications/read-all',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:currentAccount()})}).catch(()=>{}); state.items.forEach(n=>n.read=true); render(); toast('All notifications marked as read'); }
  async function clearAll() { if (!confirm('Clear all notifications for this account?')) return; await api(`/api/notifications?accountId=${encodeURIComponent(currentAccount())}`,{method:'DELETE'}).catch(()=>{}); state.items=[]; render(); toast('Notifications cleared'); }
  document.querySelectorAll('.notification-page-filters .notification-filter').forEach(btn => btn.addEventListener('click',()=>{document.querySelectorAll('.notification-page-filters .notification-filter').forEach(x=>x.classList.remove('active'));btn.classList.add('active');state.filter=btn.dataset.filter;render();}));
  $('pageMarkAll')?.addEventListener('click',markAll); $('pageClear')?.addEventListener('click',clearAll);
  window.addEventListener('storage',e=>{if(e.key==='waAccountId'){state.id=currentAccount();load();}});
  if (window.io) { const socket=window.io({transports:['websocket','polling']}); socket.on('notification',n=>{if(n.accountId&&n.accountId!==currentAccount())return; if(!state.items.some(x=>String(x._id)===String(n._id))) state.items.unshift(n); render(); }); }
  load();
})();
