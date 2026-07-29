// Единый реестр отслеживаемых активов для вердикт-движка, чтобы не дублировать
// список источников данных в нескольких функциях.

// Активы, которые не входят в динамический крипто-топ-10 (форекс/товары) —
// технические индикаторы по ним считаются через Twelve Data.
// yahooSymbol — резервный источник (lib/yahoo.js): бесплатный тариф Twelve Data
// покрывает форекс/акции/крипту, но НЕ энергоносители, поэтому WTI приходит только
// оттуда. Для остальных Yahoo служит подстраховкой, если Twelve Data недоступен.
const STATIC_ASSETS = [
  { id: 'xau', name: 'XAU/USD (Золото)', class: 'commodity', source: 'twelvedata', twelveDataSymbol: 'XAU/USD', yahooSymbol: 'GC=F', tvSymbol: 'TVC:GOLD', newsTag: 'XAU' },
  { id: 'wti', name: 'WTI (Нефть)', class: 'commodity', source: 'twelvedata', twelveDataSymbol: 'WTI/USD', yahooSymbol: 'CL=F', tvSymbol: 'TVC:USOIL', newsTag: 'WTI' },
  { id: 'usdrub', name: 'USD/RUB', class: 'forex', source: 'twelvedata', twelveDataSymbol: 'USD/RUB', yahooSymbol: 'RUB=X', tvSymbol: 'FX_IDC:USDRUB', newsTag: 'USD/RUB' },
];

// Монеты, которые технически попадают в топ по капитализации, но не годятся для
// вердикта BUY/SELL и/или графика TradingView, поэтому исключаются из топ-10:
//  - стейблкоины (цена ≈ $1, сигнал бессмыслен);
//  - обёрнутые/стейкнутые производные (движение повторяет базовый актив);
//  - биржевые/RWA-токены без надёжной спот-пары на major-биржах (график TradingView
//    для них показал бы «Invalid symbol»).
const EXCLUDED_IDS = new Set([
  // стейблкоины
  'tether', 'usd-coin', 'dai', 'binance-usd', 'true-usd', 'first-digital-usd',
  'usde', 'ethena-usde', 'paypal-usd', 'frax', 'usdd', 'tusd', 'fdusd', 'pyusd',
  'gemini-dollar', 'usdp', 'usds', 'sky-dollar', 'blackrock-usd', 'usual-usd',
  // обёрнутые / стейкнутые / ликвид-стейкинг производные
  'wrapped-bitcoin', 'wrapped-steth', 'staked-ether', 'weth', 'wrapped-eeth',
  'coinbase-wrapped-btc', 'lombard-staked-btc', 'binance-staked-sol', 'jito-staked-sol',
  'wrapped-beacon-eth', 'rocket-pool-eth', 'mantle-staked-ether', 'bybit-staked-sol',
  // биржевые / RWA-токены без надёжной спот-пары
  'whitebit', 'leo-token', 'figure-heloc', 'bitget-token', 'okb', 'cronos', 'gatechain-token',
]);

// Сохраняем прежнее имя для обратной совместимости импортов.
const STABLECOIN_IDS = EXCLUDED_IDS;

// Точечные исключения там, где CoinGecko-тикер не совпадает напрямую с парой на Binance.
const BINANCE_SYMBOL_OVERRIDES = {
  'matic-network': 'POLUSDT',
  'polygon-ecosystem-token': 'POLUSDT',
};

// Годится ли монета для крипто-топа: не в чёрном списке и символ — обычный тикер
// (только буквы/цифры). Символы с подчёркиванием/точкой (напр. FIGR_HELOC) не имеют
// стандартной спот-пары и ломают график TradingView, поэтому отсеиваются.
function isChartableCoin(coin) {
  if (!coin || EXCLUDED_IDS.has(coin.id)) return false;
  return /^[a-z0-9]+$/i.test(String(coin.symbol || ''));
}

// TradingView-символ для крипты вида BINANCE:{SYMBOL}USDT, с точечными исключениями.
function tvSymbolForCrypto(coinGeckoId, symbol) {
  const override = BINANCE_SYMBOL_OVERRIDES[coinGeckoId];
  if (override) return `BINANCE:${override}`;
  return `BINANCE:${String(symbol || '').toUpperCase()}USDT`;
}

module.exports = { STATIC_ASSETS, STABLECOIN_IDS, EXCLUDED_IDS, isChartableCoin, tvSymbolForCrypto };
