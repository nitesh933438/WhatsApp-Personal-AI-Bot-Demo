const express = require('express');
const router = express.Router();
const { initializeWhatsApp, requestPairingCode, getClient, getStatus, getRuntimeQR, listAccounts, disconnectWhatsApp, normalizeId, reconnectWhatsApp, resetWhatsAppPairing } = require('../services/whatsappService');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const audit = require('../utils/auditLog');

router.get('/', async (_req,res)=>{ const started=Date.now(); try { const accounts = await listAccounts(); res.set('Cache-Control','no-store'); res.set('X-Accounts-Response-Ms', String(Date.now()-started)); return res.status(200).json({success:true, accounts}); } catch(e){ console.error('Accounts GET failed:', e); return res.status(200).json({success:true,accounts:[{accountId:'default',name:'WhatsApp default',runtimeStatus:'offline'}],degraded:true,message:'Account state temporarily unavailable'}); } });
router.post('/', async (req,res)=>{
  try {
    const rawId=String(req.body?.accountId||'').trim(); const accountId=normalizeId(rawId); const name=String(req.body?.name||`WhatsApp ${accountId}`).trim().slice(0,80);
    if(!rawId || accountId==='default' && rawId!=='default') return res.status(400).json({success:false,message:'Valid accountId is required'});
    const account=await WhatsAppAccount.findOneAndUpdate({accountId},{$set:{name}},{upsert:true,returnDocument:'after',setDefaultsOnInsert:true}).lean();
    initializeWhatsApp(accountId,{name});
    audit('account_created',{accountId,username:req.user?.username});
    res.json({success:true,account});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

router.get('/:accountId/qr.svg', async (req,res)=>{
  try {
    const id = normalizeId(req.params.accountId);
    const account = await WhatsAppAccount.findOne({accountId:id}).lean();
    const qr = String(account?.qr || getRuntimeQR(id) || '');
    if (!qr) return res.status(404).type('text/plain').send('QR not available');
    const QRCode = require('../utils/qrcode');
    const QRErrorCorrectLevel = require('../utils/qrcode/QRErrorCorrectLevel');
    const code = new QRCode(-1, QRErrorCorrectLevel.M);
    code.addData(qr);
    code.make();
    const count = code.getModuleCount();
    const quiet = 4;
    const cell = 8;
    const size = (count + quiet * 2) * cell;
    let rects = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (code.modules[row][col]) {
          rects += `<rect x="${(col+quiet)*cell}" y="${(row+quiet)*cell}" width="${cell}" height="${cell}"/>`;
        }
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, max-age=0');
    res.type('image/svg+xml').send(svg);
  } catch (e) {
    res.status(500).type('text/plain').send('QR generation failed');
  }
});
router.post('/:accountId/connect', async (req,res)=>{
  try {
    const id=normalizeId(req.params.accountId);
    const name=String(req.body?.name || `WhatsApp ${id}`).trim().slice(0,80);
    await WhatsAppAccount.findOneAndUpdate({accountId:id},{$setOnInsert:{accountId:id,name}},{upsert:true,setDefaultsOnInsert:true,maxTimeMS:3000}).lean().catch(err=>console.warn('Connect account DB write skipped:',err.message));
    res.status(202).json({success:true,accountId:id,status:'connecting'});
    setImmediate(async ()=>{
      try {
        await reconnectWhatsApp(id);
      } catch(err) {
        console.error(`Connect initialization failed [${id}]:`,err);
      }
    });
  } catch(e){ res.status(500).json({success:false,message:e.message}); }
});
router.post('/:accountId/pairing-code', async (req,res)=>{
  try {
    const id = normalizeId(req.params.accountId);
    const phone = String(req.body?.phoneNumber || '').trim();
    const result = await requestPairingCode(id, phone);
    audit('account_pairing_code_requested', { accountId: id, username: req.user?.username });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Could not create pairing code.' });
  }
});
router.post('/:accountId/reconnect', async (req,res)=>{
  try {
    const result = await reconnectWhatsApp(req.params.accountId);
    audit('account_reconnect_started',{accountId:normalizeId(req.params.accountId),username:req.user?.username});
    res.json({success:true,...result});
  } catch(e){
    res.status(500).json({success:false,message:e.message});
  }
});
router.post('/:accountId/disconnect', async (req,res)=>{ try { await disconnectWhatsApp(req.params.accountId); audit('account_disconnected',{accountId:normalizeId(req.params.accountId),username:req.user?.username}); res.json({success:true}); } catch(e){res.status(500).json({success:false,message:e.message});} });
router.post('/:accountId/reset-pairing', async (req,res)=>{ try { const result=await resetWhatsAppPairing(req.params.accountId); audit('account_pairing_reset',{accountId:result.accountId,username:req.user?.username}); res.json({success:true,...result}); } catch(e){res.status(500).json({success:false,message:e.message});} });
router.delete('/:accountId', async (req,res)=>{ try { const id=normalizeId(req.params.accountId); await disconnectWhatsApp(id); const deleted=await WhatsAppAccount.findOneAndDelete({accountId:id}); if(!deleted) return res.status(404).json({success:false,message:'Account not found'}); audit('account_deleted',{accountId:id,username:req.user?.username}); res.json({success:true}); } catch(e){res.status(500).json({success:false,message:e.message});} });
router.patch('/:accountId', async (req,res)=>{ try { const id=normalizeId(req.params.accountId); const allowed={name:String(req.body?.name||'').trim().slice(0,80),autoReply:typeof req.body?.autoReply==='boolean'?req.body.autoReply:undefined,awayEnabled:typeof req.body?.awayEnabled==='boolean'?req.body.awayEnabled:undefined,awayMessage:typeof req.body?.awayMessage==='string'?req.body.awayMessage.trim().slice(0,500):undefined,awayStart:typeof req.body?.awayStart==='string'?req.body.awayStart:undefined,awayEnd:typeof req.body?.awayEnd==='string'?req.body.awayEnd:undefined,defaultReplyDelayMin:Number.isFinite(Number(req.body?.defaultReplyDelayMin))?Math.max(0,Math.min(120,Number(req.body.defaultReplyDelayMin))):undefined,defaultReplyDelayMax:Number.isFinite(Number(req.body?.defaultReplyDelayMax))?Math.max(0,Math.min(120,Number(req.body.defaultReplyDelayMax))):undefined,notificationsEnabled:typeof req.body?.notificationsEnabled==='boolean'?req.body.notificationsEnabled:undefined,pushEnabled:typeof req.body?.pushEnabled==='boolean'?req.body.pushEnabled:undefined}; Object.keys(allowed).forEach(k=>allowed[k]===undefined&&delete allowed[k]); const account=await WhatsAppAccount.findOneAndUpdate({accountId:id},{$set:allowed},{returnDocument:'after',upsert:true,setDefaultsOnInsert:true}).lean(); res.json({success:true,account}); } catch(e){res.status(500).json({success:false,message:e.message});} });
module.exports=router;
