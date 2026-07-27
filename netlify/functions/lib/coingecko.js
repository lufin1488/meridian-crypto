// Общая логика получения топ-10 криптоактивов из CoinGecko — используется и планировщиком
// (crypto-list-refresh.js, пишет в Blobs), и on-demand функцией (crypto-list.js, ленивая
// инициализация при первом запросе, пока планировщик ещё ни разу не отработал).

const { isChartableCoin, tvSymbolForCrypto } = require('./assets-registry');

function coinGeckoHeaders() {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { 'x-cg-demo-api-key': key } : {};
}

async function fetchTop10() {
  // per_page=30, чтобы после отсева стейблкоинов/производных/нестандартных тикеров
  // гарантированно осталось 10 нормальных монет.
  const url = 'https://api.coingecko.com/api/v3/coins/markets'
    + '?vs_currency=usd&order=market_cap_desc&per_page=30&page=1&sparkline=true&price_change_percentage=24h';
  const res = await fetch(url, { headers: coinGeckoHeaders() });
  if (!res.ok) throw new Error('CoinGecko markets not ok: HTTP ' + res.status);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('CoinGecko markets: неожиданный ответ');

  const coins = data
    .filter(isChartableCoin)
    .slice(0, 10)
    .map((c) => ({
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      image: c.image,
      price: c.current_price,
      change24h: c.price_change_percentage_24h,
      marketCap: c.market_cap,
      // прореживаем спарклайн (7д почасовой ≈168 точек) до ~40 точек для лёгкого мини-графика
      sparkline: Array.isArray(c.sparkline_in_7d && c.sparkline_in_7d.price)
        ? c.sparkline_in_7d.price.filter((_, i) => i % 4 === 0)
        : [],
      tvSymbol: tvSymbolForCrypto(c.id, c.symbol),
    }));

  return { updatedAt: new Date().toISOString(), coins };
}

module.exports = { fetchTop10, coinGeckoHeaders };
