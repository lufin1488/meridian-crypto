// Отдаёт сайту вердикты, посчитанные indicators-refresh.js (планировщик, раз в 6 часов).
//
// Ленивый пересчёт: если каких-то вердиктов не хватает (первый деплой / планировщик ещё
// не отработал), считает недостающее на лету и кэширует. В штатном режиме (планировщик
// всё заполнил) этот путь не срабатывает и внешние API не дёргаются.

const { connectLambda, getStore } = require('@netlify/blobs');
const { computeVerdicts, fetchNewsContext } = require('./lib/verdict-engine');
const { STATIC_ASSETS } = require('./lib/assets-registry');

const STALE_MS = 12 * 60 * 60 * 1000; // старше 12 ч считаем устаревшим

// Нужен ли ленивый пересчёт: есть недостающие вердикты (крипта или золото/нефть/USD-RUB),
// либо всё устарело. Частоту ограничивает CDN-кэш ответа на 10 минут (см. Cache-Control).
function needsLazyCompute(verdicts, cryptoCoins) {
  if (cryptoCoins.some((c) => !verdicts[c.id])) return true;
  if (STATIC_ASSETS.some((a) => !verdicts[a.id])) return true;
  const ids = Object.keys(verdicts || {});
  const newest = ids.map((id) => Date.parse(verdicts[id].computedAt || 0)).sort((a, b) => b - a)[0] || 0;
  return Date.now() - newest > STALE_MS;
}

exports.handler = async function (event) {
  try {
    connectLambda(event); // подключить контекст Blobs из Lambda-события (обязательно для exports.handler-функций)
    const store = getStore('meridian-data');
    let data = (await store.get('verdicts', { type: 'json' })) || {};

    const cryptoListData = await store.get('crypto-list', { type: 'json' });
    const cryptoCoins = (cryptoListData && cryptoListData.coins) || [];

    if (needsLazyCompute(data, cryptoCoins)) {
      const newsItems = await fetchNewsContext();
      const missingCoins = cryptoCoins.filter((c) => !data[c.id]);
      // Золото/нефть/USD-RUB добираем, только если их ещё нет (3 быстрых запроса).
      const needStatic = STATIC_ASSETS.some((a) => !data[a.id]);

      // Что именно считаем: недостающие монеты; если недостающих нет, но чего-то нет из
      // статичных — только их; иначе (сработала проверка на устаревание) пересчитываем всё.
      let coinsToCompute;
      if (missingCoins.length) coinsToCompute = missingCoins;
      else if (needStatic) coinsToCompute = [];
      else coinsToCompute = cryptoCoins;

      // Защита от таймаута on-demand функции (~10с): если публичный CoinGecko без ключа
      // тормозит и пересчёт не уложился в 8с — просто возвращаем что есть, ничего не теряя.
      // Пересчёт аддитивный, так что повторные запросы постепенно доберут остальное.
      const computed = await Promise.race([
        computeVerdicts(coinsToCompute, newsItems, { includeStatic: needStatic }).then((r) => r.verdicts),
        new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (computed && Object.keys(computed).length) {
        // перечитываем свежий блоб прямо перед записью и сливаемся в него — чтобы
        // параллельные on-demand пересчёты накапливались, а не затирали друг друга.
        const latest = (await store.get('verdicts', { type: 'json' })) || {};
        data = { ...latest, ...data, ...computed };
        await store.setJSON('verdicts', data);
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=0, s-maxage=600',
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(err) }),
    };
  }
};
