import fs from "node:fs/promises";

const GOLDAPI_KEY = process.env.GOLDAPI_KEY;
const EXCHANGERATE_KEY = process.env.EXCHANGERATE_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

const outFile = new URL("../public/data.json", import.meta.url);

function pctChange(current, prev) {
  if (!prev) return 0;
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

function dateOffset(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

async function getJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// GoldAPI
async function getMetal(symbol, currency) {
  const current = await getJson(
    `https://api.goldapi.net/v1/${symbol}/${currency}`,
    { headers: { "x-access-token": GOLDAPI_KEY } }
  );

  const dates = [6,5,4,3,2,1,0].map(dateOffset);
  const hist = [];
  for (const d of dates) {
    const row = await getJson(
      `https://api.goldapi.net/v1/historical/${symbol}/${currency}/${d}`,
      { headers: { "x-access-token": GOLDAPI_KEY } }
    );
    hist.push(row.price);
  }

  return {
    price: current.price,
    change_pct: current.chp ?? pctChange(hist.at(-1), hist.at(-2)),
    sparkline: hist
  };
}

// ExchangeRate Host
async function getFxSeries(from, to) {
  const start = dateOffset(6);
  const end = dateOffset(0);

  const tf = await getJson(
    `https://api.exchangerate.host/timeframe?access_key=${EXCHANGERATE_KEY}&source=${from}&currencies=${to}&start_date=${start}&end_date=${end}`
  );

  const points = Object.keys(tf.quotes)
    .sort()
    .map(date => tf.quotes[date][`${from}${to}`]);

  const current = points.at(-1);
  const prev = points.at(-2);

  return {
    price: current,
    change_pct: pctChange(current, prev),
    sparkline: points
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

  const chart = await getJson(
    `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=${vs}&days=7&interval=daily`,
    { headers }
  );

  const prices = chart.prices.map(p => p[1]);

  return {
    price: current[id][vs],
    change_pct: current[id][`${vs}_24h_change`] ?? pctChange(prices.at(-1), prices.at(-2)),
    sparkline: prices
  };
}

async function main() {
  const now = new Date().toISOString();

  const [
    gold,
    silver,
    btc,
    eth,
    usdcad,
    eurcad,
    trycad,
    cadirr,
    usdirr
  ] = await Promise.all([
    getMetal("XAU", "CAD"),
    getMetal("XAG", "CAD"),
    getCoin("bitcoin", "cad"),
    getCoin("ethereum", "cad"),
    getFxSeries("USD", "CAD"),
    getFxSeries("EUR", "CAD"),
    getFxSeries("TRY", "CAD"),
    getFxSeries("CAD", "IRR"),
    getFxSeries("USD", "IRR")
  ]);

  const payload = {
    updated_iso: now,
    updated_tehran: tehranTime(now),
    items: [
      { key: "xaucad", label: "Gold (XAU/CAD)", ...gold, decimals: 2 },
      { key: "xagcad", label: "Silver (XAG/CAD)", ...silver, decimals: 2 },
      { key: "btccad", label: "BTC/CAD", ...btc, decimals: 0 },
      { key: "ethcad", label: "ETH/CAD", ...eth, decimals: 0 },
      { key: "trycad", label: "TRY/CAD", ...trycad, decimals: 4 },
      { key: "usdcad", label: "USD/CAD", ...usdcad, decimals: 4 },
      { key: "eurcad", label: "EUR/CAD", ...eurcad, decimals: 4 },
      { key: "cadirr", label: "CAD/IRR", ...cadirr, decimals: 0 },
      { key: "usdirr", label: "USD/IRR", ...usdirr, decimals: 0 }
    ]
  };

  await fs.writeFile(outFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log("Updated public/data.json");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
