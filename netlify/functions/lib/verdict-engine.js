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
const { fetchYahooSeries } = require('./yahoo');

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

// История для золота/нефти/USD-RUB: сначала Twelve Data, при неудаче — Yahoo (без ключа).
// Для нефти Twelve Data на бесплатном тарифе не отдаёт данные вовсе, поэтому резерв
// здесь не «на всякий случай», а основной рабочий путь.
async function fetchStaticAssetCloses(asset) {
  try {
    return await fetchTwelveDataCloses(asset.twelveDataSymbol);
  } catch (err) {
    if (!asset.yahooSymbol) throw err;
    const { closes } = await fetchYahooSeries(asset.yahooSymbol, '1y');
    return closes;
  }
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Запасной порог расхождения EMA (в долях цены), когда диапазон 30 дней неизвестен.
const FALLBACK_TREND_GAP = 0.06;

// Силу тренда меряем расхождением EMA50/EMA200 ОТНОСИТЕЛЬНО собственной волатильности
// актива (ширины 30-дневного диапазона). Иначе фиксированный порог даёт «100» почти всей
// крипте (она ходит на десятки процентов) и заниженные оценки золоту и валютам.
function trendStrength(price, ema50Val, ema200Val, support, resistance) {
  if (!(price > 0) || ema50Val == null || ema200Val == null) return 0;
  const gap = Math.abs(ema50Val - ema200Val) / price;
  const hasRange = support != null && resistance != null && resistance > support;
  // нижняя граница волатильности, чтобы совсем узкий диапазон не раздувал оценку
  const volatility = hasRange ? Math.max((resistance - support) / price, 0.02) : FALLBACK_TREND_GAP;
  return clamp01(gap / volatility);
}

// Строит вердикт и текстовое обоснование по чистым техническим индикаторам.
//
// Уверенность — НЕ фиксированное число: это взвешенная оценка трёх составляющих,
// каждая от 0 до 1 (их же показываем на карточке отдельными шкалами):
//   • тренд  (вес 0.5) — насколько разошлись EMA50 и EMA200 относительно цены;
//   • RSI    (вес 0.3) — насколько RSI подтверждает направление (есть ли запас хода);
//   • уровни (вес 0.2) — где цена внутри диапазона поддержка/сопротивление.
// Итог отображается в диапазоне 20–85%: 100% не бывает — это эвристика, а не прогноз.
function formOpinion({ price, rsiVal, ema50Val, ema200Val, support, resistance }) {
  const factors = [];
  let bias = 'neutral';
  let trendScore = 0;

  if (ema50Val != null && ema200Val != null && price > 0) {
    bias = ema50Val > ema200Val ? 'bull' : 'bear';
    trendScore = trendStrength(price, ema50Val, ema200Val, support, resistance);
    const strength = trendScore > 0.66 ? 'выраженный' : trendScore > 0.33 ? 'умеренный' : 'слабый';
    factors.push(bias === 'bull'
      ? `EMA50 выше EMA200 (${strength} восходящий тренд)`
      : `EMA50 ниже EMA200 (${strength} нисходящий тренд)`);
  } else if (ema50Val != null && price > 0) {
    bias = price > ema50Val ? 'bull' : 'bear';
    trendScore = clamp01(Math.abs(price - ema50Val) / price / FALLBACK_TREND_GAP);
    factors.push(bias === 'bull' ? 'цена выше EMA50' : 'цена ниже EMA50');
  }

  let rsiZone = 'neutral';
  if (rsiVal != null) {
    if (rsiVal < 30) rsiZone = 'oversold';
    else if (rsiVal > 70) rsiZone = 'overbought';
    factors.push(`RSI ${rsiVal.toFixed(0)}${rsiZone === 'oversold' ? ' (перепроданность)' : rsiZone === 'overbought' ? ' (перекупленность)' : ''}`);
  }

  // Насколько RSI подтверждает направление: для покупки хорош запас снизу (RSI ближе к 30),
  // для продажи — запас сверху (RSI ближе к 70). Нейтральные 50 дают ровно половину.
  let rsiScore = 0.5;
  if (rsiVal != null) {
    rsiScore = bias === 'bear' ? clamp01((rsiVal - 30) / 40) : clamp01((70 - rsiVal) / 40);
  }

  // Где цена внутри диапазона: покупать выгоднее у поддержки, продавать — у сопротивления.
  let levelScore = 0.5;
  if (support != null && resistance != null && resistance > support) {
    const rangePos = clamp01((price - support) / (resistance - support));
    levelScore = bias === 'bear' ? rangePos : 1 - rangePos;
    if (rangePos > 0.85) factors.push('цена у сопротивления');
    else if (rangePos < 0.15) factors.push('цена у поддержки');
  }

  let verdict = 'wait';
  let direction = null;
  let confidence;

  const conflict = (bias === 'bull' && rsiZone === 'overbought') || (bias === 'bear' && rsiZone === 'oversold');

  if (bias !== 'neutral' && !conflict) {
    verdict = bias === 'bull' ? 'buy' : 'sell';
    direction = bias === 'bull' ? 'long' : 'short';
    confidence = 20 + 65 * (0.5 * trendScore + 0.3 * rsiScore + 0.2 * levelScore);
  } else if (conflict) {
    // Тренд и RSI спорят — уверенность в «не входить» тем выше, чем сильнее расхождение.
    const extremeness = rsiZone === 'overbought' ? clamp01((rsiVal - 70) / 20) : clamp01((30 - rsiVal) / 20);
    confidence = 40 + 35 * extremeness;
    factors.push('сигнал неоднозначный — тренд и RSI расходятся');
  } else {
    // Нет данных по тренду (слишком короткая история) — доверять нечему.
    confidence = 25;
    factors.push('недостаточно истории для оценки тренда');
  }

  confidence = Math.round(Math.max(20, Math.min(85, confidence)));
  const verdictLabel = verdict === 'buy' ? 'BUY' : verdict === 'sell' ? 'SELL' : 'НЕ ВХОДИТЬ';

  return {
    verdict,
    verdictLabel,
    direction,
    confidence,
    factors,
    // составляющие уверенности (0–100) — показываются на карточке отдельными шкалами
    scores: {
      trend: Math.round(trendScore * 100),
      rsi: Math.round(rsiScore * 100),
      levels: Math.round(levelScore * 100),
    },
  };
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
          fetchCloses: () => fetchStaticAssetCloses(asset),
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
