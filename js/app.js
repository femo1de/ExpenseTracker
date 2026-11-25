import { CONFIG } from "../config.js";
import { decryptToken, isUserConfigured } from "./crypto.js";
import {
  calculateBalances,
  computeEvenSplit,
  createEmptyLedger,
  createExpenseEntry,
  createSettlementEntry,
  deleteEntry,
  getAllTags,
  getCurrencyDecimals,
  getEntryImpactForUser,
  normalizeTags,
  roundCurrency,
  sortEntriesNewestFirst,
  upsertEntry,
} from "./ledger.js";
import { POPULAR_CURRENCIES, fetchExchangeRate, formatMoney, formatRate } from "./fx.js";
import { createGitHubStorage, createLocalDemoStorage } from "./github-storage.js";

const SESSION_STORAGE_KEY = "trip_expenses_session_v1";
const LAST_CURRENCY_KEY = "trip_expenses_last_currency_v1";
const CUSTOM_CURRENCY_VALUE = "__CUSTOM__";

const users = CONFIG.users;
const userIds = users.map((u) => u.id);
const homeCurrency = String(CONFIG.homeCurrency || "SGD").toUpperCase();

const state = {
  selectedLoginUserId: userIds[0],
  currentUser: null,
  storage: null,
  ledger: createEmptyLedger(homeCurrency),
  filter: "all",
  selectedTag: "",
  search: "",
  breakdownExpanded: true,
  isSaving: false,
  expPaidBy: userIds[0],
  expSplitMode: "even",
  payPaidBy: userIds[1],
  pendingDeleteId: null,
};

const el = (id) => document.getElementById(id);

function getUserById(id) {
  return users.find((u) => u.id === id) || users[0];
}

function getUserName(id) {
  return getUserById(id)?.name || id;
}

function getOtherUserId(id) {
  return userIds.find((uid) => uid !== id) || userIds[0];
}

function todayIsoDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getLastCurrency() {
  try {
    return localStorage.getItem(LAST_CURRENCY_KEY) || homeCurrency;
  } catch {
    return homeCurrency;
  }
}

function setLastCurrency(code) {
  try {
    localStorage.setItem(LAST_CURRENCY_KEY, String(code).toUpperCase());
  } catch {
    // ignore storage errors
  }
}

let toastTimer = null;
function showToast(message, isError = false) {
  const toast = el("toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 3200);
}

function setSyncStatus(text, kind = "ok") {
  const pill = el("sync-status");
  pill.textContent = text;
  pill.className = `sync-pill ${kind}`;
}

function populateCurrencySelect(selectEl, preferredCode) {
  selectEl.innerHTML = "";
  const seen = new Set();

  const homeItem = POPULAR_CURRENCIES.find((c) => c.code === homeCurrency) || {
    code: homeCurrency,
    name: homeCurrency,
  };
  const ordered = [homeItem, ...POPULAR_CURRENCIES.filter((c) => c.code !== homeCurrency)];

  for (const curr of ordered) {
    if (seen.has(curr.code)) continue;
    seen.add(curr.code);
    const opt = document.createElement("option");
    opt.value = curr.code;
    opt.textContent = `${curr.code} — ${curr.name}`;
    selectEl.appendChild(opt);
  }

  const customOpt = document.createElement("option");
  customOpt.value = CUSTOM_CURRENCY_VALUE;
  customOpt.textContent = "Other currency...";
  selectEl.appendChild(customOpt);

  const normalized = String(preferredCode || homeCurrency).toUpperCase();
  if (seen.has(normalized)) {
    selectEl.value = normalized;
  } else {
    selectEl.value = CUSTOM_CURRENCY_VALUE;
  }
}

function getSelectedCurrency(prefix) {
  const selectVal = el(`${prefix}-currency`).value;
  if (selectVal === CUSTOM_CURRENCY_VALUE) {
    return el(`${prefix}-custom-currency`).value.trim().toUpperCase();
  }
  return selectVal;
}

function setCurrencySelection(prefix, code) {
  const normalized = String(code || homeCurrency).toUpperCase();
  const selectEl = el(`${prefix}-currency`);
  const hasOption = Array.from(selectEl.options).some((opt) => opt.value === normalized);
  if (hasOption) {
    selectEl.value = normalized;
    el(`${prefix}-custom-currency-row`).classList.add("hidden");
    el(`${prefix}-custom-currency`).value = "";
  } else {
    selectEl.value = CUSTOM_CURRENCY_VALUE;
    el(`${prefix}-custom-currency-row`).classList.remove("hidden");
    el(`${prefix}-custom-currency`).value = normalized;
  }
}

// ---- Login & Session ----

function renderLoginUserPicker() {
  const container = el("login-user-picker");
  container.innerHTML = "";
  for (const user of users) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `seg-btn${state.selectedLoginUserId === user.id ? " active" : ""}`;
    btn.textContent = user.name;
    btn.addEventListener("click", () => {
      state.selectedLoginUserId = user.id;
      renderLoginUserPicker();
      el("login-password").focus();
    });
    container.appendChild(btn);
  }
}

function saveLocalSession(userId, token, mode) {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ userId, token, mode }));
  } catch {
    // ignore storage errors
  }
}

function readLocalSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearLocalSession() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

async function enterDashboard(user, token, mode = "github") {
  state.currentUser = user;
  if (mode === "demo") {
    state.storage = createLocalDemoStorage(homeCurrency, userIds);
  } else {
    state.storage = createGitHubStorage({
      owner: CONFIG.github.owner,
      repo: CONFIG.github.repo,
      branch: CONFIG.github.branch,
      filePath: CONFIG.github.filePath,
      token,
      homeCurrency,
    });
  }

  el("login-view").classList.add("hidden");
  el("dashboard-view").classList.remove("hidden");
  el("app-title").textContent = CONFIG.appName || "Trip Expenses";
  el("current-user-pill").textContent = user.name;
  el("home-currency-badge").textContent = homeCurrency;
  el("stat-user-a-label").textContent = `${users[0].name} Paid`;
  el("stat-user-b-label").textContent = `${users[1].name} Paid`;

  await refreshLedger();
}

async function refreshLedger(showNotification = false) {
  if (!state.storage) return;
  setSyncStatus("Syncing...", "syncing");
  el("refresh-btn").disabled = true;

  try {
    const { data } = await state.storage.load();
    state.ledger = data;
    renderDashboard();
    if (state.storage.mode === "demo") {
      setSyncStatus("Demo mode", "demo");
    } else {
      setSyncStatus("Synced", "ok");
    }
    if (showNotification) {
      showToast("Up to date");
    }
  } catch (err) {
    setSyncStatus("Sync failed", "error");
    showToast(err.message || "Could not load expenses.", true);
  } finally {
    el("refresh-btn").disabled = false;
  }
}

function signOut() {
  clearLocalSession();
  state.currentUser = null;
  state.storage = null;
  el("dashboard-view").classList.add("hidden");
  el("login-view").classList.remove("hidden");
  el("login-password").value = "";
  el("login-error").classList.add("hidden");
}

// ---- Dashboard Rendering ----

function formatDateHeading(dateStr) {
  const today = todayIsoDate();
  if (dateStr === today) return "Today";

  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yStr = `${yesterdayDate.getFullYear()}-${String(yesterdayDate.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(yesterdayDate.getDate()).padStart(2, "0")}`;
  if (dateStr === yStr) return "Yesterday";

  const parsed = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateStr;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

function renderDashboard() {
  const balances = calculateBalances(state.ledger.entries, userIds, homeCurrency);
  const currentId = state.currentUser.id;

  const headlineEl = el("balance-headline");
  const amountEl = el("balance-amount");
  const subtextEl = el("balance-subtext");
  const settleWrap = el("settle-cta-wrap");

  if (balances.isSettled) {
    headlineEl.textContent = "All settled up!";
    amountEl.textContent = formatMoney(0, homeCurrency);
    amountEl.className = "balance-amount settled";
    subtextEl.textContent =
      balances.expenseCount === 0
        ? "Add your first trip expense to start tracking."
        : `${balances.expenseCount} expense${balances.expenseCount === 1 ? "" : "s"} recorded.`;
    settleWrap.classList.add("hidden");
  } else {
    const debtorName = getUserName(balances.debtorId);
    const creditorName = getUserName(balances.creditorId);
    const youOwe = balances.debtorId === currentId;

    headlineEl.textContent = youOwe
      ? `You owe ${creditorName}`
      : `${debtorName} owes you`;
    amountEl.textContent = formatMoney(balances.owedAmountHome, homeCurrency);
    amountEl.className = `balance-amount ${youOwe ? "negative" : "positive"}`;
    subtextEl.textContent = `${debtorName} → ${creditorName} (converted to ${homeCurrency})`;
    settleWrap.classList.remove("hidden");
  }

  el("stat-total-spent").textContent = formatMoney(balances.totalSpentHome, homeCurrency);
  el("stat-user-a-paid").textContent = formatMoney(balances.paidByUserHome[userIds[0]], homeCurrency);
  el("stat-user-b-paid").textContent = formatMoney(balances.paidByUserHome[userIds[1]], homeCurrency);

  // Per-currency breakdown
  const breakdownWrap = el("currency-breakdown-wrap");
  const breakdownList = el("currency-breakdown-list");
  if (balances.byCurrency.length > 0) {
    breakdownWrap.classList.remove("hidden");
    breakdownList.classList.toggle("hidden", !state.breakdownExpanded);
    el("breakdown-chevron").textContent = state.breakdownExpanded ? "▾" : "▸";
    el("toggle-breakdown-btn").setAttribute("aria-expanded", String(state.breakdownExpanded));

    breakdownList.innerHTML = "";
    for (const row of balances.byCurrency) {
      const li = document.createElement("li");
      li.className = "breakdown-item";
      const youOweRow = row.debtorId === currentId;
      const dirLabel = youOweRow
        ? `You owe ${getUserName(row.creditorId)}`
        : `${getUserName(row.debtorId)} owes you`;

      const codeSpan = document.createElement("span");
      codeSpan.className = "breakdown-code";
      codeSpan.textContent = row.currency;

      const dirSpan = document.createElement("span");
      dirSpan.className = "breakdown-dir";
      dirSpan.textContent = dirLabel;

      const valSpan = document.createElement("span");
      valSpan.className = `breakdown-val ${youOweRow ? "negative" : "positive"}`;
      valSpan.textContent = formatMoney(row.owedAmount, row.currency);

      li.append(codeSpan, dirSpan, valSpan);
      breakdownList.appendChild(li);
    }
  } else {
    breakdownWrap.classList.add("hidden");
  }

  renderTagFilterBar();
  renderFeed();
}

function renderTagFilterBar() {
  const bar = el("tag-filter-bar");
  const allTags = getAllTags(state.ledger.entries);

  if (
    state.selectedTag &&
    !allTags.some((t) => t.toLowerCase() === state.selectedTag.toLowerCase())
  ) {
    state.selectedTag = "";
  }

  if (allTags.length === 0) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }

  bar.classList.remove("hidden");
  bar.innerHTML = "";

  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = `tag-filter-pill${state.selectedTag === "" ? " active" : ""}`;
  allBtn.textContent = "All tags";
  allBtn.addEventListener("click", () => {
    state.selectedTag = "";
    renderTagFilterBar();
    renderFeed();
  });
  bar.appendChild(allBtn);

  for (const tag of allTags) {
    const isActive = state.selectedTag.toLowerCase() === tag.toLowerCase();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `tag-filter-pill${isActive ? " active" : ""}`;
    btn.textContent = `#${tag}`;
    btn.addEventListener("click", () => {
      state.selectedTag = isActive ? "" : tag;
      renderTagFilterBar();
      renderFeed();
    });
    bar.appendChild(btn);
  }
}

function renderFeed() {
  const container = el("feed-container");
  const summaryEl = el("tag-filter-summary");
  const query = state.search.trim().toLowerCase();
  const activeTagKey = state.selectedTag.toLowerCase();
  const sorted = sortEntriesNewestFirst(state.ledger.entries);

  const filtered = sorted.filter((entry) => {
    if (state.filter !== "all" && entry.type !== state.filter) return false;
    const entryTags = normalizeTags(entry.tags);
    if (activeTagKey && !entryTags.some((t) => t.toLowerCase() === activeTagKey)) {
      return false;
    }
    if (!query) return true;
    const haystack = [
      entry.title,
      entry.notes,
      entry.currency,
      entry.date,
      entryTags.join(" "),
      getUserName(entry.paidBy),
      entry.paidTo ? getUserName(entry.paidTo) : "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  if (state.selectedTag) {
    const tagExpenses = filtered.filter((e) => e.type === "expense");
    const tagTotalHome = roundCurrency(
      tagExpenses.reduce((sum, e) => sum + (Number(e.amountHome) || 0), 0),
      homeCurrency
    );
    summaryEl.textContent = `#${state.selectedTag} · ${tagExpenses.length} expense${
      tagExpenses.length === 1 ? "" : "s"
    } · ${formatMoney(tagTotalHome, homeCurrency)} total`;
    summaryEl.classList.remove("hidden");
  } else {
    summaryEl.classList.add("hidden");
  }

  container.innerHTML = "";

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const h3 = document.createElement("h3");
    const p = document.createElement("p");
    if (state.ledger.entries.length === 0) {
      h3.textContent = "No expenses yet";
      p.textContent = "Tap “+ Add Expense” to record your first shared trip expense.";
    } else {
      h3.textContent = "No matching entries";
      p.textContent = "Try clearing your search or switching the filter.";
    }
    empty.append(h3, p);
    container.appendChild(empty);
    return;
  }

  const groups = new Map();
  for (const entry of filtered) {
    const key = entry.date || "Unknown date";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  for (const [dateStr, items] of groups.entries()) {
    const groupEl = document.createElement("div");
    groupEl.className = "date-group";

    const heading = document.createElement("div");
    heading.className = "date-group-title";
    heading.textContent = formatDateHeading(dateStr);
    groupEl.appendChild(heading);

    for (const entry of items) {
      groupEl.appendChild(buildEntryCard(entry));
    }

    container.appendChild(groupEl);
  }
}

function buildEntryCard(entry) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "entry-card";
  card.addEventListener("click", () => {
    if (entry.type === "settlement") {
      openPaybackModal(entry);
    } else {
      openExpenseModal(entry);
    }
  });

  const icon = document.createElement("div");
  icon.className = `entry-icon${entry.type === "settlement" ? " settlement" : ""}`;
  icon.textContent = entry.type === "settlement" ? "⇄" : "🧾";

  const main = document.createElement("div");
  main.className = "entry-main";

  const title = document.createElement("div");
  title.className = "entry-title";
  title.textContent = entry.title;

  const meta = document.createElement("div");
  meta.className = "entry-meta";
  if (entry.type === "settlement") {
    const fromName = getUserName(entry.paidBy);
    const toName = getUserName(entry.paidTo || getOtherUserId(entry.paidBy));
    meta.textContent = `${fromName} paid ${toName}${entry.notes ? ` · ${entry.notes}` : ""}`;
  } else {
    const payerName = getUserName(entry.paidBy);
    const splitLabel = entry.splitMode === "sum" ? "Custom split" : "Split evenly";
    meta.textContent = `Paid by ${payerName} · ${splitLabel}${entry.notes ? ` · ${entry.notes}` : ""}`;
  }

  main.append(title, meta);

  const entryTags = normalizeTags(entry.tags);
  if (entryTags.length > 0) {
    const tagsRow = document.createElement("div");
    tagsRow.className = "entry-tags";
    for (const tag of entryTags) {
      const pill = document.createElement("span");
      pill.className = "entry-tag";
      pill.textContent = `#${tag}`;
      tagsRow.appendChild(pill);
    }
    main.appendChild(tagsRow);
  }

  const amounts = document.createElement("div");
  amounts.className = "entry-amounts";

  const total = document.createElement("div");
  total.className = "entry-total";
  total.textContent = formatMoney(entry.amount, entry.currency);
  amounts.appendChild(total);

  if (entry.currency !== homeCurrency) {
    const sub = document.createElement("div");
    sub.className = "entry-home-sub";
    sub.textContent = `≈ ${formatMoney(entry.amountHome, homeCurrency)}`;
    amounts.appendChild(sub);
  }

  const impact = getEntryImpactForUser(entry, state.currentUser.id, userIds, true);
  const impactBadge = document.createElement("div");
  impactBadge.className = `entry-impact ${impact.direction}`;
  impactBadge.textContent =
    impact.amount > 0
      ? `${impact.label} ${formatMoney(impact.amount, homeCurrency)}`
      : impact.label;
  amounts.appendChild(impactBadge);

  card.append(icon, main, amounts);
  return card;
}

// ---- FX Helper for Modals ----

async function handleModalCurrencyChange(prefix, preserveManualRate = false) {
  const code = getSelectedCurrency(prefix);
  const isCustom = el(`${prefix}-currency`).value === CUSTOM_CURRENCY_VALUE;
  el(`${prefix}-custom-currency-row`).classList.toggle("hidden", !isCustom);

  const fxBox = el(`${prefix}-fx-box`);
  if (!code || code === homeCurrency) {
    fxBox.classList.add("hidden");
    el(`${prefix}-fx-rate`).value = "1";
    updateModalCalculations(prefix);
    return;
  }

  fxBox.classList.remove("hidden");
  el(`${prefix}-fx-from`).textContent = code;
  el(`${prefix}-fx-to`).textContent = homeCurrency;

  if (!/^[A-Z]{3}$/.test(code)) {
    el(`${prefix}-fx-status`).textContent = "Enter a valid 3-letter ISO currency code.";
    updateModalCalculations(prefix);
    return;
  }

  if (preserveManualRate && Number(el(`${prefix}-fx-rate`).value) > 0) {
    el(`${prefix}-fx-status`).textContent = "Saved rate on this entry (tap Refresh for live rate).";
    updateModalCalculations(prefix);
    return;
  }

  el(`${prefix}-fx-status`).textContent = `Fetching ${code} → ${homeCurrency} rate...`;
  try {
    const result = await fetchExchangeRate(code, homeCurrency);
    // Guard against currency changed while awaiting network
    if (getSelectedCurrency(prefix) !== code) return;
    el(`${prefix}-fx-rate`).value = formatRate(result.rate);
    el(`${prefix}-fx-status`).textContent = result.stale
      ? `Offline cached rate (${result.source}) — editable`
      : `Rate via ${result.source} — editable`;
  } catch (err) {
    if (getSelectedCurrency(prefix) !== code) return;
    el(`${prefix}-fx-status`).textContent = err.message;
  }

  updateModalCalculations(prefix);
}

function updateModalCalculations(prefix) {
  const amount = Number(el(`${prefix}-amount`).value) || 0;
  const code = getSelectedCurrency(prefix) || homeCurrency;
  const rate = code === homeCurrency ? 1 : Number(el(`${prefix}-fx-rate`).value) || 0;
  const homePreview = el(`${prefix}-home-preview`);
  if (homePreview) {
    const converted = roundCurrency(amount * rate, homeCurrency);
    homePreview.textContent = `≈ ${formatMoney(converted, homeCurrency)}`;
  }

  if (prefix === "exp") {
    updateExpenseSplitUI();
  }
}

// ---- Expense Modal ----

function renderExpensePaidBy() {
  const container = el("exp-paid-by");
  container.innerHTML = "";
  for (const user of users) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `seg-btn${state.expPaidBy === user.id ? " active" : ""}`;
    btn.textContent = user.name;
    btn.addEventListener("click", () => {
      state.expPaidBy = user.id;
      renderExpensePaidBy();
      updateExpenseSplitUI();
    });
    container.appendChild(btn);
  }
}

function setExpenseSplitMode(mode, prefillSplits = null) {
  state.expSplitMode = mode;
  for (const btn of el("exp-split-mode").querySelectorAll("[data-split-mode]")) {
    btn.classList.toggle("active", btn.dataset.splitMode === mode);
  }

  el("exp-even-preview").classList.toggle("hidden", mode !== "even");
  el("exp-custom-split-box").classList.toggle("hidden", mode !== "sum");

  if (mode === "sum") {
    const amount = Number(el("exp-amount").value) || 0;
    const code = getSelectedCurrency("exp") || homeCurrency;
    const decimals = getCurrencyDecimals(code);
    if (prefillSplits) {
      el("exp-split-a").value = Number(prefillSplits[userIds[0]] ?? 0).toFixed(decimals);
      el("exp-split-b").value = Number(prefillSplits[userIds[1]] ?? 0).toFixed(decimals);
    } else if (!el("exp-split-a").value && !el("exp-split-b").value && amount > 0) {
      const even = computeEvenSplit(amount, code, state.expPaidBy, userIds);
      el("exp-split-a").value = even[userIds[0]].toFixed(decimals);
      el("exp-split-b").value = even[userIds[1]].toFixed(decimals);
    }
  }

  updateExpenseSplitUI();
}

function updateExpenseSplitUI() {
  const amount = Number(el("exp-amount").value) || 0;
  const code = getSelectedCurrency("exp") || homeCurrency;
  const safeCode = /^[A-Z]{3}$/.test(code) ? code : homeCurrency;

  if (state.expSplitMode === "even") {
    if (amount > 0) {
      const even = computeEvenSplit(amount, safeCode, state.expPaidBy, userIds);
      el("exp-even-preview").textContent = `${users[0].name}: ${formatMoney(
        even[userIds[0]],
        safeCode
      )}  ·  ${users[1].name}: ${formatMoney(even[userIds[1]], safeCode)}`;
    } else {
      el("exp-even-preview").textContent = "Split 50/50 between both partners.";
    }
    return;
  }

  const shareA = Number(el("exp-split-a").value) || 0;
  const shareB = Number(el("exp-split-b").value) || 0;
  const sum = roundCurrency(shareA + shareB, safeCode);
  const total = roundCurrency(amount, safeCode);
  const diff = roundCurrency(total - sum, safeCode);
  const statusEl = el("exp-split-status");

  if (total <= 0) {
    statusEl.textContent = "Enter the total amount above.";
    statusEl.className = "field-hint";
  } else if (Math.abs(diff) === 0) {
    statusEl.textContent = `✓ Matches total (${formatMoney(total, safeCode)})`;
    statusEl.className = "field-hint ok";
  } else if (diff > 0) {
    statusEl.textContent = `Remaining to assign: ${formatMoney(diff, safeCode)}`;
    statusEl.className = "field-hint err";
  } else {
    statusEl.textContent = `Exceeds total by ${formatMoney(Math.abs(diff), safeCode)}`;
    statusEl.className = "field-hint err";
  }
}

function renderExpenseTagSuggestions() {
  const container = el("exp-tag-suggestions");
  const allTags = getAllTags(state.ledger.entries);
  if (allTags.length === 0) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  const currentTags = normalizeTags(el("exp-tags").value);
  const currentKeys = new Set(currentTags.map((t) => t.toLowerCase()));

  container.classList.remove("hidden");
  container.innerHTML = "";

  for (const tag of allTags) {
    const isSelected = currentKeys.has(tag.toLowerCase());
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `chip-btn${isSelected ? " active" : ""}`;
    chip.textContent = `#${tag}`;
    chip.addEventListener("click", () => {
      const tags = normalizeTags(el("exp-tags").value);
      const idx = tags.findIndex((t) => t.toLowerCase() === tag.toLowerCase());
      if (idx >= 0) {
        tags.splice(idx, 1);
      } else {
        tags.push(tag);
      }
      el("exp-tags").value = tags.join(", ");
      renderExpenseTagSuggestions();
    });
    container.appendChild(chip);
  }
}

function openExpenseModal(entry = null) {
  state.pendingDeleteId = null;
  el("exp-error").classList.add("hidden");
  el("exp-split-a-label").textContent = `${users[0].name}'s share`;
  el("exp-split-b-label").textContent = `${users[1].name}'s share`;
  el("chip-all-a").textContent = `All ${users[0].name}`;
  el("chip-all-b").textContent = `All ${users[1].name}`;

  const currencyToUse = entry ? entry.currency : getLastCurrency();
  populateCurrencySelect(el("exp-currency"), currencyToUse);
  setCurrencySelection("exp", currencyToUse);

  if (entry) {
    el("expense-modal-title").textContent = "Edit Expense";
    el("exp-save-btn").textContent = "Update Expense";
    el("exp-id").value = entry.id;
    el("exp-title").value = entry.title;
    el("exp-amount").value = String(entry.amount);
    el("exp-fx-rate").value = String(entry.fxRate || 1);
    el("exp-date").value = entry.date || todayIsoDate();
    el("exp-tags").value = normalizeTags(entry.tags).join(", ");
    el("exp-notes").value = entry.notes || "";
    state.expPaidBy = entry.paidBy;
    el("exp-delete-btn").classList.remove("hidden");
    el("exp-delete-btn").textContent = "Delete";
    renderExpensePaidBy();
    setExpenseSplitMode(entry.splitMode || "even", entry.splits);
    handleModalCurrencyChange("exp", true);
  } else {
    el("expense-modal-title").textContent = "Add Expense";
    el("exp-save-btn").textContent = "Save Expense";
    el("exp-id").value = "";
    el("exp-title").value = "";
    el("exp-amount").value = "";
    el("exp-fx-rate").value = "";
    el("exp-date").value = todayIsoDate();
    el("exp-tags").value = state.selectedTag || "";
    el("exp-notes").value = "";
    el("exp-split-a").value = "";
    el("exp-split-b").value = "";
    state.expPaidBy = state.currentUser.id;
    el("exp-delete-btn").classList.add("hidden");
    renderExpensePaidBy();
    setExpenseSplitMode("even");
    handleModalCurrencyChange("exp", false);
  }

  renderExpenseTagSuggestions();
  el("expense-modal").classList.remove("hidden");
  setTimeout(() => el("exp-title").focus(), 40);
}

// ---- Payback Modal ----

function renderPayDirection() {
  const container = el("pay-direction");
  container.innerHTML = "";
  const options = [
    { from: userIds[0], to: userIds[1], label: `${users[0].name} → ${users[1].name}` },
    { from: userIds[1], to: userIds[0], label: `${users[1].name} → ${users[0].name}` },
  ];

  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `seg-btn${state.payPaidBy === opt.from ? " active" : ""}`;
    btn.textContent = opt.label;
    btn.addEventListener("click", () => {
      state.payPaidBy = opt.from;
      renderPayDirection();
    });
    container.appendChild(btn);
  }
}

function openPaybackModal(entry = null, prefillSettle = false) {
  state.pendingDeleteId = null;
  el("pay-error").classList.add("hidden");

  const balances = calculateBalances(state.ledger.entries, userIds, homeCurrency);
  const currencyToUse = entry ? entry.currency : homeCurrency;
  populateCurrencySelect(el("pay-currency"), currencyToUse);
  setCurrencySelection("pay", currencyToUse);

  if (entry) {
    el("payback-modal-title").textContent = "Edit Payback";
    el("pay-save-btn").textContent = "Update Payback";
    el("pay-id").value = entry.id;
    el("pay-amount").value = String(entry.amount);
    el("pay-fx-rate").value = String(entry.fxRate || 1);
    el("pay-date").value = entry.date || todayIsoDate();
    el("pay-title").value = entry.title || "";
    el("pay-notes").value = entry.notes || "";
    state.payPaidBy = entry.paidBy;
    el("pay-delete-btn").classList.remove("hidden");
    el("pay-delete-btn").textContent = "Delete";
    renderPayDirection();
    handleModalCurrencyChange("pay", true);
  } else {
    el("payback-modal-title").textContent = prefillSettle ? "Settle Up" : "Record Payback";
    el("pay-save-btn").textContent = "Save Payback";
    el("pay-id").value = "";
    el("pay-date").value = todayIsoDate();
    el("pay-title").value = "";
    el("pay-notes").value = "";
    el("pay-fx-rate").value = "1";
    el("pay-delete-btn").classList.add("hidden");

    if (!balances.isSettled) {
      state.payPaidBy = balances.debtorId;
      el("pay-amount").value = prefillSettle
        ? balances.owedAmountHome.toFixed(getCurrencyDecimals(homeCurrency))
        : "";
    } else {
      state.payPaidBy = state.currentUser.id;
      el("pay-amount").value = "";
    }

    renderPayDirection();
    handleModalCurrencyChange("pay", false);
  }

  el("payback-modal").classList.remove("hidden");
  setTimeout(() => el("pay-amount").focus(), 40);
}

function closeModal(modalId) {
  el(modalId).classList.add("hidden");
  state.pendingDeleteId = null;
}

// ---- Mutations ----

async function persistMutation(mutatorFn, commitMessage, successToast) {
  if (state.isSaving || !state.storage) return false;
  state.isSaving = true;
  setSyncStatus("Saving...", "syncing");

  try {
    const { data } = await state.storage.mutate(mutatorFn, commitMessage);
    state.ledger = data;
    renderDashboard();
    setSyncStatus(state.storage.mode === "demo" ? "Demo mode" : "Synced", state.storage.mode === "demo" ? "demo" : "ok");
    showToast(successToast);
    return true;
  } catch (err) {
    setSyncStatus("Save failed", "error");
    showToast(err.message || "Could not save changes.", true);
    return false;
  } finally {
    state.isSaving = false;
  }
}

async function handleExpenseSubmit(event) {
  event.preventDefault();
  const errorEl = el("exp-error");
  errorEl.classList.add("hidden");

  const editId = el("exp-id").value;
  const existing = editId ? state.ledger.entries.find((e) => e.id === editId) : null;
  const currency = getSelectedCurrency("exp");

  let entry;
  try {
    entry = createExpenseEntry(
      {
        title: el("exp-title").value,
        amount: el("exp-amount").value,
        currency,
        fxRate: currency === homeCurrency ? 1 : el("exp-fx-rate").value,
        date: el("exp-date").value,
        paidBy: state.expPaidBy,
        splitMode: state.expSplitMode,
        splits:
          state.expSplitMode === "sum"
            ? {
                [userIds[0]]: el("exp-split-a").value,
                [userIds[1]]: el("exp-split-b").value,
              }
            : null,
        tags: el("exp-tags").value,
        notes: el("exp-notes").value,
        createdBy: state.currentUser.id,
      },
      userIds,
      homeCurrency,
      existing
    );
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
    return;
  }

  const saveBtn = el("exp-save-btn");
  saveBtn.disabled = true;
  const ok = await persistMutation(
    (ledger) => upsertEntry(ledger, entry),
    `${existing ? "Edit" : "Add"} expense: ${entry.title} (${entry.amount} ${entry.currency})`,
    existing ? "Expense updated" : "Expense saved"
  );
  saveBtn.disabled = false;

  if (ok) {
    setLastCurrency(entry.currency);
    closeModal("expense-modal");
  }
}

async function handlePaybackSubmit(event) {
  event.preventDefault();
  const errorEl = el("pay-error");
  errorEl.classList.add("hidden");

  const editId = el("pay-id").value;
  const existing = editId ? state.ledger.entries.find((e) => e.id === editId) : null;
  const currency = getSelectedCurrency("pay");
  const paidTo = getOtherUserId(state.payPaidBy);

  let entry;
  try {
    entry = createSettlementEntry(
      {
        title: el("pay-title").value,
        amount: el("pay-amount").value,
        currency,
        fxRate: currency === homeCurrency ? 1 : el("pay-fx-rate").value,
        date: el("pay-date").value,
        paidBy: state.payPaidBy,
        paidTo,
        notes: el("pay-notes").value,
        createdBy: state.currentUser.id,
      },
      userIds,
      homeCurrency,
      existing
    );
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
    return;
  }

  const saveBtn = el("pay-save-btn");
  saveBtn.disabled = true;
  const ok = await persistMutation(
    (ledger) => upsertEntry(ledger, entry),
    `${existing ? "Edit" : "Record"} payback: ${entry.amount} ${entry.currency}`,
    existing ? "Payback updated" : "Payback recorded"
  );
  saveBtn.disabled = false;

  if (ok) {
    closeModal("payback-modal");
  }
}

async function handleDeleteClick(modalId, idInputId, buttonId) {
  const entryId = el(idInputId).value;
  if (!entryId) return;

  const btn = el(buttonId);
  if (state.pendingDeleteId !== entryId) {
    state.pendingDeleteId = entryId;
    btn.textContent = "Tap again to delete";
    return;
  }

  btn.disabled = true;
  const ok = await persistMutation(
    (ledger) => deleteEntry(ledger, entryId),
    `Delete entry ${entryId}`,
    "Entry deleted"
  );
  btn.disabled = false;

  if (ok) {
    closeModal(modalId);
  }
}

// ---- Event Wiring ----

function wireEvents() {
  // Password show/hide
  el("toggle-password-btn").addEventListener("click", () => {
    const input = el("login-password");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    el("toggle-password-btn").textContent = showing ? "Show" : "Hide";
  });

  // Login submit
  el("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = el("login-error");
    errorEl.classList.add("hidden");

    const user = getUserById(state.selectedLoginUserId);
    const password = el("login-password").value;
    const remember = el("remember-me").checked;

    if (!isUserConfigured(user)) {
      errorEl.textContent = "Config not set up yet. Use Demo Mode above or run scripts/setup-config.mjs.";
      errorEl.classList.remove("hidden");
      return;
    }

    const submitBtn = el("login-submit-btn");
    submitBtn.disabled = true;
    submitBtn.textContent = "Unlocking...";
    try {
      const token = await decryptToken(user, password);
      if (remember) {
        saveLocalSession(user.id, token, "github");
      } else {
        clearLocalSession();
      }
      await enterDashboard(user, token, "github");
    } catch (err) {
      errorEl.textContent = err.message || "Could not unlock.";
      errorEl.classList.remove("hidden");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Unlock Ledger";
    }
  });

  // Demo mode
  el("demo-mode-btn").addEventListener("click", async () => {
    const user = getUserById(state.selectedLoginUserId);
    saveLocalSession(user.id, "demo", "demo");
    await enterDashboard(user, "demo", "demo");
  });

  // Header controls
  el("refresh-btn").addEventListener("click", () => refreshLedger(true));
  el("logout-btn").addEventListener("click", signOut);

  // Breakdown toggle
  el("toggle-breakdown-btn").addEventListener("click", () => {
    state.breakdownExpanded = !state.breakdownExpanded;
    renderDashboard();
  });

  // Primary action buttons
  el("desktop-add-expense-btn").addEventListener("click", () => openExpenseModal());
  el("mobile-add-expense-btn").addEventListener("click", () => openExpenseModal());
  el("desktop-payback-btn").addEventListener("click", () => openPaybackModal(null, false));
  el("mobile-payback-btn").addEventListener("click", () => openPaybackModal(null, false));
  el("quick-settle-btn").addEventListener("click", () => openPaybackModal(null, true));

  // Search & filter
  el("search-input").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderFeed();
  });

  for (const pill of document.querySelectorAll(".filter-pill")) {
    pill.addEventListener("click", () => {
      state.filter = pill.dataset.filter;
      for (const p of document.querySelectorAll(".filter-pill")) {
        p.classList.toggle("active", p === pill);
      }
      renderFeed();
    });
  }

  // Modal close handlers
  for (const closeBtn of document.querySelectorAll("[data-close-modal]")) {
    closeBtn.addEventListener("click", () => closeModal(closeBtn.dataset.closeModal));
  }
  for (const backdrop of document.querySelectorAll(".modal-backdrop")) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal(backdrop.id);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModal("expense-modal");
      closeModal("payback-modal");
    }
  });

  // Expense form interactivity
  el("exp-amount").addEventListener("input", () => updateModalCalculations("exp"));
  el("exp-fx-rate").addEventListener("input", () => updateModalCalculations("exp"));
  el("exp-currency").addEventListener("change", () => handleModalCurrencyChange("exp", false));
  el("exp-custom-currency").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "");
    if (e.target.value.length === 3) {
      handleModalCurrencyChange("exp", false);
    } else {
      updateModalCalculations("exp");
    }
  });
  el("exp-fx-refresh").addEventListener("click", () => handleModalCurrencyChange("exp", false));

  for (const btn of el("exp-split-mode").querySelectorAll("[data-split-mode]")) {
    btn.addEventListener("click", () => setExpenseSplitMode(btn.dataset.splitMode));
  }

  // Auto-calculate partner B's share when editing partner A's share, and vice versa
  el("exp-split-a").addEventListener("input", () => {
    const total = Number(el("exp-amount").value) || 0;
    const shareA = Number(el("exp-split-a").value);
    const code = getSelectedCurrency("exp") || homeCurrency;
    const decimals = getCurrencyDecimals(code);
    if (total > 0 && Number.isFinite(shareA) && shareA >= 0 && shareA <= total) {
      el("exp-split-b").value = roundCurrency(total - shareA, code).toFixed(decimals);
    }
    updateExpenseSplitUI();
  });

  el("exp-split-b").addEventListener("input", () => {
    const total = Number(el("exp-amount").value) || 0;
    const shareB = Number(el("exp-split-b").value);
    const code = getSelectedCurrency("exp") || homeCurrency;
    const decimals = getCurrencyDecimals(code);
    if (total > 0 && Number.isFinite(shareB) && shareB >= 0 && shareB <= total) {
      el("exp-split-a").value = roundCurrency(total - shareB, code).toFixed(decimals);
    }
    updateExpenseSplitUI();
  });

  for (const chip of document.querySelectorAll("[data-quick-split]")) {
    chip.addEventListener("click", () => {
      const total = Number(el("exp-amount").value) || 0;
      const code = getSelectedCurrency("exp") || homeCurrency;
      const decimals = getCurrencyDecimals(code);
      if (chip.dataset.quickSplit === "even") {
        const even = computeEvenSplit(total, code, state.expPaidBy, userIds);
        el("exp-split-a").value = even[userIds[0]].toFixed(decimals);
        el("exp-split-b").value = even[userIds[1]].toFixed(decimals);
      } else if (chip.dataset.quickSplit === "allA") {
        el("exp-split-a").value = roundCurrency(total, code).toFixed(decimals);
        el("exp-split-b").value = (0).toFixed(decimals);
      } else if (chip.dataset.quickSplit === "allB") {
        el("exp-split-a").value = (0).toFixed(decimals);
        el("exp-split-b").value = roundCurrency(total, code).toFixed(decimals);
      }
      updateExpenseSplitUI();
    });
  }

  el("exp-tags").addEventListener("input", () => renderExpenseTagSuggestions());
  el("expense-form").addEventListener("submit", handleExpenseSubmit);
  el("exp-delete-btn").addEventListener("click", () =>
    handleDeleteClick("expense-modal", "exp-id", "exp-delete-btn")
  );

  // Payback form interactivity
  el("pay-amount").addEventListener("input", () => updateModalCalculations("pay"));
  el("pay-fx-rate").addEventListener("input", () => updateModalCalculations("pay"));
  el("pay-currency").addEventListener("change", () => handleModalCurrencyChange("pay", false));
  el("pay-custom-currency").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "");
    if (e.target.value.length === 3) {
      handleModalCurrencyChange("pay", false);
    } else {
      updateModalCalculations("pay");
    }
  });
  el("pay-fx-refresh").addEventListener("click", () => handleModalCurrencyChange("pay", false));
  el("payback-form").addEventListener("submit", handlePaybackSubmit);
  el("pay-delete-btn").addEventListener("click", () =>
    handleDeleteClick("payback-modal", "pay-id", "pay-delete-btn")
  );
}

// ---- Bootstrap ----

async function init() {
  document.title = CONFIG.appName || "Trip Expenses";
  el("login-title").textContent = CONFIG.appName || "Trip Expenses";

  wireEvents();
  renderLoginUserPicker();

  const anyConfigured = users.every(isUserConfigured);
  el("setup-notice").classList.toggle("hidden", anyConfigured);

  const savedSession = readLocalSession();
  if (savedSession && savedSession.userId && savedSession.token) {
    const user = users.find((u) => u.id === savedSession.userId);
    if (user && (savedSession.mode === "demo" || anyConfigured)) {
      await enterDashboard(user, savedSession.token, savedSession.mode || "github");
      return;
    }
  }

  el("login-view").classList.remove("hidden");
}

init();
