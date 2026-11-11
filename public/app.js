const state = {
  accounts: [],
  catalogs: [],
  profileFile: {}, // profileId -> fileName
  polling: null,
  collapsed: new Set(), // account ids that are collapsed
  draggedId: null,
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
    updateCollapseAllButton();
    return;
  }
  list.innerHTML = '';
  for (const acc of state.accounts) {
    const isCollapsed = state.collapsed.has(acc.id);
    const block = document.createElement('div');
    block.className = 'account-block' + (isCollapsed ? ' collapsed' : '');
    block.dataset.id = acc.id;
    block.draggable = true;

    const head = document.createElement('div');
    head.className = 'item account-head';

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'collapse-btn';
    collapseBtn.title = isCollapsed ? 'Expand' : 'Collapse';
    collapseBtn.textContent = isCollapsed ? '▸' : '▾';
    collapseBtn.onclick = () => toggleCollapse(acc.id);
    head.appendChild(collapseBtn);

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.title = 'Drag to reorder';
    handle.textContent = '≡';
    head.appendChild(handle);

    const info = document.createElement('div');
    info.className = 'info';
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = acc.name;
    const subEl = document.createElement('div');
    subEl.className = 'sub';
    subEl.textContent = acc.email;
    info.appendChild(nameEl);
    info.appendChild(subEl);
    head.appendChild(info);

    const mk = (label, cls, handler) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = handler;
      return b;
    };
    head.appendChild(mk('Open', '', () => openAccount(acc.id)));
    head.appendChild(mk('Sign in', '', () => loginAccount(acc.id)));
    head.appendChild(mk('Sync profiles', '', () => syncProfiles(acc.id)));
    head.appendChild(mk('Rename', '', () => renameAccountInline(acc, head)));
    head.appendChild(mk('Delete', 'danger', () => deleteAccount(acc.id)));

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
      const clearBtn = document.createElement('button');
      clearBtn.className = 'warn small';
      clearBtn.textContent = 'Clear collections';
      clearBtn.onclick = () => clearProfileCollections(acc.id, p.id, p.name);
      const del = document.createElement('button');
      del.className = 'danger small';
      del.textContent = 'Delete';
      del.onclick = () => deleteProfile(acc.id, p.id);
      row.appendChild(label);
      row.appendChild(clearBtn);
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

    block.addEventListener('dragstart', (e) => {
      if (e.target.closest('button, input, select')) { e.preventDefault(); return; }
      state.draggedId = acc.id;
      block.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', acc.id); } catch (_) {}
    });
    block.addEventListener('dragend', () => {
      state.draggedId = null;
      block.classList.remove('dragging');
    });
    block.addEventListener('dragover', (e) => {
      if (state.draggedId && state.draggedId !== acc.id) {
        e.preventDefault();
        block.classList.add('drag-over');
      }
    });
    block.addEventListener('dragleave', () => block.classList.remove('drag-over'));
    block.addEventListener('drop', (e) => {
      e.preventDefault();
      block.classList.remove('drag-over');
      dropOn(acc.id);
    });

    list.appendChild(block);
  }
  updateCollapseAllButton();
}

function toggleCollapse(id) {
  if (state.collapsed.has(id)) state.collapsed.delete(id);
  else state.collapsed.add(id);
  localStorage.setItem('nuvio-collapsed-accounts', JSON.stringify([...state.collapsed]));
  renderAccounts();
}

function toggleCollapseAll() {
  const allCollapsed = state.accounts.length > 0 && state.accounts.every((a) => state.collapsed.has(a.id));
  if (allCollapsed) state.collapsed.clear();
  else for (const a of state.accounts) state.collapsed.add(a.id);
  localStorage.setItem('nuvio-collapsed-accounts', JSON.stringify([...state.collapsed]));
  renderAccounts();
}

function updateCollapseAllButton() {
  const btn = document.getElementById('collapse-all-btn');
  if (!btn) return;
  const allCollapsed = state.accounts.length > 0 && state.accounts.every((a) => state.collapsed.has(a.id));
  btn.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
}

async function dropOn(targetId) {
  const fromId = state.draggedId;
  if (!fromId || fromId === targetId) return;
  const from = state.accounts.findIndex((a) => a.id === fromId);
  const to = state.accounts.findIndex((a) => a.id === targetId);
  if (from === -1 || to === -1) return;
  const [moved] = state.accounts.splice(from, 1);
  state.accounts.splice(to, 0, moved);
  state.draggedId = null;
  renderAccounts();
  try {
    await api('/api/accounts/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: state.accounts.map((a) => a.id) }),
    });
  } catch (e) {
    setStatus('Error saving order: ' + e.message, true);
  }
}

async function openAccount(id) {
  setStatus(`Opening account…`);
  try {
    const r = await api(`/api/accounts/${id}/open`, { method: 'POST' });
    setStatus(r.note || 'Opened.', 'success');
  } catch (e) {
    setStatus('Error: ' + e.message, true);
  }
}

async function loginAccount(id) {
  setStatus(`Opening sign-in page…`);
  try {
    const r = await api(`/api/accounts/${id}/login`, { method: 'POST' });
    setStatus(r.note || 'Sign in opened.', 'success');
  } catch (e) {
    setStatus('Error: ' + e.message, true);
  }
}

async function syncProfiles(id) {
  setStatus('Fetching profiles from Nuvio…');
  try {
    const r = await api(`/api/accounts/${id}/fetch-profiles`, { method: 'POST' });
    setStatus(r.added.length ? `Added ${r.added.length} profile(s): ${r.added.join(', ')}` : 'No new profiles found.', 'success');
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
  setStatus(`Creating profile "${name.trim()}" in Nuvio…`);
  try {
    await api(`/api/accounts/${accountId}/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    setStatus(`Created profile "${name.trim()}".`, 'success');
    await loadAccounts();
  } catch (e) {
    setStatus('Error: ' + e.message, true);
  }
}

async function deleteProfile(accountId, profileId) {
  if (!confirm('Delete this profile?')) return;
  await api(`/api/accounts/${accountId}/profiles/${profileId}`, { method: 'DELETE' });
  await loadAccounts();
}

async function clearProfileCollections(accountId, profileId, profileName) {
  if (!confirm(`Delete ALL collections for profile "${profileName}" in Nuvio? This cannot be undone.`)) return;
  setStatus(`Clearing collections for "${profileName}"…`);
  try {
    await api(`/api/accounts/${accountId}/profiles/${profileId}/clear-collections`, { method: 'POST' });
    setStatus(`Cleared collections for "${profileName}".`, 'success');
  } catch (e) {
    setStatus('Error: ' + e.message, true);
  }
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
  setStatus('Account added.', 'success');
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
    div.innerHTML = `
      <div class="info"><div class="name"></div></div>
      <button data-act="del" class="danger small">Delete</button>
    `;
    div.querySelector('.name').textContent = f.name;
    div.querySelector('[data-act="del"]').onclick = () => deleteCatalog(f.name);
    list.appendChild(div);
  }
}

async function deleteCatalog(name) {
  if (!confirm(`Delete "${name}"?`)) return;
  try {
    await api(`/api/catalogs/${encodeURIComponent(name)}`, { method: 'DELETE' });
    for (const [pid, fileName] of Object.entries(state.profileFile)) {
      if (fileName === name) delete state.profileFile[pid];
    }
    setStatus(`Deleted ${name}.`, 'success');
    await loadCatalogs();
  } catch (e) {
    setStatus('Error: ' + e.message, true);
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
    setStatus('Uploaded.', 'success');
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
        setStatus(job.status === 'done' ? 'Import finished.' : 'Import ended with an error.',
          job.status === 'done' ? 'success' : 'error');
      }
    } catch (e) {
      clearInterval(state.polling);
      state.polling = null;
      setStatus('Polling error: ' + e.message, true);
    }
  }, 1000);
}

// ---------- status / log helpers ----------
function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  if (type === true || type === 'error') {
    el.style.color = '#f87171';
    el.style.fontWeight = '600';
  } else if (type === 'success') {
    el.style.color = '#34d399';
    el.style.fontWeight = '600';
  } else {
    el.style.color = 'var(--muted)';
    el.style.fontWeight = '400';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderLog(logs) {
  const el = document.getElementById('log');
  el.innerHTML = logs.map((l) => {
    const cls = /ERROR|FATAL|error|failed/i.test(l.msg)
      ? 'log-error'
      : /imported|finished|signed in|switched|chose|already on|collection set/i.test(l.msg)
        ? 'log-ok'
        : '';
    return `<div class="${cls}">${escapeHtml(l.msg)}</div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function clearLog() {
  document.getElementById('log').textContent = '';
}

// ---------- collapse all button ----------
document.getElementById('collapse-all-btn').addEventListener('click', toggleCollapseAll);

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
  try {
    state.collapsed = new Set(JSON.parse(localStorage.getItem('nuvio-collapsed-accounts') || '[]'));
  } catch (_) { /* ignore */ }
  await Promise.all([loadAccounts(), loadCatalogs()]);
})();
