// Собирает новости из открытых RSS-источников и приводит их к единому формату,
// который понимает лента новостей на сайте.
// CORS для RSS не мешает: запрос идёт с сервера Netlify, а не из браузера.

const { XMLParser } = require('fast-xml-parser');

const FEEDS = [
  { url: 'https://www.cbr.ru/rss/RssPress', source: 'ЦБ РФ' },
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss', source: 'CoinDesk' },
  { url: 'https://www.eia.gov/rss/todayinenergy.xml', source: 'EIA' },
  { url: 'https://www.investing.com/rss/news_11.rss', source: 'Investing.com' },
];

const TAG_KEYWORDS = {
  'BTC': ['bitcoin', 'биткоин', 'btc'],
  'ETH': ['ethereum', 'эфириум', 'эфир', 'eth'],
  'XAU': ['gold', 'золот', 'xau'],
  'WTI': ['oil', 'нефт', 'wti', 'crude', 'opec', 'brent', 'опек'],
  'USD/RUB': ['рубл', 'банк россии', 'ключевая ставка', 'ruble', 'russia'],
};

const HIGH_IMPACT_WORDS = [
  'ставк', 'inflation', 'инфляц', 'rate decision', 'fed', 'фрс',
  'opec', 'опек', 'gdp', 'ввп', 'non-farm', 'payrolls',
];

const parser = new XMLParser({ ignoreAttributes: false });

function stripHtml(str) {
  return String(str || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function textOf(field) {
  if (field == null) return '';
  if (typeof field === 'object') return field['#text'] || field.__cdata || '';
  return String(field);
}

function detectTags(text) {
  const lower = text.toLowerCase();
  return Object.entries(TAG_KEYWORDS)
    .filter(([, words]) => words.some((w) => lower.includes(w)))
    .map(([tag]) => tag);
}

function detectImpact(text) {
  const lower = text.toLowerCase();
  return HIGH_IMPACT_WORDS.some((w) => lower.includes(w)) ? 'high' : 'med';
}

function formatTime(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d
    .toLocaleString('ru-RU', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
    })
    .replace('.', '');
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MeridianNewsBot/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const xml = await res.text();
    const data = parser.parse(xml);
    const rawItems = data && data.rss && data.rss.channel ? data.rss.channel.item : null;
    const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

    return items.slice(0, 8).map((item) => {
      const title = stripHtml(textOf(item.title));
      const desc = stripHtml(textOf(item.description));
      const pubDate = textOf(item.pubDate);
      const fullText = title + ' ' + desc;
      const impact = detectImpact(fullText);
      const tags = detectTags(fullText).map((t) => ({ t, c: '' }));
      tags.push({ t: impact === 'high' ? 'Высокое влияние' : 'Среднее влияние', c: impact === 'high' ? 'impact-high' : 'impact-med' });

      return {
        time: formatTime(pubDate),
        rawDate: new Date(pubDate).getTime() || 0,
        src: feed.source,
        title: title || '(без заголовка)',
        excerpt: desc.slice(0, 160),
        tags,
      };
    });
  } catch (err) {
    console.warn('Не удалось получить RSS:', feed.url, err.message);
    return [];
  }
}

exports.handler = async function () {
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const merged = results
    .flat()
    .sort((a, b) => b.rawDate - a.rawDate)
    .slice(0, 24)
    .map(({ rawDate, ...rest }) => rest);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=0, s-maxage=300',
    },
    body: JSON.stringify(merged),
  };
};
