// Раз в сутки обновляет топ-10 криптоактивов по капитализации (без стейблкоинов)
// и сохраняет в Netlify Blobs — сама страница читает готовый список через crypto-list.js,
// не дёргая CoinGecko напрямую из браузера каждого посетителя.

const { schedule } = require('@netlify/functions');
const { connectLambda, getStore } = require('@netlify/blobs');
const { fetchTop10 } = require('./lib/coingecko');

async function run() {
  const list = await fetchTop10();
  const store = getStore('meridian-data');
  await store.setJSON('crypto-list', list);
  return { statusCode: 200, body: JSON.stringify({ ok: true, count: list.coins.length }) };
}

exports.handler = schedule('@daily', async (event) => {
  try {
    connectLambda(event); // подключить контекст Blobs из Lambda-события
    return await run();
  } catch (err) {
    console.error('crypto-list-refresh failed:', err);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: String(err) }) };
  }
});
