/**
 * Thin wrapper around the Telegram Bot API (https://core.telegram.org/bots/api).
 * All calls go through UrlFetchApp, which only exists inside Apps Script.
 */

function getBotToken_() {
  var token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  if (!token) throw new Error('BOT_TOKEN is not set in Script Properties.');
  return token;
}

function telegramCall_(method, payload) {
  var url = 'https://api.telegram.org/bot' + getBotToken_() + '/' + method;
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var body = JSON.parse(response.getContentText());
  if (!body.ok) {
    Logger.log('Telegram API error on ' + method + ': ' + response.getContentText());
  }
  return body;
}

function sendMessage(chatId, text, replyMarkup) {
  var payload = { chat_id: chatId, text: text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegramCall_('sendMessage', payload);
}

function editMessageText(chatId, messageId, text, replyMarkup) {
  var payload = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  else payload.reply_markup = { inline_keyboard: [] };
  return telegramCall_('editMessageText', payload);
}

function answerCallbackQuery(callbackQueryId, text) {
  return telegramCall_('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || '', show_alert: false });
}

/**
 * @param {Array<Array<{text:string, data:string}>>} rows
 * @returns {{inline_keyboard: Array<Array<{text:string, callback_data:string}>>}}
 */
function inlineKeyboard(rows) {
  return {
    inline_keyboard: rows.map(function (row) {
      return row.map(function (btn) {
        return { text: btn.text, callback_data: btn.data };
      });
    })
  };
}

function setWebhook() {
  var url = PropertiesService.getScriptProperties().getProperty('WEBHOOK_URL');
  var secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  if (!url) throw new Error('Set WEBHOOK_URL in Script Properties first (the /exec URL from Deploy > Web app).');
  var fullUrl = url + (url.indexOf('?') === -1 ? '?' : '&') + 'secret=' + encodeURIComponent(secret || '');
  var result = telegramCall_('setWebhook', { url: fullUrl });
  Logger.log(JSON.stringify(result));
  return result;
}

/**
 * Debug helper: run this from the editor (View > Logs afterwards, or check the
 * Executions entry) to see Telegram's current webhook status without having to
 * paste BOT_TOKEN into a browser URL by hand.
 */
function checkWebhookStatus() {
  var info = telegramCall_('getWebhookInfo', {});
  Logger.log(JSON.stringify(info, null, 2));
  return info;
}
