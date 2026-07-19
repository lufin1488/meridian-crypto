// Прокси для золота (XAU/USD) и нефти (WTI/USD) через Twelve Data.
// Ключ лежит в переменной окружения TWELVE_DATA_API_KEY (Netlify → Site settings → Environment variables),
// поэтому в браузере он никогда не появляется.

const SYMBOLS = ['XAU/USD', 'WTI/USD'];

exports.handler = async function () {
  const apiKey = process.env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'TWELVE_DATA_API_KEY не настроен в переменных окружения Netlify' }),
    };
  }

  try {
    const url = `https://api.twelvedata.com/quote?symbol=${SYMBOLS.join(',')}&apikey=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();

    // При запросе нескольких символов Twelve Data возвращает объект,
    // где ключ — сам символ ("XAU/USD"), значение — данные по нему.
    const out = {};
    for (const symbol of SYMBOLS) {
      const info = data[symbol];
      if (info && info.close && !info.code) {
        out[symbol] = {
          price: parseFloat(info.close),
          percentChange: parseFloat(info.percent_change),
        };
      }
    }

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
