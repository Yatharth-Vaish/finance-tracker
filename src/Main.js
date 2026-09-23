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

  var options = readOptions();
  var parsed = parseEntry(text, readCategories(), options);
  if (!parsed) {
    sendMessage(chatId, helpText_());
    return;
  }
  applyDefaults(parsed, options, getLastPayment());

  var pid = Utilities.getUuid().slice(0, 8);
  putPending_(pid, parsed);
  sendMessage(chatId, previewText_(parsed), entryKeyboard_(pid, parsed, options));
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
  var pid = parts[1];
  var index = Number(parts[2]);

  if (action === 's') {
    saveFromCallback_(cq, chatId, messageId, pid);
  } else if (action === 'c') {
    showCategoryChooser_(cq, chatId, messageId, pid);
  } else if (action === 'sc') {
    editPending_(cq, chatId, messageId, pid, function (entry) {
      var picked = getSelectableCategories(entry.type)[index];
      if (picked) {
        entry.type = picked.type;
        entry.category = picked.category;
      }
    });
  } else if (action === 'a') {
    editPending_(cq, chatId, messageId, pid, function (entry, options) {
      var account = options.accounts[index];
      if (!account) return;
      var method = account.methods.find(function (m) { return m.label === entry.method; }) || account.methods[0] || null;
      entry.account = account.name;
      setMethod_(entry, method);
    });
  } else if (action === 'p') {
    editPending_(cq, chatId, messageId, pid, function (entry, options) {
      var account = findByName_(options.accounts, entry.account);
      if (account && account.methods[index]) setMethod_(entry, account.methods[index]);
    });
  } else if (action === 'f') {
    editPending_(cq, chatId, messageId, pid, function (entry, options) {
      if (options.people[index]) entry.forWho = options.people[index].name;
    });
  } else if (action === 'b') {
    editPending_(cq, chatId, messageId, pid, function () {});
  } else if (action === 'ud') {
    var deleted = deleteLastEntry();
    editMessageText(chatId, messageId, deleted
      ? 'Deleted: ' + escapeHtml_(deleted.Description) + ' (₹' + Math.abs(deleted.Amount) + ')'
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

function setMethod_(entry, method) {
  entry.payment = method ? method.payment : '';
  entry.app = method ? method.app : '';
  entry.method = method ? method.label : '';
}

/** Applies one tap to the pending entry and re-renders the same message with the new state. */
function editPending_(cq, chatId, messageId, pid, mutate) {
  var entry = getPending_(pid);
  if (!entry) {
    answerCallbackQuery(cq.id, 'This entry expired, please send it again.');
    return;
  }
  var options = readOptions();
  mutate(entry, options);
  putPending_(pid, entry);
  editMessageText(chatId, messageId, previewText_(entry), entryKeyboard_(pid, entry, options));
  answerCallbackQuery(cq.id);
}

function saveFromCallback_(cq, chatId, messageId, pid) {
  var entry = getPending_(pid);
  if (!entry) {
    answerCallbackQuery(cq.id, 'This entry expired, please send it again.');
    return;
  }
  appendEntry(entry);
  CacheService.getScriptCache().remove('pending_' + pid);
  // Salary landing in an account shouldn't change which account/app spending defaults to.
  if (entry.type !== 'Income') setLastPayment(entry.account, entry.method);

  editMessageText(chatId, messageId,
    'Saved ✓ · ' + entry.type + ' · ' + escapeHtml_(entry.category) + ' · ₹' + entry.amount +
    '\n' + entryOwnerLine_(entry) +
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
  var categories = getSelectableCategories(entry.type);
  editMessageText(chatId, messageId, 'Choose a category for: ' + escapeHtml_(entry.description), categoryKeyboard_(pid, categories));
  answerCallbackQuery(cq.id);
}

function escapeHtml_(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function entryOwnerLine_(entry) {
  var direction = entry.type === 'Income' ? 'Into' : 'From';
  var account = entry.account ? escapeHtml_(entry.account) + (entry.method ? ' · ' + escapeHtml_(entry.method) : '') : '—';
  return direction + ': ' + account + '   For: ' + escapeHtml_(entry.forWho);
}

function previewText_(entry) {
  var sign = entry.type === 'Income' ? '+' : '−';
  var lines = [sign + '₹' + entry.amount + ' · ' + entry.type + ' · ' + escapeHtml_(entry.category)];
  if (entry.description) lines.push(escapeHtml_(entry.description));
  lines.push(entryOwnerLine_(entry));
  return lines.join('\n');
}

function chunk_(items, size) {
  var rows = [];
  for (var i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

/**
 * One screen for the whole entry: tap a name to change it, ● marks the current choice.
 * Save, Category, every account, the methods of the chosen account, and every person.
 */
function entryKeyboard_(pid, entry, options) {
  var mark = function (selected, label) { return (selected ? '● ' : '') + label; };
  var rows = [[
    { text: '✓ Save', data: 's:' + pid },
    { text: 'Category: ' + entry.category, data: 'c:' + pid }
  ]];

  var accountButtons = options.accounts.map(function (a, i) {
    return { text: mark(a.name === entry.account, a.name), data: 'a:' + pid + ':' + i };
  });
  chunk_(accountButtons, 3).forEach(function (r) { rows.push(r); });

  var account = findByName_(options.accounts, entry.account);
  if (account && account.methods.length > 1) {
    rows.push(account.methods.map(function (m, i) {
      return { text: mark(m.label === entry.method, m.label), data: 'p:' + pid + ':' + i };
    }));
  }

  var personButtons = options.people.map(function (p, i) {
    return { text: mark(p.name === entry.forWho, p.name), data: 'f:' + pid + ':' + i };
  });
  chunk_(personButtons, 3).forEach(function (r) { rows.push(r); });

  return inlineKeyboard(rows);
}

function categoryKeyboard_(pid, categories) {
  var buttons = categories.map(function (c, i) {
    return { text: c.category, data: 'sc:' + pid + ':' + i };
  });
  var rows = chunk_(buttons, 2);
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
    '  <b>12000 credit card bill</b> → transfer (not counted as spending)\n' +
    'Add words from your Options tab to skip the taps, e.g. <b>250 gift partner gpay</b>.\n' +
    'Shorthand: ₹, rs, and k (e.g. <b>1.2k rent</b>) all work.\n\n' +
    'Commands: /today /month /undo /help';
}
