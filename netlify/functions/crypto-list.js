// Отдаёт сайту заранее посчитанный топ-10 криптоактивов (см. crypto-list-refresh.js).
// Если блоб ещё пуст (первый деплой, суточный планировщик ещё не отработал) — считает
// список на лету и кэширует, чтобы сайт показал топ-10 сразу, а не через сутки.
// Кэшируется на CDN на час — список всё равно обновляется раз в сутки.

const { connectLambda, getStore } = require('@netlify/blobs');
const { fetchTop10 } = require('./lib/coingecko');

exports.handler = async function (event) {
  try {
    connectLambda(event); // подключить контекст Blobs из Lambda-события (обязательно для exports.handler-функций)
    const store = getStore('meridian-data');
    let data = await store.get('crypto-list', { type: 'json' });

    if (!data || !data.coins || !data.coins.length) {
      // ленивая инициализация: блоб ещё не заполнен планировщиком
      data = await fetchTop10();
      await store.setJSON('crypto-list', data);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=0, s-maxage=3600',
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(err), coins: [] }),
    };
  }
};
