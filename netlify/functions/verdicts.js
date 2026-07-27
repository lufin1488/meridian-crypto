// Отдаёт сайту вердикты, посчитанные indicators-refresh.js. Кэш на CDN короче, чем у
// crypto-list, т.к. это более "живая" часть дашборда (хоть и обновляется раз в 6 часов).

const { connectLambda, getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  try {
    connectLambda(event); // подключить контекст Blobs из Lambda-события (обязательно для exports.handler-функций)
    const store = getStore('meridian-data');
    const data = await store.get('verdicts', { type: 'json' });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=0, s-maxage=600',
      },
      body: JSON.stringify(data || {}),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(err) }),
    };
  }
};
