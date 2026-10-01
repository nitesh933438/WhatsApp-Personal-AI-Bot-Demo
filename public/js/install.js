(() => {
  if (window.__personalBotInstall) return;
  window.__personalBotInstall = true;
  const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true || document.referrer.startsWith('android-app://');
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const key = 'personalBotInstallDismissedUntil';
  let deferredPrompt = null;

  const dismissedRecently = () => {
    const until = Number(localStorage.getItem(key) || 0);
    return until > Date.now();
  };
  const dismiss = (days=7) => localStorage.setItem(key, String(Date.now() + days*86400000));

  function addSidebarButton() {
    const nav = document.querySelector('.sidebar .nav');
    if (!nav || nav.querySelector('#installAppNav')) return;
    const a = document.createElement('a');
    a.href = '#'; a.id = 'installAppNav'; a.className = 'install-app-nav';
    a.innerHTML = '<span class="nav-icon">⇩</span><span>Install App</span><span class="install-nav-dot" aria-hidden="true"></span>';
    a.addEventListener('click', e => { e.preventDefault(); openInstall(); });
    const settings = [...nav.querySelectorAll('a')].find(x => /settings/i.test(x.textContent));
    nav.insertBefore(a, settings || null);
  }

  function addBanner() {
    if (document.getElementById('installAppBanner') || isStandalone() || dismissedRecently()) return;
    const banner = document.createElement('section');
    banner.id='installAppBanner'; banner.className='install-banner';
    banner.setAttribute('role','dialog'); banner.setAttribute('aria-label','Install app');
    banner.innerHTML = `
      <div class="install-banner-icon"><img src="/icon-192.png" alt=""></div>
      <div class="install-banner-copy"><strong>Install Personal Bot</strong><span>Get a faster app-like experience with quick access from your device.</span></div>
      <div class="install-banner-actions"><button class="btn" id="installLater" type="button">Later</button><button class="btn primary" id="installNow" type="button">Install App</button></div>
      <button class="install-banner-close" id="installClose" type="button" aria-label="Close">×</button>`;
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add('show'));
    banner.querySelector('#installLater').onclick=()=>{dismiss(7); closeBanner();};
    banner.querySelector('#installClose').onclick=()=>{dismiss(3); closeBanner();};
    banner.querySelector('#installNow').onclick=()=>openInstall();
  }
  function closeBanner(){ const b=document.getElementById('installAppBanner'); if(!b)return; b.classList.remove('show'); setTimeout(()=>b.remove(),220); }

  function iosInstructions() {
    const modal=document.createElement('div'); modal.className='install-overlay'; modal.innerHTML=`<div class="install-modal">
      <div class="install-modal-head"><div><strong>Install Personal Bot</strong><small>Add this app to your Home Screen.</small></div><button class="icon" type="button" aria-label="Close">×</button></div>
      <div class="install-steps"><div><b>1</b><span>Tap the <strong>Share</strong> button in Safari.</span></div><div><b>2</b><span>Select <strong>Add to Home Screen</strong>.</span></div><div><b>3</b><span>Tap <strong>Add</strong> to finish.</span></div></div>
      <button class="btn primary" type="button">Got it</button></div>`;
    document.body.appendChild(modal); requestAnimationFrame(()=>modal.classList.add('show'));
    const close=()=>{modal.classList.remove('show');setTimeout(()=>modal.remove(),180);};
    modal.querySelectorAll('button').forEach(b=>b.addEventListener('click',close));
    modal.addEventListener('click',e=>{if(e.target===modal)close();});
  }

  async function openInstall() {
    if (isStandalone()) { window.App?.toast?.('Personal Bot is already installed.'); return; }
    if (deferredPrompt) {
      try {
        deferredPrompt.prompt();
        const choice=await deferredPrompt.userChoice;
        if(choice?.outcome==='accepted'){ dismiss(3650); closeBanner(); window.App?.toast?.('App installation started.'); }
      } catch (_) {}
      deferredPrompt=null; updateAvailability(); return;
    }
    if (isIOS) { iosInstructions(); return; }
    window.App?.toast?.('If your browser supports installation, use the browser menu and choose “Install app” or “Add to Home Screen”.');
  }

  function updateAvailability(){
    const available=!!deferredPrompt && !isStandalone();
    document.querySelectorAll('#installAppNav').forEach(el=>{el.classList.toggle('available',available);});
    const btn=document.querySelector('#installNow'); if(btn && !available && !isIOS){btn.textContent='Browser menu';}
  }

  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;updateAvailability(); if(!isStandalone()&&!dismissedRecently()) addBanner();});
  window.addEventListener('appinstalled',()=>{deferredPrompt=null;dismiss(3650);closeBanner();document.querySelectorAll('#installAppNav').forEach(el=>el.remove());window.App?.toast?.('Personal Bot installed successfully.');});
  window.addEventListener('pageshow',()=>{if(!isStandalone()) addSidebarButton();});
  document.addEventListener('DOMContentLoaded',()=>{addSidebarButton(); if(isIOS&&!isStandalone()&&!dismissedRecently()) setTimeout(addBanner,900);});
  addSidebarButton();
  if (isIOS&&!isStandalone()&&!dismissedRecently()) setTimeout(addBanner,900);
})();
