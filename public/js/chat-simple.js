(() => {
  const { $, esc, api, toast, accountId, setAccount } = App;
  const socket = window.io ? window.io({ transports:['websocket','polling'] }) : null;
  const params = new URLSearchParams(location.search);
  const state = { accounts:[], id:params.get('accountId')||accountId(), users:[], current:params.get('number')||'', tab:'all' };
  const messageCacheKey = number => `chatMessages:${state.id}:${number}`;
  function readCachedMessages(number){ try { const x=JSON.parse(localStorage.getItem(messageCacheKey(number))||'[]'); return Array.isArray(x)?x.slice(-100):[]; } catch(_){ return []; } }
  function cacheMessage(number,m){ if(!number||!m||m.status==='sending') return; try { const key=messageCacheKey(number); const arr=readCachedMessages(number); const id=String(m.messageId||m.id||`${m.sender||''}:${m.createdAt||m.time||''}:${m.message||''}`); if(arr.some(x=>String(x.messageId||x.id||'')===id)) return; arr.push({...m,createdAt:m.createdAt||m.time||new Date().toISOString()}); localStorage.setItem(key,JSON.stringify(arr.slice(-100))); } catch(_){} }
  function cacheMessages(number,arr){ try { localStorage.setItem(messageCacheKey(number),JSON.stringify((arr||[]).slice(-100))); } catch(_){} }
  const items=$('chatItems'), messages=$('messages'), input=$('input'), file=$('file'), app=$('chatApp');
  const fmtTime = value => { const d=new Date(value); return Number.isNaN(d.getTime())?'':d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); };
  async function loadAccounts(){state.accounts=await App.accounts();if(!state.accounts.length)state.accounts=[{accountId:'default',name:'WhatsApp default'}];if(!state.accounts.some(a=>a.accountId===state.id))state.id=state.accounts[0].accountId;setAccount(state.id);App.setupAccountSelect($('accountSelect'),state.accounts,state.id,async()=>{state.current='';app.classList.remove('chat-open');await loadUsers();});$('accountSelect').value=state.id;$('sideAccount').textContent=state.accounts.find(a=>a.accountId===state.id)?.name||state.id;}
  async function loadUsers(){
    const cacheKey='chatUsers:'+state.id;
    try{
      const d=await api('/api/chat/?accountId='+encodeURIComponent(state.id));
      const incoming=Array.isArray(d.users)?d.users:[];
      if(incoming.length||!state.users.length){
        state.users=incoming;
        try{localStorage.setItem(cacheKey,JSON.stringify(state.users.slice(0,100)))}catch(_){}
      }
      renderUsers();
      if(state.current && state.users.some(u=>u.number===state.current)) {
        await openChat(state.current);
      } else if(!state.current && state.users.length && window.matchMedia('(min-width: 721px)').matches) {
        await openChat(state.users[0].number);
      }
    }catch(e){
      if(!state.users.length){try{const cached=JSON.parse(localStorage.getItem(cacheKey)||'[]');if(Array.isArray(cached))state.users=cached;}catch(_){}}
      renderUsers();
      if(state.users.length && !state.current && window.matchMedia('(min-width: 721px)').matches) await openChat(state.users[0].number);
      else if(!state.users.length) toast(e.message,true);
    }
  }
  function renderUsers(){const q=$('search').value.trim().toLowerCase();let list=state.users.filter(u=>{const ok=(u.name||u.number||'').toLowerCase().includes(q)||(u.lastMessage||'').toLowerCase().includes(q);return ok && (state.tab==='all'||Number(u.unread||0)>0)});items.innerHTML=list.map(u=>`<div class="chat-item ${state.current===u.number?'active':''}" data-number="${esc(u.number)}"><span class="avatar">${esc((u.name||u.number||'?').slice(0,1).toUpperCase())}</span><span class="list-main"><strong>${esc(u.name||u.number||'Unknown')}</strong><small>${esc(u.lastMessage||'')}</small></span><span class="time">${fmtTime(u.updatedAt)}</span></div>`).join('')||'<div class="empty">No chats found.</div>';}
  async function openChat(number){state.current=number;const u=state.users.find(x=>x.number===number)||{};$('chatName').textContent=u.name||number;$('chatStatus').textContent=number; $('chatAvatar').textContent=(u.name||number||'?').slice(0,1).toUpperCase();input.disabled=false;app.classList.add('chat-open');renderUsers();messages.innerHTML='<div class="empty">Loading messages…</div>';try{const d=await api('/api/chat/'+encodeURIComponent(number)+'?accountId='+encodeURIComponent(state.id));const chats=Array.isArray(d.chats)?d.chats:[];const cached=readCachedMessages(number);const rows=chats.length?chats:cached;messages.innerHTML='';rows.forEach(addMessage);if(chats.length) cacheMessages(number,chats);if(!rows.length) messages.innerHTML='<div class="chat-empty"><div><strong>No messages yet</strong><div>Send the first message.</div></div></div>';scrollBottom();await api('/api/chat/'+encodeURIComponent(number)+'/read?accountId='+encodeURIComponent(state.id),{method:'PATCH'}).catch(()=>{});}catch(e){const cached=readCachedMessages(number);messages.innerHTML='';cached.forEach(addMessage);if(!cached.length) messages.innerHTML='<div class="empty">Could not load messages.</div>';else toast('Showing saved local chat history while the server reconnects.',true)}}
  function addMessage(m){
    const div=document.createElement('div');
    const outgoing = m.sender !== 'user';
    div.className='bubble '+(outgoing?'out':'in');
    if(m.deleted) div.textContent='This message was deleted';
    else if(m.messageType==='image'&&m.mediaUrl){
      div.innerHTML=`<img src="${esc(m.mediaUrl)}" style="max-width:min(360px,100%);border-radius:10px;display:block"><small>${esc(fmtTime(m.createdAt||m.time))}</small>`;
    } else {
      div.innerHTML=`<div>${esc(m.message||'')}</div><small>${esc(fmtTime(m.createdAt||m.time))}${outgoing?' • '+(m.status||'sent'):''}</small>`;
    }
    messages.appendChild(div);
    cacheMessage(state.current,m);
  }
  function scrollBottom(){messages.scrollTop=messages.scrollHeight;}
  items.addEventListener('click',e=>{const row=e.target.closest('.chat-item');if(row)openChat(row.dataset.number)});$('search').addEventListener('input',renderUsers);document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.tab=b.dataset.tab;renderUsers()}));$('backBtn').onclick=()=>app.classList.remove('chat-open');$('fileBtn').onclick=()=>file.click();
  file.onchange=()=>{if(file.files[0])toast(`Attached: ${file.files[0].name}`)};
  $('composer').onsubmit=async e=>{e.preventDefault();if(!state.current)return;const text=input.value.trim(),f=file.files[0];if(!text&&!f)return;input.value='';const temp={sender:'admin',message:text||f.name,createdAt:new Date().toISOString(),status:'sending',messageType:'text'};addMessage(temp);scrollBottom();const fd=new FormData();fd.append('number',state.current);fd.append('accountId',state.id);if(text)fd.append('message',text);if(f)fd.append('file',f);file.value='';try{const d=await fetch('/send',{method:'POST',body:fd});const r=await d.json();if(!d.ok||!r.success)throw Error(r.message||'Message could not be sent');const pending=[...messages.querySelectorAll('.bubble.out')].findLast(el=>el.querySelector('small')?.textContent.includes('sending'));if(pending)pending.remove();toast('Message sent');}catch(err){toast(err.message,true)}};
  socket?.on('newMessage',m=>{if(m.accountId!==state.id)return;let u=state.users.find(x=>x.number===m.number);if(!u){u={number:m.number,name:m.name||m.number,lastMessage:m.message,updatedAt:m.time,unread:1};state.users.unshift(u)}else{u.lastMessage=m.message;u.updatedAt=m.time;if(state.current!==m.number)u.unread=(u.unread||0)+1}renderUsers();if(state.current===m.number){addMessage(m);scrollBottom();}});socket?.on('botReply',m=>{if(m.accountId!==state.id)return;let u=state.users.find(x=>x.number===m.number);if(!u){u={number:m.number,name:m.name||m.number,lastMessage:m.message,updatedAt:m.time,unread:0};state.users.unshift(u)}else{u.lastMessage=m.message;u.updatedAt=m.time}renderUsers();if(state.current===m.number){addMessage(m);scrollBottom();}});socket?.on('messageSent',m=>{if(m.accountId!==state.id)return;let u=state.users.find(x=>x.number===m.number);if(!u){u={number:m.number,name:m.name||m.number,lastMessage:m.message,updatedAt:m.time,unread:0};state.users.unshift(u)}else{u.lastMessage=m.message;u.updatedAt=m.time}renderUsers();if(state.current===m.number){addMessage(m);scrollBottom();}});
  (async()=>{try{await loadAccounts();await loadUsers();}catch(e){toast(e.message,true)}})();
})();
