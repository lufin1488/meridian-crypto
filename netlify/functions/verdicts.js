// Отдаёт сайту вердикты, посчитанные indicators-refresh.js (планировщик, раз в 6 часов).
//
// Ленивый пересчёт: если вердиктов по крипте заметно меньше, чем монет в топ-10 (первый
// деплой / планировщик ещё не отработал новый код), считает крипту на лету и кэширует.
// В штатном режиме (планировщик заполнил вердикты) этот путь не срабатывает. Twelve Data-
// активы (золото/нефть/USD-RUB) тут не считаются — они появятся при плановом прогоне,
// чтобы on-demand запрос гарантированно уложился в таймаут функции.

const { connectLambda, getStore } = require('@netlify/blobs');
const { computeVerdicts, fetchNewsContext } = require('./lib/verdict-engine');

const STALE_MS = 12 * 60 * 60 * 1000; // старше 12 ч считаем устаревшим

function isSparseOrStale(verdicts, cryptoCount) {
  const ids = Object.keys(verdicts || {});
  if (cryptoCount > 0 && ids.length < Math.ceil(cryptoCount * 0.6)) return true; // заполнено меньше 60%
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

    if (cryptoCoins.length && isSparseOrStale(data, cryptoCoins.length)) {
      const newsItems = await fetchNewsContext();
      // Считаем только недостающие монеты — меньше пакет, быстрее укладывается в лимит.
      const missing = cryptoCoins.filter((c) => !data[c.id]);
      const toCompute = missing.length ? missing : cryptoCoins;
      // Защита от таймаута on-demand функции (~10с): если публичный CoinGecko без ключа
      // тормозит и пересчёт не уложился в 8с — просто возвращаем что есть, ничего не теряя.
      // Пересчёт аддитивный, так что повторные запросы постепенно доберут все монеты.
      const computed = await Promise.race([
        computeVerdicts(toCompute, newsItems, { includeStatic: false }).then((r) => r.verdicts),
        new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (computed && Object.keys(computed).length) {
        // сохраняем поверх, не затирая уже посчитанные Twelve Data-активы
        data = { ...data, ...computed };
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
