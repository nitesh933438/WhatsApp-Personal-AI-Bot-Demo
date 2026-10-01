"use strict";
const fs = require("fs");
const path = require("path");

/**
 * Create a JSON backup of data and save to backups directory.
 */
async function createBackup(data, name = "backup") {
  const backupsDir = path.join(__dirname, "../data/backups");
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${name}-${timestamp}.json`;
  const filepath = path.join(backupsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf8");
  return { filepath, filename };
}

/**
 * List available backups.
 */
function listBackups() {
  const backupsDir = path.join(__dirname, "../data/backups");
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      name: f,
      path: path.join(backupsDir, f),
      size: fs.statSync(path.join(backupsDir, f)).size,
      created: fs.statSync(path.join(backupsDir, f)).birthtime
    }))
    .sort((a, b) => b.created - a.created);
}

/**
 * Restore a backup by filename.
 */
function restoreBackup(filename) {
  const filepath = path.join(__dirname, "../data/backups", filename);
  if (!fs.existsSync(filepath)) throw new Error(`Backup not found: ${filename}`);
  const raw = fs.readFileSync(filepath, "utf8");
  return JSON.parse(raw);
}

module.exports = { createBackup, listBackups, restoreBackup };
