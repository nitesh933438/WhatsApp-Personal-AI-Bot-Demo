const express = require("express");
const router = express.Router();
const PushSubscription = require("../models/PushSubscription");
const Notification = require("../models/Notification");
const { configured } = require("../services/pushService");

router.get("/vapid-public-key", (_req,res)=>res.json({success:true,configured:configured(),publicKey:process.env.VAPID_PUBLIC_KEY||""}));
router.post("/subscribe", async (req,res)=>{
  try {
    const sub=req.body?.subscription;
    if(!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return res.status(400).json({success:false,message:"Invalid push subscription"});
    const accountId=String(req.body?.accountId||"default").trim().slice(0,50)||"default";
    const doc=await PushSubscription.findOneAndUpdate({endpoint:sub.endpoint},{$set:{keys:sub.keys,accountId,deviceLabel:String(req.body?.deviceLabel||"").slice(0,100),lastUsedAt:new Date()}},{upsert:true,returnDocument:'after',setDefaultsOnInsert:true}).lean();
    res.json({success:true,subscriptionId:doc._id});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
router.delete("/subscribe", async (req,res)=>{try{const endpoint=String(req.body?.endpoint||""); if(!endpoint)return res.status(400).json({success:false,message:"Endpoint required"}); await PushSubscription.deleteOne({endpoint}); res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}});
router.get("/", async (req,res)=>{
  try{
    const accountId=String(req.query.accountId||"default");
    const limit=Math.min(100,Math.max(1,Number(req.query.limit)||50));
    let notifications = [];
    let unread = 0;
    try {
      notifications = await Notification.find({accountId}).sort({createdAt:-1}).limit(limit).lean();
      unread = await Notification.countDocuments({accountId,read:false});
    } catch (_) {}
    res.json({success:true,notifications:notifications||[],unread:unread||0});
  }catch(e){
    res.json({success:true,notifications:[],unread:0});
  }
});
router.patch("/:id/read", async (req,res)=>{try{const n=await Notification.findByIdAndUpdate(req.params.id,{$set:{read:true}},{returnDocument:'after'}).lean(); if(!n)return res.status(404).json({success:false,message:"Notification not found"}); res.json({success:true,notification:n});}catch(e){res.status(500).json({success:false,message:e.message});}});
router.delete("/:id", async (req,res)=>{try{const n=await Notification.findByIdAndDelete(req.params.id); if(!n)return res.status(404).json({success:false,message:"Notification not found"}); res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}});
router.delete("/", async (req,res)=>{try{const accountId=String(req.query.accountId||"default"); await Notification.deleteMany({accountId}); res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}});
router.patch("/read-all", async (req,res)=>{try{const accountId=String(req.body?.accountId||"default"); await Notification.updateMany({accountId,read:false},{$set:{read:true}}); res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}});
module.exports=router;
