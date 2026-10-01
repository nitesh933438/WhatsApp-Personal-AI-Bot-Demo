"use strict";

/**
 * General-purpose helper utilities.
 */

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Truncate a string to a maximum length.
 */
function truncate(str, maxLen = 100) {
  const s = String(str || "");
  return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
}

/**
 * Sanitize a phone number to WhatsApp format.
 * Removes spaces, dashes, parentheses. Appends @c.us if needed.
 */
function sanitizePhone(phone) {
  if (!phone) return "";
  let p = String(phone).replace(/[\s\-\(\)]/g, "");
  if (!p.endsWith("@c.us") && !p.endsWith("@g.us")) {
    p = p + "@c.us";
  }
  return p;
}

/**
 * Format bytes to human-readable size.
 */
function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + " " + sizes[i];
}

/**
 * Generate a random alphanumeric ID.
 */
function randomId(length = 8) {
  return Math.random().toString(36).substring(2, 2 + length).toUpperCase();
}

/**
 * Check if a value is a non-empty string.
 */
function isNonEmptyString(val) {
  return typeof val === "string" && val.trim().length > 0;
}

/**
 * Deep-clone a plain object (JSON safe).
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

module.exports = { sleep, truncate, sanitizePhone, formatBytes, randomId, isNonEmptyString, deepClone };
