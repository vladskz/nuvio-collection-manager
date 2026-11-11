const { getContext, closeContext, closeAll } = require('./browser');

/**
 * Returns true when the current page appears to be logged in.
 * 1. Checks localStorage for a saved auth session (Nuvio uses Supabase).
 * 2. Falls back to checking a URL fragment, then an optional selector.
 */
async function isLoggedIn(page, config) {
  const login = config.login || {};
  const storageKey = login.loggedInLocalStorageKey;
  if (storageKey) {
    const loggedIn = await page
      .evaluate((key) => {
        try {
          const session = JSON.parse(localStorage.getItem(key) || 'null');
          return !!(session && (session.access_token || session.refresh_token));
        } catch (_) {
          return false;
        }
      }, storageKey)
      .catch(() => false);
    if (loggedIn) return true;
  }
  const urlContains = login.loggedInUrlContains;
  if (urlContains && page.url().includes(urlContains)) return true;
  const selector = login.loggedInSelector;
  if (selector) {
    const count = await page.locator(selector).count().catch(() => 0);
    return count > 0;
  }
  return false;
}

async function autoLogin(page, account, config, log) {
  const login = config.login || {};
  const emailSel = login.emailSelector;
  const passSel = login.passwordSelector;
  const submitSel = login.submitSelector;
  if (!emailSel || !passSel || !submitSel) {
    throw new Error('Login selectors are not configured. Please open the account manually once.');
  }

  log(`  signing in as ${account.email}...`);
  await page.goto(config.urls.login, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  await page.fill(emailSel, account.email);
  await page.fill(passSel, account.password);
  const clicked = await page
    .locator(submitSel)
    .first()
    .click({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) await page.press(passSel, 'Enter');
  await page.waitForTimeout(login.postLoginWaitMs || 4000);

  if (!(await isLoggedIn(page, config))) {
    throw new Error('Auto-login did not succeed (not redirected to /account).');
  }
  log(`  signed in as ${account.email}`);
}

async function ensureLoggedIn(page, account, config, log) {
  await page.goto(config.urls.collections, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  if (await isLoggedIn(page, config)) {
    log('  already signed in (session reused)');
    return;
  }
  await autoLogin(page, account, config, log);
  await page.goto(config.urls.collections, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
}

/**
 * Read the profile names from the account's profile menu.
 * Returns a de-duplicated array of profile names.
 */
async function fetchProfileNames(account, config, log = () => {}) {
  const context = await getContext(account.id, { headless: false });
  const page = await context.newPage();
  try {
    await ensureLoggedIn(page, account, config, log);
    const pc = config.profile || {};
    const switchSel = pc.switchSelector || 'button.nv-profile-trigger';
    const itemSel = pc.itemSelector || 'button.nv-profile-option';
    const activeSel = pc.activeNameSelector || '.nv-profile-trigger-name';

    const names = new Set();

    // Always capture the currently active profile (covers accounts with a single
    // profile, where the menu shows no profile list to switch between).
    const activeName = ((await page.locator(activeSel).first().textContent().catch(() => '')) || '').trim();
    if (activeName) names.add(activeName);

    // Open the menu and read any additional profiles.
    const trigger = page.locator(switchSel).first();
    if (await trigger.count().catch(() => 0)) {
      await trigger.click().catch(() => {});
      await page.waitForTimeout(800);
      const items = await page.$$eval(itemSel, (els) =>
        els
          .map((el) => {
            const last = el.lastElementChild;
            return (last ? last.textContent : el.textContent || '').trim();
          })
          .filter(Boolean)
      );
      for (const n of items) names.add(n);
    }

    return [...names];
  } finally {
    await page.close().catch(() => {});
    await closeContext(account.id);
  }
}

/**
 * Switch to the given profile if the config knows how. Nuvio imports go into
 * whichever profile is currently active, so we must activate it first.
 */
async function switchProfile(page, profile, config, log) {
  const pc = config.profile || {};
  if (!profile || !profile.name) return;
  if (!pc.switchSelector) {
    log('  note: profile switching is not configured — using the active profile');
    return;
  }

  const activeSel = pc.activeNameSelector || pc.switchSelector;
  const current = ((await page.locator(activeSel).first().textContent().catch(() => '')) || '').trim();
  if (current === profile.name) {
    log(`  already on profile "${profile.name}"`);
    return;
  }

  await page.click(pc.switchSelector).catch(() => {});
  await page.waitForTimeout(600);

  const itemSel = pc.itemSelector || pc.switchSelector;
  const item = page.locator(itemSel, { hasText: profile.name }).first();
  const found = await item.count().catch(() => 0);
  if (found > 0) {
    await item.click().catch(() => {});
    await page.waitForTimeout(2500);
    log(`  switched to profile "${profile.name}"`);
  } else {
    log(`  WARNING: could not find profile "${profile.name}" in the switcher`);
  }
}

const IMPORT_MODE_LABELS = {
  add: 'Add as new',
  merge: 'Merge',
  overwrite: 'Overwrite',
};

/**
 * After the JSON file is picked, Nuvio asks how to import it:
 * "Add as new", "Merge" or "Overwrite". Pick the configured mode.
 */
async function chooseImportMode(page, config, log) {
  const imp = config.import || {};
  const mode = imp.importMode || 'overwrite';
  const label = IMPORT_MODE_LABELS[mode] || IMPORT_MODE_LABELS.overwrite;

  const target = imp.importModeSelector
    ? page.locator(imp.importModeSelector).filter({ hasText: label }).first()
    : page.locator(`button:has-text("${label}"), [role=button]:has-text("${label}")`).first();

  try {
    await target.waitFor({ state: 'visible', timeout: 8000 });
  } catch (_) {
    log(`  NOTE: import-mode dialog ("${label}") did not appear — continuing`);
    return false;
  }
  await target.click().catch(() => {});
  await page.waitForTimeout(800);
  log(`  chose import mode: ${label}`);
  return true;
}

/**
 * Import a single catalog file into a single account profile.
 * Returns a status string ('ok' | 'failed').
 */
async function importOneFile(target, filePath, fileName, config, log) {
  const { account, profile } = target;
  const imp = config.import || {};
  const headless = imp.headless === true; // default to a visible browser so the user can watch
  const context = await getContext(account.id, { headless });
  const page = await context.newPage();
  try {
    await ensureLoggedIn(page, account, config, log);
    await switchProfile(page, profile, config, log);

    const importButton = imp.importButtonSelector;
    if (!importButton) {
      throw new Error('No import button selector configured (config.import.importButtonSelector)');
    }

    // The Import button opens a native file chooser; capture it and set the file.
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10000 }),
      page.click(importButton),
    ]);
    await chooser.setFiles(filePath);

    // Nuvio asks Add as new / Merge / Overwrite — choose the configured mode.
    await chooseImportMode(page, config, log);

    if (imp.confirmButtonSelector) {
      await page.waitForTimeout(1000);
      await page.click(imp.confirmButtonSelector).catch(() => {});
    }

    if (imp.successSelector) {
      await page
        .waitForSelector(imp.successSelector, { timeout: imp.perFileWaitMs || 6000 })
        .catch(() => {});
    } else {
      await page.waitForTimeout(imp.perFileWaitMs || 6000);
    }

    log(`  imported ${fileName}`);
    return 'ok';
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Run bulk import: each assignment is one (account + profile + file) import.
 * progress: { accountsDone, accountsTotal, filesDone, filesTotal, log(msg) }
 */
async function runBulkImport(assignments, config, progress) {
  const results = [];
  try {
    for (const assignment of assignments) {
      progress.accountsDone += 1;
      progress.filesDone += 1;
      const { account, profile, file } = assignment;
      const label = `Account: ${account.name} / Profile: ${profile ? profile.name : '(default)'}`;
      progress.log(`${label} <- ${file.name}`);
      const result = {
        accountId: account.id,
        profileId: profile ? profile.id : null,
        name: label,
        file: file.name,
      };
      try {
        const status = await importOneFile(assignment, file.path, file.name, config, progress.log);
        result.status = status;
      } catch (err) {
        progress.log(`  ERROR: ${err.message}`);
        result.error = err.message;
      }
      results.push(result);
    }
  } finally {
    await closeAll();
  }
  return results;
}

module.exports = { runBulkImport, isLoggedIn, fetchProfileNames };
