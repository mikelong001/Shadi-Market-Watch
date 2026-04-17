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

function rollSparkline(existingItem, newPrice, desiredLength = 7) {
  const prev = Array.isArray(existingItem?.sparkline) ? existingItem.sparkline : [];
  const next = [...prev, newPrice].slice(-desiredLength);

  if (next.length === 0) return [newPrice];
  while (next.length < desiredLength) next.unshift(next[0]);

  return next;
}

function buildItem(existingData, key, label, price, decimals) {
  const existingItem = getExistingItem(existingData, key);
  const sparkline = rollSparkline(existingItem, price, 7);
  const prev = sparkline.length > 1 ? sparkline[sparkline.length - 2] : price;

  return {
    key,
    label,
    price,
    change_pct: pctChange(price, prev),
    sparkline,
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

  return current.price;
}

// CoinGecko
async function getCoin(id, vs = "cad") {
  const headers = COINGECKO_API_KEY
    ? { "x-cg-demo-api-key": COINGECKO_API_KEY }
    : {};

  const current = await getJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=${vs}`,
    { headers }
  );

  return current[id][vs];
}

// ExchangeRate-API open access
async function getFxLatest(base) {
  const data = await getJson(`https://open.er-api.com/v6/latest/${base}`);

  if (data.result !== "success" || !data.rates) {
    throw new Error(`Bad FX response for ${base}`);
  }

  return data.rates;
}

async function main() {
  const now = new Date().toISOString();
  const existingData = await readExistingData();

  const [
    goldPrice,
    silverPrice,
    btcPrice,
    ethPrice,
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
    buildItem(existingData, "xaucad", "Gold (XAU/CAD)", goldPrice, 2),
    buildItem(existingData, "xagcad", "Silver (XAG/CAD)", silverPrice, 2),
    buildItem(existingData, "btccad", "BTC/CAD", btcPrice, 0),
    buildItem(existingData, "ethcad", "ETH/CAD", ethPrice, 0),
    buildItem(existingData, "usdcad", "USD/CAD", usdRates.CAD, 4),
    buildItem(existingData, "eurcad", "EUR/CAD", eurRates.CAD, 4),
    buildItem(existingData, "trycad", "TRY/CAD", tryRates.CAD, 4),
    buildItem(existingData, "cadirr", "CAD/IRR", cadRates.IRR, 0),
    buildItem(existingData, "usdirr", "USD/IRR", usdRates.IRR, 0)
  ];

  const payload = {
    updated_iso: now,
    updated_tehran: tehranTime(now),
    items
  };

  await fs.writeFile(outFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log("Updated public/data.json");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

main().catch(err => {
  console.error(err);
  process.exit(1);
});
