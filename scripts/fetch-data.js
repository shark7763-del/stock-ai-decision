/* ===================================================================
   每日自動資料管線（試跑版：台灣50 成分股）
   資料來源：台灣證券交易所公開資訊 (www.twse.com.tw)
   產出：data.json  —— 前端「載入今日數據」直接讀取套用
   執行：node scripts/fetch-data.js
   無第三方相依，只用 Node 內建 https。
   =================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

/* 台灣50 (0050) 成分股，約 50 檔（皆為上市，TWSE 可查） */
const CODES = ['2330','2317','2454','2308','2382','2412','2891','2881','2882','2303',
'3711','2886','2884','1216','2885','2357','3034','2892','2890','5880','2880','3008',
'2883','2002','1303','1301','2887','3037','2207','2603','2379','4938','2345','3045',
'2912','1326','2395','5871','6669','3231','2801','2227','1101','2618','2408','3661',
'4904','9910','2474','6505',
// 常見 ETF
'0050','0056','006208','00878','00919','00929','00940','00713','00891','00892'];

const MONTHS = 5;          // 抓近 5 個月，確保 ≥60 個交易日
const DELAY  = 1200;       // 每次 API 間隔(ms)，避免被限流
const UA = 'Mozilla/5.0 (compatible; stock-ai-decision/1.0)';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => parseFloat(String(s).replace(/,/g, '')) || 0;
const roc2ad = d => { const [y,m,dd]=d.split('/'); return `${+y+1911}-${m.padStart(2,'0')}-${dd.padStart(2,'0')}`; };

function getJSON(url, tries = 3) {
  return new Promise((resolve) => {
    const attempt = t => {
      https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }, res => {
        let s = '';
        res.on('data', d => s += d);
        res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { t > 1 ? setTimeout(() => attempt(t - 1), 1500) : resolve(null); } });
      }).on('error', () => { t > 1 ? setTimeout(() => attempt(t - 1), 1500) : resolve(null); });
    };
    attempt(tries);
  });
}

function monthAnchors(n) {
  const out = []; const d = new Date();
  for (let i = 0; i < n; i++) { const y = d.getFullYear(), m = d.getMonth(); out.push(`${y}${String(m + 1).padStart(2, '0')}01`); d.setMonth(m - 1); }
  return out; // 由新到舊
}

/* ---- 指標計算 ---- */
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
const ma = (arr, n) => arr.length >= n ? avg(arr.slice(-n)) : (arr.length ? avg(arr) : 0);

function rsi(closes, p = 14) {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - p; i < closes.length; i++) { const ch = closes[i] - closes[i - 1]; ch >= 0 ? g += ch : l -= ch; }
  const ag = g / p, al = l / p; if (al === 0) return 100;
  return Math.round(100 - 100 / (1 + ag / al));
}
function kd(highs, lows, closes, p = 9) {
  let K = 50, D = 50;
  for (let i = 0; i < closes.length; i++) {
    const s = Math.max(0, i - p + 1);
    const hh = Math.max(...highs.slice(s, i + 1)), ll = Math.min(...lows.slice(s, i + 1));
    const rsv = hh === ll ? 50 : (closes[i] - ll) / (hh - ll) * 100;
    K = K * 2 / 3 + rsv / 3; D = D * 2 / 3 + K / 3;
  }
  return { k: Math.round(K), d: Math.round(D) };
}
function macdDIF(closes) {
  if (closes.length < 26) return 0;
  const ema = (arr, n) => { const k = 2 / (n + 1); let e = arr[0]; for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k); return e; };
  return +(ema(closes, 12) - ema(closes, 26)).toFixed(2);
}

async function fetchStock(code) {
  const rows = [];
  for (const anchor of monthAnchors(MONTHS).slice().reverse()) {
    const j = await getJSON(`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${anchor}&stockNo=${code}`);
    await sleep(DELAY);
    if (j && j.stat === 'OK' && Array.isArray(j.data)) j.data.forEach(r => rows.push(r));
  }
  if (!rows.length) return null;
  // 欄位: 日期,成交股數,成交金額,開,高,低,收,漲跌,成交筆數
  rows.sort((a, b) => roc2ad(a[0]).localeCompare(roc2ad(b[0])));
  const closes = rows.map(r => num(r[6])).filter(v => v > 0);
  const highs = rows.map(r => num(r[4]));
  const lows = rows.map(r => num(r[5]));
  const vols = rows.map(r => Math.round(num(r[1]) / 1000)); // 股 → 張
  if (closes.length < 5) return null;
  const { k, d } = kd(highs, lows, closes);
  const lastC = closes[closes.length - 1], prevC = closes.length >= 2 ? closes[closes.length - 2] : lastC;
  const chg = prevC ? +(((lastC - prevC) / prevC) * 100).toFixed(2) : 0;
  return {
    code, chg,
    price: closes[closes.length - 1],
    volume: vols[vols.length - 1],
    vol5: Math.round(ma(vols, 5)),
    ma5: +ma(closes, 5).toFixed(2), ma10: +ma(closes, 10).toFixed(2),
    ma20: +ma(closes, 20).toFixed(2), ma60: +ma(closes, 60).toFixed(2),
    rsi: rsi(closes), k, d, macd: macdDIF(closes),
    _date: roc2ad(rows[rows.length - 1][0])
  };
}

async function fetchMarket() {
  const closes = [];
  for (const anchor of monthAnchors(4).slice().reverse()) {
    const j = await getJSON(`https://www.twse.com.tw/exchangeReport/FMTQIK?response=json&date=${anchor}`);
    await sleep(DELAY);
    if (j && j.stat === 'OK' && Array.isArray(j.data)) j.data.forEach(r => closes.push({ d: roc2ad(r[0]), c: num(r[4]) }));
  }
  closes.sort((a, b) => a.d.localeCompare(b.d));
  const c = closes.map(x => x.c).filter(v => v > 0);
  if (!c.length) return { twPrice: 0, twMa20: 0, twMa60: 0, otcPrice: 0, otcMa20: 0, otcMa60: 0 };
  return {
    twPrice: +c[c.length - 1].toFixed(2), twMa20: +ma(c, 20).toFixed(2), twMa60: +ma(c, 60).toFixed(2),
    otcPrice: 0, otcMa20: 0, otcMa60: 0,
    _date: closes[closes.length - 1].d
  };
}

async function fetchInstitutional(dateAD) {
  // dateAD: YYYY-MM-DD → YYYYMMDD
  const ymd = dateAD.replace(/-/g, '');
  const j = await getJSON(`https://www.twse.com.tw/fund/T86?response=json&date=${ymd}&selectType=ALL`);
  const map = {};
  if (j && j.stat === 'OK' && Array.isArray(j.data)) {
    // 欄位: 證券代號,證券名稱,外陸資買賣超(不含外資自營商)=idx4, 投信買賣超=idx10
    j.data.forEach(r => { map[r[0].trim()] = { foreign: Math.round(num(r[4]) / 1000), trust: Math.round(num(r[10]) / 1000) }; });
  }
  return map;
}

(async () => {
  // 名稱字典
  let names = {};
  try { const raw = fs.readFileSync(path.join(__dirname, '..', 'stocks-db.js'), 'utf8'); names = JSON.parse(raw.replace(/^window\.TW_STOCKS=/, '').replace(/;\s*$/, '')); } catch (e) {}

  console.log(`抓取 ${CODES.length} 檔 × ${MONTHS} 月…`);
  const market = await fetchMarket();
  const tradeDate = market._date || new Date().toISOString().slice(0, 10);
  const inst = await fetchInstitutional(tradeDate);

  const stocks = [];
  for (let i = 0; i < CODES.length; i++) {
    const code = CODES[i];
    const s = await fetchStock(code);
    if (!s) { console.log(`  [略過] ${code} 無資料`); continue; }
    const it = inst[code] || { foreign: 0, trust: 0 };
    stocks.push({
      code, name: (names[code] && names[code].n) || '', industry: (names[code] && names[code].i) || '',
      price: s.price, chg: s.chg, volume: s.volume, vol5: s.vol5,
      ma5: s.ma5, ma10: s.ma10, ma20: s.ma20, ma60: s.ma60,
      rsi: s.rsi, k: s.k, d: s.d, macd: s.macd,
      foreign: it.foreign, trust: it.trust
    });
    console.log(`  [${i + 1}/${CODES.length}] ${code} ${stocks[stocks.length-1].name} ${s.price}`);
  }

  const out = { updated: new Date().toISOString(), tradeDate, market, stocks };
  fs.writeFileSync(path.join(__dirname, '..', 'data.json'), JSON.stringify(out));
  console.log(`完成：${stocks.length} 檔，交易日 ${tradeDate}，加權 ${market.twPrice}`);
})();
