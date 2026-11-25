import { getCurrencyDecimals } from "./ledger.js";

const FX_CACHE_KEY = "trip_expenses_fx_cache_v1";
const FX_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FETCH_TIMEOUT_MS = 5000;

export const POPULAR_CURRENCIES = [
  { code: "SGD", name: "Singapore Dollar" },
  { code: "EUR", name: "Euro" },
  { code: "USD", name: "US Dollar" },
  { code: "JPY", name: "Japanese Yen" },
  { code: "GBP", name: "British Pound" },
  { code: "MYR", name: "Malaysian Ringgit" },
  { code: "THB", name: "Thai Baht" },
  { code: "IDR", name: "Indonesian Rupiah" },
  { code: "AUD", name: "Australian Dollar" },
  { code: "KRW", name: "South Korean Won" },
  { code: "TWD", name: "New Taiwan Dollar" },
  { code: "CHF", name: "Swiss Franc" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "NZD", name: "New Zealand Dollar" },
  { code: "HKD", name: "Hong Kong Dollar" },
  { code: "CNY", name: "Chinese Yuan" },
  { code: "VND", name: "Vietnamese Dong" },
  { code: "PHP", name: "Philippine Peso" },
  { code: "INR", name: "Indian Rupee" },
  { code: "AED", name: "UAE Dirham" },
  { code: "SEK", name: "Swedish Krona" },
  { code: "NOK", name: "Norwegian Krone" },
  { code: "DKK", name: "Danish Krone" },
  { code: "CZK", name: "Czech Koruna" },
  { code: "PLN", name: "Polish Zloty" },
  { code: "TRY", name: "Turkish Lira" },
  { code: "MXN", name: "Mexican Peso" },
  { code: "BRL", name: "Brazilian Real" },
  { code: "ZAR", name: "South African Rand" },
];

function readCache() {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(FX_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(FX_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore quota/storage errors
  }
}

async function fetchJsonWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchExchangeRate(fromCurrency, toCurrency) {
  const from = String(fromCurrency || "").trim().toUpperCase();
  const to = String(toCurrency || "SGD").trim().toUpperCase();

  if (!/^[A-Z]{3}$/.test(from)) {
    throw new Error("Enter a valid 3-letter currency code.");
  }

  if (from === to) {
    return { rate: 1, source: "same", stale: false, fetchedAt: Date.now() };
  }

  const cacheKey = `${from}_${to}`;
  const cache = readCache();
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.fetchedAt < FX_CACHE_TTL_MS && Number.isFinite(cached.rate)) {
    return { ...cached, stale: false };
  }

  // Primary: open.er-api.com (covers 160+ currencies, CORS-enabled, no API key)
  try {
    const data = await fetchJsonWithTimeout(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`);
    const rate = Number(data?.rates?.[to]);
    if (Number.isFinite(rate) && rate > 0) {
      const entry = { rate, source: "open.er-api.com", fetchedAt: Date.now() };
      cache[cacheKey] = entry;
      writeCache(cache);
      return { ...entry, stale: false };
    }
  } catch {
    // Fall through to secondary provider
  }

  // Fallback: api.frankfurter.dev (ECB rates, CORS-enabled, no API key)
  try {
    const data = await fetchJsonWithTimeout(
      `https://api.frankfurter.dev/v1/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    );
    const rate = Number(data?.rates?.[to]);
    if (Number.isFinite(rate) && rate > 0) {
      const entry = { rate, source: "frankfurter.dev", fetchedAt: Date.now() };
      cache[cacheKey] = entry;
      writeCache(cache);
      return { ...entry, stale: false };
    }
  } catch {
    // Fall through to stale cache or error
  }

  if (cached && Number.isFinite(cached.rate)) {
    return { ...cached, stale: true };
  }

  throw new Error(`Could not fetch ${from} → ${to} rate. You can enter a rate manually.`);
}

export function formatMoney(amount, currency = "SGD") {
  const code = String(currency || "SGD").toUpperCase();
  const decimals = getCurrencyDecimals(code);
  const num = Number(amount) || 0;

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(num);
  } catch {
    return `${code} ${num.toFixed(decimals)}`;
  }
}

export function formatRate(rate) {
  const num = Number(rate);
  if (!Number.isFinite(num)) return "";
  if (num >= 10) return num.toFixed(3);
  if (num >= 0.1) return num.toFixed(4);
  return num.toFixed(6);
}
