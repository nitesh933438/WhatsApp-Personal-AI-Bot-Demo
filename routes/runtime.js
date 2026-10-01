const express = require('express');
const router = express.Router();
const { startAllAccounts, stopAllAccounts, reconnectWhatsApp, getRuntimeHealth, listAccounts, setEmergencyAutoReplyStop, isEmergencyAutoReplyStopped } = require('../services/whatsappService');
const audit = require('../utils/auditLog');

router.get('/health', async (req,res)=>{
  try { res.json({ success:true, health:getRuntimeHealth(), accounts:await listAccounts(), emergencyAutoReplyStopped:isEmergencyAutoReplyStopped(), time:new Date().toISOString() }); }
  catch(e){ res.status(500).json({success:false,message:e.message}); }
});
router.post('/start-all', async (req,res)=>{ try { const accounts=await startAllAccounts(); audit('start_all',{username:req.user?.username,accounts}); res.json({success:true,accounts,emergencyAutoReplyStopped:isEmergencyAutoReplyStopped()}); } catch(e){res.status(500).json({success:false,message:e.message});} });
router.post('/stop-all', async (req,res)=>{ try { const accounts=await stopAllAccounts(); audit('stop_all',{username:req.user?.username,accounts}); res.json({success:true,accounts}); } catch(e){res.status(500).json({success:false,message:e.message});} });
router.post('/emergency-stop', async (req,res)=>{ setEmergencyAutoReplyStop(true); audit('emergency_auto_reply_stop',{username:req.user?.username}); res.json({success:true,emergencyAutoReplyStopped:true}); });
router.post('/resume-auto-reply', async (req,res)=>{ setEmergencyAutoReplyStop(false); audit('emergency_auto_reply_resume',{username:req.user?.username}); res.json({success:true,emergencyAutoReplyStopped:false}); });
router.post('/:accountId/reconnect', async (req,res)=>{ try { const result=await reconnectWhatsApp(req.params.accountId); audit('account_reconnect',{accountId:result.accountId,username:req.user?.username}); res.json({success:true,...result}); } catch(e){res.status(500).json({success:false,message:e.message});} });
router.get('/:accountId', async (req,res)=>{ try { const id=String(req.params.accountId); res.json({success:true,accountId:id,status:(require('../services/whatsappService').getStatus(id)),health:getRuntimeHealth()}); } catch(e){res.status(500).json({success:false,message:e.message});} });
module.exports=router;
