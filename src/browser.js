const path = require('path');
const { chromium } = require('playwright');
const { PROFILES_DIR } = require('./accounts');

// accountId -> { context, headless }
const contexts = new Map();

async function getContext(accountId, { headless = false } = {}) {
  const existing = contexts.get(accountId);
  if (existing) {
    if (existing.headless === headless) return existing.context;
    // Mode changed: close and relaunch with the same profile dir.
    try {
      await existing.context.close();
    } catch (_) {
      /* ignore */
    }
    contexts.delete(accountId);
  }

  const userDataDir = path.join(PROFILES_DIR, accountId);
  const launchOptions = {
    headless,
    args: ['--no-first-run', '--no-default-browser-check'],
  };
  if (!headless) launchOptions.viewport = null;

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  contexts.set(accountId, { context, headless });

  context.on('close', () => {
    if (contexts.get(accountId)?.context === context) contexts.delete(accountId);
  });

  return context;
}

function hasOpenContext(accountId) {
  return contexts.has(accountId);
}

async function closeContext(accountId) {
  const existing = contexts.get(accountId);
  if (existing) {
    try {
      await existing.context.close();
    } catch (_) {
      /* ignore */
    }
    contexts.delete(accountId);
  }
}

async function closeAll() {
  for (const id of [...contexts.keys()]) {
    await closeContext(id);
  }
}

module.exports = { getContext, hasOpenContext, closeContext, closeAll };
