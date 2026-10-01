const DEFAULT_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Kolkata";

function getHour(timeZone = DEFAULT_TIMEZONE) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false
  }).format(new Date()));
  return hour === 24 ? 0 : hour;
}

function getTimeGreeting(timeZone = DEFAULT_TIMEZONE) {
  const hour = getHour(timeZone);
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Good night";
}

function cleanName(name) {
  const value = String(name || "").trim().replace(/\s+/g, " ");
  if (!value || /^(user|unknown)$/i.test(value)) return "";
  if (!/[A-Za-z\u0900-\u097F]/u.test(value)) return "";
  return value.slice(0, 80);
}

function shouldGreet(user, now = Date.now(), incomingText = "") {
  // Greet the first message, after a long inactive gap, on a new local day,
  // and when the user explicitly starts a new greeting after a reasonable gap.
  if (!user) return true;
  // A newly created/saved contact should receive the first-conversation greeting
  // even if an older record exists without a greeting timestamp.
  if (Number(user.totalMessages || 0) <= 1) return true;
  if (!user.lastGreetingAt) return true;

  const last = new Date(user.lastGreetingAt);
  const elapsed = now - last.getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return true;
  if (elapsed >= 12 * 60 * 60 * 1000) return true;

  const tz = DEFAULT_TIMEZONE;
  const dayKey = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  if (dayKey(new Date(now)) !== dayKey(last)) return true;

  // If the user explicitly says hi/hello/namaste again after 30+ minutes,
  // treat it as a fresh conversation opener and add the time-based greeting.
  const text = String(incomingText || "").trim().toLowerCase();
  const explicitGreeting = /^(hi+|hello|hey+|heyy|namaste|pranam|ram ram|good morning|good afternoon|good evening|good night)(?:\s+(?:bro|bhai|nitesh|sir|yaar))?[!.,\s]*$/i.test(text) || /^(नमस्ते|प्रणाम|राम राम|सुप्रभात|शुभ रात्रि)(?:\s+(?:भाई|भइया|नितेश))?[!！.,।\s]*$/u.test(text);
  return explicitGreeting && elapsed >= 30 * 60 * 1000;
}

function buildGreeting(name, language = "english", timeZone = DEFAULT_TIMEZONE, options = {}) {
  const clean = cleanName(name);
  const honorific = options?.honorific ? ` ${String(options.honorific).trim()}` : "";
  const period = getTimeGreeting(timeZone);
  const greetings = {
    english: { "Good morning": "Good morning", "Good afternoon": "Good afternoon", "Good evening": "Good evening", "Good night": "Good night" },
    hindi: { "Good morning": "सुप्रभात", "Good afternoon": "नमस्कार", "Good evening": "शुभ संध्या", "Good night": "शुभ रात्रि" },
    hinglish: { "Good morning": "Good morning", "Good afternoon": "Good afternoon", "Good evening": "Good evening", "Good night": "Good night" },
    bhojpuri: { "Good morning": "सुप्रभात", "Good afternoon": "दुपहरिया के प्रणाम", "Good evening": "शुभ संझा", "Good night": "शुभ रात" }
  };
  const selected = greetings[language] || greetings.english;
  const suffix = clean ? `, ${clean}${honorific}` : "";
  return `${selected[period] || period}${suffix}! 👋`;
}

module.exports = { getTimeGreeting, buildGreeting, shouldGreet, cleanName, DEFAULT_TIMEZONE };
