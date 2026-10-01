/**
 * Polling entry point. Apps Script Web Apps always answer with an HTTP 302 redirect
 * (to serve the response body from a second URL), and Telegram's webhook client
 * refuses to follow redirects - it logs "Wrong response from the webhook: 302 Found"
 * and keeps retrying forever. So instead of a webhook, a time-driven trigger calls
 * pollUpdates() once a minute, which pulls new messages with getUpdates().
 *
 * Wires Parser.js (pure parsing) + Gemini.js (optional LLM parsing) to Ledger.js
 * (sheet I/O) and Telegram.js (bot API).
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

/**
 * Tries Gemini first (if GEMINI_API_KEY is configured); falls back to the regex parser
 * on any failure so the bot never goes silent just because the LLM is unavailable.
 * @returns {Array<object>} zero or more sanitized, default-filled entries
 */
function parseMessageEntries_(text, categories, options) {
  var entries = parseEntryLLM_(text, categories, options);
  if (!entries) {
    var single = parseEntry(text, categories, options);
    entries = single ? [single] : [];
  }
  // Each entry looks up its own type's bucket - a multi-leg message can mix Income and
  // Transfer, and each should default from its own history, not get cross-contaminated.
  entries.forEach(function (e) { applyDefaults(e, options, getLastPayment(e.type)); });
  return entries;
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
  var entries = parseMessageEntries_(text, readCategories(), options);
  if (entries.length === 0) {
    sendMessage(chatId, helpText_());
    return;
  }

  // Entries save immediately (fixes the ~1-2 min round trip a confirm-then-save flow
  // cost): only one poll cycle is needed for the common case. Mistakes are fixed
  // afterward via the buttons on the confirmation, or /undo, not before the save.
  var ids = entries.map(function (e) { return appendEntry(e); });

  var lastSpend = entries.slice().reverse().find(function (e) { return e.type !== 'Income'; });
  if (lastSpend) setLastPayment('Spending', lastSpend.account, lastSpend.method);
  var lastIncome = entries.slice().reverse().find(function (e) { return e.type === 'Income'; });
  if (lastIncome && lastIncome.account) setLastPayment('Income', lastIncome.account, lastIncome.method);

  var pid = Utilities.getUuid().slice(0, 8);
  putSaved_(pid, ids, entries);

  if (entries.length === 1) {
    sendMessage(chatId, savedText_(entries[0]), entryKeyboard_(pid, entries[0], options));
  } else {
    sendMessage(chatId, savedMultiText_(entries), multiKeyboard_(pid));
  }
}

function handleCommand_(chatId, text) {
  var command = text.split(/\s+/)[0].toLowerCase();
  if (command === '/start' || command === '/help') {
    sendMessage(chatId, helpText_());
  } else if (command === '/today') {
    sendMessage(chatId, 'Today: ' + formatSummary_(summaryForToday()));
  } else if (command === '/month') {
    sendMessage(chatId, formatPublicSpendingPower_());
  } else if (command === '/budget' || command === '/balance') {
    sendMessage(chatId, formatAllBudgets_());
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

  if (action === 'c') {
    showCategoryChooser_(cq, chatId, messageId, pid);
  } else if (action === 'sc') {
    editSaved_(cq, chatId, messageId, pid, function (entry) {
      var picked = getSelectableCategories(entry.type)[index];
      if (!picked) return null;
      entry.type = picked.type;
      entry.category = picked.category;
      return { type: picked.type, category: picked.category };
    });
  } else if (action === 'a') {
    editSaved_(cq, chatId, messageId, pid, function (entry, options) {
      var account = options.accounts[index];
      if (!account) return null;
      var method = account.methods.find(function (m) { return m.label === entry.method; }) || account.methods[0] || null;
      entry.account = account.name;
      setMethod_(entry, method);
      // A manual correction is a strong signal - worth remembering for next time too,
      // same as a freshly-typed account would be.
      setLastPayment(entry.type === 'Income' ? 'Income' : 'Spending', entry.account, entry.method);
      return { account: entry.account, payment: entry.payment, app: entry.app };
    });
  } else if (action === 'p') {
    editSaved_(cq, chatId, messageId, pid, function (entry, options) {
      var account = findByName_(options.accounts, entry.account);
      if (!account || !account.methods[index]) return null;
      setMethod_(entry, account.methods[index]);
      return { payment: entry.payment, app: entry.app };
    });
  } else if (action === 'f') {
    editSaved_(cq, chatId, messageId, pid, function (entry, options) {
      if (!options.people[index]) return null;
      entry.forWho = options.people[index].name;
      return { forWho: entry.forWho };
    });
  } else if (action === 'b') {
    editSaved_(cq, chatId, messageId, pid, function () { return {}; });
  } else if (action === 'u') {
    undoOne_(cq, chatId, messageId, pid);
  } else if (action === 'ua') {
    undoAll_(cq, chatId, messageId, pid);
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

function getSaved_(pid) {
  var raw = CacheService.getScriptCache().get('saved_' + pid);
  return raw ? JSON.parse(raw) : null;
}

function putSaved_(pid, ids, entries) {
  CacheService.getScriptCache().put('saved_' + pid, JSON.stringify({ ids: ids, entries: entries }), PENDING_TTL_SECONDS);
}

function removeSaved_(pid) {
  CacheService.getScriptCache().remove('saved_' + pid);
}

function setMethod_(entry, method) {
  entry.payment = method ? method.payment : '';
  entry.app = method ? method.app : '';
  entry.method = method ? method.label : '';
}

/**
 * Applies one tap to a saved (single-entry) message: mutates the cached snapshot,
 * patches the real Ledger row with whatever `mutate` says changed, and re-renders.
 * `mutate(entry, options)` mutates `entry` in place and returns the patch to write, or
 * null/undefined for "nothing valid was picked, leave the row alone."
 */
function editSaved_(cq, chatId, messageId, pid, mutate) {
  var saved = getSaved_(pid);
  if (!saved) {
    answerCallbackQuery(cq.id, 'This entry expired - edit it in the Sheet directly, or resend the message.');
    return;
  }
  var options = readOptions();
  var entry = saved.entries[0];
  var patch = mutate(entry, options);
  if (patch && Object.keys(patch).length > 0) {
    updateEntryField(saved.ids[0], patch);
  }
  putSaved_(pid, saved.ids, saved.entries);
  editMessageText(chatId, messageId, savedText_(entry), entryKeyboard_(pid, entry, options));
  answerCallbackQuery(cq.id);
}

function undoOne_(cq, chatId, messageId, pid) {
  var saved = getSaved_(pid);
  if (!saved) {
    answerCallbackQuery(cq.id, 'Already gone or expired.');
    return;
  }
  var ok = deleteEntryById_(saved.ids[0]);
  removeSaved_(pid);
  editMessageText(chatId, messageId, ok ? 'Undone.' : 'Already gone - nothing to undo.');
  answerCallbackQuery(cq.id, ok ? 'Undone' : '');
}

function undoAll_(cq, chatId, messageId, pid) {
  var saved = getSaved_(pid);
  if (!saved) {
    answerCallbackQuery(cq.id, 'Already gone or expired.');
    return;
  }
  var count = saved.ids.filter(function (id) { return deleteEntryById_(id); }).length;
  removeSaved_(pid);
  editMessageText(chatId, messageId, count > 0
    ? 'Undone ' + count + ' ' + (count === 1 ? 'entry' : 'entries') + '.'
    : 'Already gone - nothing to undo.');
  answerCallbackQuery(cq.id);
}

function showCategoryChooser_(cq, chatId, messageId, pid) {
  var saved = getSaved_(pid);
  if (!saved) {
    answerCallbackQuery(cq.id, 'This entry expired - edit it in the Sheet directly, or resend the message.');
    return;
  }
  var entry = saved.entries[0];
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

function savedText_(entry) {
  var sign = entry.type === 'Income' ? '+' : '−';
  var lines = ['Saved ✓ ' + sign + '₹' + entry.amount + ' · ' + entry.type + ' · ' + escapeHtml_(entry.category)];
  if (entry.description) lines.push(escapeHtml_(entry.description));
  lines.push(entryOwnerLine_(entry));
  lines.push('Today: ' + formatSummary_(summaryForToday()));
  lines.push(formatPublicSpendingPower_());
  return lines.join('\n');
}

function savedMultiText_(entries) {
  var lines = ['Saved ' + entries.length + ' entries ✓'];
  entries.forEach(function (e, i) {
    var sign = e.type === 'Income' ? '+' : '−';
    var desc = e.description ? ' (' + escapeHtml_(e.description) + ')' : '';
    lines.push((i + 1) + '. ' + sign + '₹' + e.amount + ' · ' + e.type + ' · ' + escapeHtml_(e.category) + desc);
  });
  var net = entries.reduce(function (sum, e) { return sum + (e.type === 'Income' ? e.amount : -e.amount); }, 0);
  lines.push('Net from this message: ' + formatSigned_(net));
  lines.push('Today: ' + formatSummary_(summaryForToday()));
  lines.push(formatPublicSpendingPower_());
  return lines.join('\n');
}

/**
 * Only the budgets flagged Public in the Budgets tab, and only *this month's* flat
 * allowance (getMonthlySpendingPowers() - no rollover) - safe to show automatically,
 * including after a save, even if someone glances at the chat. Everything else
 * (non-public budgets, and the real rollover balance of every budget) only ever shows
 * via /budget or /balance, which the user has to deliberately run.
 */
function formatPublicSpendingPower_() {
  var publicBudgets = getMonthlySpendingPowers().filter(function (b) { return b.public; });
  if (publicBudgets.length === 0) return 'Spending power: (no public budgets configured)';
  return 'Spending power: ' + publicBudgets.map(function (b) {
    return escapeHtml_(b.name) + ' ' + formatSigned_(b.balance);
  }).join(' · ');
}

/**
 * The real balance per budget "as per transaction history" - rolls over a prior month's
 * leftover or overspend, unlike the monthly-reset spending power above. Every budget,
 * public or not - only ever shown on an explicit /budget or /balance.
 */
function formatAllBudgets_() {
  var all = getBudgetBalances();
  if (all.length === 0) return 'No budgets configured yet - add rows to the Budgets tab.';
  var lines = ['Balance (includes rollover from past months):'];
  all.forEach(function (b) {
    lines.push('  ' + escapeHtml_(b.name) + ': ' + formatSigned_(b.balance) + (b.public ? ' (public)' : ''));
  });
  return lines.join('\n');
}

function chunk_(items, size) {
  var rows = [];
  for (var i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

/**
 * One screen for the whole (already-saved) entry: tap a name to correct it, ● marks
 * the current choice. Undo, Category, every account, the methods of the chosen
 * account, and every person.
 */
function entryKeyboard_(pid, entry, options) {
  var mark = function (selected, label) { return (selected ? '● ' : '') + label; };
  var rows = [[
    { text: '↩ Undo', data: 'u:' + pid },
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

function multiKeyboard_(pid) {
  return inlineKeyboard([[{ text: '↩ Undo all', data: 'ua:' + pid }]]);
}

function formatSummary_(summary) {
  return formatSigned_(summary.net) + ' net (income ₹' + Math.round(summary.income) + ', expense ₹' + Math.round(Math.abs(summary.expense)) + ')';
}

function formatSigned_(n) {
  var rounded = Math.round(n);
  return (rounded >= 0 ? '+' : '−') + '₹' + Math.abs(rounded);
}

function helpText_() {
  return 'Send an amount and a description to log it - it saves immediately:\n' +
    '  <b>60 snacks</b> → expense\n' +
    '  <b>+50000 salary</b> → income\n' +
    '  <b>12000 credit card bill</b> → transfer (not counted as spending)\n' +
    'Add words from your Options tab to skip the taps, e.g. <b>250 gift partner gpay</b>.\n' +
    'Shorthand: ₹, rs, and k (e.g. <b>1.2k rent</b>) all work.\n' +
    'Logging something from before today? Say so: <b>250 lunch yesterday</b>, <b>3 days ago</b>.\n' +
    'A message can describe more than one transaction at once (e.g. someone paying from\n' +
    'your card and sending it back) - it\'ll log each one and you can undo the whole message.\n' +
    'Made a mistake? Tap a button under the confirmation to fix it, or Undo.\n\n' +
    'Commands: /today (income/expense) /month (this month\'s public spending power, resets on the 1st) ' +
    '/budget or /balance (every budget\'s real rollover balance, private) /undo /help';
}
