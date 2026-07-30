// Диагностика состояния сайта: какие ключи настроены и отвечают ли источники данных.
//
// БЕЗОПАСНОСТЬ: наружу отдаются только признаки «ключ задан / не задан» (true/false)
// и HTTP-статусы внешних сервисов. Сами значения ключей не логируются и не возвращаются.

const { connectLambda, getStore } = require('@netlify/blobs');
const { coinGeckoHeaders } = require('./lib/coingecko');
const { STATIC_ASSETS } = require('./lib/assets-registry');

const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((resolve) => setTimeout(() => resolve({ ok: false, note: 'таймаут' }), ms)),
]);

async function checkCoinGecko() {
  try {
    const usingKey = Boolean(process.env.COINGECKO_API_KEY);
    const res = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=1&page=1',
      { headers: coinGeckoHeaders() },
    );
    return {
      ok: res.ok,
      status: res.status,
      usingKey,
      note: res.status === 429 ? 'лимит запросов (429) — нужен ключ' : res.ok ? 'отвечает' : 'ошибка',
    };
  } catch (err) {
    return { ok: false, note: String(err.message || err) };
  }
}

async function checkTwelveData() {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return { ok: false, note: 'ключ не задан' };
  try {
    const res = await fetch(`https://api.twelvedata.com/quote?symbol=XAU/USD&apikey=${apiKey}`);
    const data = await res.json();
    if (data && data.code && data.code !== 200) {
      // сообщения Twelve Data не содержат ключа, но на всякий случай отдаём только код
      return { ok: false, status: data.code, note: 'сервис вернул ошибку' };
    }
    return { ok: Boolean(data && data.close), note: data && data.close ? 'отвечает' : 'нет данных' };
  } catch (err) {
    return { ok: false, note: String(err.message || err) };
  }
}

async function checkYahoo() {
  try {
    const symbol = (STATIC_ASSETS.find((a) => a.id === 'wti') || {}).yahooSymbol || 'CL=F';
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } },
    );
    return { ok: res.ok, status: res.status, note: res.ok ? 'отвечает' : 'ошибка' };
  } catch (err) {
    return { ok: false, note: String(err.message || err) };
  }
}

exports.handler = async function (event) {
  connectLambda(event);

  // проверки идут параллельно, поэтому общий предел — 7с, с запасом до лимита функции
  const [coingecko, twelvedata, yahoo] = await Promise.all([
    withTimeout(checkCoinGecko(), 7000),
    withTimeout(checkTwelveData(), 7000),
    withTimeout(checkYahoo(), 7000),
  ]);

  let storage = { ok: false, note: 'недоступно' };
  try {
    const store = getStore('meridian-data');
    const verdicts = (await store.get('verdicts', { type: 'json' })) || {};
    const list = (await store.get('crypto-list', { type: 'json' })) || {};
    const subscribers = (await store.get('subscribers', { type: 'json' })) || [];
    const ages = Object.values(verdicts)
      .map((v) => Date.parse(v.computedAt))
      .filter((t) => !Number.isNaN(t));
    storage = {
      ok: true,
      verdicts: Object.keys(verdicts).length,
      coins: (list.coins || []).length,
      telegramSubscribers: subscribers.filter((s) => s.active).length,
      verdictsAgeMinutes: ages.length ? Math.round((Date.now() - Math.max(...ages)) / 60000) : null,
    };
  } catch (err) {
    storage = { ok: false, note: String(err.message || err) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      checkedAt: new Date().toISOString(),
      // только признаки наличия — не значения
      keysConfigured: {
        TWELVE_DATA_API_KEY: Boolean(process.env.TWELVE_DATA_API_KEY),
        COINGECKO_API_KEY: Boolean(process.env.COINGECKO_API_KEY),
        TELEGRAM_BOT_TOKEN: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      },
      sources: { coingecko, twelvedata, yahoo },
      storage,
    }, null, 2),
  };
};
