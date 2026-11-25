// Pure financial logic for a two-partner multi-currency expense ledger.

const ZERO_DECIMAL_CURRENCIES = new Set([
  "CLP",
  "ISK",
  "JPY",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "XAF",
  "XOF",
  "XPF",
]);

const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD",
  "IQD",
  "JOD",
  "KWD",
  "LYD",
  "OMR",
  "TND",
]);

export function getCurrencyDecimals(currency) {
  const code = String(currency || "SGD").toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

export function roundCurrency(value, currency) {
  const decimals = getCurrencyDecimals(currency);
  const factor = 10 ** decimals;
  const rounded = Math.round((Number(value) + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function createEmptyLedger(homeCurrency = "SGD") {
  return {
    version: 1,
    homeCurrency: String(homeCurrency || "SGD").toUpperCase(),
    entries: [],
  };
}

export function normalizeLedger(raw, fallbackHomeCurrency = "SGD") {
  const homeCurrency = String(raw?.homeCurrency || fallbackHomeCurrency || "SGD").toUpperCase();
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  return {
    version: 1,
    homeCurrency,
    entries,
  };
}

function generateId(prefix, dateStr) {
  const compactDate = String(dateStr || "").replace(/-/g, "") || "00000000";
  const bytes = new Uint8Array(4);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${compactDate}_${hex}`;
}

export function computeEvenSplit(amount, currency, paidBy, userIds) {
  const [idA, idB] = userIds;
  const decimals = getCurrencyDecimals(currency);
  const factor = 10 ** decimals;
  const totalMinor = Math.round(Number(amount) * factor);
  const otherMinor = Math.floor(totalMinor / 2);
  const payerMinor = totalMinor - otherMinor;

  const otherId = paidBy === idA ? idB : idA;
  return {
    [paidBy]: payerMinor / factor,
    [otherId]: otherMinor / factor,
  };
}

export function validateCustomSplit(amount, currency, splits, userIds) {
  const [idA, idB] = userIds;
  const decimals = getCurrencyDecimals(currency);
  const factor = 10 ** decimals;
  const total = roundCurrency(amount, currency);

  const rawA = Number(splits?.[idA]);
  const rawB = Number(splits?.[idB]);

  if (!Number.isFinite(rawA) || !Number.isFinite(rawB) || rawA < 0 || rawB < 0) {
    throw new Error("Both split amounts must be 0 or greater.");
  }

  const shareA = roundCurrency(rawA, currency);
  const shareB = roundCurrency(rawB, currency);
  const diff = Math.abs(shareA + shareB - total);
  const tolerance = 0.5 / factor + 1e-6;

  if (diff > tolerance) {
    throw new Error(
      `Split shares (${shareA.toFixed(decimals)} + ${shareB.toFixed(decimals)}) must equal the total (${total.toFixed(decimals)}).`
    );
  }

  // Ensure exact minor-unit sum equals total.
  const normalizedB = roundCurrency(total - shareA, currency);
  return {
    [idA]: shareA,
    [idB]: normalizedB,
  };
}

export function convertSplitsToHome(amountHome, homeCurrency, splits, amount, paidBy, userIds) {
  const [idA, idB] = userIds;
  const otherId = paidBy === idA ? idB : idA;
  if (amount <= 0) {
    return { [idA]: 0, [idB]: 0 };
  }
  const otherShareHome = roundCurrency((splits[otherId] / amount) * amountHome, homeCurrency);
  const payerShareHome = roundCurrency(amountHome - otherShareHome, homeCurrency);
  return {
    [paidBy]: payerShareHome,
    [otherId]: otherShareHome,
  };
}

function validateCommonFields({ amount, currency, fxRate, date, paidBy }, userIds, homeCurrency) {
  const [idA, idB] = userIds;
  if (paidBy !== idA && paidBy !== idB) {
    throw new Error("Invalid payer selected.");
  }

  const normalizedCurrency = String(currency || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
    throw new Error("Currency must be a 3-letter ISO code (e.g., SGD, EUR, JPY).");
  }

  const parsedAmount = roundCurrency(Number(amount), normalizedCurrency);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new Error("Amount must be greater than 0.");
  }

  const normalizedHome = String(homeCurrency || "SGD").toUpperCase();
  const parsedRate =
    normalizedCurrency === normalizedHome ? 1 : Number(fxRate);
  if (!Number.isFinite(parsedRate) || parsedRate <= 0) {
    throw new Error(`Please provide a valid exchange rate to ${normalizedHome}.`);
  }

  const normalizedDate = String(date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
    throw new Error("Date must be in YYYY-MM-DD format.");
  }

  const amountHome =
    normalizedCurrency === normalizedHome
      ? parsedAmount
      : roundCurrency(parsedAmount * parsedRate, normalizedHome);

  return {
    amount: parsedAmount,
    currency: normalizedCurrency,
    fxRate: parsedRate,
    amountHome,
    date: normalizedDate,
    homeCurrency: normalizedHome,
  };
}

export function createExpenseEntry(input, userIds, homeCurrency, existingEntry = null) {
  const title = String(input.title || "").trim();
  if (!title) {
    throw new Error("Please enter a description for the expense.");
  }

  const common = validateCommonFields(input, userIds, homeCurrency);
  const splitMode = input.splitMode === "sum" ? "sum" : "even";

  const splits =
    splitMode === "even"
      ? computeEvenSplit(common.amount, common.currency, input.paidBy, userIds)
      : validateCustomSplit(common.amount, common.currency, input.splits, userIds);

  const splitsHome =
    common.currency === common.homeCurrency
      ? { ...splits }
      : convertSplitsToHome(
          common.amountHome,
          common.homeCurrency,
          splits,
          common.amount,
          input.paidBy,
          userIds
        );

  const now = new Date().toISOString();
  return {
    id: existingEntry?.id || generateId("exp", common.date),
    type: "expense",
    title,
    date: common.date,
    amount: common.amount,
    currency: common.currency,
    fxRate: common.fxRate,
    amountHome: common.amountHome,
    paidBy: input.paidBy,
    splitMode,
    splits,
    splitsHome,
    notes: String(input.notes || "").trim(),
    createdBy: existingEntry?.createdBy || input.createdBy || input.paidBy,
    createdAt: existingEntry?.createdAt || now,
    updatedAt: now,
  };
}

export function createSettlementEntry(input, userIds, homeCurrency, existingEntry = null) {
  const [idA, idB] = userIds;
  const common = validateCommonFields(input, userIds, homeCurrency);
  const paidTo = input.paidTo || (input.paidBy === idA ? idB : idA);

  if (paidTo === input.paidBy || (paidTo !== idA && paidTo !== idB)) {
    throw new Error("Recipient must be the other partner.");
  }

  const title = String(input.title || "").trim() || "Payback";
  const splits = {
    [input.paidBy]: 0,
    [paidTo]: common.amount,
  };
  const splitsHome = {
    [input.paidBy]: 0,
    [paidTo]: common.amountHome,
  };

  const now = new Date().toISOString();
  return {
    id: existingEntry?.id || generateId("pay", common.date),
    type: "settlement",
    title,
    date: common.date,
    amount: common.amount,
    currency: common.currency,
    fxRate: common.fxRate,
    amountHome: common.amountHome,
    paidBy: input.paidBy,
    paidTo,
    splits,
    splitsHome,
    notes: String(input.notes || "").trim(),
    createdBy: existingEntry?.createdBy || input.createdBy || input.paidBy,
    createdAt: existingEntry?.createdAt || now,
    updatedAt: now,
  };
}

/**
 * Signed delta from user A's (userIds[0]) perspective:
 *   > 0  => Partner B owes Partner A
 *   < 0  => Partner A owes Partner B
 */
export function getEntryDeltaForFirstUser(entry, userIds, useHome = true) {
  const [idA, idB] = userIds;
  if (!entry) return 0;

  if (entry.type === "settlement") {
    const amt = Number(useHome ? entry.amountHome : entry.amount) || 0;
    return entry.paidBy === idA ? amt : -amt;
  }

  const splits = useHome ? entry.splitsHome : entry.splits;
  if (!splits) return 0;

  if (entry.paidBy === idA) {
    return Number(splits[idB]) || 0;
  }
  return -(Number(splits[idA]) || 0);
}

export function calculateBalances(entries, userIds, homeCurrency = "SGD") {
  const [idA, idB] = userIds;
  const normalizedHome = String(homeCurrency || "SGD").toUpperCase();

  let rawNetHome = 0;
  let totalSpentHome = 0;
  const paidByUserHome = { [idA]: 0, [idB]: 0 };
  const currencyTotals = new Map();
  let expenseCount = 0;
  let settlementCount = 0;

  for (const entry of entries || []) {
    const deltaHome = getEntryDeltaForFirstUser(entry, userIds, true);
    rawNetHome += deltaHome;

    const currency = String(entry.currency || normalizedHome).toUpperCase();
    const deltaOrig = getEntryDeltaForFirstUser(entry, userIds, false);
    currencyTotals.set(currency, (currencyTotals.get(currency) || 0) + deltaOrig);

    if (entry.type === "settlement") {
      settlementCount += 1;
    } else {
      expenseCount += 1;
      const amtHome = Number(entry.amountHome) || 0;
      totalSpentHome += amtHome;
      if (entry.paidBy === idA || entry.paidBy === idB) {
        paidByUserHome[entry.paidBy] += amtHome;
      }
    }
  }

  const netHome = roundCurrency(rawNetHome, normalizedHome);
  const homeFactor = 10 ** getCurrencyDecimals(normalizedHome);
  const settledHome = Math.abs(netHome) < 0.5 / homeFactor;

  const byCurrency = [];
  for (const [currency, rawNet] of currencyTotals.entries()) {
    const net = roundCurrency(rawNet, currency);
    const factor = 10 ** getCurrencyDecimals(currency);
    if (Math.abs(net) < 0.5 / factor) continue;
    byCurrency.push({
      currency,
      net,
      debtorId: net > 0 ? idB : idA,
      creditorId: net > 0 ? idA : idB,
      owedAmount: Math.abs(net),
    });
  }

  byCurrency.sort((a, b) => {
    if (a.currency === normalizedHome) return -1;
    if (b.currency === normalizedHome) return 1;
    return a.currency.localeCompare(b.currency);
  });

  return {
    homeCurrency: normalizedHome,
    netHome: settledHome ? 0 : netHome,
    isSettled: settledHome,
    debtorId: settledHome ? null : netHome > 0 ? idB : idA,
    creditorId: settledHome ? null : netHome > 0 ? idA : idB,
    owedAmountHome: settledHome ? 0 : Math.abs(netHome),
    byCurrency,
    totalSpentHome: roundCurrency(totalSpentHome, normalizedHome),
    paidByUserHome: {
      [idA]: roundCurrency(paidByUserHome[idA], normalizedHome),
      [idB]: roundCurrency(paidByUserHome[idB], normalizedHome),
    },
    expenseCount,
    settlementCount,
  };
}

export function getEntryImpactForUser(entry, currentUserId, userIds, useHome = true) {
  const [idA, idB] = userIds;
  const otherId = currentUserId === idA ? idB : idA;

  if (entry.type === "settlement") {
    const amount = Number(useHome ? entry.amountHome : entry.amount) || 0;
    if (entry.paidBy === currentUserId) {
      return { direction: "paid_back", amount, label: "You paid back" };
    }
    return { direction: "received", amount, label: "Paid you back" };
  }

  const splits = useHome ? entry.splitsHome : entry.splits;
  if (entry.paidBy === currentUserId) {
    const lent = Number(splits?.[otherId]) || 0;
    return {
      direction: lent > 0 ? "lent" : "even",
      amount: lent,
      label: lent > 0 ? "You lent" : "Personal",
    };
  }

  const borrowed = Number(splits?.[currentUserId]) || 0;
  return {
    direction: borrowed > 0 ? "borrowed" : "even",
    amount: borrowed,
    label: borrowed > 0 ? "You owe" : "Not involved",
  };
}

export function sortEntriesNewestFirst(entries) {
  return [...(entries || [])].sort((a, b) => {
    const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
    if (dateCompare !== 0) return dateCompare;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
}

export function upsertEntry(ledger, entry) {
  const entries = [...(ledger.entries || [])];
  const idx = entries.findIndex((item) => item.id === entry.id);
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  return {
    ...ledger,
    entries,
  };
}

export function deleteEntry(ledger, entryId) {
  return {
    ...ledger,
    entries: (ledger.entries || []).filter((item) => item.id !== entryId),
  };
}
