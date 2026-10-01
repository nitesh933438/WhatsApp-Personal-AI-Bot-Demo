(() => {
  const { $, api, toast, accountId, setAccount } = App;
  const s = { id:accountId(), accounts:[] };
  function prefs(){ return window.PersonalNotifications?.state?.settings || {inApp:true,desktop:true,sound:true}; }
  function syncPrefs(){ const p=prefs(); if($('notifyInApp'))$('notifyInApp').checked=p.inApp!==false; if($('notifyDesktop'))$('notifyDesktop').checked=p.desktop!==false; if($('notifySound'))$('notifySound').checked=p.sound!==false; }
  async function load(){
    s.accounts=await App.accounts(); if(!s.accounts.length)s.accounts=[{accountId:'default',name:'WhatsApp default'}]; if(!s.accounts.some(a=>a.accountId===s.id))s.id=s.accounts[0].accountId; setAccount(s.id);
    App.setupAccountSelect($('accountSelect'),s.accounts,s.id,async()=>{s.id=$('accountSelect').value;setAccount(s.id);await load()}); $('accountSelect').value=s.id;
    const a=s.accounts.find(x=>x.accountId===s.id)||s.accounts[0]; $('sideAccount').textContent=a.name||s.id; $('autoReply').checked=a.autoReply!==false; $('awayEnabled').checked=!!a.awayEnabled; $('awayMessage').value=a.awayMessage||'I am away right now. I will get back to you soon.'; $('min').value=a.defaultReplyDelayMin??0; $('max').value=a.defaultReplyDelayMax??2; updatePermission(); syncPrefs(); if($('notifyPush'))$('notifyPush').checked=a.pushEnabled!==false;
    if($('pushStatus'))$('pushStatus').textContent=('serviceWorker' in navigator&&'PushManager' in window)?'Background push is supported. It activates when VAPID keys are configured.':'Background push is not supported by this browser.';
  }
  function updatePermission(){ $('permission').textContent='Permission: '+(('Notification'in window)?Notification.permission:'Not supported by this browser'); }
  async function save(){
    const min=Number($('min').value),max=Number($('max').value); if(!Number.isFinite(min)||!Number.isFinite(max)||min<0||max<0||min>120||max>120||min>max){toast('Minimum delay cannot be greater than maximum.',true);return}
    try{await api('/api/whatsapp/accounts/'+encodeURIComponent(s.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoReply:$('autoReply').checked,awayEnabled:$('awayEnabled').checked,awayMessage:$('awayMessage').value.trim(),defaultReplyDelayMin:min,defaultReplyDelayMax:max,notificationsEnabled:true,pushEnabled:$('notifyPush')?.checked!==false})});toast('Settings saved');await load()}catch(e){toast(e.message,true)}
  }
  $('save').onclick=save;
  $('connect').onclick=async()=>{try{await api('/api/whatsapp/accounts/'+encodeURIComponent(s.id)+'/reconnect',{method:'POST'});toast('Connection started. Open Home to scan the QR.')}catch(e){toast(e.message,true)}};
  $('stop').onclick=async()=>{try{await api('/api/whatsapp/accounts/'+encodeURIComponent(s.id)+'/disconnect',{method:'POST'});toast('WhatsApp disconnected');await load()}catch(e){toast(e.message,true)}};
  $('enable').onclick=async()=>{if(!('Notification'in window)){toast('Notifications are not supported.',true);return}const ok=await window.PersonalNotifications?.requestDesktop?.();updatePermission();if(ok)await window.PersonalNotifications?.subscribePush?.();};
  $('themeAlt').onclick=()=>$('themeBtn').click();
  $('saveNotificationPrefs')?.addEventListener('click',async()=>{const n=window.PersonalNotifications;if(!n){toast('Notification center is still loading. Try again.',true);return}n.setSetting('inApp',$('notifyInApp').checked);n.setSetting('desktop',$('notifyDesktop').checked);n.setSetting('sound',$('notifySound').checked);try{await api('/api/whatsapp/accounts/'+encodeURIComponent(s.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({pushEnabled:$('notifyPush').checked})});toast('Notification preferences saved');if($('notifyPush').checked)await n.subscribePush();}catch(e){toast(e.message,true)}});
  $('testNotification')?.addEventListener('click',()=>{document.querySelector('#notificationTest')?.click();});
  load().catch(e=>toast(e.message,true));
})();
