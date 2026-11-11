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
 * Delete each collection in the active profile one by one.
 * "Delete all" in Nuvio clears every profile, so we delete collections individually.
 */
async function clearProfileCollections(account, profile, config, log = () => {}) {
  const imp = config.import || {};
  const headless = imp.headless === true;
  const context = await getContext(account.id, { headless });
  const page = await context.newPage();
  try {
    await ensureLoggedIn(page, account, config, log);
    await switchProfile(page, profile, config, log);

    const cc = config.clearCollections || {};
    const delSel = cc.deleteCollectionButtonSelector || `article button:has-text("Delete")`;
    const confirmSel = cc.confirmButtonSelector || 'button.nu-button-danger';

    let deleted = 0;
    for (let i = 0; i < 200; i++) {
      const del = page.locator(delSel).first();
      const n = await del.count().catch(() => 0);
      if (!n) break;
      await del.click().catch(() => {});
      await page.waitForTimeout(600);
      const confirm = page.locator(confirmSel).first();
      if (await confirm.count().catch(() => 0)) {
        await confirm.click().catch(() => {});
        deleted += 1;
      }
      await page.waitForTimeout(900);
    }
    log(`  deleted ${deleted} collection(s) for profile "${profile.name}"`);
    return 'ok';
  } finally {
    await page.close().catch(() => {});
    await closeContext(account.id);
  }
}

/**
 * Create a new profile in Nuvio with the given name and a random avatar.
 * Requires the primary profile to be active (the Add Profile button only shows there).
 */
async function createProfileInNuvio(account, profileName, config, log = () => {}) {
  const imp = config.import || {};
  const headless = imp.headless === true;
  const context = await getContext(account.id, { headless });
  const page = await context.newPage();
  try {
    await ensureLoggedIn(page, account, config, log);

    const pc = config.profile || {};
    const switchSel = pc.switchSelector || 'button.nv-profile-trigger';
    const itemSel = pc.itemSelector || 'button.nv-profile-option';

    // Switch to the primary profile (first entry in the profile menu).
    await page.click(switchSel).catch(() => {});
    await page.waitForTimeout(600);
    const firstProfile = page.locator(itemSel).first();
    if (await firstProfile.count().catch(() => 0)) {
      await firstProfile.click().catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Go to the Profiles tab.
    const accountUrl = (config.urls.account || 'https://nuvio.tv/account').split('?')[0];
    await page.goto(`${accountUrl}?tab=profiles`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const cp = config.createProfile || {};
    await page.click(cp.addButtonSelector || 'button:has-text("Add Profile")').catch(() => {});
    await page.waitForTimeout(1000);

    await page.fill(cp.nameInputSelector || '[role="dialog"] input[type=text]', profileName).catch(() => {});

    // Pick a random avatar (skips "Use initials").
    const avatars = page.locator(cp.avatarSelector || '[role="dialog"] button.group');
    const count = await avatars.count().catch(() => 0);
    if (count > 0) {
      await avatars.nth(Math.floor(Math.random() * count)).click().catch(() => {});
      await page.waitForTimeout(300);
    }

    await page.click(cp.createButtonSelector || '[role="dialog"] button.btn-primary').catch(() => {});
    await page.waitForTimeout(2500);

    const stillOpen = await page.locator('[role="dialog"]').count().catch(() => 0);
    if (stillOpen > 0) {
      throw new Error('Profile creation failed (dialog did not close — name may be taken or the 6-profile limit reached).');
    }
    log(`  created profile "${profileName}"`);
    return 'ok';
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
    : page.locator(`[role="dialog"] button:has-text("${label}")`).first();

  try {
    await target.waitFor({ state: 'visible', timeout: 8000 });
  } catch (_) {
    log(`  NOTE: import-mode dialog ("${label}") did not appear — continuing`);
    return false;
  }
  await target.click().catch(() => {});
  await page.waitForTimeout(400);
  log(`  chose import mode: ${label}`);

  // Confirm the import. The confirm button is the last button in the dialog
  // ("Add collections" / "Merge collections" / "Overwrite collections").
  const confirm = imp.confirmImportButtonSelector
    ? page.locator(imp.confirmImportButtonSelector).first()
    : page.locator('[role="dialog"] button').last();
  if (await confirm.count().catch(() => 0)) {
    await confirm.click().catch(() => {});
    await page.waitForTimeout(1000);
    log('  confirmed import');
  } else {
    log('  WARNING: import confirm button not found — import may not have been applied');
  }
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

module.exports = { runBulkImport, isLoggedIn, fetchProfileNames, clearProfileCollections, createProfileInNuvio };
