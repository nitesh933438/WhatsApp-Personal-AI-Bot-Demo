"use strict";

/**
 * Pre-defined offline/away reply templates.
 * Used when business hours are set and the bot is outside working hours.
 */

const DEFAULT_OFFLINE_REPLIES = [
  "We're currently offline. We'll get back to you during business hours.",
  "Thanks for your message! We're away right now and will respond soon.",
  "Hi! We've received your message and will reply during our next working hours.",
  "Our team is currently unavailable. Please leave your message and we'll respond shortly.",
  "We're closed at the moment. Your message has been noted and we'll respond ASAP."
];

/**
 * Get a random offline reply message.
 */
function getOfflineReply(customMessage = null) {
  if (customMessage && customMessage.trim()) return customMessage.trim();
  const idx = Math.floor(Math.random() * DEFAULT_OFFLINE_REPLIES.length);
  return DEFAULT_OFFLINE_REPLIES[idx];
}

/**
 * Check if current time is within business hours.
 * @param {string} startTime - "HH:MM" format
 * @param {string} endTime - "HH:MM" format
 * @param {string} timezone - IANA timezone string
 */
function isWithinBusinessHours(startTime = "09:00", endTime = "18:00", timezone = "Asia/Kolkata") {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone
    });
    const timeStr = formatter.format(now);
    const [currentHour, currentMin] = timeStr.split(":").map(Number);
    const [startHour, startMin] = startTime.split(":").map(Number);
    const [endHour, endMin] = endTime.split(":").map(Number);

    const currentMins = currentHour * 60 + currentMin;
    const startMins = startHour * 60 + startMin;
    const endMins = endHour * 60 + endMin;

    return currentMins >= startMins && currentMins < endMins;
  } catch (_) {
    return true; // Default to online if timezone check fails
  }
}

module.exports = { getOfflineReply, isWithinBusinessHours, DEFAULT_OFFLINE_REPLIES };
