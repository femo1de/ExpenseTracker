# Trip Expenses

A lightweight, zero-dependency web app for two partners to track shared trip expenses and running balances—hosted directly on GitHub Pages with no external backend or user accounts.

## Features

- **Mobile-first & desktop responsive** (installable to iOS/Android Home Screen as a PWA).
- **Simple partner unlock**: Each partner gets their own password, which decrypts a repo-scoped Fine-Grained GitHub PAT locally in the browser using Web Crypto (`PBKDF2-SHA256` + `AES-256-GCM`). No plaintext token is ever stored in the repo.
- **Any currency + auto FX conversion to SGD**: Fetches live exchange rates automatically (`open.er-api.com` with `frankfurter.dev` fallback, 6-hour local cache) with manual override for offline use or exact credit-card rates.
- **Flexible splits & paybacks**: Split expenses evenly (50/50) or by exact custom amounts, or record a payback / one-tap **Settle Up**.
- **Running total + per-currency breakdown**: Shows who owes whom in `SGD` alongside an expandable per-currency breakdown.
- **JSON storage on a dedicated `data` branch**: Saves `expenses.json` on an orphan `data` branch (auto-created on first expense) so saving expenses never triggers GitHub Pages rebuilds, with automatic `409 Conflict` merge retries if both partners save simultaneously.

---

## Setup & Deployment (`femo1de/ExpenseTracker`)

### 1. Create the GitHub repository

Create a new repository named **`ExpenseTracker`** under your **`femo1de`** GitHub account.

- On a **Free** GitHub account, GitHub Pages requires the hosting repo (`femo1de/ExpenseTracker`) to be **Public**.
- *(Optional)* If you want your expense history to stay **Private** on a Free GitHub account, create a second **Private** repo (e.g., `femo1de/ExpenseTracker-data`) and point the setup script's "Data repository name" to `ExpenseTracker-data`.

### 2. Create a Fine-Grained Personal Access Token

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Set **Repository access** to **Only select repositories** → pick `femo1de/ExpenseTracker` (or `femo1de/ExpenseTracker-data` if using a private data repo).
3. Under **Repository permissions**, grant **ONLY**:
   - **Contents**: `Read and write`
   - Leave all other permissions as `No access`.
4. Copy the generated `github_pat_...` token.

### 3. Generate `config.js` (Encrypted Token)

From `D:\Code\ExpenseTracker`, run:

```powershell
node scripts/setup-config.mjs
```

Enter your app title, home currency (`SGD`), GitHub repo details, both partner display names, each partner's password, and the Fine-Grained PAT. This writes `config.js` containing only encrypted blobs (safe from GitHub secret scanning revocation).

### 4. Push & Enable GitHub Pages

```powershell
git add .
git commit -m "Initial Trip Expenses webapp"
git remote add origin https://github.com/femo1de/ExpenseTracker.git
git push -u origin main
```

Then in GitHub:
1. Open **`femo1de/ExpenseTracker` → Settings → Pages**.
2. Under **Build and deployment**, set Source to **Deploy from a branch**, select **`main`** and **`/ (root)`**, and click **Save**.
3. Your app will be live at **`https://femo1de.github.io/ExpenseTracker/`**.

*(The `data` branch and `expenses.json` are created automatically the first time you save an expense.)*

### 5. Add to Phone Home Screen

- **iPhone (Safari)**: Open `https://femo1de.github.io/ExpenseTracker/` → Share → **Add to Home Screen**.
- **Android (Chrome)**: Open the URL → Menu (`⋮`) → **Add to Home screen / Install app**.

---

## Local Testing & Demo Mode

Before configuring GitHub, you can preview the app locally with Demo Mode (stores sample data in `localStorage`):

```powershell
# Run unit tests (Node 20+)
node --test tests/*.test.mjs

# Serve locally (e.g. with Python or npx serve)
python -m http.server 8080
# Then open http://localhost:8080
```
