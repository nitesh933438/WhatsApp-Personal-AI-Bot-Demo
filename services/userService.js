const fs = require('fs');
const path = require('path');
const User = require('../models/User');
const Chat = require('../models/Chat');
const norm=(accountId)=>String(accountId||'default');

// Keep the database intentionally small while preserving enough history for
// the UI and AI context. The AI only reads the recent window, while the
// conversation summary + explicit memories preserve useful long-term context.
const MAX_MESSAGES_PER_CHAT = Math.max(20, Math.min(500, Number(process.env.MAX_MESSAGES_PER_CHAT) || 100));
const pruneJobs = new Map();

async function pruneChatHistory(number, accountId='default') {
  const key = `${norm(accountId)}:${String(number || '')}`;
  if (!number || pruneJobs.has(key)) return pruneJobs.get(key);
  const job = (async () => {
    try {
      const old = await Chat.find({ accountId: norm(accountId), number })
        .sort({ createdAt: -1 })
        .skip(MAX_MESSAGES_PER_CHAT)
        .select('_id mediaUrl')
        .lean();
      if (!old.length) return;

      const ids = old.map(x => x._id);
      await Chat.deleteMany({ _id: { $in: ids } });

      // Uploaded media is not useful after its chat row is removed. Clean the
      // local file too, but never let file cleanup break WhatsApp messaging.
      for (const item of old) {
        const url = String(item.mediaUrl || '');
        if (!url.startsWith('/uploads/chat/')) continue;
        const filename = path.basename(url);
        if (!filename || filename === '.' || filename === '..') continue;
        try { fs.unlinkSync(path.join(__dirname, '../uploads/chat', filename)); } catch (_) {}
      }
    } catch (err) {
      console.warn('Chat retention cleanup skipped:', err?.message || err);
    } finally {
      pruneJobs.delete(key);
    }
  })();
  pruneJobs.set(key, job);
  return job;
}


// Periodic safety-net cleanup. Normally each write prunes its own conversation,
// but this job also catches history that was imported, restored, or written while
// the process was restarting. It never deletes the newest MAX_MESSAGES_PER_CHAT
// messages for a contact.
async function pruneAllChatHistories() {
  if (!Chat.db?.readyState) return { contacts: 0, deleted: 0 };
  let deleted = 0;
  let contacts = 0;
  try {
    const groups = await Chat.aggregate([
      { $group: { _id: { accountId: '$accountId', number: '$number' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: MAX_MESSAGES_PER_CHAT } } }
    ]).allowDiskUse(true);

    for (const group of groups) {
      const accountId = norm(group?._id?.accountId);
      const number = String(group?._id?.number || '');
      if (!number) continue;
      contacts += 1;
      const before = await Chat.countDocuments({ accountId, number });
      await pruneChatHistory(number, accountId);
      const after = await Chat.countDocuments({ accountId, number });
      deleted += Math.max(0, before - after);
    }
  } catch (err) {
    console.warn('Periodic chat retention cleanup skipped:', err?.message || err);
  }
  return { contacts, deleted };
}

async function saveUser(number,name,lastMessage,accountId='default'){
  const cleanName=String(name||'').trim();
  const set={accountId:norm(accountId),number,lastMessage,lastSeen:new Date()};
  if(cleanName && !/^(user|unknown|there)$/i.test(cleanName)) set.name=cleanName;
  return User.findOneAndUpdate({accountId:norm(accountId),number},{ $set:set },{upsert:true,returnDocument:'after',setDefaultsOnInsert:true});
}

async function saveChatHistory(number,sender,message,meta={}){
  const accountId = norm(meta.accountId);
  const text = message || '';
  const row = await Chat.create({
    accountId, number, sender, message:text,
    messageType:meta.messageType||'text', mediaUrl:meta.mediaUrl||'',
    fileName:meta.fileName||'', mimeType:meta.mimeType||'',
    status:meta.status||'sent', messageId:meta.messageId||'', replyTo:meta.replyTo||''
  });
  // Keep the lightweight contact list current for bot/admin messages too.
  // This prevents the chat row from jumping/disappearing after a reply.
  User.findOneAndUpdate(
    { accountId, number },
    { $set: { lastMessage: text, lastSeen: new Date() } },
    { upsert: true, setDefaultsOnInsert: true }
  ).catch(() => {});
  // Retention cleanup runs after the row is safely persisted. It never changes
  // which message was just written and never throws into the WhatsApp path.
  await pruneChatHistory(number, accountId).catch((err) => console.warn('Chat retention cleanup skipped:', err?.message || err));
  return row;
}

async function updateMessageCount(number,accountId='default'){ await User.findOneAndUpdate({accountId:norm(accountId),number},{$inc:{totalMessages:1}}); }
async function updateAIReplyCount(number,accountId='default'){ await User.findOneAndUpdate({accountId:norm(accountId),number},{$inc:{aiReplies:1},$set:{lastSeen:new Date()}}); }
async function getUsers(accountId='default'){ return User.find({accountId:norm(accountId)}).sort({pinned:-1,updatedAt:-1}); }
async function getUser(number,accountId='default'){ return User.findOne({accountId:norm(accountId),number}); }

module.exports={saveUser,saveChatHistory,updateMessageCount,updateAIReplyCount,getUsers,getUser,pruneChatHistory,pruneAllChatHistories,MAX_MESSAGES_PER_CHAT};
