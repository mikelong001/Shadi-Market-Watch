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

function appendHistory(existingItem, nowIso, newPrice, maxPoints = 240) {
  const history = normalizeHistory(existingItem);
  const nowMs = new Date(nowIso).getTime();
  const last = history[history.length - 1];

  if (last) {
    const lastMs = new Date(last.t).getTime();

    // If the last point is effectively the same run, replace it.
    if (Math.abs(nowMs - lastMs) < 60 * 1000) {
      last.p = newPrice;
      last.t = nowIso;
      return history.slice(-maxPoints);
    }
  }

  history.push({ t: nowIso, p: newPrice });
  return history.slice(-maxPoints);
}

function findClosestPoint(history, targetMs, toleranceMs) {
  let best = null;
  let bestDiff = Infinity;

  for (const point of history) {
    const pointMs = new Date(point.t).getTime();
    const diff = Math.abs(pointMs - targetMs);

    if (diff < bestDiff) {
      best = point;
      bestDiff = diff;
    }
  }

  if (!best || bestDiff > toleranceMs) return null;
  return best;
}

function compute24hChange(history, nowIso) {
  const nowMs = new Date(nowIso).getTime();
  const point24h = findClosestPoint(
    history,
    nowMs - 24 * 60 * 60 * 1000,
    6 * 60 * 60 * 1000
  );

  if (!point24h) return null;

  const current = history[history.length - 1]?.p;
  if (typeof current !== "number") return null;

  return pctChange(current, point24h.p);
}

function compute7dChange(history, nowIso) {
  const nowMs = new Date(nowIso).getTime();
  const point7d = findClosestPoint(
    history,
    nowMs - 7 * 24 * 60 * 60 * 1000,
    18 * 60 * 60 * 1000
  );

  if (!point7d) return null;

  const current = history[history.length - 1]?.p;
  if (typeof current !== "number") return null;

  return pctChange(current, point7d.p);
}

function build7DaySparkline(history, nowIso, fallbackPrice) {
  const nowMs = new Date(nowIso).getTime();
  const toleranceMs = 18 * 60 * 60 * 1000;
  const points = [];

  for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
    const targetMs = nowMs - daysAgo * 24 * 60 * 60 * 1000;
    const point = findClosestPoint(history, targetMs, toleranceMs);

    if (point) {
      points.push(point.p);
    } else if (points.length) {
      points.push(points[points.length - 1]);
    } else {
      points.push(fallbackPrice);
    }
  }

  return points;
}

function roundTo(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function buildItem({
  existingData,
  nowIso,
  key,
  label,
  price,
  decimals,
  fallback24h = null,
  fallback7d = null
}) {
  const existingItem = getExistingItem(existingData, key);
  const history = appendHistory(existingItem, nowIso, price);

  const computed24h = compute24hChange(history, nowIso);
  const computed7d = compute7dChange(history, nowIso);

  const change24h =
    computed24h !== null
      ? computed24h
      : typeof fallback24h === "number"
        ? fallback24h
        : typeof existingItem?.change_24h === "number"
          ? existingItem.change_24h
          : 0;

  const change7d =
    computed7d !== null
      ? computed7d
      : typeof fallback7d === "number"
        ? fallback7d
        : typeof existingItem?.change_7d === "number"
          ? existingItem.change_7d
          : 0;

  return {
    key,
    label,
    price,
    change_24h: roundTo(change24h, 2),
    change_7d: roundTo(change7d, 2),
    sparkline: build7DaySparkline(history, nowIso, price),
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
    change_24h: typeof current.chp === "number" ? current.chp : null
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
    change_24h: current[id][`${vs}_24h_change`] ?? null
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
    tryRates
  ] = await Promise.all([
    getMetal("XAU", "CAD"),
    getMetal("XAG", "CAD"),
    getCoin("bitcoin", "cad"),
    getCoin("ethereum", "cad"),
    getFxLatest("USD"),
    getFxLatest("EUR"),
    getFxLatest("TRY")
  ]);

  const items = [
    buildItem({
      existingData,
      nowIso,
      key: "xaucad",
      label: "Gold (XAU/CAD)",
      price: gold.price,
      decimals: 2,
      fallback24h: gold.change_24h
    }),
    buildItem({
      existingData,
      nowIso,
      key: "xagcad",
      label: "Silver (XAG/CAD)",
      price: silver.price,
      decimals: 2,
      fallback24h: silver.change_24h
    }),
    buildItem({
      existingData,
      nowIso,
      key: "btccad",
      label: "BTC/CAD",
      price: btc.price,
      decimals: 0,
      fallback24h: btc.change_24h
    }),
    buildItem({
      existingData,
      nowIso,
      key: "ethcad",
      label: "ETH/CAD",
      price: eth.price,
      decimals: 0,
      fallback24h: eth.change_24h
    }),
    buildItem({
      existingData,
      nowIso,
      key: "usdcad",
      label: "USD/CAD",
      price: usdRates.CAD,
      decimals: 4
    }),
    buildItem({
      existingData,
      nowIso,
      key: "eurcad",
      label: "EUR/CAD",
      price: eurRates.CAD,
      decimals: 4
    }),
    buildItem({
      existingData,
      nowIso,
      key: "trycad",
      label: "TRY/CAD",
      price: tryRates.CAD,
      decimals: 4
    })
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
