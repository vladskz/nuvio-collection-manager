/*
 * Helper to discover the correct selectors on nuvio.tv.
 *
 * Usage:
 *   node scripts/inspect-page.js <account-name-or-id> [collections|account]
 *
 * It opens a headed browser with that account's saved profile, navigates to the
 * chosen page, then prints every file input, form, button and link it finds —
 * so you can copy the right selector into config/import-flow.json.
 *
 * If the account does not exist yet, pass any string and the script will still
 * open the page so you can log in manually and inspect the DOM.
 */
const { loadAccounts } = require('../src/accounts');
const { getContext } = require('../src/browser');

const CONFIG_FILE = require('path').join(__dirname, '..', 'config', 'import-flow.json');
const config = require(CONFIG_FILE);

(async () => {
  const arg = process.argv[2] || '';
  const tab = process.argv[3] || 'collections';
  const url = tab === 'account' ? config.urls.account : config.urls.collections;

  const data = loadAccounts();
  const account = data.accounts.find((a) => a.id === arg || a.name.toLowerCase() === arg.toLowerCase());

  const id = account ? account.id : 'inspect_' + Date.now().toString(36);
  console.log(`Opening ${url} (account: ${account ? account.name : 'temporary profile'})…`);

  const context = await getContext(id, { headless: false });
  const pages = context.pages();
  const page = pages.length ? pages[0] : await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  console.log('\n=== PAGE URL ===');
  console.log(page.url());

  console.log('\n=== FILE INPUTS (input[type=file]) ===');
  const files = await page.$$eval('input[type=file]', (els) =>
    els.map((el, i) => ({
      i,
      id: el.id,
      name: el.name,
      className: el.className,
      accept: el.accept,
    }))
  );
  console.log(JSON.stringify(files, null, 2));

  console.log('\n=== BUTTONS ===');
  const buttons = await page.$$eval('button, input[type=submit], a[role=button]', (els) =>
    els.slice(0, 60).map((el, i) => ({
      i,
      tag: el.tagName,
      id: el.id,
      className: el.className,
      text: (el.innerText || el.value || '').trim().slice(0, 80),
    }))
  );
  console.log(JSON.stringify(buttons, null, 2));

  console.log('\n=== FORMS ===');
  const forms = await page.$$eval('form', (els) =>
    els.map((el, i) => ({ i, id: el.id, className: el.className, action: el.action }))
  );
  console.log(JSON.stringify(forms, null, 2));

  console.log('\nClose the browser window when done (or press Ctrl+C here).');
  // Keep the script alive until the context closes.
  await new Promise((resolve) => context.on('close', resolve));
})();
