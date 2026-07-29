// Резервный источник котировок и дневной истории — публичный chart-эндпоинт Yahoo Finance.
// Нужен для нефти (WTI): у Twelve Data бесплатный тариф покрывает форекс/акции/крипту,
// а энергоносители в него не входят, поэтому WTI оттуда не приходит. Ключ не требуется.
//
// ВАЖНО про изменение за 24ч: meta.chartPreviousClose при range=1y/5d — это закрытие
// ПЕРЕД окном (например, годовой давности), а не вчерашнее. Поэтому дневное изменение
// считаем по двум последним закрытиям массива.

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

// Возвращает { price, percentChange, closes } либо бросает ошибку.
async function fetchYahooSeries(yahooSymbol, range = '1y') {
  const url = `${YAHOO_BASE}${encodeURIComponent(yahooSymbol)}?interval=1d&range=${range}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Yahoo ${yahooSymbol}: HTTP ${res.status}`);
  const data = await res.json();

  const result = data && data.chart && Array.isArray(data.chart.result) && data.chart.result[0];
  if (!result) {
    const desc = data && data.chart && data.chart.error && data.chart.error.description;
    throw new Error(`Yahoo ${yahooSymbol}: ${desc || 'нет данных'}`);
  }

  const closes = ((result.indicators.quote[0] || {}).close || []).filter((x) => x != null);
  if (!closes.length) throw new Error(`Yahoo ${yahooSymbol}: пустой ряд закрытий`);

  const price = (result.meta && result.meta.regularMarketPrice) || closes[closes.length - 1];
  const prevClose = closes.length > 1 ? closes[closes.length - 2] : null;
  const percentChange = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

  return { price, percentChange, closes };
}

module.exports = { fetchYahooSeries };
