"use strict";

/**
 * Input validation utilities.
 */

/**
 * Validate a WhatsApp phone number.
 * Accepts formats: 919334387983, +919334387983, 919334387983@c.us
 */
function isValidPhone(phone) {
  if (!phone) return false;
  const cleaned = String(phone).replace(/[\s\-\(\)\+]/g, "").replace(/@c\.us$/, "").replace(/@g\.us$/, "");
  return /^\d{7,15}$/.test(cleaned);
}

/**
 * Validate an email address.
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

/**
 * Validate that a string is non-empty and within max length.
 */
function isValidString(val, maxLen = 1000) {
  if (typeof val !== "string") return false;
  const trimmed = val.trim();
  return trimmed.length > 0 && trimmed.length <= maxLen;
}

/**
 * Validate a MongoDB ObjectId format.
 */
function isValidObjectId(id) {
  return /^[a-f\d]{24}$/i.test(String(id || ""));
}

/**
 * Sanitize a string by removing dangerous characters.
 */
function sanitizeString(val, maxLen = 1000) {
  return String(val || "").replace(/[<>]/g, "").trim().slice(0, maxLen);
}

/**
 * Validate an account ID (alphanumeric, dashes, underscores).
 */
function isValidAccountId(id) {
  return /^[a-z0-9_-]{1,50}$/i.test(String(id || ""));
}

module.exports = { isValidPhone, isValidEmail, isValidString, isValidObjectId, sanitizeString, isValidAccountId };
