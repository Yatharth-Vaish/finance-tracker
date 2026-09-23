/**
 * Polling entry point. Apps Script Web Apps always answer with an HTTP 302 redirect
 * (to serve the response body from a second URL), and Telegram's webhook client
 * refuses to follow redirects - it logs "Wrong response from the webhook: 302 Found"
 * and keeps retrying forever. So instead of a webhook, a time-driven trigger calls
 * pollUpdates() once a minute, which pulls new messages with getUpdates().
 *
 * Wires Parser.js (pure parsing) to Ledger.js (sheet I/O) and Telegram.js (bot API).
 */

var PENDING_TTL_SECONDS = 600; // 10 minutes
var POLL_INTERVAL_MINUTES = 1;

function pollUpdates() {
  var props = PropertiesService.getScriptProperties();
  var offset = Number(props.getProperty('LAST_UPDATE_ID') || '0');

  var response = getUpdates(offset);
  if (!response.ok) {
    Logger.log('getUpdates failed: ' + JSON.stringify(response));
    return;
  }

  response.result.forEach(function (update) {
    try {
      if (update.message) {
        handleMessage_(update.message);
      } else if (update.callback_query) {
        handleCallbackQuery_(update.callback_query);
      }
    } catch (err) {
      Logger.log('pollUpdates error on update ' + update.update_id + ': ' + err + (err && err.stack ? '\n' + err.stack : ''));
    }
    offset = update.update_id + 1;
  });

  if (response.result.length > 0) {
    props.setProperty('LAST_UPDATE_ID', String(offset));
  }
}

/**
 * One-time setup: clears any leftover webhook (so getUpdates is allowed to work -
 * Telegram refuses polling while a webhook is registered) and installs the
 * time-driven trigger. Safe to re-run; it replaces any existing trigger.
 */
function setupPolling() {
  deleteWebhook();

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pollUpdates') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pollUpdates').timeBased().everyMinutes(POLL_INTERVAL_MINUTES).create();

  Logger.log('Polling trigger installed: pollUpdates every ' + POLL_INTERVAL_MINUTES + ' minute(s).');
}

function isAllowedChat_(chatId) {
  var allowed = PropertiesService.getScriptProperties().getProperty('ALLOWED_CHAT_ID');
  if (!allowed) return null; // signals "not configured yet"
  return String(chatId) === String(allowed);
}

function handleMessage_(message) {
  var chatId = message.chat.id;
  var text = (message.text || '').trim();

  var allowedState = isAllowedChat_(chatId);
  if (allowedState === null) {
    sendMessage(chatId, 'Your chat ID is <b>' + chatId + '</b>.\nSet ALLOWED_CHAT_ID to this value in Script Properties, then message me again.');
    return;
  }
  if (allowedState === false) return; // silently ignore anyone else

  if (text.charAt(0) === '/') {
    handleCommand_(chatId, text);
    return;
  }

  var parsed = parseEntry(text, readCategories());
  if (!parsed) {
    sendMessage(chatId, helpText_());
    return;
  }

  var pid = Utilities.getUuid().slice(0, 8);
  CacheService.getScriptCache().put('pending_' + pid, JSON.stringify(parsed), PENDING_TTL_SECONDS);
  sendMessage(chatId, previewText_(parsed), paymentKeyboard_(pid));
}

function handleCommand_(chatId, text) {
  var command = text.split(/\s+/)[0].toLowerCase();
  if (command === '/start' || command === '/help') {
    sendMessage(chatId, helpText_());
  } else if (command === '/today') {
    sendMessage(chatId, 'Today: ' + formatSummary_(summaryForToday()));
  } else if (command === '/month') {
    sendMessage(chatId, 'This month: ' + formatSummary_(summaryForMonth()));
  } else if (command === '/undo') {
    sendMessage(chatId, 'Delete the most recent entry?', inlineKeyboard([
      [{ text: 'Yes, delete', data: 'ud' }, { text: 'Cancel', data: 'no' }]
    ]));
  } else {
    sendMessage(chatId, "I don't know that command.\n\n" + helpText_());
  }
}

function handleCallbackQuery_(cq) {
  var chatId = cq.message.chat.id;
  var messageId = cq.message.message_id;
  var parts = cq.data.split(':');
  var action = parts[0];

  if (action === 's') {
    saveFromCallback_(cq, chatId, messageId, parts[1], parts[2]);
  } else if (action === 'c') {
    showCategoryChooser_(cq, chatId, messageId, parts[1]);
  } else if (action === 'sc') {
    setCategoryFromCallback_(cq, chatId, messageId, parts[1], Number(parts[2]));
  } else if (action === 'b') {
    backToPreview_(cq, chatId, messageId, parts[1]);
  } else if (action === 'ud') {
    var deleted = deleteLastEntry();
    editMessageText(chatId, messageId, deleted
      ? 'Deleted: ' + deleted.Description + ' (₹' + Math.abs(deleted.Amount) + ')'
      : 'Nothing to undo.');
    answerCallbackQuery(cq.id);
  } else if (action === 'no') {
    editMessageText(chatId, messageId, 'Cancelled.');
    answerCallbackQuery(cq.id);
  } else {
    answerCallbackQuery(cq.id);
  }
}

function getPending_(pid) {
  var raw = CacheService.getScriptCache().get('pending_' + pid);
  return raw ? JSON.parse(raw) : null;
}

function putPending_(pid, entry) {
  CacheService.getScriptCache().put('pending_' + pid, JSON.stringify(entry), PENDING_TTL_SECONDS);
}

function saveFromCallback_(cq, chatId, messageId, pid, payment) {
  var entry = getPending_(pid);
  if (!entry) {
    answerCallbackQuery(cq.id, 'This entry expired, please send it again.');
    return;
  }
  entry.payment = payment;
  appendEntry(entry);
  CacheService.getScriptCache().remove('pending_' + pid);

  editMessageText(chatId, messageId,
    'Saved ✓ · ' + entry.type + ' · ' + entry.category + ' · ₹' + entry.amount +
    '\nToday: ' + formatSummary_(summaryForToday()) +
    '\nMonth: ' + formatSummary_(summaryForMonth()));
  answerCallbackQuery(cq.id, 'Saved');
}

function showCategoryChooser_(cq, chatId, messageId, pid) {
  var entry = getPending_(pid);
  if (!entry) {
    answerCallbackQuery(cq.id, 'This entry expired, please send it again.');
    return;
  }
  var categories = getCategoryNames(entry.type);
  editMessageText(chatId, messageId, 'Choose a category for: ' + entry.description, categoryKeyboard_(pid, categories));
  answerCallbackQuery(cq.id);
}

function setCategoryFromCallback_(cq, chatId, messageId, pid, index) {
  var entry = getPending_(pid);
  if (!entry) {
    answerCallbackQuery(cq.id, 'This entry expired, please send it again.');
    return;
  }
  var categories = getCategoryNames(entry.type);
  entry.category = categories[index] || entry.category;
  putPending_(pid, entry);
  editMessageText(chatId, messageId, previewText_(entry), paymentKeyboard_(pid));
  answerCallbackQuery(cq.id, 'Category set to ' + entry.category);
}

function backToPreview_(cq, chatId, messageId, pid) {
  var entry = getPending_(pid);
  if (!entry) {
    answerCallbackQuery(cq.id, 'This entry expired, please send it again.');
    return;
  }
  editMessageText(chatId, messageId, previewText_(entry), paymentKeyboard_(pid));
  answerCallbackQuery(cq.id);
}

function previewText_(entry) {
  var sign = entry.type === 'Expense' ? '−' : '+';
  var desc = entry.description ? ' (' + entry.description + ')' : '';
  return sign + '₹' + entry.amount + ' · ' + entry.type + ' · ' + entry.category + desc;
}

function paymentKeyboard_(pid) {
  var otherMethods = PAYMENT_METHODS.filter(function (m) { return m !== 'UPI'; });
  var otherButtons = otherMethods.map(function (m) { return { text: m, data: 's:' + pid + ':' + m }; });
  return inlineKeyboard([
    [{ text: '✓ Save (UPI)', data: 's:' + pid + ':UPI' }, { text: 'Change category', data: 'c:' + pid }],
    otherButtons
  ]);
}

function categoryKeyboard_(pid, categories) {
  var rows = [];
  for (var i = 0; i < categories.length; i += 2) {
    var row = [{ text: categories[i], data: 'sc:' + pid + ':' + i }];
    if (categories[i + 1]) row.push({ text: categories[i + 1], data: 'sc:' + pid + ':' + (i + 1) });
    rows.push(row);
  }
  rows.push([{ text: '‹ Back', data: 'b:' + pid }]);
  return inlineKeyboard(rows);
}

function formatSummary_(summary) {
  return formatSigned_(summary.net) + ' net (income ₹' + Math.round(summary.income) + ', expense ₹' + Math.round(Math.abs(summary.expense)) + ')';
}

function formatSigned_(n) {
  var rounded = Math.round(n);
  return (rounded >= 0 ? '+' : '−') + '₹' + Math.abs(rounded);
}

function helpText_() {
  return 'Send an amount and a description to log it:\n' +
    '  <b>60 snacks</b> → expense\n' +
    '  <b>+50000 salary</b> → income\n' +
    'Shorthand: ₹, rs, and k (e.g. <b>1.2k rent</b>) all work.\n\n' +
    'Commands: /today /month /undo /help';
}
