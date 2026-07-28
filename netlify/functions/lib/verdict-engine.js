// Общий движок расчёта вердиктов: тянет историю цен, считает индикаторы (RSI/EMA/уровни)
// и формирует вердикт BUY/SELL/НЕ ВХОДИТЬ. Используется планировщиком
// (indicators-refresh.js — полный расчёт + очередь уведомлений) и on-demand функцией
// (verdicts.js — ленивый пересчёт крипты, если блоб ещё не заполнен планировщиком).
//
// Вердикт считается ТОЛЬКО по техническим индикаторам. Связанные новости идут рядом
// как контекст, а не подмешиваются в уверенность — так честнее рядом с дисклеймером.

const { rsi, ema, supportResistance } = require('./indicators');
const { coinGeckoHeaders } = require('./coingecko');
const { STATIC_ASSETS } = require('./assets-registry');

async function fetchCryptoCloses(coinGeckoId) {
  // Без interval=daily: для days>90 CoinGecko и так отдаёт дневные точки (auto-granularity),
  // а явный interval=daily на demo-ключе может вернуть 401 "only for Enterprise".
  const url = `https://api.coingecko.com/api/v3/coins/${coinGeckoId}/market_chart?vs_currency=usd&days=250`;
  const res = await fetch(url, { headers: coinGeckoHeaders() });
  if (!res.ok) throw new Error(`CoinGecko market_chart ${coinGeckoId}: HTTP ${res.status}`);
  const data = await res.json();
  return (data.prices || []).map((p) => p[1]);
}

async function fetchTwelveDataCloses(symbol) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new Error('TWELVE_DATA_API_KEY не настроен');
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=250&apikey=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.values) throw new Error(`Twelve Data time_series ${symbol}: ${data.message || 'нет данных'}`);
  return data.values.map((v) => parseFloat(v.close)).reverse(); // Twelve Data отдаёт новые→старые
}

// Строит вердикт и текстовое обоснование по чистым техническим индикаторам.
function formOpinion({ price, rsiVal, ema50Val, ema200Val, support, resistance }) {
  const factors = [];
  let bias = 'neutral';

  if (ema50Val != null && ema200Val != null) {
    bias = ema50Val > ema200Val ? 'bull' : 'bear';
    factors.push(bias === 'bull' ? 'EMA50 выше EMA200 (восходящий тренд)' : 'EMA50 ниже EMA200 (нисходящий тренд)');
  } else if (ema50Val != null) {
    bias = price > ema50Val ? 'bull' : 'bear';
    factors.push(bias === 'bull' ? 'цена выше EMA50' : 'цена ниже EMA50');
  }

  let rsiZone = 'neutral';
  if (rsiVal != null) {
    if (rsiVal < 30) rsiZone = 'oversold';
    else if (rsiVal > 70) rsiZone = 'overbought';
    factors.push(`RSI ${rsiVal.toFixed(0)}${rsiZone === 'oversold' ? ' (перепроданность)' : rsiZone === 'overbought' ? ' (перекупленность)' : ''}`);
  }

  if (support != null && resistance != null && resistance > support) {
    const rangePos = (price - support) / (resistance - support);
    if (rangePos > 0.85) factors.push('цена у сопротивления');
    else if (rangePos < 0.15) factors.push('цена у поддержки');
  }

  let verdict = 'wait';
  let direction = null;
  let confidence = 35;

  if (bias === 'bull' && rsiZone !== 'overbought') {
    verdict = 'buy'; direction = 'long';
    confidence = 55 + (rsiZone === 'oversold' ? 15 : 0);
  } else if (bias === 'bear' && rsiZone !== 'oversold') {
    verdict = 'sell'; direction = 'short';
    confidence = 55 + (rsiZone === 'overbought' ? 15 : 0);
  } else if (rsiZone === 'oversold' || rsiZone === 'overbought') {
    verdict = 'wait';
    confidence = 40;
    factors.push('сигнал неоднозначный — тренд и RSI расходятся');
  }

  confidence = Math.max(20, Math.min(85, confidence));
  const verdictLabel = verdict === 'buy' ? 'BUY' : verdict === 'sell' ? 'SELL' : 'НЕ ВХОДИТЬ';

  return { verdict, verdictLabel, direction, confidence, factors };
}

// Ищет недавние новости, упоминающие актив (по имени/тикеру), для показа как контекста.
function matchNews(newsItems, names) {
  const lowerNames = names.filter(Boolean).map((n) => n.toLowerCase());
  return newsItems
    .filter((n) => {
      const text = `${n.title} ${n.excerpt}`.toLowerCase();
      return lowerNames.some((name) => name.length > 2 && text.includes(name));
    })
    .slice(0, 3)
    .map((n) => ({ time: n.time, src: n.src, title: n.title }));
}

// Считает индикаторы + вердикт по ряду цен закрытия и формирует запись вердикта.
function buildVerdict(closes, newsItems, newsNames) {
  if (!Array.isArray(closes) || closes.length < 20) {
    throw new Error('недостаточно истории для индикаторов');
  }
  const price = closes[closes.length - 1];
  const rsiVal = rsi(closes, 14);
  const ema50Val = ema(closes, 50);
  const ema200Val = ema(closes, 200);
  const { support, resistance } = supportResistance(closes, 30);
  const opinion = formOpinion({ price, rsiVal, ema50Val, ema200Val, support, resistance });
  return {
    ...opinion,
    indicators: { rsi: rsiVal, ema50: ema50Val, ema200: ema200Val, support, resistance },
    relatedNews: matchNews(newsItems, newsNames),
    computedAt: new Date().toISOString(),
  };
}

// Параллельно тянет историю по всем активам и считает вердикты.
// Параллельно — иначе последовательные запросы упираются в таймаут serverless-функции.
// includeStatic=false для лёгкого on-demand пересчёта только крипты (без Twelve Data).
async function computeVerdicts(cryptoCoins, newsItems, { includeStatic = true } = {}) {
  const tasks = [
    ...cryptoCoins.map((coin) => ({
      id: coin.id,
      newsNames: [coin.name, coin.symbol],
      fetchCloses: () => fetchCryptoCloses(coin.id),
    })),
    ...(includeStatic
      ? STATIC_ASSETS.map((asset) => ({
          id: asset.id,
          newsNames: [asset.newsTag],
          fetchCloses: () => fetchTwelveDataCloses(asset.twelveDataSymbol),
        }))
      : []),
  ];

  const verdicts = {};
  const errors = [];
  const results = await Promise.allSettled(tasks.map((t) => t.fetchCloses()));
  results.forEach((res, i) => {
    const task = tasks[i];
    if (res.status !== 'fulfilled') {
      errors.push(`${task.id}: ${res.reason && res.reason.message ? res.reason.message : res.reason}`);
      return;
    }
    try {
      verdicts[task.id] = buildVerdict(res.value, newsItems, task.newsNames);
    } catch (err) {
      errors.push(`${task.id}: ${err.message}`);
    }
  });

  return { verdicts, errors };
}

// Подтягивает ленту новостей сайта (для контекста вердиктов). Без сайт-URL — пустой список.
async function fetchNewsContext() {
  try {
    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL;
    if (!siteUrl) return [];
    const res = await fetch(siteUrl + '/.netlify/functions/news');
    if (res.ok) return await res.json();
  } catch (err) {
    console.warn('verdict-engine: не удалось получить новости для контекста', err.message);
  }
  return [];
}

module.exports = { computeVerdicts, fetchNewsContext };
