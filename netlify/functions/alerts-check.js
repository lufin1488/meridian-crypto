// Каждые ~20 минут: лёгкая проверка (только текущие цены, без пересчёта индикаторов) —
// резкие движения цены (>3% за ~час) и рассылка в Telegram того, что накопил
// indicators-refresh.js в notify-queue (новый вердикт "ВХОДИТЬ" — всем подписчикам,
// понижение до "НЕ ВХОДИТЬ" и резкие движения — только тем, кто включил это в /settings).

const { schedule } = require('@netlify/functions');
const { getStore } = require('@netlify/blobs');
const { STATIC_ASSETS } = require('./lib/assets-registry');
const { coinGeckoHeaders } = require('./lib/coingecko');

const PRICE_SPIKE_PCT = 3;
const PRICE_SAMPLE_WINDOW_MS = 65 * 60 * 1000; // ~65 минут, чтобы 3-4 прогона по 20 мин точно перекрыли час

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (err) {
    console.warn('alerts-check: не удалось отправить сообщение', chatId, err.message);
  }
}

const DISCLAIMER = '\n\n<i>Это аналитическое мнение на основе технических индикаторов, а не индивидуальная инвестиционная рекомендация.</i>';

async function fetchCurrentPrices(cryptoCoins) {
  const prices = {};

  if (cryptoCoins.length) {
    const ids = cryptoCoins.map((c) => c.id).join(',');
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { headers: coinGeckoHeaders() });
    if (res.ok) {
      const data = await res.json();
      for (const coin of cryptoCoins) {
        if (data[coin.id]) prices[coin.id] = data[coin.id].usd;
      }
    }
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (apiKey) {
    const symbols = STATIC_ASSETS.map((a) => a.twelveDataSymbol).join(',');
    const res = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbols)}&apikey=${apiKey}`);
    if (res.ok) {
      const data = await res.json();
      for (const asset of STATIC_ASSETS) {
        const info = data[asset.twelveDataSymbol];
        if (info && info.price) prices[asset.id] = parseFloat(info.price);
      }
    }
  }

  return prices;
}

async function run() {
  const store = getStore('meridian-data');
  const [cryptoListData, subscribers, priceSamples, notifyQueue, notifiedNews] = await Promise.all([
    store.get('crypto-list', { type: 'json' }),
    store.get('subscribers', { type: 'json' }),
    store.get('price-samples', { type: 'json' }),
    store.get('notify-queue', { type: 'json' }),
    store.get('notified-news', { type: 'json' }),
  ]);

  const cryptoCoins = (cryptoListData && cryptoListData.coins) || [];
  const subs = (subscribers || []).filter((s) => s.active);
  const samples = priceSamples || {};
  const queue = notifyQueue || [];
  const seenNews = new Set(notifiedNews || []);

  const names = {};
  // те же подписи, что и на сайте (BTC/USD, ETH/USD, …), а не полные имена CoinGecko
  for (const c of cryptoCoins) names[c.id] = `${String(c.symbol || '').toUpperCase()}/USD`;
  for (const a of STATIC_ASSETS) names[a.id] = a.name;

  const now = Date.now();
  const prices = await fetchCurrentPrices(cryptoCoins);

  // 1. Резкие движения цены за последний час
  const spikes = [];
  for (const [assetId, price] of Object.entries(prices)) {
    const history = (samples[assetId] || []).filter((s) => now - s.t <= PRICE_SAMPLE_WINDOW_MS);
    if (history.length) {
      const oldest = history[0];
      const pct = ((price - oldest.price) / oldest.price) * 100;
      if (Math.abs(pct) >= PRICE_SPIKE_PCT) {
        spikes.push({ assetId, pct });
      }
    }
    history.push({ t: now, price });
    samples[assetId] = history.slice(-6);
  }
  await store.setJSON('price-samples', samples);

  // 2. Важные новости (высокое влияние), которые ещё не рассылались
  let freshHighImpactNews = [];
  try {
    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL;
    if (siteUrl) {
      const res = await fetch(siteUrl + '/.netlify/functions/news');
      if (res.ok) {
        const items = await res.json();
        freshHighImpactNews = items.filter((n) => {
          const key = `${n.src}|${n.title}`;
          const isHigh = (n.tags || []).some((t) => t.c === 'impact-high');
          if (isHigh && !seenNews.has(key)) { seenNews.add(key); return true; }
          return false;
        });
      }
    }
  } catch (err) {
    console.warn('alerts-check: не удалось проверить новости', err.message);
  }
  const seenNewsArr = [...seenNews].slice(-200);
  await store.setJSON('notified-news', seenNewsArr);

  // 3. Рассылка приоритетных/второстепенных уведомлений подписчикам
  if (subs.length) {
    for (const item of queue) {
      const assetName = names[item.assetId] || item.assetId;
      if (item.type === 'new-verdict') {
        const text = `🎯 <b>${assetName}</b>: новый вердикт — <b>${item.verdictLabel}</b> (уверенность ${item.confidence}%)\n${(item.factors || []).join('; ')}${DISCLAIMER}`;
        for (const s of subs) await sendTelegramMessage(s.chatId, text);
      } else if (item.type === 'downgrade') {
        const text = `↩️ <b>${assetName}</b>: вердикт понижен до «${item.verdictLabel}»${DISCLAIMER}`;
        for (const s of subs.filter((s) => s.settings?.verdictDowngrade)) await sendTelegramMessage(s.chatId, text);
      }
    }

    for (const spike of spikes) {
      const assetName = names[spike.assetId] || spike.assetId;
      const dir = spike.pct > 0 ? 'выросла' : 'упала';
      const text = `⚡ <b>${assetName}</b>: цена резко ${dir} на ${Math.abs(spike.pct).toFixed(1)}% за последний час${DISCLAIMER}`;
      for (const s of subs.filter((s) => s.settings?.priceMoves)) await sendTelegramMessage(s.chatId, text);
    }

    for (const n of freshHighImpactNews) {
      const text = `📰 <b>${n.src}</b>: ${n.title}`;
      for (const s of subs.filter((s) => s.settings?.news)) await sendTelegramMessage(s.chatId, text);
    }
  }

  await store.setJSON('notify-queue', []); // очередь обработана

  return { statusCode: 200, body: JSON.stringify({ ok: true, spikes: spikes.length, notified: queue.length }) };
}

exports.handler = schedule('*/20 * * * *', async () => {
  try {
    return await run();
  } catch (err) {
    console.error('alerts-check failed:', err);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: String(err) }) };
  }
});
