# Nuvio Collection Manager

A local web dashboard that makes it easy to:

- **Switch between your Nuvio accounts instantly** — each account gets its own
  browser profile, so after you sign in once you never sign out/in again.
- **Bulk-import catalogs** — pick several JSON catalog files and several accounts,
  and the tool uploads them one by one using your saved sessions.

Everything runs on your own machine. Passwords are stored in a local file
(`data/accounts.json`) — never sent anywhere.

## Setup

1. Install dependencies (this also downloads a Chromium browser):

   ```powershell
   npm install
   npx playwright install chromium
   ```

2. Start the dashboard:

   ```powershell
   npm start
   ```

3. Open http://localhost:4123 in your browser.

## First-time setup per account

1. In the **Accounts** box, add an account (name, email, password).
2. Click **Open** next to it. A browser window opens at nuvio.tv.
3. If it asks you to sign in, sign in **once**. The session is saved for that
   account automatically (cookies/local storage live in `data/profiles/<id>/`).
4. Repeat for your other accounts.

After that, clicking **Open** on any account takes you straight into it — no
sign-out/sign-in dance.

## Importing catalogs in bulk

Nuvio's collections are **per profile** — importing replaces the collections of
whichever profile is active. So the tool works profile-by-profile:

1. In each account's **Profiles** box, add the profiles you work with (just the
   profile name, e.g. "skz", "ale", "TEST").
2. Upload your JSON catalog files in the **Catalogs** box.
3. In the **Bulk import** box, each profile has a dropdown — pick the catalog
   JSON file to import into that profile (or leave "— skip —").
4. Click **Import selected catalogs into selected accounts** and watch the log.

For each assignment the tool opens that account, switches to the chosen profile
(via the top-right profile menu), clicks **Import** on the Collections page, and
picks the JSON file. If an account is not signed in, it signs in automatically
using the stored email/password.

## Page selectors

The flow is config-driven via `config/import-flow.json` and is already filled in
from a live inspection of nuvio.tv. If the site changes, adjust these:

- `urls.login` — `https://nuvio.tv/account/login`.
- `login.emailSelector` / `passwordSelector` / `submitSelector` — the sign-in
  form fields (automatic sign-in during bulk import).
- `profile.switchSelector` — `button.nv-profile-trigger` (the top-right profile
  menu button).
- `profile.itemSelector` — `button.nv-profile-option` (the profile entries,
  matched by name).
- `profile.activeNameSelector` — `.nv-profile-trigger-name` (used to check which
  profile is active before switching).
- `import.importButtonSelector` — the **Import** button on the Collections page.
- `import.confirmButtonSelector` / `import.successSelector` — optional, only if
  the site adds a confirmation step or success toast.

To inspect the live page again (to re-check selectors), run:

```powershell
npm run inspect -- "Account Name" collections
```

## Notes & security

- `data/accounts.json`, `data/profiles/`, and `data/catalogs/` are git-ignored.
- Passwords are stored in plain text locally because you chose that option. Keep
  this folder private.
- The bulk import defaults to a visible browser (`import.headless: false`) so you
  can watch what happens. Set it to `true` to run in the background.
