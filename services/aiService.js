require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const mongoose = require("mongoose");
const Chat = require("../models/Chat");
const User = require("../models/User");
const AIMemory = require("../models/AIMemory");
const { getTimeGreeting } = require("../utils/greeting");

let model = null;
let geminiModels = new Map();
try {
  if (process.env.GEMINI_API_KEY) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const primaryName = process.env.GEMINI_MODEL || "gemini-1.5-flash";
    const fallbackNames = String(
      process.env.GEMINI_FALLBACK_MODELS || "gemini-2.0-flash,gemini-1.5-pro,gemini-2.0-flash-lite"
    ).split(",").map(x => x.trim()).filter(Boolean);
    const names = [...new Set([primaryName, ...fallbackNames])];
    for (const name of names) {
      geminiModels.set(name, genAI.getGenerativeModel({ model: name }));
    }
    model = geminiModels.get(primaryName);
    console.log(`✅ Gemini AI Loaded (${names.join(", ")})`);
  } else console.log("⚠ GEMINI_API_KEY Missing");
} catch (err) { console.log("❌ Gemini Init Error", err.message); }

// Gemini calls are serialized so several incoming WhatsApp messages do not
// create a burst of parallel requests. A 429 puts the queue into a short
// cooldown instead of immediately hammering the API again.
let geminiQueue = Promise.resolve();
let geminiCooldownUntil = 0;
let geminiDailyQuotaUntil = 0;
const geminiModelDailyQuotaUntil = new Map();

function getAIErrorStatus(err) {
  const status = Number(err?.status || err?.statusCode || err?.response?.status || 0);
  return Number.isFinite(status) ? status : 0;
}

function isRateLimitError(err) {
  const text = String(err?.message || err || "").toLowerCase();
  const status = getAIErrorStatus(err);
  return status === 429 || text.includes("429") || text.includes("too many requests") || text.includes("quota exceeded");
}

function isTransientAIError(err) {
  const text = String(err?.message || err || "").toLowerCase();
  const status = getAIErrorStatus(err);
  return status === 408 || status === 425 || status === 429 ||
    status === 500 || status === 502 || status === 503 || status === 504 ||
    /\b(408|425|429|500|502|503|504)\b/.test(text) ||
    text.includes("service unavailable") ||
    text.includes("temporarily unavailable") ||
    text.includes("high demand") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("fetch failed") ||
    text.includes("econnreset") ||
    text.includes("socket hang up") ||
    text.includes("temporarily overloaded");
}

function isDailyQuotaError(err) {
  const text = String(err?.message || err || "").toLowerCase();
  return text.includes("generaterequestsperdayperproject") ||
    text.includes("generate_requests_per_day") ||
    text.includes("free_tier_requests") && text.includes("perday");
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function enqueueGemini(task) {
  const run = geminiQueue.catch(() => {}).then(async () => {
    const wait = geminiCooldownUntil - Date.now();
    if (wait > 0) await sleep(wait);
    return task();
  });
  geminiQueue = run.catch(() => {});
  return run;
}

async function generateOpenAIContent(prompt) {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) throw new Error('OpenAI is not configured');
  const modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelName,
      temperature: 0.8,
      max_tokens: 500,
      messages: [
        { role: 'system', content: 'You are a natural WhatsApp personal assistant. Answer the current user message directly, naturally and briefly. Match the user language and tone. Use supplied conversation context. Never invent facts.' },
        { role: 'user', content: prompt }
      ]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `OpenAI HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI returned an empty response');
  return text;
}

async function generateOllamaContent(prompt) {
  const baseUrl = String(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  const modelName = String(process.env.OLLAMA_MODEL || "llama3.2:3b").trim();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelName,
      stream: false,
      messages: [
        { role: "system", content: "You are Nitesh sir's personal WhatsApp assistant. Reply like a natural human WhatsApp conversation: understand the current message first, use context only when relevant, match language and tone, be concise, never invent facts, and never use generic filler when a specific response is possible." },
        { role: "user", content: prompt }
      ],
      options: { temperature: 0.8 }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Ollama HTTP ${response.status}`);
  const text = data?.message?.content?.trim();
  if (!text) throw new Error("Ollama returned an empty response");
  return text;
}

function providerOrder() {
  const configured = String(process.env.AI_PROVIDER_ORDER || "gemini,openai,ollama").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  return [...new Set(configured)];
}

async function generateWithProvider(prompt, provider) {
  if (provider === "gemini") {
    const names = [...geminiModels.keys()];
    const errors = [];
    for (const modelName of names) {
      try {
        const result = await generateContent(prompt, {
          retries: Math.max(0, Math.min(2, Number(process.env.GEMINI_MODEL_RETRIES ?? 1))),
          modelName
        });
        const text = result.response.text().trim();
        if (text) return text;
      } catch (err) {
        errors.push(`${modelName}: ${err.message}`);
        // A single Gemini model can be temporarily overloaded while another
        // model is healthy. Never stop the whole Gemini chain on 429/5xx.
        if (isDailyQuotaError(err) || isTransientAIError(err)) continue;
        throw err;
      }
    }
    throw new Error(errors.join(" | ") || "No Gemini model is available");
  }
  if (provider === "openai") return generateOpenAIContent(prompt);
  if (provider === "ollama") return generateOllamaContent(prompt);
  throw new Error(`Unknown AI provider: ${provider}`);
}

async function generateBestAvailableAI(prompt) {
  const errors = [];
  for (const provider of providerOrder()) {
    try {
      if (provider === "gemini" && !model) continue;
      if (provider === "openai" && !String(process.env.OPENAI_API_KEY || "").trim()) continue;
      // Ollama is opt-in. Render does not normally run a local Ollama server,
      // so it must not produce a noisy "fetch failed" error unless explicitly enabled.
      if (provider === "ollama" && String(process.env.OLLAMA_ENABLED || "false").toLowerCase() !== "true") continue;
      const text = await generateWithProvider(prompt, provider);
      if (text) return { text, provider };
    } catch (err) {
      errors.push(`${provider}: ${err.message}`);
      if (provider === "gemini" && isDailyQuotaError(err)) {
        // generateWithProvider already records per-model cooldowns.
      }
    }
  }
  const err = new Error(errors.join(" | ") || "No AI provider is configured or available");
  err.providerErrors = errors;
  throw err;
}

async function generateContent(prompt, options = {}) {
  if (!geminiModels.size && !model) throw new Error("Gemini is not configured");
  const selectedModel = options.modelName ? geminiModels.get(options.modelName) : model;
  if (!selectedModel) throw new Error(`Gemini model not configured: ${options.modelName || "primary"}`);
  const quotaKey = options.modelName || process.env.GEMINI_MODEL || "gemini-1.5-flash";
  const modelQuotaUntil = geminiModelDailyQuotaUntil.get(quotaKey) || 0;
  if (modelQuotaUntil > Date.now()) {
    const err = new Error(`Gemini model ${quotaKey} daily quota cooldown active`);
    err.status = 429;
    err.code = "GEMINI_DAILY_QUOTA";
    throw err;
  }
  // Once Google reports a project/day quota exhaustion, do not queue or retry
  // more requests. This keeps WhatsApp replies fast instead of waiting behind
  // a doomed Gemini request. The cooldown is intentionally short-lived; the
  // API will be re-attempted after it expires.
  const retries = Math.max(0, Math.min(3, Number(options.retries ?? 2)));
  return enqueueGemini(async () => {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await selectedModel.generateContent(prompt);
        geminiCooldownUntil = 0;
        return result;
      } catch (err) {
        lastError = err;
        // A daily project quota cannot be fixed by retrying. Return the
        // conversational fallback immediately instead of making the user
        // wait through 10-60 second retry cycles.
        if (isDailyQuotaError(err)) {
          // Do not make the next WhatsApp message wait through the queue.
          // Keep a short local circuit breaker and let getAIReply() use its
          // natural offline response immediately.
          geminiModelDailyQuotaUntil.set(quotaKey, Date.now() + (Number(process.env.GEMINI_DAILY_QUOTA_COOLDOWN_MS) || 24 * 60 * 60 * 1000));
          throw err;
        }
        if (!isTransientAIError(err) || attempt >= retries) throw err;
        const backoff = Math.min(
          10000,
          (Number(process.env.GEMINI_RETRY_BASE_MS) || 1200) * (2 ** attempt) +
          Math.round(Math.random() * 600)
        );
        geminiCooldownUntil = Date.now() + backoff;
        const status = getAIErrorStatus(err);
        console.warn(`⚠ Gemini temporary error${status ? ` (${status})` : ""}. Retrying in ${Math.round(backoff / 1000)}s...`);
        await sleep(backoff);
      }
    }
    throw lastError;
  });
}

function detectLanguage(text = "") {
  const value = String(text).trim();
  if (!value) return "english";
  const devanagari = (value.match(/[\u0900-\u097F]/g) || []).length;
  const latinWords = (value.match(/[A-Za-z]+/g) || []).length;
  const bhojpuriRoman = /\b(ka haal ba|kaisan ba|kaise ba|tohra|tohar|hamar|humar|rauwa|bani|bada|kahat|kahe|kahanwa|kaisan|kaile|kaini|karat|rahla|rahal|hau|chahi|chaahi|lagela|hojela|karela|deha|deba|liha|leha|hamni|tohni|sabke|baate)\b/i;
  const bhojpuriDeva = /(का हाल बा|कइसन बा|तोहरा|तोहार|हमार|रउआ|बानी|बाड़|कइसे|कइनी|कइल|करत|रहल|काहे|चाही|लागेला|होखेला|केहू|हमनी|तोहनी)/;
  const hinglishHints = /\b(kya|kaise|kaisa|hai|hain|ho|hoga|kar|karo|kr|acha|achha|batao|mujhe|tum|aap|apna|mera|meri|nahi|haan|nahin|chahiye|kyu|kyon|kab|kahan|kaha|wala|wali|ka|ke|ki|se|mein|me|raha|rahi|rahe|bhi|bas|bhai|aao|ao|aana|aaja|chalo|chale|jana|jaana|ghumne|par|pe|bula|bulao|na|khana|khaana|khaya|khaye|pina|peena|hua|hu|ho)\b/i;
  if (bhojpuriDeva.test(value) || bhojpuriRoman.test(value)) return "bhojpuri";
  if (devanagari >= 2) return "hindi";
  if (hinglishHints.test(value) && latinWords >= 2) return "hinglish";
  return "english";
}

function inferConversationLanguage(question, history = []) {
  const detected = detectLanguage(question);
  const short = String(question).trim().split(/\s+/).length <= 3;
  if (!short) return detected;
  const recentUser = history.filter(x => x.sender === "user").slice(-5).map(x => x.message || "").filter(Boolean);
  const counts = { english: 0, hindi: 0, hinglish: 0, bhojpuri: 0 };
  for (const item of recentUser) counts[detectLanguage(item)] += 1;
  const previous = Object.entries(counts).sort((a,b) => b[1] - a[1])[0];
  if (previous && previous[1] > 0) return previous[0];
  return detected;
}

function detectIntent(text = "") {
  const value = String(text).trim().toLowerCase();
  if (!value) return "unknown";
  if (/^(hi+|hello|hey+|heyy|namaste|pranam|ram ram|good morning|good afternoon|good evening|good night)(?:\s+(?:bro|bhai|nitesh|sir|yaar))?[!.,\s]*$/iu.test(value) || /^(नमस्ते|प्रणाम|राम राम|सुप्रभात|शुभ रात्रि)(?:\s+(?:भाई|भइया|नितेश))?[!！.,।\s]*$/iu.test(value)) return "greeting";
  if (/\b(who are you|who r u|tum kaun|aap kaun|kaun ho|ke hau|ka ho|what are you)\b|कौन हो|आप कौन|तुम कौन|क्या हो/iu.test(value)) return "identity";
  if (/\b(how are you|how r u|kaise ho|ka haal|kaisan ba|kya haal|kya haal ba|kya haal ba ho|sab theek|sab thik)\b|कैसे हो|कैसे हैं|क्या हाल|सब ठीक|कैसन बा/iu.test(value)) return "casual_checkin";
  if (/\b(i love you|love you|pyaar|pyar|miss you)\b|आई लव यू|प्यार|याद आ रही/iu.test(value)) return "affection";
  if (/\b(what are you doing|what're you doing|kya kar rahe|kya kar rahi|kya karte ho|ka karat bani|ka karat ba|ka karat ho)\b|क्या कर रहे|क्या कर रही|का करत बानी/iu.test(value)) return "activity";
  if (/^(where are you|kaha ho|kahaan ho|kahan ho|ka ha|कहाँ हो|कहां हो)[?!.,\s]*$/iu.test(value)) return "location";
  if (/^(aur batao|aur btao|phir batao|batao na|haan|han|okay|ok|acha|achha|hmm|hmmm|theek hai|thik hai|sahi hai|nice|cool)[?!.,\s]*$/iu.test(value)) return "small_talk";
  if (/\b(khana|khana pina|khana peena|khaana|khaana peena|pina hua|peena hua|khaye|khaya|khailu|khail|khaile|kha liya|kha li|dinner|lunch|breakfast)\b|खाना|खाना पीना|खाया|खाये|पीना हुआ/iu.test(value)) return "food_checkin";
  if (/^(aur|or)\s+(batao|btao)(?:\s+.*)?$/iu.test(value)) return "small_talk";
  if (/\?$|\b(what|why|how|when|where|who|which|kya|kyu|kaise|kab|kahan|kon|kaun|kaha|kehu|kaisan)\b/.test(value)) return "question";
  if (/\b(help|madad|guide|steps|step by step|kaise karu|batao)\b/.test(value)) return "help";
  if (/\b(thanks|thank you|dhanyavaad|shukriya|dhanyabad)\b|धन्यवाद|शुक्रिया/iu.test(value)) return "thanks";
  if (/\b(please|can you|could you|karo|kar do|send|bhejo|remind|call|set)\b/.test(value)) return "request";
  if (/\b(sorry|apolog|maaf)\b/.test(value)) return "apology";
  return "conversation";
}

function getLanguageInstruction(preference, detected) {
  const language = preference === "auto" ? detected : preference;
  const rules = {
    english: "Reply in natural conversational English. Do not translate the user's message unless asked.",
    hindi: "Reply in natural conversational Hindi, preferably Devanagari when the user uses Devanagari. Do not sound formal or textbook-like.",
    hinglish: "Reply in natural casual Hinglish, matching the user's Roman-script style. Use everyday Indian WhatsApp wording rather than literal translation.",
    bhojpuri: "Reply in natural conversational Bhojpuri. Match the user's Roman/Devanagari script. Do not translate Bhojpuri into Hindi or English unless asked. Use authentic everyday Bhojpuri wording without overdoing dialect spellings."
  };
  return rules[language] || rules.english;
}

function getLengthInstruction(length) {
  if (length === "short") return "Keep the reply very concise, usually 1-3 short sentences.";
  if (length === "detailed") return "Give enough detail to be useful, but avoid unnecessary repetition.";
  return "Keep the reply concise but complete, usually 1-4 short WhatsApp-style sentences unless the user asks for detail.";
}

function pickReply(options = []) {
  const list = Array.isArray(options) ? options.filter(Boolean) : [];
  if (!list.length) return "";
  return list[Math.floor(Math.random() * list.length)];
}

function getOfflineReply(question, language = detectLanguage(question), name = "") {
  const value = String(question || "").trim();
  const lower = value.toLowerCase();
  const intent = detectIntent(lower);
  const replies = {
    english: {
      identity: ["I'm Nitesh sir's personal WhatsApp assistant. 🙂", "I'm Nitesh sir's personal assistant here on WhatsApp. 😊"],
      casual_checkin: ["I'm good 😄 How about you?", "Doing good 😄 What about you?"],
      greeting: ["Hey! 😊 How's it going?", "Heyy 😄 What's up?"],
      activity: ["Just here, chatting with you 😄", "Just hanging around here and talking to you 😄"],
      location: ["Right here on WhatsApp 😄", "I'm right here on WhatsApp 😄"],
      small_talk: ["All good 😄 What's going on with you?", "Doing good 😄 Tell me, what's up?"],
      food_checkin: ["All good 😄 Have you eaten?", "Yep 😄 Did you have something to eat?"],
      affection: ["Aww 😄 that's sweet. I'm Nitesh's assistant, but I appreciate it!", "Haha, that's sweet 😄 I appreciate the love!"],
      thanks: ["Anytime! 😊", "You're welcome 😄"],
      apology: ["No worries 😊", "It's all good 😄"],
      fallback: ["Got you 😄 Tell me a little more.", "Hmm, tell me a bit more about that 😄", "Yeah, I'm listening. Tell me more."]
    },
    hindi: {
      identity: ["मैं Nitesh sir का personal WhatsApp assistant हूँ। 🙂", "मैं Nitesh sir का personal assistant हूँ, यहीं WhatsApp पर। 😊"],
      casual_checkin: ["मैं बढ़िया हूँ 😄 आप बताइए, कैसे हैं?", "एकदम बढ़िया 😄 आपका क्या हाल है?"],
      greeting: ["अरे नमस्ते 😊 कैसे चल रहा है?", "नमस्ते 😄 क्या हाल-चाल है?"],
      activity: ["बस यहीं आपसे बात कर रहा हूँ 😄", "बस यहीं हूँ, आपसे बात कर रहा हूँ 😄"],
      location: ["यहीं WhatsApp पर हूँ 😄", "बस यहीं WhatsApp पर हूँ 😄"],
      small_talk: ["बस बढ़िया 😄 आप बताइए, क्या चल रहा है?", "सब बढ़िया 😄 आपका क्या चल रहा है?"],
      food_checkin: ["हाँ 😄 सब बढ़िया। आपने खाना खा लिया?", "बढ़िया 😄 आपका खाना-पीना हो गया?"],
      affection: ["अरे वाह 😄 ये तो बहुत प्यारा है। मैं Nitesh का assistant हूँ, फिर भी appreciate करता हूँ!", "अच्छा जी 😄 प्यार के लिए thanks! ❤️"],
      thanks: ["कोई बात नहीं 😊", "अरे, anytime 😄"],
      apology: ["कोई बात नहीं 😊", "अरे कोई दिक्कत नहीं 😄"],
      fallback: ["समझ गया 😄 थोड़ा और बताइए।", "हम्म, इसके बारे में थोड़ा और बताइए 😄", "हाँ, बताइए… मैं सुन रहा हूँ।"]
    },
    hinglish: {
      identity: ["Main Nitesh sir ka personal WhatsApp assistant hoon. 🙂", "Main Nitesh sir ka personal assistant hoon, yahin WhatsApp par. 😊"],
      casual_checkin: ["Main badhiya hoon 😄 Tum batao, kaise ho?", "Ekdam badhiya 😄 Tumhara kya haal hai?"],
      greeting: ["Heyy 😊 Kya scene hai?", "Hello 😄 Kya haal-chaal?"],
      activity: ["Bas yahin tumse baat kar raha hoon 😄", "Bas yahin hoon, tumse chat kar raha hoon 😄"],
      location: ["Yahin WhatsApp par hoon 😄", "Bas yahin WhatsApp par hoon 😄"],
      small_talk: ["Bas badhiya 😄 Tum batao, kya chal raha hai?", "Sab badhiya 😄 Tumhare side kya scene hai?"],
      food_checkin: ["Haan 😄 sab badhiya. Tumne khana kha liya?", "Badhiya 😄 Tumhara khana-peena ho gaya?"],
      affection: ["Aww 😄 that's sweet. Main Nitesh ka assistant hoon, but appreciate karta hoon!", "Haha 😄 ye sweet tha, appreciate karta hoon! ❤️"],
      thanks: ["Anytime bhai 😊", "Koi baat nahi 😄"],
      apology: ["Koi baat nahi 😊", "Arey no issue 😄"],
      fallback: ["Samajh gaya 😄 Thoda aur batao.", "Hmm, iske baare mein thoda aur batao 😄", "Haan, bolo… main sun raha hoon."]
    },
    bhojpuri: {
      identity: ["हम Nitesh sir के personal WhatsApp assistant हईं। 🙂", "हम Nitesh sir के personal assistant हईं, इहे WhatsApp पर। 😊"],
      casual_checkin: ["हम बढ़िया बानी 😄 रउआ बताईं, कइसन बानी?", "एकदम बढ़िया बानी 😄 रउआ के का हाल बा?"],
      greeting: ["अरे प्रणाम 😊 का हाल बा?", "नमस्ते 😄 कइसन चलत बा?"],
      activity: ["बस इहे तानी, रउआ से बतियावत बानी 😄", "बस इहे बानी, रउआ से बतियावत बानी 😄"],
      location: ["इहे WhatsApp पर बानी 😄", "बस इहे WhatsApp पर बानी 😄"],
      small_talk: ["बस बढ़िया बा 😄 रउआ बताईं, का हाल बा?", "सब बढ़िया बा 😄 रउआ के तरफ का हाल बा?"],
      food_checkin: ["हाँ 😄 बढ़िया बा। रउआ खाना खा लिहनी?", "अच्छा 😄 रउआ के खाना-पीना हो गइल?"],
      affection: ["अरे वाह 😄 ई त बड़ा प्यारा बात बा। हम Nitesh के assistant हईं, बाकिर appreciate करत बानी!", "ई सुन के बढ़िया लागल 😄❤️"],
      thanks: ["कवनो बात नइखे 😊", "अरे, कवनो बात नइखे 😄"],
      apology: ["कवनो दिक्कत नइखे 😊", "ठीक बा, कवनो बात नइखे 😄"],
      fallback: ["समझ गइनी 😄 थोड़ा अउरी बताईं।", "हम्म, एकरा बारे में थोड़ा अउरी बताईं 😄", "हाँ, बताईं… हम सुनत बानी।"]
    }
  };
  const set = replies[language] || replies.english;
  if (set[intent]) return pickReply(set[intent]);
  if (/\b(java|python|node|html|css|javascript|react|express|mongodb|mysql)\b/i.test(lower)) {
    const tech = {
      java: "☕ Java एक Object-Oriented Programming Language है.",
      python: "🐍 Python एक simple और powerful programming language है.",
      node: "🟢 Node.js JavaScript runtime है, जो server-side apps के लिए use होता है.",
      html: "🌐 HTML web page का structure बनाता है.",
      css: "🎨 CSS web page की styling और layout संभालता है.",
      javascript: "⚡ JavaScript web की programming language है.",
      react: "⚛ React UI बनाने के लिए JavaScript library है.",
      express: "🚀 Express.js Node.js का web framework है.",
      mongodb: "🍃 MongoDB एक NoSQL database है.",
      mysql: "🗄 MySQL एक relational database है."
    };
    const key = Object.keys(tech).find(k => lower.includes(k));
    if (key) return tech[key];
  }
  return pickReply(set.fallback);
}


function getLastUserMessage(history = [], currentQuestion = "") {
  const current = String(currentQuestion || "").trim().toLowerCase();
  let skippedCurrent = false;
  for (const item of [...history].reverse()) {
    if (item?.sender !== "user") continue;
    const message = String(item.message || "").trim();
    if (!message) continue;
    if (!skippedCurrent && current && message.toLowerCase() === current) { skippedCurrent = true; continue; }
    return message;
  }
  return "";
}

function getContextualOfflineReply(question, language = detectLanguage(question), name = "", history = []) {
  const value = String(question || "").trim();
  const lower = value.toLowerCase();
  const userMessages = Array.isArray(history)
    ? history.filter(x => x?.sender === "user" && String(x.message || "").trim()).map(x => String(x.message).trim())
    : [];
  const recentUsers = userMessages.slice(-8);
  const previousUser = recentUsers.length > 1 ? recentUsers[recentUsers.length - 2].toLowerCase() : "";
  const conversationText = Array.isArray(history)
    ? history.filter(x => String(x?.message || "").trim()).map(x => String(x.message).trim()).slice(-20).join(" ").toLowerCase()
    : "";
  const recentText = conversationText || recentUsers.join(" ").toLowerCase();
  const isHinglish = language === "hinglish";
  const isBhojpuri = language === "bhojpuri";

  const has = (pattern) => pattern.test(recentText);
  const currentHas = (pattern) => pattern.test(lower);

  // ---- Current-turn intent guard ---------------------------------------
  // Never let an old topic (college/outing/food) hijack a clearly new message.
  // The current message wins; history is only used for genuine short follow-ups.
  if (/\b(kal\s+nahi\s+parso|parso\s+(?:chal|chalte|chale|jana|jaana)|parso)\b/i.test(lower) || /कल नहीं परसों|परसों/u.test(lower)) {
    if (isBhojpuri) return "😄 ठीक बा, कल ना—परसों चलल जाव.";
    if (isHinglish) return "😄 Achha, kal nahi—parso chalte hain.";
    if (language === "hindi") return "😄 अच्छा, कल नहीं—परसों चलते हैं।";
    return "😄 Okay, not tomorrow—let's go the day after tomorrow.";
  }

  if (/\b(abhi\s+free|free\s+ho|free\s+ho\s+kya|are\s+you\s+free|free\s+right\s+now)\b/i.test(lower)) {
    if (isHinglish) return "😄 Haan, abhi yahin hoon. Bolo kya hua?";
    if (language === "hindi") return "😄 हाँ, अभी यहीं हूँ। बताओ क्या हुआ?";
    if (isBhojpuri) return "😄 हँ, अभी इहे बानी. बताईं का बात बा?";
    return "😄 Yeah, I'm here right now. What's up?";
  }

  // Food preparation is different from asking whether the user has eaten.
  if (/\b(khana|khaana)\s+(banana|banaana|banan)\s+(hai|h)\b/i.test(lower) ||
      /\b(kya\s+bana(?:u|oon)|kya\s+banau|what\s+should\s+i\s+cook)\b/i.test(lower) ||
      /खाना बनाने|क्या बनाऊँ/u.test(lower)) {
    if (isHinglish) return "😄 Kya mood hai—jaldi banana hai ya proper dinner? Bolo, 2-3 easy options bata deta hoon.";
    if (language === "hindi") return "😄 जल्दी बनाना है या proper dinner? बताओ, 2-3 आसान options बता देता हूँ।";
    if (isBhojpuri) return "😄 जल्दी बनावे के बा कि बढ़िया dinner? बताईं, आसान option बताइब.";
    return "😄 Are you looking for something quick or a proper dinner? I can suggest a few easy options.";
  }

  if (/\b(khana\s+khane|khana\s+khane\s+jana|khaane\s+jana|eat\s+out|dinner\s+ke\s+liye)\b/i.test(lower)) {
    if (isHinglish) return "Achha 😄 Kahan jaane ka plan hai khana khane?";
    if (language === "hindi") return "अच्छा 😄 खाना खाने कहाँ जाने का प्लान है?";
    if (isBhojpuri) return "अच्छा 😄 खाना खाए कहाँ जाए के प्लान बा?";
    return "Nice 😄 Where are you thinking of going to eat?";
  }

  if (/\b(instagram\s*(par|pe)?\s*aao|instagram\s+par\s+aao|come\s+to\s+instagram)\b/i.test(lower)) {
    if (isHinglish) return "😄 Haan, Instagram pe aao—reels bhejo, dekhte hain.";
    if (language === "hindi") return "😄 हाँ, Instagram पर आओ—reels भेजो, देखते हैं।";
    if (isBhojpuri) return "😄 हँ, Instagram पर आईं—reels भेजीं, देखत बानी.";
    return "😄 Sure, send me the reels on Instagram and we'll check them out.";
  }

  if (/\b(reels?\s+(dekhoge|dekho|dekhna|dekhega)|reels?\s+dekhoge)\b/i.test(lower)) {
    if (isHinglish) return "😄 Haan, bhejo reels. Saath mein dekhte hain.";
    if (language === "hindi") return "😄 हाँ, reels भेजो। साथ में देखते हैं।";
    if (isBhojpuri) return "😄 हँ, reels भेजीं. साथे देखत बानी.";
    return "😄 Yeah, send them over. Let's watch.";
  }

  if (/\b(shayari|sayari|syari|syaari|sher)\b/i.test(lower) || /शायरी|सयारी/u.test(lower)) {
    if (isHinglish) return "❤️\n\"Kuch baatein lafzon mein kahan hoti hain,\nKuch yaadein bas dil mein raha karti hain.\"";
    if (language === "hindi") return "❤️\n\"कुछ बातें लफ़्ज़ों में कहाँ होती हैं,\nकुछ यादें बस दिल में रहा करती हैं।\"";
    if (isBhojpuri) return "❤️\n\"कुछ बात दिल में रह जाला, जुबान तक ना आ पावेला,\nयाद के कोई अपना होखे, त दिल मुस्कुरा जाला।\"";
    return "❤️\n\"Some feelings never make it into words;\nsome memories simply stay in the heart.\"";
  }

  if (/\b(college|school|class)\b/i.test(lower) && /\b(kal|tomorrow)\b/i.test(lower)) {
    if (isHinglish) return "😄 Haan, kal college ka plan hai. Tum chaloge?";
    if (language === "hindi") return "😄 हाँ, कल कॉलेज का प्लान है। तुम चलोगे?";
    if (isBhojpuri) return "😄 हँ, काल कॉलेज के प्लान बा. रउआ चलब?";
    return "😄 Yeah, college tomorrow. Are you going?";
  }

  // Direct identity questions must never fall through to a generic reply.
  if (/\b(who are you|who r u|tum kaun|aap kaun|kaun ho|kon ho|what are you)\b/i.test(lower) || /कौन हो|आप कौन|तुम कौन|क्या हो/u.test(lower)) {
    if (isBhojpuri) return "हम Nitesh sir के personal WhatsApp assistant हईं। 🙂";
    if (isHinglish) return "Main Nitesh sir ka personal WhatsApp assistant hoon. 🙂";
    if (language === "hindi") return "मैं Nitesh sir का personal WhatsApp assistant हूँ। 🙂";
    return "I'm Nitesh sir's personal WhatsApp assistant. 🙂";
  }

  // Questions about Nitesh sir must be answered directly. Never invent his
  // physical location or current activity when it is not configured.
  const ownerWhere = /\b(nitesh|unke sir|tumhare sir|aapke sir)\b/i.test(lower) &&
    /\b(kahan|kaha|kahaan|where|kidhar|kahan pe|kaha pe|kaha par|kahaan par)\b/i.test(lower);
  if (ownerWhere || /\b(nitesh)\s+(kahan|kaha|kahaan)\b/i.test(lower)) {
    if (isBhojpuri) return "Nitesh sir abhi kahan bाड़ें, ई exact जानकारी हमरा लगे नइखे. 😄 हम इहाँ WhatsApp संभालत बानी.";
    if (isHinglish) return "Nitesh sir abhi kahan hain, uski exact info mere paas nahi hai 😄 Main bas yahin WhatsApp handle kar raha hoon.";
    if (language === "hindi") return "Nitesh sir अभी कहाँ हैं, इसकी exact जानकारी मेरे पास नहीं है 😄 मैं बस यहाँ WhatsApp संभाल रहा हूँ।";
    return "I don't have Nitesh sir's exact current location 😄 I'm just handling WhatsApp here.";
  }

  const ownerDoing = /\b(nitesh|unke sir|tumhare sir|aapke sir)\b/i.test(lower) &&
    /\b(kya kar|kar rahe|kar rahi|kar raheho|karat ba|karat bad|ka karat|doing|what.*doing)\b/i.test(lower);
  if (ownerDoing) {
    if (isBhojpuri) return "Nitesh sir abhi ka karat bाड़ें, ई हमरा पता नइखे 😄 हमरा लगे बस WhatsApp conversation बा.";
    if (isHinglish) return "Nitesh sir abhi kya kar rahe hain, ye mujhe nahi pata 😄 Main unki taraf se WhatsApp handle kar raha hoon.";
    if (language === "hindi") return "Nitesh sir अभी क्या कर रहे हैं, ये मुझे नहीं पता 😄 मैं उनकी तरफ से WhatsApp संभाल रहा हूँ।";
    return "I don't know what Nitesh sir is doing right now 😄 I'm just handling WhatsApp on his behalf.";
  }

  // Handle common WhatsApp typos such as "kya kar raheho".
  if (/\bkya\s+kar\s+raheho\b/i.test(lower) || /\bkya\s+kar\+?raheho\b/i.test(lower)) {
    if (isHinglish) return "😄 Bas yahin hoon, tumse baat kar raha hoon.";
    if (language === "hindi") return "😄 बस यहीं हूँ, आपसे बात कर रहा हूँ।";
    return "😄 Just here, chatting with you.";
  }

  if (/\b(kaise ho|how are you|kya haal|kya haal ba|kya haal ba ho|sab theek|sab thik)\b/i.test(lower) || /कैसे हो|क्या हाल|सब ठीक/u.test(lower)) {
    if (isBhojpuri) return "😄 हम बढ़िया बानी, रउआ बताईं?";
    if (isHinglish) return "😄 Main badhiya hoon, tum batao?";
    if (language === "hindi") return "😄 मैं बढ़िया हूँ, आप बताइए?";
    return "😄 I'm good. How about you?";
  }

  if (/\b(kya kar rahe|kya kar rahi|kya kar raheho|what are you doing|ka karat)\b/i.test(lower) || /क्या कर रहे|क्या कर रही|का करत/u.test(lower)) {
    if (isBhojpuri) return "😄 बस रउआ से बतियावत बानी।";
    if (isHinglish) return "😄 Bas tumse baat kar raha hoon.";
    if (language === "hindi") return "😄 बस आपसे बात कर रहा हूँ।";
    return "😄 Just chatting with you.";
  }

  // Keep simple greetings short. The message handler adds the time-based opener.
  if (/^(hi+|hello|hey+|heyy|namaste|pranam|ram ram)[!.,\s]*$/i.test(lower) || /^(नमस्ते|प्रणाम|राम राम)[!！.,।\s]*$/u.test(lower)) {
    if (isBhojpuri) return "का हाल बा? 😄";
    if (isHinglish) return "Kya scene hai? 😄";
    if (language === "hindi") return "क्या हाल है? 😄";
    return "How's it going? 😄";
  }

  // Natural reciprocal food chat: “kha lo jakar, mai kha liye” is a suggestion/update, not a question.
  if (/\b(kha\s+lo|kha\s+le|jakar\s+kha|jaa\s*kar\s+kha)\b/i.test(lower) && /\b(mai|main|maine)\b/i.test(lower) && /\b(kha\s+li|kha\s+liye|kha\s+lia|kha\s+liya)\b/i.test(lower)) {
    if (isBhojpuri) return "😄 हँ, रउआ खा लिहनी त बढ़िया. हमहूँ खा लेब.";
    if (isHinglish) return "😄 Achha, tum kha liye ho to badhiya 😄 Main bhi kha leta hoon.";
    if (language === "hindi") return "😄 अच्छा, आपने खा लिया तो बढ़िया 😄 मैं भी खा लेता हूँ।";
    return "😄 Nice, you already ate 😄 I'll grab something too.";
  }

  // Current-turn intents must win over stale historical topics.
  if (/\b(ek\s+)?(shayari|sayari|shayri|sher|poem|poetry)\b/i.test(lower) || /\b(syari|shayari)\s+suno\b/i.test(lower)) {
    if (isBhojpuri) return "ज़रूर 😄 दिल से निकले बात के असर कुछ अउर होला,\nतोहरा मुस्कान रहे त दिनो सुंदर लागेला। ❤️";
    if (isHinglish) return "Bilkul 😄\n\"Kuch baatein lafzon mein nahi kahi jaati,\n bas ek muskaan hoti hai jo sab keh jaati hai.\" ❤️";
    if (language === "hindi") return 'बिल्कुल 😄\n"कुछ बातें लफ़्ज़ों में नहीं कही जातीं,\nबस एक मुस्कान होती है जो सब कह जाती है।" ❤️';
    return `Bilkul 😄\n"Some feelings don't need many words,\nsometimes a smile says it all." ❤️`;
  }

  if (/\b(reels?|reel)\b/i.test(lower) && /\b(dekh|dekho|dekhe|dekhoge|dekhen|watch)\b/i.test(lower)) {
    if (isBhojpuri) return "😄 हँ, भेजीं—देखत बानी.";
    if (isHinglish) return "😄 Haan, bhejo. Reels dekhte hain.";
    if (language === "hindi") return "😄 हाँ, भेजो। रील्स देखते हैं।";
    return "😄 Haan, send it. Let's watch.";
  }

  if (/\b(khana)\s+(banana|banaana)\b/i.test(lower) && /\b(kya\s+banau|kya\s+banaun|kya\s+banaye|kya\s+banae)\b/i.test(lower)) {
    if (isBhojpuri) return "😄 कुछ आसान बनाईं—चावल-दाल, अंडा भुर्जी या मसाला मैगी. का मन बा?";
    if (isHinglish) return "😄 Kuch easy bana lo—dal-chawal, egg bhurji ya masala maggi. Kis cheez ka mann hai?";
    if (language === "hindi") return "😄 कुछ आसान बना लो—दाल-चावल, अंडा भुर्जी या मसाला मैगी। किसका मन है?";
    return "😄 Make something easy—dal-rice, egg bhurji or masala Maggi. What are you in the mood for?";
  }

  if (/\b(khana)\s+(banana|banaana)\s+(hai|h)\b/i.test(lower)) {
    if (isBhojpuri) return "😄 अच्छा, अब खाना बनावे के बा. का बनावे के सोचत बानी?";
    if (isHinglish) return "😄 Achha, ab khana banana hai. Kya banane ka soch rahe ho?";
    if (language === "hindi") return "😄 अच्छा, अब खाना बनाना है। क्या बनाने का सोच रहे हो?";
    return "😄 Ah, time to cook. What are you thinking of making?";
  }

  if (/\b(free|available)\b/i.test(lower) && /\b(abhi|aaj|now|right now)\b/i.test(lower) && /\b(nitesh|tum|aap)\b/i.test(lower)) {
    if (isBhojpuri) return "😄 Nitesh sir ke abhi free bाड़ें कि ना, ई हमरा पता नइखे.";
    if (isHinglish) return "😄 Nitesh sir abhi free hain ya nahi, ye mujhe confirm nahi hai.";
    if (language === "hindi") return "😄 Nitesh sir अभी फ्री हैं या नहीं, ये मुझे confirm नहीं है।";
    return "😄 I can't confirm whether Nitesh sir is free right now.";
  }

  if (/\b(kal\s+nahi\s+parso|parso\s+chale|parso\s+chal|parso)\b/i.test(lower) && /\b(chal|chale|chalna|ghum|plan)\b/i.test(lower)) {
    if (isBhojpuri) return "😄 ठीक बा, काल ना—परसों चलते हैं. टाइम बाद में तय कर लीं.";
    if (isHinglish) return "😄 Theek hai, kal nahi—parso chalte hain. Time baad mein fix kar lenge.";
    if (language === "hindi") return "😄 ठीक है, कल नहीं—परसों चलते हैं। समय बाद में तय कर लेंगे।";
    return "😄 Okay, not tomorrow—let's go the day after tomorrow. We can fix the time later.";
  }

  // Context-aware food conversation.
  if (/\b(khana|khana pina|khana peena|khaana|khaana peena|pina hua|peena hua|khaye|khaya|kha liya|kha li|dinner|lunch|breakfast)\b/i.test(lower) || /खाना|खाना पीना|खाया|खाये|पीना हुआ/u.test(lower)) {
    if (isBhojpuri) return "😄 रउआ के खाना-पीना हो गइल? हम त इहे बतियावत बानी.";
    if (isHinglish) return "😄 Tumhara khana-peena ho gaya? Main to yahin tumse baat kar raha hoon.";
    if (language === "hindi") return "😄 आपका खाना-पीना हो गया? मैं तो यहीं आपसे बात कर रहा हूँ।";
    return "😄 Did you eat? I'm just here chatting with you.";
  }

  // College/school context is carried across short follow-ups instead of resetting.
  const recentConversationText = recentUsers.slice(-4).join(" ");
  const schoolTopic = /\b(college|school|class)\b/i.test(recentConversationText) ||
    has(/\b(kal|tomorrow|aaj|today)\s*(college|school|class)\b/i);
  if (schoolTopic) {
    if (/\b(bahut mann nahi|mann nahi|man nahi|mood nahi|mood na|mann nhi|man nhi)\b/i.test(lower)) {
      if (isBhojpuri) return "😅 मन ना कर रहल बा त कॉलेज जाए के अउरी भारी लागेला.";
      if (isHinglish) return "Samajh raha hoon 😅 Jab mann hi na kare na, college jaana aur mushkil lagta hai.";
      if (language === "hindi") return "समझ रहा हूँ 😅 जब मन ही न करे, कॉलेज जाना और मुश्किल लगता है।";
      return "I get that 😅 When you don't feel like it, college feels even harder.";
    }
    if (/\b(jana|jaana|going|go|padega|padhna)\b/i.test(lower) || /जाना|जाएंगे|जाना है/u.test(lower)) {
      if (isBhojpuri) return "😅 हँ, काल कॉलेज जाए के बा.";
      if (isHinglish) return "Haan 😅 kal college jaana hi hai.";
      if (language === "hindi") return "हाँ 😅 कल कॉलेज जाना ही है।";
      return "Yeah 😅 college tomorrow it is.";
    }
    if (/^(haan|han|hmm|hmmm|acha|achha|theek|thik|thik hai|theek hai|ok|okay|oo acha|oh acha)[?!.,\s]*$/i.test(lower)) {
      if (isBhojpuri) return "😄 हँ, कॉलेज के बाते चलत बा.";
      if (isHinglish) return "😄 Haan, college wali baat hi chal rahi hai.";
      if (language === "hindi") return "😄 हाँ, कॉलेज वाली बात ही चल रही है।";
      return "😄 Yep, we're still on the college topic.";
    }
  }

  // Outing/trip context: remember the destination and continue the plan.
  const outingTopic = /\b(ghumne|ghoomne|bahar|trip|outing|chale|chalna|chalo|plan|ghumna)\b/i.test(recentConversationText) ||
    /\b(jamshedpur|ranchi|patna|delhi|kolkata|dhanbad|bokaro)\b/i.test(recentConversationText);
  if (outingTopic) {
    if (/\b(kal chalte|kal chale|tomorrow.*go|tomorrow.*leave|kal.*ghum)\b/i.test(lower) || /कल चलते|कल चलें/u.test(lower)) {
      if (isBhojpuri) return "😄 हँ, काल चलेनी. टाइम तय कर लीं.";
      if (isHinglish) return "Haan 😄 kal chalte hain. Time bata dena.";
      if (language === "hindi") return "हाँ 😄 कल चलते हैं। समय बता देना।";
      return "Yeah 😄 let's go tomorrow. Pick a time.";
    }
    if (/^(kab|kabhi|when|what time)\b/i.test(lower) || /\b(kab chale|kab chalna)\b/i.test(lower)) {
      if (isBhojpuri) return "😄 जब रउआ बोलीं. काल के प्लान रखीं?";
      if (isHinglish) return "😄 Jab tum bolo. Kal ka plan rakh dein?";
      if (language === "hindi") return "😄 जब आप बोलें। कल का प्लान रखें?";
      return "😄 Whenever you want. Shall we plan for tomorrow?";
    }
    // Continue an already agreed outing naturally.
    if (/^\s*(haan|han|ha|yes|yeah|yep|ok|okay|theek|thik)\s*[.!?]*$/i.test(lower)) {
      if (isBhojpuri) return "😄 हँ, काल चलल जाव. अब टाइम तय करीं.";
      if (isHinglish) return "😄 Haan, kal chalte hain. Ab time fix kar lete hain.";
      if (language === "hindi") return "😄 हाँ, कल चलते हैं। अब समय तय कर लेते हैं।";
      return "😄 Yep, tomorrow works. Let's fix the time.";
    }
    if (/\b(\d{1,2})(?:\s*[:.]\s*\d{2})?\s*(?:baje|pm|am)\b/i.test(lower) || /^\s*\d{1,2}\s*(?:baje)?\s*$/i.test(lower)) {
      const timeText = value;
      if (isBhojpuri) return `😄 ठीक बा, ${timeText} बजे के रखीं.`;
      if (isHinglish) return `😄 Theek hai, ${timeText} baje chalte hain.`;
      if (language === "hindi") return `😄 ठीक है, ${timeText} बजे चलते हैं।`;
      return `😄 Sounds good, let's go at ${timeText}.`;
    }
    if (/\b(kahan|kaha|kahaan|where)\b/i.test(lower) && /\b(chal|chalo|chaloge|chalna|ghum|ghumne)\b/i.test(lower)) {
      if (isBhojpuri) return "😄 बताईं, कहाँ जाए के मन बा?";
      if (isHinglish) return "😄 Batao, kahan chalna hai?";
      if (language === "hindi") return "😄 बताओ, कहाँ चलना है?";
      return "😄 Where should we go?";
    }

    // A bare destination after "ghumne chale" is treated as the destination,
    // not as a brand-new unrelated message.
    if (/^[a-z\u0900-\u097f][a-z\u0900-\u097f\s.-]{1,40}$/iu.test(value) &&
        !/\b(haan|han|acha|achha|theek|thik|ok|okay|chalo|chale|jana|jaana|kab|kahan|kaha)\b/i.test(lower)) {
      if (isBhojpuri) return `अच्छा 😄 ${value} में घूमे के प्लान बा?`;
      if (isHinglish) return `Achha 😄 ${value} mein ghoomne ka plan hai?`;
      if (language === "hindi") return `अच्छा 😄 ${value} में घूमने का प्लान है?`;
      return `Nice 😄 So the plan is ${value}?`;
    }
    if (/\b(kaha|kahaan|kahan|where)\b/i.test(lower)) {
      if (isBhojpuri) return "😂 बताईं, कहाँ जाए के प्लान बा?";
      if (isHinglish) return "😂 Batao, kahan chalne ka plan hai?";
      if (language === "hindi") return "😂 बताओ, कहाँ चलने का प्लान है?";
      return "😂 So, where are we going?";
    }
    if (/\b(ghumne|ghoomne|bahar|trip|outing|chale|chalna)\b/i.test(lower)) {
      if (isBhojpuri) return "😂 चलीं, कहाँ के प्लान बा?";
      if (isHinglish) return "😂 Chalo 😄 Kahan ka plan hai?";
      if (language === "hindi") return "😂 चलो 😄 कहाँ का प्लान है?";
      return "😂 I'm in 😄 Where are we going?";
    }
  }

  // Social-app invitations should be acknowledged directly.
  if (/\b(instagram|insta|snapchat|telegram|facebook)\b/i.test(lower) &&
      /\b(aao|ao|come|chalo|chal|jaa|jao|join|aana|aao na)\b/i.test(lower)) {
    if (isBhojpuri) return "😂 Instagram पर बोलावत बानी का? का सीन बा?";
    if (isHinglish) return "😂 Instagram pe bula rahe ho? Kya scene hai?";
    if (language === "hindi") return "😂 Instagram पर बुला रहे हो? क्या सीन है?";
    return "😂 Calling me over to Instagram? What's the scene?";
  }

  // Short acknowledgements continue the latest topic instead of falling into
  // "tell me more" or "kya scene hai" every time.
  if (/^(aur batao|aur btao|phir batao|phir btao|aur|or|phir|fir|then|haan|han|hmm|hmmm|okay|ok|acha|achha|theek|thik|thik hai|theek hai|batao|btao|ba|bani|ho|oo acha|oh acha|ohh acha|accha)[?!.,\s]*$/i.test(lower)) {
    if (schoolTopic) {
      if (isHinglish) return "😄 Haan, kal college wala scene hi hai.";
      if (language === "hindi") return "😄 हाँ, कल कॉलेज वाला सीन ही है।";
      if (isBhojpuri) return "😄 हँ, काल कॉलेजे वाला सीन बा.";
      return "😄 Yep, still on the college topic.";
    }
    if (outingTopic) {
      if (isHinglish) return "😄 Haan, ghoomne wala plan yaad hai. Ab bas time/destination fix karna hai.";
      if (language === "hindi") return "😄 हाँ, घूमने वाला प्लान याद है। अब बस समय/जगह तय करनी है।";
      if (isBhojpuri) return "😄 हँ, घूमे वाला प्लान याद बा. अब टाइम/जगह तय करे के बा.";
      return "😄 Yep, we've got the outing plan. We just need the time/place.";
    }
    if (previousUser && /\b(kya kar|what are you doing|ka karat)\b/i.test(previousUser)) {
      if (isHinglish) return "😄 Bas yahin hoon. Tum batao, kya chal raha hai?";
      if (language === "hindi") return "😄 बस यहीं हूँ। आप बताइए, क्या चल रहा है?";
      return "😄 Just here. What's going on with you?";
    }
    if (isBhojpuri) return "😄 हँ, बताईं, का चलत बा?";
    if (isHinglish) return "😄 Haan, batao. Kya chal raha hai?";
    if (language === "hindi") return "😄 हाँ, बताइए। क्या चल रहा है?";
    return "😄 Yeah, tell me. What's going on?";
  }

  // Very short follow-ups such as "jana hai" inherit the immediately relevant topic.
  if (schoolTopic && /\b(jana|jaana|hai|hain|padega|going|go)\b/i.test(lower)) {
    if (isHinglish) return "Haan 😅 kal college jaana hi hai.";
    if (language === "hindi") return "हाँ 😅 कल कॉलेज जाना ही है।";
    if (isBhojpuri) return "😅 हँ, काल कॉलेज जाए के बा.";
    return "Yeah 😅 college tomorrow it is.";
  }


  // ---- Deep local conversation fallback ---------------------------------
  // When Gemini is unavailable/rate-limited, keep the conversation coherent
  // instead of guessing a new topic. This layer intentionally works from the
  // contact's own recent history, so contacts never share context.
  const allText = conversationText;
  const lastFew = recentUsers.slice(-4).join(" ").toLowerCase();

  const hasOuting = /\b(ghum|ghoom|ghumne|ghoomne|bahar|outing|trip|chalo|chale|chalna|chaloge|plan|jamshedpur|ranchi|patna|dhanbad|bokaro|kolkata|delhi)\b/i.test(allText);
  const hasCollege = /\b(college|school|class|campus|lecture|teacher|professor|exam|exam)\b/i.test(allText);
  const hasFood = /\b(khana|khana peena|khana pina|kha|khaye|khaya|kha liya|kha li|dinner|lunch|breakfast|bhookh|bhukh)\b/i.test(allText);

  // "batao", "haan", "acha", "hmm" should respond to the active topic,
  // but should not parrot the topic back as a system-like status message.
  if (/^(batao|btao|haan|han|ha|hmm|hmmm|acha|achha|theek|thik|ok|okay|oh|ohh|aur|or|phir|fir)[!.,\s]*$/i.test(lower)) {
    if (hasOuting) {
      if (isBhojpuri) return "😄 हँ, अब बताईं—कहाँ के प्लान बनाईं?";
      if (isHinglish) return "😄 Haan, bolo—kal wale plan mein kahan chalna hai?";
      if (language === "hindi") return "😄 हाँ, बोलो—कल कहाँ चलने का प्लान है?";
      return "😄 Yeah, tell me—where are we heading tomorrow?";
    }
    if (hasCollege) {
      if (isBhojpuri) return "😄 हँ, बताईं—कॉलेज के का सीन बा?";
      if (isHinglish) return "😄 Haan, bolo—college ka kya scene hai?";
      if (language === "hindi") return "😄 हाँ, बोलो—कॉलेज का क्या सीन है?";
      return "😄 Yeah, tell me—what's the college situation?";
    }
    if (hasFood) {
      if (isBhojpuri) return "😄 हँ, बताईं—खाना खा लिहनी?";
      if (isHinglish) return "😄 Haan, bolo—khana ho gaya?";
      if (language === "hindi") return "😄 हाँ, बोलो—खाना हो गया?";
      return "😄 Yeah, tell me—did you eat?";
    }
  }

  // A time-only message inherits an outing/appointment topic.
  if (/^\s*\d{1,2}(?:\s*[:.]\s*\d{1,2})?\s*(?:baje|am|pm)?\s*$/i.test(lower) && (hasOuting || /\b(kal|tomorrow|aaj|today)\b/i.test(lastFew))) {
    if (isBhojpuri) return `😄 ठीक बा, ${value} के टाइम रखीं.`;
    if (isHinglish) return `😄 Theek hai, ${value} baje rakh lete hain.`;
    if (language === "hindi") return `😄 ठीक है, ${value} बजे रख लेते हैं।`;
    return `😄 Perfect, let's keep it at ${value}.`;
  }

  // "kal" / "chalo kal" is normally a continuation when an outing topic exists.
  if (/^(kal|tomorrow|chalo kal|kal chalo|kal chale)[!.,\s]*$/i.test(lower) && hasOuting) {
    if (isBhojpuri) return "😄 हँ, काल चलल जाव. अब टाइम तय करीं.";
    if (isHinglish) return "😄 Haan, kal chalte hain 😄 Time fix kar lete hain.";
    if (language === "hindi") return "😄 हाँ, कल चलते हैं 😄 समय तय कर लेते हैं।";
    return "😄 Tomorrow works 😄 Let's fix the time.";
  }

  // "where?" after an agreed plan should not restart the conversation.
  if (/^(kaha|kahan|kahaan|where|kidhar)(?:\s+chaloge|\s+chale|\s+jana|\s+jayenge)?[?!.,\s]*$/i.test(lower) && hasOuting) {
    if (isBhojpuri) return "😄 जहाँ रउआ के मन हो—कवन जगह सोचले बानी?";
    if (isHinglish) return "😄 Jahan tum bolo 😄 Koi place socha hai?";
    if (language === "hindi") return "😄 जहाँ तुम बोलो 😄 कोई जगह सोची है?";
    return "😄 Wherever you like 😄 Got a place in mind?";
  }

  // Natural acknowledgement of a food update.
  if (/\b(main|mai|maine)\s+kha\s+(liya|liye|lia|li)\b/i.test(lower) || /\bmaine\s+kha\s+liya\b/i.test(lower)) {
    if (isHinglish) return "😄 Achha, badhiya. Ab pet bhar gaya?";
    if (language === "hindi") return "😄 अच्छा, बढ़िया। अब पेट भर गया?";
    if (isBhojpuri) return "😄 बढ़िया, पेट भर गइल?";
    return "😄 Nice, feeling full now?";
  }

  // Questions directed at the assistant with "sir" are not automatically
  // questions about Nitesh. Only explicit owner references above are treated
  // as owner questions.
  if (/\b(kya kar|ka karat|what are you doing|kar raheho)\b/i.test(lower) && /\bsir\b/i.test(lower)) {
    if (isBhojpuri) return "😄 बस रउआ से बतियावत बानी.";
    if (isHinglish) return "😄 Bas yahin hoon, tumse baat kar raha hoon.";
    if (language === "hindi") return "😄 बस यहीं हूँ, आपसे बात कर रहा हूँ।";
    return "😄 Just here, chatting with you.";
  }

  // A plain statement should be acknowledged semantically, not repeated.
  if (hasOuting && /\b(jaana hai|jana hai|chalna hai|chalna|chalega|chaloge)\b/i.test(lower)) {
    if (isHinglish) return "😄 Haan, plan ban gaya phir.";
    if (language === "hindi") return "😄 हाँ, फिर प्लान बन गया।";
    if (isBhojpuri) return "😄 हँ, त प्लान बन गइल.";
    return "😄 Sounds like we've got a plan.";
  }

  // Final conversational fallback: do not echo the user's words and do not
  // use the old one-line “samajh gaya/batao” response for every topic.
  if (/\b(batao|tell me|what|kya|ka|why|kyu|kyun|how|kaise)\b/i.test(lower) || /बताओ|क्या|क्यों|कैसे/u.test(lower)) {
    if (isBhojpuri) return "😄 हँ, बताईं, का पूछत बानी?";
    if (isHinglish) return "😄 Haan, bolo. Kya jaan'na hai?";
    if (language === "hindi") return "😄 हाँ, बताइए। क्या जानना है?";
    return "😄 Sure, what do you want to know?";
  }
  if (previousUser) {
    if (isBhojpuri) return "😄 हँ, आगे बताईं.";
    if (isHinglish) return "😄 Haan, bolो 😄";
    if (language === "hindi") return "😄 हाँ, बताइए 😄";
    return "😄 Yeah, go on.";
  }

  return getOfflineReply(question, language, name);
}

async function getPersonalContext(number, useMemory = true, accountId = "default") {
  const user = await User.findOne({ accountId, number }).lean();
  const context = { name: user?.name || "User", number, memories: [] };
  if (useMemory) context.memories = await AIMemory.find({ accountId, number, active: true }).sort({ updatedAt: -1 }).limit(30).lean();
  context.summary = user?.conversationSummary || "";
  context.summaryUpdatedAt = user?.summaryUpdatedAt || null;
  return context;
}

function tokenize(value = "") {
  return String(value).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(w => w.length >= 2);
}
function relevanceScore(query, message, index, total) {
  const q = new Set(tokenize(query)); const words = tokenize(message);
  if (!q.size || !words.length) return 0;
  const overlap = words.reduce((n, word) => n + (q.has(word) ? 1 : 0), 0);
  const density = overlap / Math.max(1, Math.min(words.length, 20));
  const recency = total ? (index + 1) / total : 1;
  return overlap * 3 + density * 4 + recency * 1.5;
}
function selectRelevantContext(history, question, maxItems = 14) {
  if (!Array.isArray(history) || !history.length) return [];
  const recentCount = Math.min(8, history.length); const recent = history.slice(-recentCount); const recentSet = new Set(recent);
  const candidates = history.map((item, index) => ({ item, index, score: relevanceScore(question, item.message || "", index, history.length) }))
    .filter(x => !recentSet.has(x.item)).sort((a,b) => b.score - a.score).slice(0, Math.max(0, maxItems - recent.length)).sort((a,b) => a.index - b.index).map(x => x.item);
  return [...candidates, ...recent];
}
function isFollowUpMessage(text = "") {
  const value = String(text).trim().toLowerCase();
  return /^(yes|yeah|yep|haan|han|hmm|ok|okay|acha|achha|right|same|why|how|then|and|also|what about|phir|fir|aur|iske|uska|usko|yeh|ye|woh|wo|it|that|this|send it|do it|kar do|batao|ba|bani|ho)\b/.test(value) || value.length <= 12;
}
function buildContextDigest(history, question) {
  if (!Array.isArray(history) || !history.length) return { selected: [], followUp: false };
  // The latest turns are the primary context. Older semantically similar turns
  // are added only as secondary context, never ahead of the current thread.
  const recent = history.slice(-20);
  const recentSet = new Set(recent);
  const older = history.map((item, index) => ({ item, index, score: relevanceScore(question, item.message || "", index, history.length) }))
    .filter(x => !recentSet.has(x.item) && x.score >= 3.5)
    .sort((a,b) => b.score - a.score)
    .slice(0, 6)
    .sort((a,b) => a.index - b.index)
    .map(x => x.item);
  return { selected: [...older, ...recent].slice(-24), followUp: isFollowUpMessage(question) };
}



// Universal offline conversation engine. This is intentionally intent-first:
// the current message decides the topic; history is used only to resolve
// genuinely short follow-ups. It is a fallback for Gemini outages/quotas, not
// a list of canned replies tied to a handful of test conversations.
function universalOfflineReply(question, language, name = "", history = []) {
  const text = String(question || "").trim();
  const lower = text.toLowerCase();
  const lang = language || detectLanguage(text);
  const recent = Array.isArray(history) ? history.filter(x => x?.message).slice(-12) : [];
  const lastUser = [...recent].reverse().find(x => x.sender === "user")?.message || "";
  const lastAssistant = [...recent].reverse().find(x => x.sender !== "user")?.message || "";
  const previousUser = [...recent].reverse().filter(x => x.sender === "user").slice(1, 2)[0]?.message || "";
  const context = `${previousUser} ${lastAssistant}`.toLowerCase();
  const isShort = text.split(/\s+/).length <= 4 || text.length <= 18;
  const hinglish = lang === "hinglish" || /\b(kya|hai|haan|acha|batao|tum|mujhe|nahi|kal|parso|kaise|kahan|khana|chalo|dekhoge|sunao)\b/i.test(lower);
  const bhojpuri = lang === "bhojpuri";
  const hindi = lang === "hindi";
  const out = (en, hi, hi2, bho) => bhojpuri ? bho : hindi ? hi : hinglish ? hi2 : en;

  // High-confidence conversational intents must never fall into the generic
  // fallback, even when the remote LLM is temporarily unavailable.
  if (/\b(who\s+are\s+you|who\s+r\s+u|tum\s+(?:kon|kaun)\s+ho|kon\s+ho\s+tum|kaun\s+ho\s+tum|aap\s+(?:kon|kaun)\s+ho|what\s+are\s+you)\b/i.test(lower) ||
      /कौन हो|तुम कौन हो|आप कौन हो|क्या हो/u.test(text)) {
    return out(
      "I'm Nitesh sir's personal WhatsApp assistant. 🙂",
      "मैं Nitesh sir का personal WhatsApp assistant हूँ। 🙂",
      "Main Nitesh sir ka personal WhatsApp assistant hoon. 🙂",
      "हम Nitesh sir के personal WhatsApp assistant हईं। 🙂"
    );
  }

  // A user reporting what they are doing and asking the assistant the same
  // question should receive a reciprocal conversational answer, not a generic
  // prompt to continue.
  if (/\b(class|college|school|office|work)\s+(?:kar|doing|me|mein|hai|ho)\b/i.test(lower) &&
      /\b(tum|aap|you)\b.*\b(?:kar|doing|ho|hai)\b/i.test(lower)) {
    return out(
      "Achha 😄 Tum class kar rahe ho. Main yahin WhatsApp par hoon, tumse baat kar raha hoon.",
      "अच्छा 😄 तुम क्लास कर रहे हो। मैं यहीं WhatsApp पर हूँ, तुमसे बात कर रहा हूँ।",
      "Achha 😄 tum class kar rahe ho. Main yahin WhatsApp par hoon, tumse baat kar raha hoon.",
      "अच्छा 😄 रउआ class करत बानी. हम इहे WhatsApp पर रउआ से बतियावत बानी।"
    );
  }

  // Natural acknowledgement of a positive self-update. Do not ask an
  // unrelated "what are you thinking?" question.
  if (/^(main|mai|hum|ham)\s+(bhi\s+)?(?:theek|thik|badhiya|mast|fine|good|okay|ok)\b/i.test(lower) ||
      /^(i\s*'?m|i\s+am)\s+(fine|good|okay|ok|great)\b/i.test(lower)) {
    return out(
      "Nice 😄 Good to hear.",
      "अच्छा 😄 सुनकर अच्छा लगा।",
      "Achha 😄 sunke achha laga.",
      "बढ़िया 😄 सुन के अच्छा लागल।"
    );
  }

  // Explicit current-turn intents. These always beat historical context.
  if (/\b(shayari|sayari|shayri|syari|syaari|sher|poem|poetry)\b/i.test(lower) || /शायरी|सयारी/u.test(lower)) {
    return out(
      '❤️ "Some feelings are better felt than explained; some smiles say everything."',
      '❤️ "कुछ एहसास शब्दों से नहीं कहे जाते, कुछ मुस्कानें सब कह जाती हैं।"',
      '❤️ "Kuch feelings words mein nahi aati, kuch smiles sab keh jaati hain."',
      '❤️ "कुछ एहसास शब्द में ना समाए, कुछ मुस्कान दिल के बात बतावेला।"'
    );
  }
  if (/\b(khana|khaana|cook|cooking|banan|banana|banaana)\b/i.test(lower) && /\b(ban|bana|banau|banao|kya\s+ban|cook|cooking)\b/i.test(lower) || /खाना बनाने|क्या बनाऊँ/u.test(lower)) {
    return out(
      "What are you in the mood for—something quick or a proper meal?",
      "क्या खाने का मन है—कुछ जल्दी बने या proper खाना?",
      "Kya mood hai—kuch jaldi banne wala ya proper dinner? 😄",
      "का खाए के मन बा—जल्दी बने वाला कि बढ़िया खाना? 😄"
    );
  }
  if (/\b(reels?|video|song|music|movie|film|series)\b/i.test(lower)) {
    if (/\b(dekh|watch|sun|listen|bhej|send|aao|ao|chalo)\b/i.test(lower)) {
      return out("Sure 😄 Send it, let's check it out.", "हाँ 😄 भेजो, देखते हैं।", "Haan 😄 bhejo, saath mein dekhte hain.", "हँ 😄 भेजीं, साथे देखत बानी।");
    }
    return out("Oh nice 😄 What are you watching/listening to?", "अच्छा 😄 क्या देख/सुन रहे हो?", "Achha 😄 kya dekh/sun rahe ho?", "अच्छा 😄 का देखत/सुनत बानी?");
  }
  if (/\b(instagram|insta|snapchat|telegram|facebook|whatsapp)\b/i.test(lower)) {
    return out("😄 What are you up to there?", "😄 वहाँ क्या चल रहा है?", "😄 Wahan kya scene hai?", "😄 उहाँ का चलत बा?");
  }
  if (/\b(khana\s+khane|dinner|lunch|breakfast|eat\s+out|bhookh|bhukh)\b/i.test(lower)) {
    return out("Nice 😄 Where are you thinking of eating?", "अच्छा 😄 खाना खाने कहाँ जाने का सोच रहे हो?", "Achha 😄 khana khane kahan jaane ka plan hai?", "अच्छा 😄 खाना खाए कहाँ जाए के सोचत बानी?");
  }
  if (/\b(kaisa|kaise|how)\s+(bana|banau|make)|\b(kya\s+banau|what\s+should\s+i\s+cook)\b/i.test(lower)) {
    return out("Tell me what ingredients you have and I'll suggest something.", "जो सामान है बता दो, उसी से कुछ suggest कर दूँगा।", "Ghar mein kya-kya hai batao, usi se kuch suggest karta hoon 😄", "घर में का-का बा बताईं, ओही से कुछ सुझाइब।");
  }
  if (/\b(kal|parso|aaj|tomorrow|today|day after tomorrow)\b/i.test(lower) && /\b(chal|chalte|chale|jana|jaana|go|going|plan|mil|meet|ghum|ghoom)\b/i.test(lower)) {
    return out("Sounds good 😄 What time are you thinking?", "अच्छा 😄 किस समय का सोच रहे हो?", "Achha 😄 kis time ka plan rakhein?", "बढ़िया 😄 कवन टाइम के प्लान बा?");
  }
  if (/\b(free\s+ho|free\s+hai|are\s+you\s+free|abhi\s+free)\b/i.test(lower)) {
    return out("I'm here right now 😄 What's up?", "हाँ, अभी यहीं हूँ 😄 बताओ क्या हुआ?", "Haan, abhi yahin hoon 😄 bolo kya hua?", "हँ, अभी इहे बानी 😄 बताईं का बात बा?");
  }
  if (/\b(nitesh|sir)\b/i.test(lower) && /\b(kahan|kaha|where|kidhar)\b/i.test(lower)) {
    return out("I don't have Nitesh sir's live location.", "Nitesh sir अभी कहाँ हैं, इसकी live जानकारी मेरे पास नहीं है।", "Nitesh sir abhi kahan hain, live info mere paas nahi hai 😄", "Nitesh sir अभी कहाँ बाड़ें, ई जानकारी हमरा लगे नइखे।");
  }
  if (/\b(nitesh|sir)\b/i.test(lower) && /\b(kya\s+kar|what.*doing|kar\s+rahe|kar\s+raheho)\b/i.test(lower)) {
    return out("I don't know what Nitesh sir is doing right now.", "Nitesh sir अभी क्या कर रहे हैं, ये मुझे नहीं पता।", "Nitesh sir abhi kya kar rahe hain, mujhe nahi pata 😄", "Nitesh sir अभी का करत बाड़ें, हमरा पता नइखे।");
  }
  if (/\b(college|school|class|exam|teacher|professor|office|work|job|project)\b/i.test(lower)) {
    if (/\b(mann|mood)\b.*\b(nahi|nahin|nhi|not)\b|\b(nahi|nahin|nhi)\b.*\b(mann|mood)\b/i.test(lower)) return out("Yeah 😅 some days you just don't feel like it.", "हाँ 😅 कभी-कभी मन ही नहीं करता।", "Haan 😅 kabhi-kabhi bilkul mann nahi karta.", "हँ 😅 कई बेर मनहीं ना करेला।");
    if (/\b(kal|tomorrow|aaj|today)\b/i.test(lower)) return out("Got it 😄 What's the plan?", "अच्छा 😄 क्या प्लान है?", "Achha 😄 kya plan hai?", "अच्छा 😄 का प्लान बा?");
  }
  if (/\b(love|pyaar|pyar|miss|yaad)\b/i.test(lower)) return out("Aww 😄 that's sweet.", "अरे 😄 ये तो प्यारा है।", "Aww 😄 ye sweet tha.", "अरे 😄 ई त प्यारा बात बा।");
  if (/\b(sorry|maaf|apolog)\b/i.test(lower)) return out("No worries 😊", "कोई बात नहीं 😊", "Koi baat nahi 😊", "कवनो बात नइखे 😊");
  if (/\b(thanks|thank you|shukriya|dhanyavaad)\b/i.test(lower)) return out("Anytime 😊", "कोई बात नहीं 😊", "Anytime 😊", "कवनो बात नइखे 😊");
  if (/\b(help|madad|kaise\s+karu|how\s+do\s+i)\b/i.test(lower)) return out("Sure—tell me what you're trying to do.", "हाँ, बताओ क्या करना है।", "Haan, batao kya karna hai 😄", "हँ, बताईं का करे के बा।");
  if (/\b(hi+|hello|hey+|namaste|pranam|ram ram)\b/i.test(lower)) return out("How's it going? 😄", "क्या हाल है? 😄", "Kya haal hai? 😄", "का हाल बा? 😄");
  if (/\b(how are you|kaise ho|kya haal|sab thik|sab theek)\b/i.test(lower)) return out("I'm good 😄 How about you?", "मैं बढ़िया हूँ 😄 आप बताइए?", "Main badhiya hoon 😄 tum batao?", "हम बढ़िया बानी 😄 रउआ बताईं?");
  if (/\b(what are you doing|kya kar rahe|kya kar rahi|kya kar raheho|ka karat)\b/i.test(lower)) return out("Just here chatting with you 😄", "बस यहीं आपसे बात कर रहा हूँ 😄", "Bas yahin tumse baat kar raha hoon 😄", "बस इहे रउआ से बतियावत बानी 😄");
  if (/\b(where are you|kaha ho|kahan ho|kidhar ho)\b/i.test(lower)) return out("I'm right here on WhatsApp 😄", "यहीं WhatsApp पर हूँ 😄", "Yahin WhatsApp par hoon 😄", "इहे WhatsApp पर बानी 😄");

  // A genuinely short follow-up inherits only the immediately active topic.
  if (isShort && isFollowUpMessage(text)) {
    const active = `${lastUser} ${lastAssistant}`.toLowerCase();
    if (/\b(college|school|class|exam|office|work)\b/.test(active)) return out("Haan 😄 usi baat ko continue karte hain. Batao?", "हाँ 😄 उसी बात को आगे बढ़ाते हैं। बताओ?", "Haan 😄 usi baat ko continue karte hain, bolo?", "हँ 😄 ओही बात आगे बढ़ाईं, बताईं?");
    if (/\b(ghum|ghoom|outing|trip|chalo|chale|plan|parso|kal)\b/.test(active)) return out("Haan 😄 plan yaad hai. Ab kya fix karein?", "हाँ 😄 प्लान याद है। अब क्या तय करें?", "Haan 😄 plan yaad hai. Ab kya fix karein?", "हँ 😄 प्लान याद बा। अब का तय करीं?");
    if (/\b(khana|cook|cooking|dinner|lunch)\b/.test(active)) return out("Haan 😄 food wali baat hi kar rahe the.", "हाँ 😄 खाने वाली ही बात चल रही थी।", "Haan 😄 khane wali hi baat chal rahi thi.", "हँ 😄 खाना वाला बाते चलत रहे।");
    return out("Haan 😄 bolo, kya chal raha hai?", "हाँ 😄 बताओ, क्या चल रहा है?", "Haan 😄 bolo, kya chal raha hai?", "हँ 😄 बताईं, का चलत बा?");
  }

  // Generic conversation: never pretend to know an unprovided fact and never
  // turn the user's exact words into a malformed question.
  if (/[?？]$/.test(text) || /\b(why|what|how|when|where|who|which|kya|kaise|kab|kahan|kon|kaun)\b/i.test(lower)) {
    return out("Hmm 😄 that's a good question. Tell me a little more about what you mean.", "हम्म 😄 अच्छा सवाल है। थोड़ा सा context बता दो।", "Hmm 😄 achha sawaal hai. Thoda context batao.", "हम्म 😄 बढ़िया सवाल बा। थोड़ा context बताईं।");
  }
  if (/\b(bored|boring|akela|alone|tired|thak|pareshan|sad|dukhi|tension|stress)\b/i.test(lower)) {
    return out("Yeah, I get you. 😄 Want to talk about it?", "समझ रहा हूँ। 😄 बात करना चाहो तो बताओ।", "Samajh raha hoon 😄 baat karni hai to bolo.", "समझत बानी 😄 बताईं, बात करे के बा त करीं।");
  }
  if (/\b(joke|jokes|majak|masti|funny)\b/i.test(lower)) return out("😂 Haha, mood mast hai!", "😂 हाहा, आज तो मस्ती का mood है!", "😂 Haha, aaj full masti ka mood hai!", "😂 हाहा, आज त पूरा मस्ती के mood बा!");
  return out(
    "Got you 😄 Tell me what you're thinking.",
    "समझ गया 😄 बताओ, क्या सोच रहे हो?",
    "Samajh gaya 😄 batao, kya soch rahe ho?",
    "समझ गइनी 😄 बताईं, का सोचत बानी?"
  );
}

function getHighConfidenceReply(question, language) {
  const text = String(question || "").trim();
  const lower = text.toLowerCase();
  const lang = language || detectLanguage(text);
  const out = (en, hi, hing, bho) => lang === "bhojpuri" ? bho : lang === "hindi" ? hi : lang === "hinglish" ? hing : en;

  if (/^(who\s+are\s+you|who\s+r\s+u|what\s+are\s+you|tum\s+(kon|kaun)\s+ho|kon\s+ho\s+tum|kaun\s+ho\s+tum|aap\s+(kon|kaun)\s+ho|kaun\s+ho|कौन हो|तुम कौन हो|आप कौन हो|क्या हो)[?!.,\s]*$/iu.test(text)) {
    return out(
      "I'm Nitesh sir's personal WhatsApp assistant. 🙂",
      "मैं Nitesh sir का personal WhatsApp assistant हूँ। 🙂",
      "Main Nitesh sir ka personal WhatsApp assistant hoon. 🙂",
      "हम Nitesh sir के personal WhatsApp assistant हईं। 🙂"
    );
  }
  if (/^(where\s+are\s+you|kaha\s+ho|kahaan\s+ho|kahan\s+ho|kidhar\s+ho|कहाँ हो|कहां हो)[?!.,\s]*$/iu.test(text)) {
    return out(
      "I'm right here on WhatsApp 😄",
      "मैं यहीं WhatsApp पर हूँ 😄",
      "Main yahin WhatsApp par hoon 😄",
      "हम इहे WhatsApp पर बानी 😄"
    );
  }
  if (/^(what\s+are\s+you\s+doing|what's\s+up\s+with\s+you|kya\s+kar\s+rahe\s+ho|kya\s+kar\s+rahe|kya\s+kar\s+rahi|ka\s+karat\s+bani|का\s+करत\s+बानी|क्या\s+कर\s+रहे)[?!.,\s]*$/iu.test(text)) {
    return out(
      "Just here on WhatsApp, chatting with you 😄",
      "बस यहीं WhatsApp पर हूँ, आपसे बात कर रहा हूँ 😄",
      "Bas yahin WhatsApp par hoon, tumse baat kar raha hoon 😄",
      "बस इहे WhatsApp पर बानी, रउआ से बतियावत बानी 😄"
    );
  }
  if (/^(how\s+are\s+you|how\s+r\s+u|kaise\s+ho|kaisa\s+ho|kya\s+haal|sab\s+(theek|thik)|कैसे हो|कैसे हैं|क्या हाल|सब ठीक)[?!.,\s]*$/iu.test(text)) {
    return out(
      "I'm good 😄 How are you?",
      "मैं बढ़िया हूँ 😄 आप कैसे हैं?",
      "Main badhiya hoon 😄 tum kaise ho?",
      "हम बढ़िया बानी 😄 रउआ कइसन बानी?"
    );
  }
  if (/^(hi+|hello|hey+|heyy|namaste|pranam|ram\s+ram|good\s+morning|good\s+afternoon|good\s+evening|good\s+night|नमस्ते|प्रणाम|राम राम|सुप्रभात|शुभ रात्रि)[!.,\s]*$/iu.test(text)) {
    const period = getTimeGreeting();
    return out(
      `${period}! 👋 How are you?`,
      `${period === "Good night" ? "शुभ रात्रि" : period === "Good morning" ? "सुप्रभात" : period === "Good afternoon" ? "नमस्कार" : "शुभ संध्या"}! 👋 आप कैसे हैं?`,
      `${period}! 👋 Kya haal hai?`,
      `${period === "Good night" ? "शुभ रात" : period === "Good morning" ? "सुप्रभात" : period === "Good afternoon" ? "दुपहरिया के प्रणाम" : "शुभ संझा"}! 👋 कइसन बानी?`
    );
  }
  return "";
}

function cleanGeneratedReply(text, question) {
  let reply = String(text || "").trim();
  const q = String(question || "").trim();
  if (!reply || !q) return reply;
  const normalize = value => value.toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/[!?.,。！？，\s]+/g, " ").trim();
  const nq = normalize(q);
  const lines = reply.split(/\n+/).map(x => x.trim()).filter(Boolean);
  while (lines.length && normalize(lines[0]) === nq) lines.shift();
  reply = lines.join("\n").trim();
  return reply;
}

async function getAIReply(question, number = null, accountId = "default") {
  let detectedLanguage = detectLanguage(question);
  const highConfidence = getHighConfidenceReply(question, detectedLanguage);
  if (highConfidence) return highConfidence;
  let history = [];
  // Keep the contact profile available to the error/fallback path as well.
  // Previously `user` was block-scoped inside try{}, causing ReferenceError
  // whenever Gemini failed or another exception reached the fallback handler.
  let user = null;
  try {
    let useMemory = true;
    const dbReady = mongoose.connection.readyState === 1;
    if (number && dbReady) {
      try {
        user = await User.findOne({ accountId, number }).lean();
        useMemory = user?.aiMemory !== false;
        if (user?.aiEnabled === false) return null;
      } catch (_) {
        // Atlas/network hiccups must not stop WhatsApp replies for every contact.
        user = null;
        useMemory = false;
      }
    }
    if (number && useMemory && dbReady) {
      try {
        history = await Chat.find({ accountId, number, deleted: { $ne: true } }).sort({ createdAt: -1 }).limit(30).lean();
        history.reverse();
      } catch (_) {
        history = [];
      }
    }
    detectedLanguage = inferConversationLanguage(question, history);

    // IMPORTANT: every normal conversational turn goes through the language
    // model when it is available. Do not short-circuit greetings, identity,
    // small-talk, questions, or any other intent into canned replies.
    if (!model) return universalOfflineReply(question, detectedLanguage, user?.name || "", history);
    const personal = number && dbReady ? await getPersonalContext(number, useMemory, accountId) : { name: user?.name || "User", memories: [] };
    const summaryText = personal.summary || "No conversation summary available.";
    const memoryText = personal.memories.length ? personal.memories.map(x => `- ${x.key}: ${x.value}`).join("\n") : "No saved personal memories.";
    const digest = buildContextDigest(history, question);
    const conversation = digest.selected.length ? digest.selected.map(x => `${x.sender}: ${x.message || `[${x.messageType}]`}`).join("\n") : "No relevant previous messages.";
    const personality = user?.aiPersonality || "friendly";
    const customInstructions = (user?.aiInstructions || "").trim();
    const languageInstruction = getLanguageInstruction(user?.aiLanguage || "auto", detectedLanguage);
    const lengthInstruction = getLengthInstruction(user?.aiReplyLength || "balanced");
    const followUpInstruction = digest.followUp
      ? "This appears to be a follow-up. Resolve short references/pronouns from the immediately preceding conversation. Do not restart the topic or ask for context that is already available."
      : "Treat this as the current turn unless the supplied conversation clearly connects it to an earlier topic.";
    const system = process.env.AI_SYSTEM_PROMPT || `You are Nitesh's personal WhatsApp assistant. Make the conversation feel natural, warm and human, like a real WhatsApp chat. When speaking directly to Nitesh (the owner), address him naturally as "Nitesh sir" when appropriate; do not overuse the honorific in every sentence.

Core behavior:
- Respond to the user's actual message and intent. Never act like a numbered-menu chatbot.
- The CURRENT user message is the primary task. Use previous messages only to resolve genuine references, continuity, tone, names, plans, and facts. Never force an old topic onto a new message just because a keyword appeared earlier.
- Understand meaning even when the user uses typos, missing words, slang, Roman Hindi/Hinglish, Bhojpuri, mixed languages, or very short messages. Infer only what the conversation supports.
- For identity questions such as "who are you", "tum kon ho", or "kon ho tum", answer the identity question directly. Never answer it with a generic small-talk line.
- For greetings and ordinary small talk, answer the exact conversational turn naturally rather than using a fixed template. The application may prepend a time-based greeting on a new conversation; when it does, continue the conversation naturally without adding a second greeting.
- If the user asks for creative content such as a shayari, joke, caption, story, or poem, actually create the requested content. If they reject it ("ye nahi", "koi aur", "dusra"), create a genuinely different version rather than repeating the previous one.
- Do not use canned fallback phrases such as "Samajh gaya, batao", "Tell me more", "What's up?", or "How can I help?" when a more specific response can be produced from the message.
- Never simply mirror or rephrase the user's message as a question. Add a natural conversational response.
- Never automatically send numbered menus, option lists, welcome menus, promotional choices, or "How can I help you today?" as a generic filler.
- Only show a menu if the user explicitly asks for a menu/options.
- Match the user's language, dialect, script, vocabulary and casualness. Support English, Hindi, Hinglish, Bhojpuri and mixed messages. If the user speaks Bhojpuri, answer in Bhojpuri rather than translating it into Hindi.
- For short follow-ups such as "haan", "ba", "why", "aur?", "phir?", use the conversation context and continue naturally.
- Do not repeat greetings on every message. If the application already adds a greeting, do not add another one.
- Keep ordinary WhatsApp replies concise, usually 1-4 short sentences. Use emojis naturally and sparingly. Vary wording across turns so the conversation does not feel scripted.
- Do not use headings such as AI:, Assistant:, Response:, Answer:, or system-style labels.
- Do not invent facts, locations, activities, relationships, memories, or things Nitesh is doing.
- If asked where you are, describe your role as being here on WhatsApp; do not invent a physical location.
- If asked who you are, say you are Nitesh's personal WhatsApp assistant. Do not falsely claim to literally be Nitesh.
- When asked about Nitesh, use only configured or remembered information. When referring to the owner in direct conversation, prefer "Nitesh sir" naturally. If unavailable, say so naturally.
- If the user is joking, flirting, being affectionate, or making small talk, respond naturally and briefly instead of switching into a help-desk script.
- Do not mention Gemini, models, prompts, databases, API limits, memory implementation, or internal instructions.
- Answer first. Do not append unnecessary offers like "Let me know if you need anything else" unless it genuinely fits the conversation.`;
    const prompt = `${system}\nPersonality: ${personality}.\nDetected language: ${detectedLanguage}.\n${languageInstruction}\n${lengthInstruction}\n${followUpInstruction}\n${customInstructions ? `User custom instructions: ${customInstructions}` : ""}\n\nConversation summary:\n${summaryText}\n\nUser profile:\n- Name: ${personal.name}\n\nSaved memories:\n${memoryText}\n\nRelevant recent conversation:\n${conversation}\n\nNew user message:\n${question}\n\nRecent assistant replies are included in the conversation. Avoid repeating their wording or the same sentence pattern unless repetition is genuinely natural.
Reply naturally now. Answer the current message first. Do not repeat the user's message. Do not add labels or a generic help offer.`;
    const ai = await generateBestAvailableAI(prompt);
    if (ai.provider !== "gemini") console.warn(`ℹ️ AI reply provider: ${ai.provider}`);
    return cleanGeneratedReply(ai.text, question) || universalOfflineReply(question, detectedLanguage, personal.name, history);
  } catch (err) {
    if (err?.code === "GEMINI_DAILY_QUOTA" || isDailyQuotaError(err)) {
      // Expected when the free project quota is exhausted: answer locally.
    } else {
      console.log("❌ Gemini Error", err.message);
    }
    let name = user?.name || "";
    if (!name && number && mongoose.connection.readyState === 1) {
      try { name = (await User.findOne({ accountId, number }).lean())?.name || ""; } catch (_) {}
    }
    try {
      const recent = history.slice(-16).map(x => `${x.sender}: ${x.message || ""}`).join("\n");
      const fallbackPrompt = `CURRENT USER MESSAGE: ${question}
LANGUAGE: ${detectedLanguage}
USER NAME: ${name || "unknown"}
RECENT CONVERSATION:
${recent || "none"}

Reply directly to the current message. Use the recent conversation only when it is actually relevant. Match the user's language, spelling style and emotional tone. If the user asks for creative content, create it. If they reject a previous creative answer, make a genuinely different one. Never invent facts about Nitesh or the user. Never use generic filler such as "samajh gaya, batao". Keep normal WhatsApp replies concise.`;
      const ai = await generateBestAvailableAI(fallbackPrompt);
      return cleanGeneratedReply(ai.text, question);
    } catch (providerErr) {
      console.warn("⚠ All AI providers unavailable:", providerErr.message);
    }
    return universalOfflineReply(question, detectedLanguage, name, history);
  }
}

function shouldExtractMemory(userMessage = "") {
  return /\b(my name is|call me|i am|i'm|i live|i stay|i work|i study|i like|i love|i prefer|my favorite|remember that|mera naam|mujhe .* pasand|main .* rehta|main .* rahata|main .* karta|hamar|humar|tohar|tohra|मेरा नाम|मैं .* रहता|मुझे .* पसंद|हमार|तोहार|रउआ)\b/i.test(String(userMessage));
}

async function extractMemories(number, userMessage, accountId = "default") {
  if (!model || !number || !userMessage || userMessage.length < 4 || !shouldExtractMemory(userMessage)) return [];
  if (/\b(forget|forget it|dont remember|don't remember|remove from memory|delete memory)\b/i.test(userMessage)) return [];
  try {
    const prompt = `Extract only stable personal facts explicitly stated by the user that could help a private assistant in future conversations.\nReturn ONLY a JSON array of objects with "key" and "value". If there are no useful facts, return [].\nDo not infer sensitive traits, passwords, secrets, temporary feelings, or facts about other people.\nExamples: "I live in Delhi" => [{"key":"city","value":"Delhi"}]; "call me Nitesh" => [{"key":"preferred_name","value":"Nitesh"}].\nUser message: ${userMessage}`;
    const result = await generateContent(prompt, { retries: 1 });
    const raw = result.response.text().replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(x => x && typeof x.key === "string" && typeof x.value === "string").map(x => ({ key: x.key.trim().slice(0,80), value: x.value.trim().slice(0,500) })).filter(x => x.key && x.value).slice(0,5);
  } catch { return []; }
}

async function saveAutoMemories(number, facts, accountId = "default") {
  if (!number || !Array.isArray(facts) || !facts.length) return;
  const user = await User.findOne({ accountId, number }).lean();
  if (user?.aiMemory === false) return;
  for (const fact of facts) {
    await AIMemory.findOneAndUpdate({ accountId, number, key: fact.key }, { $set: { value: fact.value, source: "ai", active: true } }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
  }
}

async function getConversationSummary(number, accountId = "default") {
  if (!model || !number) return "";
  const history = await Chat.find({ accountId, number, deleted: { $ne: true } }).sort({ createdAt: -1 }).limit(40).lean();
  if (!history.length) return "";
  const text = history.reverse().map(x => `${x.sender}: ${x.message || `[${x.messageType}]`}`).join("\n");
  try {
    const result = await generateContent(`Summarize this private chat in 5 short bullet points. Include only useful conversation context, decisions, tasks and stated preferences. Do not invent facts or include secrets.\n\n${text}`, { retries: 1 });
    const summary = result.response.text().trim().slice(0, 5000);
    await User.updateOne({ accountId, number }, { $set: { conversationSummary: summary, summaryUpdatedAt: new Date() } });
    return summary;
  } catch { return ""; }
}

module.exports = { getAIReply, getOfflineReply, getContextualOfflineReply, universalOfflineReply, getPersonalContext, extractMemories, saveAutoMemories, getConversationSummary, detectLanguage, detectIntent, inferConversationLanguage, shouldExtractMemory };
