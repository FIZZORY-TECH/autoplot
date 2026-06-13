// ============ Procedural OHLC + asset registry ============

const PROVIDERS = [
  { id: 'coinbase', label: 'Coinbase',   cls: 'crypto', accent: 'oklch(0.74 0.16 240)' },
  { id: 'binance',  label: 'Binance',    cls: 'crypto', accent: 'oklch(0.85 0.16 80)'  },
  { id: 'kraken',   label: 'Kraken',     cls: 'crypto', accent: 'oklch(0.78 0.18 320)' },
  { id: 'nasdaq',   label: 'NASDAQ',     cls: 'stock',  accent: 'oklch(0.78 0.16 150)' },
  { id: 'nyse',     label: 'NYSE',       cls: 'stock',  accent: 'oklch(0.82 0.14 215)' },
];

const ASSETS = [
  { sym: 'BTC',   name: 'Bitcoin',     cls: 'crypto', provider: 'coinbase', seed: 67400, vol: 0.022, color: 'oklch(0.78 0.16 60)'  },
  { sym: 'ETH',   name: 'Ethereum',    cls: 'crypto', provider: 'coinbase', seed: 3420,  vol: 0.025, color: 'oklch(0.72 0.16 280)' },
  { sym: 'SOL',   name: 'Solana',      cls: 'crypto', provider: 'binance',  seed: 178,   vol: 0.040, color: 'oklch(0.78 0.18 320)' },
  { sym: 'AVAX',  name: 'Avalanche',   cls: 'crypto', provider: 'binance',  seed: 38,    vol: 0.045, color: 'oklch(0.70 0.20 25)'  },
  { sym: 'LINK',  name: 'Chainlink',   cls: 'crypto', provider: 'coinbase', seed: 14.6,  vol: 0.038, color: 'oklch(0.74 0.16 240)' },
  { sym: 'DOGE',  name: 'Dogecoin',    cls: 'crypto', provider: 'binance',  seed: 0.142, vol: 0.055, color: 'oklch(0.85 0.14 90)'  },
  { sym: 'MATIC', name: 'Polygon',     cls: 'crypto', provider: 'kraken',   seed: 0.84,  vol: 0.042, color: 'oklch(0.70 0.18 300)' },
  { sym: 'ADA',   name: 'Cardano',     cls: 'crypto', provider: 'kraken',   seed: 0.42,  vol: 0.040, color: 'oklch(0.78 0.14 240)' },
  { sym: 'XRP',   name: 'Ripple',      cls: 'crypto', provider: 'binance',  seed: 0.58,  vol: 0.038, color: 'oklch(0.85 0.04 240)' },
  { sym: 'DOT',   name: 'Polkadot',    cls: 'crypto', provider: 'kraken',   seed: 7.2,   vol: 0.044, color: 'oklch(0.75 0.18 350)' },
  { sym: 'ATOM',  name: 'Cosmos',      cls: 'crypto', provider: 'coinbase', seed: 9.4,   vol: 0.040, color: 'oklch(0.72 0.16 300)' },
  { sym: 'NEAR',  name: 'NEAR',        cls: 'crypto', provider: 'binance',  seed: 4.8,   vol: 0.045, color: 'oklch(0.80 0.06 240)' },
  { sym: 'APT',   name: 'Aptos',       cls: 'crypto', provider: 'coinbase', seed: 9.1,   vol: 0.048, color: 'oklch(0.78 0.10 200)' },

  { sym: 'AAPL',  name: 'Apple',       cls: 'stock',  provider: 'nasdaq', seed: 224,  vol: 0.011, color: 'oklch(0.85 0.05 60)'  },
  { sym: 'NVDA',  name: 'NVIDIA',      cls: 'stock',  provider: 'nasdaq', seed: 138,  vol: 0.025, color: 'oklch(0.78 0.18 140)' },
  { sym: 'TSLA',  name: 'Tesla',       cls: 'stock',  provider: 'nasdaq', seed: 245,  vol: 0.030, color: 'oklch(0.72 0.18 25)'  },
  { sym: 'MSFT',  name: 'Microsoft',   cls: 'stock',  provider: 'nasdaq', seed: 415,  vol: 0.012, color: 'oklch(0.75 0.10 240)' },
  { sym: 'META',  name: 'Meta',        cls: 'stock',  provider: 'nasdaq', seed: 580,  vol: 0.018, color: 'oklch(0.72 0.14 250)' },
  { sym: 'GOOGL', name: 'Alphabet',    cls: 'stock',  provider: 'nasdaq', seed: 175,  vol: 0.014, color: 'oklch(0.80 0.14 30)'  },
  { sym: 'AMZN',  name: 'Amazon',      cls: 'stock',  provider: 'nasdaq', seed: 198,  vol: 0.016, color: 'oklch(0.82 0.14 80)'  },
  { sym: 'AMD',   name: 'AMD',         cls: 'stock',  provider: 'nasdaq', seed: 156,  vol: 0.026, color: 'oklch(0.74 0.18 20)'  },
  { sym: 'JPM',   name: 'JPMorgan',    cls: 'stock',  provider: 'nyse',   seed: 218,  vol: 0.013, color: 'oklch(0.75 0.10 260)' },
  { sym: 'BRK.B', name: 'Berkshire',   cls: 'stock',  provider: 'nyse',   seed: 458,  vol: 0.009, color: 'oklch(0.70 0.08 60)'  },
  { sym: 'V',     name: 'Visa',        cls: 'stock',  provider: 'nyse',   seed: 295,  vol: 0.011, color: 'oklch(0.80 0.12 240)' },
  { sym: 'XOM',   name: 'ExxonMobil',  cls: 'stock',  provider: 'nyse',   seed: 118,  vol: 0.014, color: 'oklch(0.75 0.18 30)'  },
  { sym: 'WMT',   name: 'Walmart',     cls: 'stock',  provider: 'nyse',   seed: 81,   vol: 0.010, color: 'oklch(0.78 0.10 220)' },
  { sym: 'BA',    name: 'Boeing',      cls: 'stock',  provider: 'nyse',   seed: 184,  vol: 0.022, color: 'oklch(0.74 0.10 230)' },
  { sym: 'DIS',   name: 'Disney',      cls: 'stock',  provider: 'nyse',   seed: 102,  vol: 0.018, color: 'oklch(0.78 0.10 280)' },
];

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function symSeed(sym) {
  let s = 0;
  for (let i = 0; i < sym.length; i++) s = (s * 31 + sym.charCodeAt(i)) | 0;
  return s * 7919 || 1;
}

function generateOHLC(asset, count = 600) {
  const rng = mulberry32(symSeed(asset.sym));
  const out = [];
  let price = asset.seed;
  let trend = 0;
  let regimeTimer = 0;
  for (let i = 0; i < count; i++) {
    if (regimeTimer <= 0) {
      trend = (rng() - 0.5) * asset.vol * 2.4;
      regimeTimer = 20 + Math.floor(rng() * 60);
    }
    regimeTimer--;
    trend *= 0.985;
    const noise = (rng() - 0.5) * asset.vol;
    const drift = trend + noise;
    const open = price;
    const close = Math.max(open * (1 + drift), open * 0.001);
    const wick = Math.abs(rng()) * asset.vol * 0.6 + Math.abs(drift) * 0.4;
    const high = Math.max(open, close) * (1 + wick * (0.4 + rng() * 0.6));
    const low  = Math.min(open, close) * (1 - wick * (0.4 + rng() * 0.6));
    const v    = (0.4 + rng()) * (1 + Math.abs(drift) * 18);
    out.push({ t: i, o: open, h: high, l: low, c: close, v });
    price = close;
  }
  return out;
}

function toHeikinAshi(c) {
  const ha = [];
  for (let i = 0; i < c.length; i++) {
    const haC = (c[i].o + c[i].h + c[i].l + c[i].c) / 4;
    const haO = i === 0 ? (c[i].o + c[i].c) / 2 : (ha[i-1].o + ha[i-1].c) / 2;
    const haH = Math.max(c[i].h, haO, haC);
    const haL = Math.min(c[i].l, haO, haC);
    ha.push({ t: c[i].t, o: haO, h: haH, l: haL, c: haC, v: c[i].v });
  }
  return ha;
}

function sma(c, n) {
  const out = new Array(c.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < c.length; i++) {
    sum += c[i].c;
    if (i >= n) sum -= c[i - n].c;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
function ema(c, n) {
  const out = new Array(c.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = c[0]?.c ?? 0;
  for (let i = 0; i < c.length; i++) {
    prev = i === 0 ? c[0].c : c[i].c * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function bollinger(c, n = 20, mult = 2) {
  const m = sma(c, n);
  const upper = new Array(c.length).fill(NaN);
  const lower = new Array(c.length).fill(NaN);
  for (let i = n - 1; i < c.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (c[j].c - m[i]) ** 2;
    const sd = Math.sqrt(s / n);
    upper[i] = m[i] + sd * mult;
    lower[i] = m[i] - sd * mult;
  }
  return { mid: m, upper, lower };
}
function rsi(c, n = 14) {
  const out = new Array(c.length).fill(NaN);
  let gain = 0, loss = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i].c - c[i - 1].c;
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) {
        const rs = (gain / n) / Math.max(loss / n, 1e-9);
        out[i] = 100 - 100 / (1 + rs);
      }
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      const rs = gain / Math.max(loss, 1e-9);
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function parseUserSeries(text, length) {
  // Accepts CSV/JSON list of numbers or "i,value" pairs. Returns array length=length aligned to last bars.
  const arr = new Array(length).fill(NaN);
  if (!text || !text.trim()) return arr;
  let nums = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try { nums = JSON.parse(trimmed); } catch { return arr; }
  } else {
    nums = trimmed.split(/[\s,;\n]+/).map(s => parseFloat(s)).filter(n => !Number.isNaN(n));
  }
  // align to end
  const n = Math.min(nums.length, length);
  for (let i = 0; i < n; i++) arr[length - n + i] = nums[i];
  return arr;
}

// Pretty-print price to consistent decimals
function fmtPrice(v) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 10000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (a >= 1000)  return v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (a >= 100)   return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a >= 1)     return v.toFixed(3);
  if (a >= 0.01)  return v.toFixed(4);
  return v.toFixed(6);
}
function fmtPct(p) {
  const sign = p > 0 ? '+' : '';
  return sign + (p * 100).toFixed(2) + '%';
}

window.TradingData = {
  ASSETS, PROVIDERS, generateOHLC, toHeikinAshi,
  sma, ema, bollinger, rsi,
  parseUserSeries, fmtPrice, fmtPct,
};
