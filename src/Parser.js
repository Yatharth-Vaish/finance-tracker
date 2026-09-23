/**
 * Pure message parsing for the finance-tracker bot. No Apps Script globals here
 * (CacheService, SpreadsheetApp, etc.) so this file can be unit tested with plain node.
 */

var DEFAULT_CATEGORIES = [
  { type: 'Expense', category: 'Food', keywords: ['snacks', 'chai', 'coffee', 'lunch', 'dinner', 'breakfast', 'swiggy', 'zomato', 'restaurant', 'food'] },
  { type: 'Expense', category: 'Groceries', keywords: ['groceries', 'grocery', 'bigbasket', 'blinkit', 'zepto', 'vegetables', 'milk'] },
  { type: 'Expense', category: 'Transport', keywords: ['uber', 'ola', 'auto', 'cab', 'taxi', 'metro', 'bus', 'fuel', 'petrol', 'diesel', 'parking'] },
  { type: 'Expense', category: 'Rent', keywords: ['rent'] },
  { type: 'Expense', category: 'Bills & Utilities', keywords: ['electricity', 'water bill', 'wifi', 'broadband', 'internet', 'postpaid', 'gas bill', 'recharge', 'mobile bill'] },
  { type: 'Expense', category: 'Shopping', keywords: ['amazon', 'flipkart', 'myntra', 'shopping', 'clothes'] },
  { type: 'Expense', category: 'Gifts', keywords: ['gift', 'gifts', 'present'] },
  { type: 'Expense', category: 'Health', keywords: ['medicine', 'doctor', 'pharmacy', 'hospital', 'gym'] },
  { type: 'Expense', category: 'Entertainment', keywords: ['movie', 'bookmyshow', 'concert', 'game'] },
  { type: 'Expense', category: 'Subscriptions', keywords: ['netflix', 'spotify', 'prime', 'hotstar', 'subscription', 'youtube premium'] },
  { type: 'Expense', category: 'Other', keywords: [] },
  { type: 'Transfer', category: 'Credit Card Bill', keywords: ['credit card bill', 'card bill', 'cc bill', 'cc payment'] },
  { type: 'Transfer', category: 'SIP / Investment', keywords: ['sip', 'invest', 'investment'] },
  { type: 'Transfer', category: 'Savings', keywords: ['savings', 'saving'] },
  { type: 'Transfer', category: 'Own Account Transfer', keywords: ['transfer'] },
  { type: 'Income', category: 'Salary', keywords: ['salary', 'payroll'] },
  { type: 'Income', category: 'Trading/IPO', keywords: ['trading', 'stocks', 'ipo', 'dividend', 'listing gain', 'mutual fund', 'mf'] },
  { type: 'Income', category: 'Zaggle Allowance', keywords: ['zaggle', 'meal card', 'meal allowance', 'food allowance'] },
  { type: 'Income', category: 'Interest', keywords: ['interest', 'fd', 'savings interest'] },
  { type: 'Income', category: 'Refund', keywords: ['refund', 'cashback', 'reimbursement'] },
  { type: 'Income', category: 'Other Income', keywords: [] }
];

/**
 * Generic starter rows for the Options tab: [Kind, Name, Methods, Aliases].
 * Methods are comma separated; "UPI:GPay" means UPI paid through the GPay app, anything
 * else (Card, Cash...) is a plain payment method. Aliases are the short words you can type
 * inside a message to pick that account/person/app without tapping (e.g. "250 gift partner").
 * Real account/people names belong in the private Sheet (or the gitignored
 * src/LocalOptions.js seed), never in this public file.
 */
var DEFAULT_OPTIONS = [
  ['Account', 'Bank Account', 'UPI:GPay, UPI:PhonePe, Card', 'bank'],
  ['Account', 'Credit Card', 'Card', 'cc'],
  ['Account', 'Cash', 'Cash', 'cash'],
  ['Person', 'Me', '', ''],
  ['Person', 'Partner', '', 'partner'],
  ['Person', 'Family', '', 'family, fam']
];

var AMOUNT_PATTERN = /(₹|rs\.?\s*)?(\d+(?:\.\d+)?)(k)?\b/i;

function splitList_(value) {
  return String(value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function parseMethod_(token) {
  var upi = /^upi\s*:\s*(.+)$/i.exec(token);
  if (upi) return { payment: 'UPI', app: upi[1].trim(), label: upi[1].trim() };
  return { payment: token, app: '', label: token };
}

/**
 * @param {Array<Array<string>>} rows - Options tab rows (without the header): [Kind, Name, Methods, Aliases]
 * @returns {{accounts: Array<{name:string, methods:Array<{payment:string,app:string,label:string}>, aliases:string[]}>, people: Array<{name:string, aliases:string[]}>}}
 */
function parseOptions(rows) {
  var accounts = [];
  var people = [];
  (rows || []).forEach(function (row) {
    var kind = String(row[0] || '').trim().toLowerCase();
    var name = String(row[1] || '').trim();
    if (!name) return;

    var aliases = splitList_(row[3]).map(function (a) { return a.toLowerCase(); });
    var lowerName = name.toLowerCase();
    if (lowerName.indexOf(' ') === -1 && aliases.indexOf(lowerName) === -1) aliases.push(lowerName);

    if (kind === 'account') {
      accounts.push({ name: name, methods: splitList_(row[2]).map(parseMethod_), aliases: aliases });
    } else if (kind === 'person') {
      people.push({ name: name, aliases: aliases });
    }
  });
  return { accounts: accounts, people: people };
}

/**
 * @param {string} text - raw message text from Telegram
 * @param {Array<{type:string,category:string,keywords:string[]}>} [categories] - defaults to DEFAULT_CATEGORIES
 * @param {ReturnType<typeof parseOptions>} [options] - lets the message name an account, UPI app or person inline
 * @returns {{type:string, amount:number, category:string, description:string, raw:string, account:string, app:string, forWho:string}|null}
 *          null when no amount could be found (caller should show a help message)
 */
function parseEntry(text, categories, options) {
  categories = categories || DEFAULT_CATEGORIES;
  var raw = (text || '').trim();
  if (!raw) return null;

  var working = raw;
  var explicitIncome = false;

  if (working.charAt(0) === '+') {
    explicitIncome = true;
    working = working.slice(1).trim();
  } else if (/^income\b/i.test(working)) {
    explicitIncome = true;
    working = working.replace(/^income\b/i, '').trim();
  } else if (/^expense\b/i.test(working)) {
    working = working.replace(/^expense\b/i, '').trim();
  }

  var match = AMOUNT_PATTERN.exec(working);
  if (!match) return null;

  var amount = parseFloat(match[2]);
  if (match[3]) amount *= 1000; // "k" shorthand

  var description = (working.slice(0, match.index) + ' ' + working.slice(match.index + match[0].length))
    .replace(/\s+/g, ' ')
    .trim();

  var tags = { account: '', app: '', forWho: '' };
  if (options) description = extractTags_(description, options, tags);

  var type = 'Expense';
  var category;
  if (explicitIncome) {
    type = 'Income';
    category = guessCategory('Income', description, categories);
  } else {
    var transferCategory = matchCategory_('Transfer', description, categories);
    if (transferCategory) {
      type = 'Transfer';
      category = transferCategory;
    } else {
      category = guessCategory('Expense', description, categories);
    }
  }

  return {
    type: type, amount: amount, category: category, description: description, raw: raw,
    account: tags.account, app: tags.app, forWho: tags.forWho
  };
}

/**
 * Pulls account / UPI-app / person words out of the description ("250 gift partner gpay" ->
 * description "gift", forWho "Partner", app "GPay") and fills `tags`. The first person
 * in the Options list is the default, so it never needs (or gets) a token.
 */
function extractTags_(description, options, tags) {
  var accountAliases = Object.create(null);
  var appNames = Object.create(null);
  var personAliases = Object.create(null);

  options.accounts.forEach(function (a) {
    a.aliases.forEach(function (alias) { accountAliases[alias] = a.name; });
    a.methods.forEach(function (m) { if (m.app) appNames[m.app.toLowerCase()] = m.app; });
  });
  options.people.forEach(function (p, i) {
    if (i === 0) return;
    p.aliases.forEach(function (alias) { personAliases[alias] = p.name; });
  });

  var kept = [];
  description.split(/\s+/).forEach(function (token) {
    var key = token.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key && personAliases[key] && !tags.forWho) tags.forWho = personAliases[key];
    else if (key && appNames[key] && !tags.app) tags.app = appNames[key];
    else if (key && accountAliases[key] && !tags.account) tags.account = accountAliases[key];
    else kept.push(token);
  });
  return kept.join(' ').trim();
}

/**
 * Fills whatever the message didn't say: account and payment method fall back to what was
 * used last time (so a run of Zaggle purchases needs no taps), then to the first configured
 * option; the person falls back to the first one listed.
 * @param {ReturnType<typeof parseEntry>} entry
 * @param {ReturnType<typeof parseOptions>} options
 * @param {{account?:string, method?:string}} [last]
 */
function applyDefaults(entry, options, last) {
  last = last || {};
  var accounts = options.accounts;

  var account = findByName_(accounts, entry.account);
  if (!account && entry.app) {
    var supporting = accounts.filter(function (a) {
      return a.methods.some(function (m) { return m.app === entry.app; });
    });
    account = findByName_(supporting, last.account) || supporting[0] || null;
  }
  if (!account) account = findByName_(accounts, last.account) || accounts[0] || null;

  var method = null;
  if (account) {
    if (entry.app) method = account.methods.find(function (m) { return m.app === entry.app; }) || null;
    if (!method && last.account === account.name) {
      method = account.methods.find(function (m) { return m.label === last.method; }) || null;
    }
    if (!method) method = account.methods[0] || null;
  }

  entry.account = account ? account.name : '';
  entry.payment = method ? method.payment : '';
  entry.app = method ? method.app : '';
  entry.method = method ? method.label : '';
  entry.forWho = entry.forWho || (options.people[0] ? options.people[0].name : '');
  return entry;
}

function findByName_(list, name) {
  if (!name) return null;
  for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
  return null;
}

function containsWord_(text, keyword) {
  var escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)').test(text);
}

function matchCategory_(type, description, categories) {
  var lowerDesc = description.toLowerCase();
  var candidates = categories.filter(function (c) { return c.type === type; });
  for (var i = 0; i < candidates.length; i++) {
    var keywords = candidates[i].keywords || [];
    for (var j = 0; j < keywords.length; j++) {
      if (containsWord_(lowerDesc, keywords[j])) return candidates[i].category;
    }
  }
  return null;
}

function guessCategory(type, description, categories) {
  var matched = matchCategory_(type, description, categories);
  if (matched) return matched;
  var fallback = categories.find(function (c) { return c.type === type && (c.keywords || []).length === 0; });
  return fallback ? fallback.category : 'Other';
}

// Exposed to node's test runner. Apps Script has no `module`, so this is a no-op there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseEntry: parseEntry,
    parseOptions: parseOptions,
    applyDefaults: applyDefaults,
    guessCategory: guessCategory,
    DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS
  };
}
