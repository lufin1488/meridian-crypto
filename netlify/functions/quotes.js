// Прокси котировок золота (XAU/USD) и нефти (WTI/USD).
// Основной источник — Twelve Data; ключ лежит в переменной окружения TWELVE_DATA_API_KEY
// (Netlify → Site settings → Environment variables), поэтому в браузере он не появляется.
//
// Резерв — Yahoo Finance (без ключа): бесплатный тариф Twelve Data покрывает форекс/акции/
// крипту, но НЕ энергоносители, поэтому WTI оттуда не приходит вовсе. Всё, что не пришло
// от Twelve Data (нет ключа, лимит, тариф), добираем из Yahoo.

const { STATIC_ASSETS } = require('./lib/assets-registry');
const { fetchYahooSeries } = require('./lib/yahoo');

// Отдаём фронту те же ключи, что и раньше: 'XAU/USD' и 'WTI/USD'.
const QUOTED = STATIC_ASSETS.filter((a) => a.id === 'xau' || a.id === 'wti');

async function fetchFromTwelveData(symbols) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return {};
  const url = `https://api.twelvedata.com/quote?symbol=${symbols.join(',')}&apikey=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();

  // При запросе нескольких символов Twelve Data возвращает объект,
  // где ключ — сам символ ("XAU/USD"), значение — данные по нему.
  const out = {};
  for (const symbol of symbols) {
    const info = symbols.length === 1 ? data : data[symbol];
    if (info && info.close && !info.code) {
      out[symbol] = {
        price: parseFloat(info.close),
        percentChange: parseFloat(info.percent_change),
        source: 'twelvedata',
      };
    }
  }
  return out;
}

exports.handler = async function () {
  try {
    const symbols = QUOTED.map((a) => a.twelveDataSymbol);

    let out = {};
    try {
      out = await fetchFromTwelveData(symbols);
    } catch (err) {
      console.warn('quotes: Twelve Data недоступен, пробуем резерв', err.message);
    }

    // добираем недостающее из Yahoo (в первую очередь — нефть)
    const missing = QUOTED.filter((a) => !out[a.twelveDataSymbol] && a.yahooSymbol);
    const fallbacks = await Promise.allSettled(missing.map((a) => fetchYahooSeries(a.yahooSymbol, '5d')));
    fallbacks.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        out[missing[i].twelveDataSymbol] = {
          price: res.value.price,
          percentChange: res.value.percentChange,
          source: 'yahoo',
        };
      } else {
        console.warn('quotes: резерв Yahoo не сработал для', missing[i].id, res.reason && res.reason.message);
      }
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // Netlify CDN кэширует ответ на 5 минут — экономит лимит бесплатного тарифа API
        'Cache-Control': 'public, max-age=0, s-maxage=300',
      },
      body: JSON.stringify(out),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(err) }),
    };
  }
};
