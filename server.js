const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const accountsStore = require('./src/accounts');
const { getContext, closeContext, closeAll } = require('./src/browser');
const { runBulkImport, fetchProfileNames, clearProfileCollections, createProfileInNuvio } = require('./src/importer');

accountsStore.ensureDirs();

const CONFIG_FILE = path.join(__dirname, 'config', 'import-flow.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- file uploads (catalog JSON files) ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, accountsStore.CATALOGS_DIR),
  filename: (req, file, cb) => cb(null, path.basename(file.originalname)),
});
const upload = multer({ storage });

// ---------- in-memory job log ----------
const jobs = new Map(); // id -> { status, logs: [], results }

function createJob() {
  const id = 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const job = { id, status: 'running', logs: [], results: null, createdAt: Date.now() };
  jobs.set(id, job);
  return job;
}

function jobLog(job, msg) {
  job.logs.push({ t: new Date().toISOString(), msg });
  // keep only the last 2000 lines
  if (job.logs.length > 2000) job.logs.splice(0, job.logs.length - 2000);
}

// ---------- accounts ----------
app.get('/api/accounts', (req, res) => {
  res.json(accountsStore.loadAccounts());
});

app.post('/api/accounts', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  const data = accountsStore.loadAccounts();
  const account = { id: accountsStore.newId(), name, email, password };
  data.accounts.push(account);
  accountsStore.saveAccounts(data);
  res.json(account);
});

// ---------- reorder accounts (must be before /:id so "order" isn't treated as an id) ----------
app.put('/api/accounts/order', (req, res) => {
  const { ids = [] } = req.body || {};
  const data = accountsStore.loadAccounts();
  if (!Array.isArray(ids) || ids.length !== data.accounts.length) {
    return res.status(400).json({ error: 'Order must include all accounts' });
  }
  const byId = new Map(data.accounts.map((a) => [a.id, a]));
  data.accounts = ids.map((id) => byId.get(id)).filter(Boolean);
  accountsStore.saveAccounts(data);
  res.json({ ok: true });
});

app.put('/api/accounts/:id', (req, res) => {
  const data = accountsStore.loadAccounts();
  const account = data.accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'not found' });
  const { name, email, password } = req.body || {};
  if (name !== undefined) account.name = name;
  if (email !== undefined) account.email = email;
  if (password !== undefined) account.password = password;
  accountsStore.saveAccounts(data);
  res.json(account);
});

app.delete('/api/accounts/:id', async (req, res) => {
  const data = accountsStore.loadAccounts();
  const idx = data.accounts.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const [removed] = data.accounts.splice(idx, 1);
  accountsStore.saveAccounts(data);
  await closeContext(removed.id);
  res.json({ ok: true });
});

// ---------- profiles ----------
app.post('/api/accounts/:id/profiles', async (req, res) => {
  const data = accountsStore.loadAccounts();
  const account = data.accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'not found' });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (account.profiles.length >= 6) {
    return res.status(400).json({ error: 'Profile limit reached (Nuvio allows 6 profiles per account).' });
  }
  const config = loadConfig();
  try {
    await createProfileInNuvio(account, name, config);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const profile = { id: accountsStore.newProfileId(), name };
  account.profiles.push(profile);
  accountsStore.saveAccounts(data);
  res.json(profile);
});

app.put('/api/accounts/:id/profiles/:profileId', (req, res) => {
  const data = accountsStore.loadAccounts();
  const account = data.accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'not found' });
  const profile = account.profiles.find((p) => p.id === req.params.profileId);
  if (!profile) return res.status(404).json({ error: 'profile not found' });
  const { name } = req.body || {};
  if (name !== undefined) profile.name = name;
  accountsStore.saveAccounts(data);
  res.json(profile);
});

app.delete('/api/accounts/:id/profiles/:profileId', (req, res) => {
  const data = accountsStore.loadAccounts();
  const account = data.accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'not found' });
  const idx = account.profiles.findIndex((p) => p.id === req.params.profileId);
  if (idx === -1) return res.status(404).json({ error: 'profile not found' });
  account.profiles.splice(idx, 1);
  accountsStore.saveAccounts(data);
  res.json({ ok: true });
});

// ---------- clear a profile's collections in Nuvio ----------
app.post('/api/accounts/:accountId/profiles/:profileId/clear-collections', async (req, res) => {
  const data = accountsStore.loadAccounts();
  const account = data.accounts.find((a) => a.id === req.params.accountId);
  if (!account) return res.status(404).json({ error: 'account not found' });
  const profile = account.profiles.find((p) => p.id === req.params.profileId);
  if (!profile) return res.status(404).json({ error: 'profile not found' });

  const config = loadConfig();
  try {
    await clearProfileCollections(account, profile, config);
    res.json({ ok: true, profile: profile.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- sync profiles from Nuvio ----------
app.post('/api/accounts/:id/fetch-profiles', async (req, res) => {
  const data = accountsStore.loadAccounts();
  const account = data.accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'not found' });

  const config = loadConfig();
  try {
    const names = await fetchProfileNames(account, config);
    const existing = new Set(account.profiles.map((p) => p.name));
    const added = [];
    for (const name of names) {
      if (!existing.has(name)) {
        account.profiles.push({ id: accountsStore.newProfileId(), name });
        added.push(name);
      }
    }
    accountsStore.saveAccounts(data);
    res.json({ found: names, added, profiles: account.profiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- open / switch account (headed browser with its own profile) ----------
app.post('/api/accounts/:id/open', async (req, res) => {
  const data = accountsStore.loadAccounts();
  const account = data.accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'not found' });

  const config = loadConfig();
  try {
    const context = await getContext(account.id, { headless: false });
    const pages = context.pages();
    const page = pages.length ? pages[0] : await context.newPage();
    await page.goto(config.urls.account, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    res.json({ ok: true, note: 'Browser opened. If asked to sign in, sign in once — the session is saved for this account.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts/:id/login', async (req, res) => {
  const data = accountsStore.loadAccounts();
  const account = data.accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'not found' });

  const config = loadConfig();
  try {
    const context = await getContext(account.id, { headless: false });
    const pages = context.pages();
    const page = pages.length ? pages[0] : await context.newPage();
    await page.goto(config.urls.login || config.urls.account, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    res.json({ ok: true, note: 'Sign in once in the opened window — the session is saved.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- catalogs ----------
app.get('/api/catalogs', (req, res) => {
  res.json(accountsStore.listCatalogFiles());
});

app.post('/api/catalogs', upload.array('files'), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }
  res.json({ ok: true, files: req.files.map((f) => f.filename) });
});

app.delete('/api/catalogs/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const filePath = path.join(accountsStore.CATALOGS_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });
  fs.unlinkSync(filePath);
  res.json({ ok: true, deleted: name });
});

// ---------- bulk import ----------
app.post('/api/import', (req, res) => {
  const { assignments = [] } = req.body || {};
  if (!assignments.length) return res.status(400).json({ error: 'Select at least one profile + file' });

  const data = accountsStore.loadAccounts();
  const filesByName = {};
  for (const f of accountsStore.listCatalogFiles()) filesByName[f.name] = f;

  const jobs = [];
  for (const a of assignments) {
    if (!a || !a.profileId || !a.fileName) continue;
    const file = filesByName[a.fileName];
    if (!file) continue;
    let account = null;
    let profile = null;
    for (const acc of data.accounts) {
      const p = acc.profiles.find((pp) => pp.id === a.profileId);
      if (p) { account = acc; profile = p; break; }
    }
    if (account) jobs.push({ account, profile, file });
  }

  if (jobs.length === 0) return res.status(400).json({ error: 'No valid profile+file assignments' });

  const config = loadConfig();
  const job = createJob();
  jobLog(job, `Starting import: ${jobs.length} profile import(s)`);

  const progress = {
    accountsDone: 0,
    accountsTotal: jobs.length,
    filesDone: 0,
    filesTotal: jobs.length,
    log: (msg) => jobLog(job, msg),
  };

  runBulkImport(jobs, config, progress)
    .then((results) => {
      job.results = results;
      job.status = 'done';
      jobLog(job, 'Import finished.');
    })
    .catch((err) => {
      job.status = 'error';
      jobLog(job, 'FATAL: ' + err.message);
    });

  res.json({ jobId: job.id });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

// ---------- config (view only, for the UI to show hints) ----------
app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

const PORT = process.env.PORT || 4123;
app.listen(PORT, () => {
  accountsStore.ensureDirs();
  console.log(`Nuvio Collection Manager running at http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  await closeAll();
  process.exit(0);
});
