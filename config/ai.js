module.exports = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  MODEL: process.env.GEMINI_MODEL || "gemini-1.5-flash",
  PROVIDER_ORDER: process.env.AI_PROVIDER_ORDER || "gemini,openai,ollama"
};
