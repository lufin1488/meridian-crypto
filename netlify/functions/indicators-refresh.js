// Раз в 6 часов пересчитывает технические индикаторы и вердикт по каждому отслеживаемому
// активу (крипто-топ-10 + золото/нефть/USD-RUB). Дневные RSI/EMA физически не могут
// меняться быстрее — гонять это чаще бессмысленно и упирается в лимиты бесплатных API.
//
// ВАЖНО: вердикт считается ТОЛЬКО по техническим индикаторам (RSI, EMA50/200,
// поддержка/сопротивление). Связанные новости показываются рядом как контекст для
// обоснования, а не подмешиваются в % уверенности — так честнее рядом с обязательным
// дисклеймером "не инвестиционная рекомендация".

const { schedule } = require('@netlify/functions');
const { connectLambda, getStore } = require('@netlify/blobs');
const { STATIC_ASSETS } = require('./lib/assets-registry');
const { rsi, ema, supportResistance } = require('./lib/indicators');
const { coinGeckoHeaders } = require('./lib/coingecko');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function run() {
  const store = getStore('meridian-data');

  const cryptoListData = await store.get('crypto-list', { type: 'json' });
  const cryptoCoins = (cryptoListData && cryptoListData.coins) || [];

  let newsItems = [];
  try {
    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL;
    if (siteUrl) {
      const newsRes = await fetch(siteUrl + '/.netlify/functions/news');
      if (newsRes.ok) newsItems = await newsRes.json();
    }
  } catch (err) {
    console.warn('indicators-refresh: не удалось получить новости для контекста', err);
  }

  const prevVerdicts = (await store.get('verdicts', { type: 'json' })) || {};
  const newVerdicts = {};
  const notifyQueue = (await store.get('notify-queue', { type: 'json' })) || [];
  const errors = [];

  const noKey = !process.env.COINGECKO_API_KEY;

  for (const coin of cryptoCoins) {
    try {
      const closes = await fetchCryptoCloses(coin.id);
      if (closes.length < 20) throw new Error('недостаточно истории для индикаторов');
      const price = closes[closes.length - 1];
      const rsiVal = rsi(closes, 14);
      const ema50Val = ema(closes, 50);
      const ema200Val = ema(closes, 200);
      const { support, resistance } = supportResistance(closes, 30);
      const opinion = formOpinion({ price, rsiVal, ema50Val, ema200Val, support, resistance });
      const relatedNews = matchNews(newsItems, [coin.name, coin.symbol]);

      newVerdicts[coin.id] = {
        ...opinion,
        indicators: { rsi: rsiVal, ema50: ema50Val, ema200: ema200Val, support, resistance },
        relatedNews,
        computedAt: new Date().toISOString(),
      };
      if (noKey) await sleep(1500); // без демо-ключа публичный лимит CoinGecko нестабильный
    } catch (err) {
      errors.push(`${coin.id}: ${err.message}`);
    }
  }

  for (const asset of STATIC_ASSETS) {
    try {
      const closes = await fetchTwelveDataCloses(asset.twelveDataSymbol);
      if (closes.length < 20) throw new Error('недостаточно истории для индикаторов');
      const price = closes[closes.length - 1];
      const rsiVal = rsi(closes, 14);
      const ema50Val = ema(closes, 50);
      const ema200Val = ema(closes, 200);
      const { support, resistance } = supportResistance(closes, 30);
      const opinion = formOpinion({ price, rsiVal, ema50Val, ema200Val, support, resistance });
      const relatedNews = matchNews(newsItems, [asset.newsTag]);

      newVerdicts[asset.id] = {
        ...opinion,
        indicators: { rsi: rsiVal, ema50: ema50Val, ema200: ema200Val, support, resistance },
        relatedNews,
        computedAt: new Date().toISOString(),
      };
    } catch (err) {
      errors.push(`${asset.id}: ${err.message}`);
    }
  }

  // Если по активу вердикт впервые стал (или перестал быть) "ВХОДИТЬ" — ставим в очередь
  // на уведомление; alerts-check разошлёт и очистит очередь на ближайшем прогоне.
  for (const [assetId, v] of Object.entries(newVerdicts)) {
    const prev = prevVerdicts[assetId];
    const wasActionable = prev && (prev.verdict === 'buy' || prev.verdict === 'sell');
    const isActionable = v.verdict === 'buy' || v.verdict === 'sell';
    if (isActionable && (!prev || prev.verdict !== v.verdict)) {
      notifyQueue.push({ assetId, type: 'new-verdict', verdict: v.verdict, verdictLabel: v.verdictLabel, confidence: v.confidence, factors: v.factors, at: v.computedAt });
    } else if (wasActionable && !isActionable) {
      notifyQueue.push({ assetId, type: 'downgrade', verdict: v.verdict, verdictLabel: v.verdictLabel, at: v.computedAt });
    }
  }

  await store.setJSON('verdicts', newVerdicts);
  await store.setJSON('notify-queue', notifyQueue);

  if (errors.length) console.warn('indicators-refresh: часть активов не обработана:', errors.join('; '));

  return { statusCode: 200, body: JSON.stringify({ ok: true, computed: Object.keys(newVerdicts).length, errors }) };
}

exports.handler = schedule('0 */6 * * *', async (event) => {
  try {
    connectLambda(event); // подключить контекст Blobs из Lambda-события
    return await run();
  } catch (err) {
    console.error('indicators-refresh failed:', err);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: String(err) }) };
  }
});
