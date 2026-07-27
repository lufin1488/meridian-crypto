// Простые, общеизвестные формулы технических индикаторов. Без внешних npm-пакетов —
// это осознанно упрощённая эвристика, а не профессиональный квант-движок
// (см. дисклеймер на сайте: аналитическое мнение, не инвестиционная рекомендация).

// EMA (экспоненциальная скользящая средняя) на закрытиях, посчитанная от начала серии.
function ema(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const k = 2 / (period + 1);
  let value = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    value = closes[i] * k + value * (1 - k);
  }
  return value;
}

// RSI по методу Уайлдера (сглаженное среднее прироста/потерь), значение на последней точке.
function rsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Грубая эвристика уровней поддержки/сопротивления: мин/макс цены закрытия за окно.
function supportResistance(closes, lookback = 30) {
  if (!Array.isArray(closes) || closes.length === 0) return { support: null, resistance: null };
  const window = closes.slice(-lookback);
  return { support: Math.min(...window), resistance: Math.max(...window) };
}

module.exports = { ema, rsi, supportResistance };
