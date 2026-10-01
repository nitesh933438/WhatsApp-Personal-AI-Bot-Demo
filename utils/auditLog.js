const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '../data/security-audit.log');
function audit(event, details = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n');
  } catch (_) {}
}
module.exports = audit;
