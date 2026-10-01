// Kept for backward compatibility with older integrations.
// The bot is intentionally conversation-first and no longer sends numbered menus.
async function handleMenu() {
  return false;
}

module.exports = { handleMenu };
