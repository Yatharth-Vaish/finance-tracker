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

/**
 * Pulls new updates since `offset` (Telegram's own ack cursor: passing offset = N
 * tells Telegram every update below N has been handled and can stop being resent).
 */
function getUpdates(offset) {
  return telegramCall_('getUpdates', { offset: offset, timeout: 0, allowed_updates: ['message', 'callback_query'] });
}

/**
 * Apps Script Web Apps can't serve a webhook Telegram accepts (see the comment atop
 * Main.js), so this project polls instead. Telegram refuses to hand out updates via
 * getUpdates while a webhook URL is registered, so this must be called once before
 * polling will return anything - see setupPolling() in Main.js.
 */
function deleteWebhook() {
  var result = telegramCall_('deleteWebhook', { drop_pending_updates: true });
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
