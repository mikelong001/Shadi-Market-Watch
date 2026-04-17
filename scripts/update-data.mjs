import fs from "node:fs/promises";

const GOLDAPI_KEY = process.env.GOLDAPI_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

const outFile = new URL("../public/data.json", import.meta.url);

function pctChange(current, prev) {
  if (!prev || prev === 0) return 0;
  return ((current - prev) / prev) * 100;
}

function tehranTime(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    month: "short",
    day: "numeric"
  }).format(new Date(iso)) + " Tehran";
}

async function getJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

async function readExistingData() {
  try {
    const raw = await fs.readFile(outFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return { items: [] };
  }
}

function getExistingItem(existingData, key) {
  return existingData.items.find(item => item.key === key);
}

function normalizeHistory(existingItem) {
  if (!Array.isArray(existingItem?.history)) return [];
  return existingItem.history
    .filter(point =>
      point &&
      typeof point.t === "string" &&
      typeof point.p === "number" &&
      Number.isFinite(point.p)
    )
    .sort((a, b) => new Date(a.t) - new Date(b.t));
}

function appendHistory(existingItem, nowIso, newPrice, maxPoints = 48) {
  const history = normalizeHistory(existingItem);
  const last = history[history.length - 1];

  if (last && last.t === nowIso) {
    last.p = newPrice;
    return history.slice(-maxPoints);
  }

  history.push({ t: nowIso, p: newPrice });
  return history.slice(-maxPoints);
}

function getClosest24hPrice(history, nowIso) {
  if (!history.length) return null;

  const target = new Date(nowIso).getTime() - 24 * 60 * 60 * 1000;

  let best = null;
  let bestDiff = Infinity;

  for (const point of history) {
    const t = new Date(point.t).getTime();
    const diff = Math.abs(t - target);
    if (diff < bestDiff) {
      best = point;
      bestDiff = diff;
    }
  }

  // Need something reasonably close to 24h ago.
  // 6 hours tolerance works fine for a 2-hour schedule.
  if (bestDiff > 6 * 60 * 60 * 1000) return null;

  return best.p;
}

function historyToSparkline(history, desiredLength = 7, fallbackPrice = 0) {
  const vals = history.map(point => point.p).slice(-desiredLength);

  if (!vals.length) return Array(desiredLength).fill(fallbackPrice);
  while (vals.length < desiredLength) vals.unshift(vals[0]);

  return vals;
}

function buildItemFromApi(existingData, nowIso, key, label, price, decimals, apiChangePct = 0) {
  const existingItem = getExistingItem(existingData, key);
  const history = appendHistory(existingItem, nowIso, price);

  return {
    key,
    label,
    price,
    change_pct: typeof apiChangePct === "number" ? apiChangePct : 0,
    sparkline: historyToSparkline(history, 7, price),
    history,
    decimals
  };
}

function buildFxItem(existingData, nowIso, key, label, price, decimals) {
  const existingItem = getExistingItem(existingData, key);
  const history = appendHistory(existingItem, nowIso, price);
  const prev24h = getClosest24hPrice(history, nowIso);

  return {
    key,
    label,
    price,
    change_pct: prev24h ? pctChange(price, prev24h) : 0,
    sparkline: historyToSparkline(history, 7, price),
    history,
    decimals
  };
}

// GoldAPI
async function getMetal(symbol, currency) {
  if (!GOLDAPI_KEY) {
    throw new Error("Missing GOLDAPI_KEY");
  }

  const headers = {
    "x-access-token": GOLDAPI_KEY,
    "Content-Type": "application/json"
  };

  const current = await getJson(
    `https://www.goldapi.io/api/${symbol}/${currency}`,
    { headers }
  );

  return {
    price: current.price,
    change_pct: typeof current.chp === "number" ? current.chp : 0
  };
}

// CoinGecko
async function getCoin(id, vs = "cad") {
  const headers = COINGECKO_API_KEY
    ? { "x-cg-demo-api-key": COINGECKO_API_KEY }
    : {};

  const current = await getJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=${vs}&include_24hr_change=true`,
    { headers }
  );

  return {
    price: current[id][vs],
    change_pct: current[id][`${vs}_24h_change`] ?? 0
  };
}

// FX latest
async function getFxLatest(base) {
  const data = await getJson(`https://open.er-api.com/v6/latest/${base}`);

  if (data.result !== "success" || !data.rates) {
    throw new Error(`Bad FX response for ${base}`);
  }

  return data.rates;
}

async function main() {
  const nowIso = new Date().toISOString();
  const existingData = await readExistingData();

  const [
    gold,
    silver,
    btc,
    eth,
    usdRates,
    eurRates,
    tryRates,
    cadRates
  ] = await Promise.all([
    getMetal("XAU", "CAD"),
    getMetal("XAG", "CAD"),
    getCoin("bitcoin", "cad"),
    getCoin("ethereum", "cad"),
    getFxLatest("USD"),
    getFxLatest("EUR"),
    getFxLatest("TRY"),
    getFxLatest("CAD")
  ]);

  const items = [
    buildItemFromApi(existingData, nowIso, "xaucad", "Gold (XAU/CAD)", gold.price, 2, gold.change_pct),
    buildItemFromApi(existingData, nowIso, "xagcad", "Silver (XAG/CAD)", silver.price, 2, silver.change_pct),
    buildItemFromApi(existingData, nowIso, "btccad", "BTC/CAD", btc.price, 0, btc.change_pct),
    buildItemFromApi(existingData, nowIso, "ethcad", "ETH/CAD", eth.price, 0, eth.change_pct),

    buildFxItem(existingData, nowIso, "usdcad", "USD/CAD", usdRates.CAD, 4),
    buildFxItem(existingData, nowIso, "eurcad", "EUR/CAD", eurRates.CAD, 4),
    buildFxItem(existingData, nowIso, "trycad", "TRY/CAD", tryRates.CAD, 4),
    buildFxItem(existingData, nowIso, "cadirr", "CAD/IRR", cadRates.IRR, 0),
    buildFxItem(existingData, nowIso, "usdirr", "USD/IRR", usdRates.IRR, 0)
  ];

  const payload = {
    updated_iso: nowIso,
    updated_tehran: tehranTime(nowIso),
    items
  };

  await fs.writeFile(outFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log("Updated public/data.json");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
