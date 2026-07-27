// Принимает апдейты от Telegram (после ручной настройки setWebhook пользователем).
// Команды: /start (подписка), /stop (отписка), /settings (вкл/выкл второстепенных
// уведомлений через инлайн-кнопки). Хранит подписчиков в Netlify Blobs.

const { getStore } = require('@netlify/blobs');

const DEFAULT_SETTINGS = { priceMoves: true, news: true, verdictDowngrade: true };

const SETTINGS_LABELS = {
  priceMoves: 'Резкие движения цены (>3%/час)',
  news: 'Важные новости',
  verdictDowngrade: 'Понижение вердикта до «НЕ ВХОДИТЬ»',
};

async function telegramApi(method, params) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не настроен');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
}

function settingsKeyboard(settings) {
  return {
    inline_keyboard: Object.entries(SETTINGS_LABELS).map(([key, label]) => [
      { text: `${settings[key] ? '✅' : '⬜️'} ${label}`, callback_data: `toggle:${key}` },
    ]),
  };
}

async function getSubscribers(store) {
  return (await store.get('subscribers', { type: 'json' })) || [];
}

function findOrCreate(subs, chatId) {
  let sub = subs.find((s) => s.chatId === chatId);
  if (!sub) {
    sub = { chatId, settings: { ...DEFAULT_SETTINGS }, active: true, joinedAt: new Date().toISOString() };
    subs.push(sub);
  }
  return sub;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'MERIDIAN Telegram webhook OK' };
  }

  let update;
  try {
    update = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 200, body: 'ignored' };
  }

  try {
    const store = getStore('meridian-data');
    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim();
      const subs = await getSubscribers(store);

      if (text.startsWith('/start')) {
        const sub = findOrCreate(subs, chatId);
        sub.active = true;
        await store.setJSON('subscribers', subs);
        await telegramApi('sendMessage', {
          chat_id: chatId,
          text: 'Готово! Ты подписан на аналитику MERIDIAN.\n\n🎯 Приоритетно: как только по активу формируется вердикт «ВХОДИТЬ» (BUY/SELL) — пришлю сразу.\n\nВторостепенные уведомления можно настроить через /settings.\nОтписаться — /stop.\n\nЭто аналитические сигналы, не индивидуальная инвестиционная рекомендация.',
        });
      } else if (text.startsWith('/stop')) {
        const sub = subs.find((s) => s.chatId === chatId);
        if (sub) { sub.active = false; await store.setJSON('subscribers', subs); }
        await telegramApi('sendMessage', { chat_id: chatId, text: 'Отписал. Вернуться можно в любой момент через /start.' });
      } else if (text.startsWith('/settings')) {
        const sub = findOrCreate(subs, chatId);
        await store.setJSON('subscribers', subs);
        await telegramApi('sendMessage', {
          chat_id: chatId,
          text: 'Второстепенные уведомления (приоритетные сигналы «ВХОДИТЬ» приходят всегда):',
          reply_markup: settingsKeyboard(sub.settings),
        });
      } else {
        await telegramApi('sendMessage', { chat_id: chatId, text: 'Команды: /start, /stop, /settings' });
      }
    } else if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      const subs = await getSubscribers(store);
      const sub = findOrCreate(subs, chatId);

      const [, key] = (cq.data || '').split(':');
      if (key && key in DEFAULT_SETTINGS) {
        sub.settings[key] = !sub.settings[key];
        await store.setJSON('subscribers', subs);
      }

      await telegramApi('answerCallbackQuery', { callback_query_id: cq.id });
      await telegramApi('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: cq.message.message_id,
        reply_markup: settingsKeyboard(sub.settings),
      });
    }
  } catch (err) {
    console.error('telegram-webhook error:', err);
  }

  return { statusCode: 200, body: 'ok' };
};
