(() => {
  const { $, esc, api, toast, accountId, setAccount } = App;
  const socket = window.io ? window.io({ transports: ['websocket', 'polling'] }) : null;
  const state = { accounts: [], id: accountId(), poll: null, qrVersion: 0 };
  const els = {
    select: $('accountSelect'),
    status: $('status'),
    dot: $('dot'),
    error: $('errorBox'),
    recent: $('recent'),
    overlay: $('connectOverlay'),
    modalStatus: $('modalStatus'),
    modalMessage: $('modalMessage'),
    qrArea: $('qrArea'),
    phoneArea: $('phoneArea'),
    qr: $('qr'),
    title: $('connectTitle'),
    settings: $('settingsOverlay')
  };

  const statusText = s => ({
    online: 'Connected',
    qr: 'Waiting for QR',
    pairing: 'Enter pairing code in WhatsApp',
    connecting: 'Connecting…',
    loading: 'Loading WhatsApp…',
    authenticating: 'Connecting to WhatsApp…',
    offline: 'Not connected',
    disconnected: 'Disconnected',
    error: 'Needs attention'
  }[s] || 'Checking…');

  async function paintAIStatus() {
    try {
      const d = await api('/api/ai/status');
      const el = $('aiStatus');
      if (el) el.textContent = d.configured ? 'AI: ready' : 'AI: no provider configured';
    } catch (_) {
      const el = $('aiStatus');
      if (el) el.textContent = 'AI: status unavailable';
    }
  }

  function paintStatus(a) {
    const s = String(a?.runtimeStatus || a?.status || 'offline').toLowerCase();
    els.status.textContent = statusText(s);
    els.dot.className = 'dot ' + (s === 'online' ? 'online' : ['qr', 'pairing', 'connecting', 'loading', 'authenticating'].includes(s) ? 'busy' : ['error', 'disconnected'].includes(s) ? 'bad' : '');
    if (a?.lastError && s === 'error') {
      els.error.style.display = 'block';
      els.error.textContent = a.lastError;
    } else {
      els.error.style.display = 'none';
    }
    if (state.id === a?.accountId) $('sideAccount').textContent = a?.name || state.id;
    return s;
  }

  async function loadAccounts() {
    paintAIStatus();
    state.accounts = await App.accounts();
    if (!state.accounts.length) {
      state.accounts = [{ accountId: 'default', name: 'WhatsApp default', runtimeStatus: 'offline' }];
    }
    if (!state.accounts.some(a => a.accountId === state.id)) state.id = state.accounts[0].accountId;
    setAccount(state.id);
    App.setupAccountSelect(els.select, state.accounts, state.id, async id => {
      state.id = id;
      await loadAccounts();
    });
    const a = state.accounts.find(x => x.accountId === state.id) || state.accounts[0];
    els.select.value = state.id;
    paintStatus(a);
    await loadRecent();
    if (els.overlay.classList.contains('open')) paintModal(a);
  }

  async function loadRecent() {
    try {
      const d = await api('/api/chat/?accountId=' + encodeURIComponent(state.id));
      const users = d.users || [];
      els.recent.innerHTML = users.slice(0, 8).map(u => `<a class="list-row" href="/chat?accountId=${encodeURIComponent(state.id)}&number=${encodeURIComponent(u.number || '')}"><span class="avatar">${esc((u.name || u.number || '?').slice(0, 1).toUpperCase())}</span><span class="list-main"><strong>${esc(u.name || u.number || 'Unknown')}</strong><small>${esc(u.lastMessage || '')}</small></span><span class="card-sub">Open</span></a>`).join('') || '<div class="empty">No chats yet.</div>';
    } catch (e) {
      els.recent.innerHTML = '<div class="empty">No chats available yet.</div>';
    }
  }

  function paintModal(a) {
    const s = paintStatus(a);
    els.title.textContent = a?.name || state.id;
    els.modalStatus.textContent = statusText(s);
    els.modalMessage.textContent = s === 'qr' ? 'Scan the QR code with WhatsApp.' : s === 'online' ? 'WhatsApp is connected.' : s === 'loading' ? (a?.progress || 'Loading WhatsApp…') : s === 'authenticating' ? (a?.progress || 'Connecting to WhatsApp…') : s === 'pairing' ? 'Enter the code in WhatsApp → Linked devices → Link with phone number.' : a?.lastError || 'Starting WhatsApp…';
    
    if (s === 'qr' && (a?.qr || a?.runtimeStatus === 'qr')) {
      els.qrArea.style.display = 'block';
      const src = `/api/whatsapp/accounts/${encodeURIComponent(state.id)}/qr.svg?v=${++state.qrVersion}`;
      els.qr.src = src;
    } else {
      els.qrArea.style.display = 'none';
    }

    if (s === 'pairing' && a?.pairingCode) {
      $('pairCodeArea').style.display = 'block';
      $('pairCode').textContent = a.pairingCode;
    }
    if (s !== 'pairing') {
      $('pairCodeArea').style.display = 'none';
    }
    if (s === 'online') {
      setTimeout(closeConnect, 800);
    }
  }

  function openConnect() {
    els.overlay.classList.add('open');
    if (!state.poll) {
      state.poll = setInterval(() => {
        if (els.overlay.classList.contains('open')) refreshModal().catch(() => {});
      }, 1500);
    }
  }

  function closeConnect() {
    els.overlay.classList.remove('open');
    if (state.poll) {
      clearInterval(state.poll);
      state.poll = null;
    }
  }

  async function refreshModal() {
    try {
      state.accounts = await App.accounts();
      const a = state.accounts.find(x => x.accountId === state.id);
      if (a) paintModal(a);
    } catch (e) {
      els.modalMessage.textContent = e.message;
    }
  }

  async function start(kind) {
    openConnect();
    els.modalStatus.textContent = kind === 'disconnect' ? 'Disconnecting…' : 'Connecting…';
    els.modalMessage.textContent = 'Starting connection. QR code will appear in a moment…';
    try {
      await api(`/api/whatsapp/accounts/${encodeURIComponent(state.id)}/${kind}`, { method: 'POST' });
      toast(kind === 'connect' ? 'WhatsApp connection started' : kind === 'reconnect' ? 'Reconnect started' : 'Disconnected');
      await refreshModal();
    } catch (e) {
      toast(e.message, true);
      els.modalStatus.textContent = 'Could not start';
      els.modalMessage.textContent = e.message;
    }
  }

  $('qrMode').onclick = () => {
    els.qrArea.style.display = 'block';
    els.phoneArea.style.display = 'none';
  };

  $('phoneMode').onclick = () => {
    els.qrArea.style.display = 'none';
    els.phoneArea.style.display = 'block';
  };

  $('getPairCode').onclick = async () => {
    const phone = $('pairPhone').value.trim();
    if (!phone) {
      toast('Enter your WhatsApp number (e.g. 919876543210).', true);
      return;
    }
    const btn = $('getPairCode');
    btn.disabled = true;
    btn.textContent = 'Generating code… (10-15s)';
    $('pairCodeArea').style.display = 'none';
    try {
      const d = await api(`/api/whatsapp/accounts/${encodeURIComponent(state.id)}/pairing-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone })
      });
      $('pairCode').textContent = d.code;
      $('pairCodeArea').style.display = 'block';
      toast('Pairing code generated! Enter it on WhatsApp.');
      await loadAccounts();
    } catch (e) {
      toast(e.message || 'Failed to generate pairing code. Please try again.', true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Get pairing code';
    }
  };

  $('copyPairCode')?.addEventListener('click', () => {
    const code = $('pairCode').textContent.trim();
    if (code) {
      navigator.clipboard.writeText(code.replace(/-/g, '')).catch(() => {});
      toast('Pairing code copied: ' + code);
    }
  });

  $('connect').onclick = () => {
    if ($('phoneArea').style.display === 'block') {
      $('getPairCode').click();
      return;
    }
    $('qrMode').click();
    start('connect');
  };

  $('reconnect').onclick = () => start('reconnect');

  $('disconnect').onclick = async () => {
    try {
      await api(`/api/whatsapp/accounts/${encodeURIComponent(state.id)}/disconnect`, { method: 'POST' });
      toast('WhatsApp disconnected');
      await loadAccounts();
    } catch (e) {
      toast(e.message, true);
    }
  };

  $('resetPairing').onclick = async () => {
    if (!confirm('Reset pairing for this WhatsApp account? The saved WhatsApp session will be removed and a new QR will be required.')) return;
    try {
      await api(`/api/whatsapp/accounts/${encodeURIComponent(state.id)}/reset-pairing`, { method: 'POST' });
      toast('Pairing reset. Starting a new QR…');
      await loadAccounts();
      openConnect();
      await start('connect');
    } catch (e) {
      toast(e.message, true);
    }
  };

  $('refresh').onclick = () => loadAccounts().catch(e => toast(e.message, true));
  $('closeConnect').onclick = closeConnect;
  els.overlay.onclick = e => {
    if (e.target === els.overlay) closeConnect();
  };

  $('addAccount').onclick = async () => {
    const id = prompt('Account ID (example: personal-2)');
    if (!id) return;
    const name = prompt('Account name', id) || id;
    try {
      const d = await api('/api/whatsapp/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: id.trim(), name: name.trim() })
      });
      state.id = d.account.accountId;
      setAccount(state.id);
      await loadAccounts();
      openConnect();
    } catch (e) {
      toast(e.message, true);
    }
  };

  function fillSettings(a) {
    $('name').value = a?.name || state.id;
    $('autoReply').checked = a?.autoReply !== false;
    $('awayEnabled').checked = !!a?.awayEnabled;
    $('awayMessage').value = a?.awayMessage || 'I am away right now. I will get back to you soon.';
    $('min').value = a?.defaultReplyDelayMin ?? 0;
    $('max').value = a?.defaultReplyDelayMax ?? 2;
  }

  $('accountSettings').onclick = () => {
    const a = state.accounts.find(x => x.accountId === state.id);
    fillSettings(a);
    els.settings.classList.add('open');
  };
  $('closeSettings').onclick = () => els.settings.classList.remove('open');
  $('cancelSettings').onclick = () => els.settings.classList.remove('open');
  els.settings.onclick = e => {
    if (e.target === els.settings) els.settings.classList.remove('open');
  };
  $('saveSettings').onclick = async () => {
    const min = Number($('min').value), max = Number($('max').value);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0 || min > 120 || max > 120 || min > max) {
      toast('Check the reply delay values.', true);
      return;
    }
    try {
      await api(`/api/whatsapp/accounts/${encodeURIComponent(state.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('name').value.trim(),
          autoReply: $('autoReply').checked,
          awayEnabled: $('awayEnabled').checked,
          awayMessage: $('awayMessage').value.trim(),
          defaultReplyDelayMin: min,
          defaultReplyDelayMax: max
        })
      });
      toast('Settings saved');
      els.settings.classList.remove('open');
      await loadAccounts();
    } catch (e) {
      toast(e.message, true);
    }
  };

  // Real-time Socket.IO events for instant QR & status updates
  if (socket) {
    socket.on('whatsappQR', ({ accountId }) => {
      if (accountId !== state.id) return;
      els.qrArea.style.display = 'block';
      els.phoneArea.style.display = 'none';
      els.qr.src = `/api/whatsapp/accounts/${encodeURIComponent(state.id)}/qr.svg?v=${++state.qrVersion}`;
      els.modalStatus.textContent = 'Waiting for QR';
      els.modalMessage.textContent = 'Scan the QR code with WhatsApp on your phone.';
      paintStatus({ accountId: state.id, runtimeStatus: 'qr' });
    });

    socket.on('whatsappAccountStatus', data => {
      if (data.accountId !== state.id) return;
      paintStatus(data);
      if (els.overlay.classList.contains('open')) {
        paintModal(data);
      }
    });

    socket.on('whatsappPairingCode', ({ accountId, code }) => {
      if (accountId !== state.id) return;
      $('pairCodeArea').style.display = 'block';
      $('pairCode').textContent = code;
      paintStatus({ accountId: state.id, runtimeStatus: 'pairing' });
    });
  }

  window.addEventListener('beforeunload', () => state.poll && clearInterval(state.poll));
  loadAccounts().catch(e => toast(e.message, true));
})();
