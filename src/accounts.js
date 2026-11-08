const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const CATALOGS_DIR = path.join(DATA_DIR, 'catalogs');

function ensureDirs() {
  for (const dir of [DATA_DIR, PROFILES_DIR, CATALOGS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ accounts: [] }, null, 2));
  }
}

function loadAccounts() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.accounts)) data.accounts = [];
    for (const acc of data.accounts) {
      if (!Array.isArray(acc.profiles)) acc.profiles = [];
      for (const p of acc.profiles) {
        if (!p.id) p.id = newProfileId();
      }
    }
    return data;
  } catch (err) {
    return { accounts: [] };
  }
}

function saveAccounts(data) {
  ensureDirs();
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
}

function newId() {
  return 'acct_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function newProfileId() {
  return 'prof_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function listCatalogFiles() {
  ensureDirs();
  if (!fs.existsSync(CATALOGS_DIR)) return [];
  return fs
    .readdirSync(CATALOGS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((f) => ({ name: f, path: path.join(CATALOGS_DIR, f) }));
}

module.exports = {
  DATA_DIR,
  ACCOUNTS_FILE,
  PROFILES_DIR,
  CATALOGS_DIR,
  ensureDirs,
  loadAccounts,
  saveAccounts,
  newId,
  newProfileId,
  listCatalogFiles,
};
