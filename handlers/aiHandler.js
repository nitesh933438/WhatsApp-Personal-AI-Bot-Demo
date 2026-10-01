async function handleAI(message, getAIReply) {
  const question = message.body || "";
  return getAIReply(question, message.from);
}

module.exports = { handleAI };
