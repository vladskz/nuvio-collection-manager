const state = {
  accounts: [],
  catalogs: [],
  profileFile: {}, // profileId -> fileName
  polling: null,
};

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- accounts ----------
async function loadAccounts() {
  const data = await api('/api/accounts');
  state.accounts = data.accounts || [];
  renderAccounts();
  renderImportAccounts();
}

function renderAccounts() {
  const list = document.getElementById('accounts-list');
  if (!state.accounts.length) {
    list.innerHTML = '<div class="hint">No accounts yet. Add your first account above.</div>';
    return;
  }
  list.innerHTML = '';
  for (const acc of state.accounts) {
    const block = document.createElement('div');
    block.className = 'account-block';

    const head = document.createElement('div');
    head.className = 'item';
    head.innerHTML = `
      <div class="info">
        <div class="name"></div>
        <div class="sub"></div>
      </div>
      <button data-act="open">Open</button>
      <button data-act="login">Sign in</button>
      <button data-act="sync">Sync profiles</button>
      <button data-act="rename">Rename</button>
      <button data-act="delete" class="danger">Delete</button>
    `;
    head.querySelector('.name').textContent = acc.name;
    head.querySelector('.sub').textContent = acc.email;
    head.querySelector('[data-act="open"]').onclick = () => openAccount(acc.id);
    head.querySelector('[data-act="login"]').onclick = () => loginAccount(acc.id);
    head.querySelector('[data-act="sync"]').onclick = () => syncProfiles(acc.id);
    head.querySelector('[data-act="rename"]').onclick = () => renameAccountInline(acc, head);
    head.querySelector('[data-act="delete"]').onclick = () => deleteAccount(acc.id);
    block.appendChild(head);

    const profBox = document.createElement('div');
    profBox.className = 'profiles';
    const profTitle = document.createElement('div');
    profTitle.className = 'sub-title';
    profTitle.textContent = 'Profiles';
    profBox.appendChild(profTitle);

    for (const p of acc.profiles || []) {
      const row = document.createElement('div');
      row.className = 'profile-row';
      const label = document.createElement('span');
      label.className = 'profile-label';
      label.textContent = p.name;
      const del = document.createElement('button');
      del.className = 'danger small';
      del.textContent = 'Delete';
      del.onclick = () => deleteProfile(acc.id, p.id);
      row.appendChild(label);
      row.appendChild(del);
      profBox.appendChild(row);
    }

    const addRow = document.createElement('div');
    addRow.className = 'row';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Profile name';
    const addBtn = document.createElement('button');
    addBtn.textContent = 'Add profile';
    addBtn.onclick = () => addProfile(acc.id, nameInput.value);
    addRow.appendChild(nameInput);
    addRow.appendChild(addBtn);
    profBox.appendChild(addRow);

    block.appendChild(profBox);
    list.appendChild(block);
  }
}

async function openAccount(id) {
  setStatus(`Opening account…`);
  try {
    const r = await api(`/api/accounts/${id}/open`, { method: 'POST' });
    setStatus(r.note || 'Opened.');
  } catch (e) {
    setStatus('Error: ' + e.message, true);
  }
}

async function loginAccount(id) {
  setStatus(`Opening sign-in page…`);
  try {
    const r = await api(`/api/accounts/${id}/login`, { method: 'POST' });
    setStatus(r.note || 'Sign in opened.');
  } catch (e) {
    setStatus('Error: ' + e.message, true);
  }
}

async function syncProfiles(id) {
  setStatus('Fetching profiles from Nuvio…');
  try {
    const r = await api(`/api/accounts/${id}/fetch-profiles`, { method: 'POST' });
    setStatus(r.added.length ? `Added ${r.added.length} profile(s): ${r.added.join(', ')}` : 'No new profiles found.');
    await loadAccounts();
  } catch (e) {
    setStatus('Error: ' + e.message, true);
  }
}

function renameAccountInline(acc, head) {
  const nameEl = head.querySelector('.name');
  const current = acc.name;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'rename-input';
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    if (save && newName && newName !== current) {
      try {
        await api(`/api/accounts/${acc.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        });
      } catch (e) {
        setStatus('Error: ' + e.message, true);
      }
    }
    await loadAccounts();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

async function deleteAccount(id) {
  if (!confirm('Delete this account? Its saved browser session will also be closed.')) return;
  await api(`/api/accounts/${id}`, { method: 'DELETE' });
  await loadAccounts();
}

async function addProfile(accountId, name) {
  if (!name.trim()) return setStatus('Profile name is required.', true);
  await api(`/api/accounts/${accountId}/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() }),
  });
  await loadAccounts();
}

async function deleteProfile(accountId, profileId) {
  if (!confirm('Delete this profile?')) return;
  await api(`/api/accounts/${accountId}/profiles/${profileId}`, { method: 'DELETE' });
  await loadAccounts();
}

document.getElementById('account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('acc-name').value.trim();
  const email = document.getElementById('acc-email').value.trim();
  const password = document.getElementById('acc-password').value;
  if (!name || !email || !password) return;
  const account = await api('/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  });
  e.target.reset();
  await loadAccounts();
  // Auto-pull the account's profiles from Nuvio right after adding it.
  syncProfiles(account.id);
});

// ---------- catalogs ----------
async function loadCatalogs() {
  const files = await api('/api/catalogs');
  state.catalogs = files || [];
  renderCatalogs();
  renderImportAccounts();
}

function renderCatalogs() {
  const list = document.getElementById('catalogs-list');
  if (!state.catalogs.length) {
    list.innerHTML = '<div class="hint">No JSON files yet. Upload the catalog files you want to import.</div>';
    return;
  }
  list.innerHTML = '';
  for (const f of state.catalogs) {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<div class="info"><div class="name"></div></div>`;
    div.querySelector('.name').textContent = f.name;
    list.appendChild(div);
  }
}

document.getElementById('upload-btn').addEventListener('click', async () => {
  const input = document.getElementById('catalog-files');
  if (!input.files.length) {
    setStatus('Choose one or more JSON files first.', true);
    return;
  }
  const form = new FormData();
  for (const file of input.files) form.append('files', file);
  setStatus('Uploading…');
  try {
    await api('/api/catalogs', { method: 'POST', body: form });
    input.value = '';
    setStatus('Uploaded.');
    await loadCatalogs();
  } catch (e) {
    setStatus('Upload error: ' + e.message, true);
  }
});

// ---------- import ----------
function renderImportAccounts() {
  const list = document.getElementById('import-accounts');
  if (!state.accounts.length) {
    list.innerHTML = '<div class="hint">Add accounts and profiles above first.</div>';
    return;
  }
  if (!state.catalogs.length) {
    list.innerHTML = '<div class="hint">Upload at least one catalog JSON file first.</div>';
    return;
  }
  list.innerHTML = '';
  for (const acc of state.accounts) {
    const group = document.createElement('div');
    group.className = 'import-group';

    const header = document.createElement('div');
    header.className = 'import-header';
    header.textContent = acc.name;
    group.appendChild(header);

    const profiles = acc.profiles || [];
    if (!profiles.length) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'No profiles — add one in the Accounts section.';
      group.appendChild(hint);
    }
    for (const p of profiles) {
      const row = document.createElement('div');
      row.className = 'item';
      row.innerHTML = `<div class="info"><div class="name"></div><div class="sub"></div></div>`;
      row.querySelector('.name').textContent = p.name;
      row.querySelector('.sub').textContent = 'catalog file to import';

      const select = document.createElement('select');
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '— skip —';
      select.appendChild(none);
      for (const f of state.catalogs) {
        const opt = document.createElement('option');
        opt.value = f.name;
        opt.textContent = f.name;
        select.appendChild(opt);
      }
      select.value = state.profileFile[p.id] || '';
      select.onchange = () => {
        if (select.value) state.profileFile[p.id] = select.value;
        else delete state.profileFile[p.id];
      };
      row.appendChild(select);
      group.appendChild(row);
    }
    list.appendChild(group);
  }
}

document.getElementById('run-import-btn').addEventListener('click', async () => {
  const assignments = Object.entries(state.profileFile).map(([profileId, fileName]) => ({ profileId, fileName }));
  if (!assignments.length) return setStatus('Assign at least one profile to a catalog file.', true);

  setStatus('Starting import…');
  clearLog();
  try {
    const { jobId } = await api('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments }),
    });
    pollJob(jobId);
  } catch (e) {
    setStatus('Error: ' + e.message, true);
  }
});

function pollJob(jobId) {
  if (state.polling) clearInterval(state.polling);
  state.polling = setInterval(async () => {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      renderLog(job.logs || []);
      if (job.status === 'running') {
        setStatus(`Importing… ${job.logs.length} log lines`);
      } else {
        clearInterval(state.polling);
        state.polling = null;
        setStatus(job.status === 'done' ? 'Import finished.' : 'Import ended with an error.');
      }
    } catch (e) {
      clearInterval(state.polling);
      state.polling = null;
      setStatus('Polling error: ' + e.message, true);
    }
  }, 1000);
}

// ---------- status / log helpers ----------
function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.style.color = isError ? '#b91c1c' : '#1f2937';
}

function renderLog(logs) {
  const el = document.getElementById('log');
  el.textContent = logs.map((l) => `${l.msg}`).join('\n');
  el.scrollTop = el.scrollHeight;
}

function clearLog() {
  document.getElementById('log').textContent = '';
}

// ---------- tab navigation ----------
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('panel-' + tab).classList.add('active');
    document.getElementById('page-title').textContent = btn.textContent;
  });
});

// ---------- init ----------
(async function init() {
  await Promise.all([loadAccounts(), loadCatalogs()]);
})();
