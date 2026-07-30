// Раз в 6 часов пересчитывает технические индикаторы и вердикт по каждому отслеживаемому
// активу (крипто-топ-10 + золото/нефть/USD-RUB). Дневные RSI/EMA физически не могут
// меняться быстрее — гонять это чаще бессмысленно и упирается в лимиты бесплатных API.
// Здесь же — при появлении/смене вердикта на "ВХОДИТЬ" ставим уведомление в очередь,
// которую разошлёт alerts-check. Сам расчёт вынесен в lib/verdict-engine.js.

const { schedule } = require('@netlify/functions');
const { connectLambda, getStore } = require('@netlify/blobs');
const { computeVerdicts, fetchNewsContext } = require('./lib/verdict-engine');
const { STATIC_ASSETS } = require('./lib/assets-registry');

async function run() {
  const store = getStore('meridian-data');

  const cryptoListData = await store.get('crypto-list', { type: 'json' });
  const cryptoCoins = (cryptoListData && cryptoListData.coins) || [];
  const newsItems = await fetchNewsContext();

  const prevVerdicts = (await store.get('verdicts', { type: 'json' })) || {};
  const notifyQueue = (await store.get('notify-queue', { type: 'json' })) || [];

  const { verdicts: newVerdicts, errors } = await computeVerdicts(cryptoCoins, newsItems, { includeStatic: true });

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

  // Сливаем с предыдущими, а НЕ затираем: если часть активов не отдалась (лимит API,
  // сетевой сбой), их вердикты должны остаться прошлыми, а не исчезнуть с сайта.
  // Заодно отсеиваем активы, выпавшие из текущего топ-10, чтобы блоб не рос бесконечно.
  const trackedIds = new Set([...cryptoCoins.map((c) => c.id), ...STATIC_ASSETS.map((a) => a.id)]);
  const merged = {};
  for (const id of trackedIds) {
    if (newVerdicts[id]) merged[id] = newVerdicts[id];
    else if (prevVerdicts[id]) merged[id] = prevVerdicts[id];
  }

  await store.setJSON('verdicts', merged);
  await store.setJSON('notify-queue', notifyQueue);

  if (errors.length) console.warn('indicators-refresh: часть активов не обработана:', errors.join('; '));

  return { statusCode: 200, body: JSON.stringify({ ok: true, computed: Object.keys(newVerdicts).length, kept: Object.keys(merged).length, errors }) };
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
