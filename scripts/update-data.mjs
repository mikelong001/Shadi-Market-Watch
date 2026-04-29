import fs from "node:fs/promises";

const GOLDAPI_KEY = process.env.GOLDAPI_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const METALS_DEV_KEY = process.env.METALS_DEV_KEY;

const outFile = new URL("../public/data.json", import.meta.url);

const HISTORY_DAYS = 30;
const RUNS_PER_DAY = 4;
const MAX_POINTS = HISTORY_DAYS * RUNS_PER_DAY;

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
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function safeGet(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.log(`Skipping ${label}: ${err.message}`);
    return null;
  }
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

function appendHistory(existingItem, nowIso, newPrice, maxPoints = MAX_POINTS) {
  const history = normalizeHistory(existingItem);
  const nowMs = new Date(nowIso).getTime();
  const last = history[history.length - 1];

  if (last) {
    const lastMs = new Date(last.t).getTime();

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
    8 * 60 * 60 * 1000
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

function keepExistingOrEmpty(existingData, key, label, decimals) {
  return getExistingItem(existingData, key) || {
    key,
    label,
    price: 0,
    change_24h: 0,
    change_7d: 0,
    sparkline: [0, 0, 0, 0, 0, 0, 0],
    history: [],
    decimals
  };
}

function buildLiveOrExisting(existingData, nowIso, key, label, live, decimals) {
  if (!live || typeof live.price !== "number") {
    return keepExistingOrEmpty(existingData, key, label, decimals);
  }

  return buildItem({
    existingData,
    nowIso,
    key,
    label,
    price: live.price,
    decimals,
    fallback24h: live.change_24h
  });
}

async function getMetalGoldApi(symbol, currency) {
  if (!GOLDAPI_KEY) throw new Error("Missing GOLDAPI_KEY");

  const current = await getJson(
    `https://www.goldapi.io/api/${symbol}/${currency}`,
    {
      headers: {
        "x-access-token": GOLDAPI_KEY,
        "Content-Type": "application/json"
      }
    }
  );

  return {
    price: current.price,
    change_24h: typeof current.chp === "number" ? current.chp : null
  };
}

async function getMetalMetalsDev(metal, currency) {
  if (!METALS_DEV_KEY) throw new Error("Missing METALS_DEV_KEY");

  const data = await getJson(
    `https://api.metals.dev/v1/metal/spot?api_key=${METALS_DEV_KEY}&metal=${metal}&currency=${currency}`,
    {
      headers: {
        "Accept": "application/json"
      }
    }
  );

  if (data.status !== "success" || !data.rate || typeof data.rate.price !== "number") {
    throw new Error(`Bad Metals.Dev response for ${metal}`);
  }

  return {
    price: data.rate.price,
    change_24h: typeof data.rate.change_percent === "number" ? data.rate.change_percent : null
  };
}

async function getMetalWithFallback(symbol, metalName, currency) {
  const fromGoldApi = await safeGet(
    `GoldAPI ${symbol}/${currency}`,
    () => getMetalGoldApi(symbol, currency)
  );

  if (fromGoldApi) return fromGoldApi;

  const fromMetalsDev = await safeGet(
    `Metals.Dev ${metalName}/${currency}`,
    () => getMetalMetalsDev(metalName, currency)
  );

  return fromMetalsDev;
}

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
    getMetalWithFallback("XAU", "gold", "CAD"),
    getMetalWithFallback("XAG", "silver", "CAD"),
    safeGet("bitcoin", () => getCoin("bitcoin", "cad")),
    safeGet("ethereum", () => getCoin("ethereum", "cad")),
    safeGet("USD rates", () => getFxLatest("USD")),
    safeGet("EUR rates", () => getFxLatest("EUR")),
    safeGet("TRY rates", () => getFxLatest("TRY")),
    safeGet("CAD rates", () => getFxLatest("CAD"))
  ]);

  const items = [
    buildLiveOrExisting(existingData, nowIso, "xaucad", "Gold (XAU/CAD)", gold, 2),
    buildLiveOrExisting(existingData, nowIso, "xagcad", "Silver (XAG/CAD)", silver, 2),
    buildLiveOrExisting(existingData, nowIso, "btccad", "BTC/CAD", btc, 0),
    buildLiveOrExisting(existingData, nowIso, "ethcad", "ETH/CAD", eth, 0),

    usdRates
      ? buildItem({ existingData, nowIso, key: "usdcad", label: "USD/CAD", price: usdRates.CAD, decimals: 4 })
      : keepExistingOrEmpty(existingData, "usdcad", "USD/CAD", 4),

    eurRates
      ? buildItem({ existingData, nowIso, key: "eurcad", label: "EUR/CAD", price: eurRates.CAD, decimals: 4 })
      : keepExistingOrEmpty(existingData, "eurcad", "EUR/CAD", 4),

    tryRates
      ? buildItem({ existingData, nowIso, key: "trycad", label: "TRY/CAD", price: tryRates.CAD, decimals: 4 })
      : keepExistingOrEmpty(existingData, "trycad", "TRY/CAD", 4),

    cadRates
      ? buildItem({ existingData, nowIso, key: "cadirr", label: "CAD/IRR", price: cadRates.IRR, decimals: 0 })
      : keepExistingOrEmpty(existingData, "cadirr", "CAD/IRR", 0),

    usdRates
      ? buildItem({ existingData, nowIso, key: "usdirr", label: "USD/IRR", price: usdRates.IRR, decimals: 0 })
      : keepExistingOrEmpty(existingData, "usdirr", "USD/IRR", 0)
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
