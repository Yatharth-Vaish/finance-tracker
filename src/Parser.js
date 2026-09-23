/**
 * Pure message parsing for the finance-tracker bot. No Apps Script globals here
 * (CacheService, SpreadsheetApp, etc.) so this file can be unit tested with plain node.
 */

var DEFAULT_CATEGORIES = [
  { type: 'Expense', category: 'Food', keywords: ['snacks', 'chai', 'coffee', 'lunch', 'dinner', 'breakfast', 'swiggy', 'zomato', 'restaurant', 'food'] },
  { type: 'Expense', category: 'Groceries', keywords: ['groceries', 'grocery', 'bigbasket', 'blinkit', 'zepto', 'vegetables', 'milk'] },
  { type: 'Expense', category: 'Transport', keywords: ['uber', 'ola', 'auto', 'cab', 'taxi', 'metro', 'bus', 'fuel', 'petrol', 'diesel', 'parking'] },
  { type: 'Expense', category: 'Rent', keywords: ['rent'] },
  { type: 'Expense', category: 'Bills & Utilities', keywords: ['electricity', 'water bill', 'wifi', 'broadband', 'gas bill', 'recharge', 'mobile bill'] },
  { type: 'Expense', category: 'Shopping', keywords: ['amazon', 'flipkart', 'myntra', 'shopping', 'clothes'] },
  { type: 'Expense', category: 'Health', keywords: ['medicine', 'doctor', 'pharmacy', 'hospital', 'gym'] },
  { type: 'Expense', category: 'Entertainment', keywords: ['movie', 'bookmyshow', 'concert', 'game'] },
  { type: 'Expense', category: 'Subscriptions', keywords: ['netflix', 'spotify', 'prime', 'hotstar', 'subscription', 'youtube premium'] },
  { type: 'Expense', category: 'Other', keywords: [] },
  { type: 'Income', category: 'Salary', keywords: ['salary', 'payroll'] },
  { type: 'Income', category: 'Trading/IPO', keywords: ['trading', 'stocks', 'ipo', 'dividend', 'mutual fund', 'mf'] },
  { type: 'Income', category: 'Interest', keywords: ['interest', 'fd', 'savings interest'] },
  { type: 'Income', category: 'Refund', keywords: ['refund', 'cashback', 'reimbursement'] },
  { type: 'Income', category: 'Other Income', keywords: [] }
];

var AMOUNT_PATTERN = /(₹|rs\.?\s*)?(\d+(?:\.\d+)?)(k)?\b/i;

/**
 * @param {string} text - raw message text from Telegram
 * @param {Array<{type:string,category:string,keywords:string[]}>} [categories] - defaults to DEFAULT_CATEGORIES
 * @returns {{type:string, amount:number, category:string, description:string, raw:string}|null}
 *          null when no amount could be found (caller should show a help message)
 */
function parseEntry(text, categories) {
  categories = categories || DEFAULT_CATEGORIES;
  var raw = (text || '').trim();
  if (!raw) return null;

  var working = raw;
  var type = 'Expense';

  if (working.charAt(0) === '+') {
    type = 'Income';
    working = working.slice(1).trim();
  } else if (/^income\b/i.test(working)) {
    type = 'Income';
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

  var category = guessCategory(type, description, categories);

  return { type: type, amount: amount, category: category, description: description, raw: raw };
}

function guessCategory(type, description, categories) {
  var lowerDesc = ' ' + description.toLowerCase() + ' ';
  var candidates = categories.filter(function (c) { return c.type === type; });

  for (var i = 0; i < candidates.length; i++) {
    var keywords = candidates[i].keywords || [];
    for (var j = 0; j < keywords.length; j++) {
      if (lowerDesc.indexOf(keywords[j].toLowerCase()) !== -1) {
        return candidates[i].category;
      }
    }
  }

  var fallback = candidates.find(function (c) { return c.keywords.length === 0; });
  return fallback ? fallback.category : 'Other';
}

// Exposed to node's test runner. Apps Script has no `module`, so this is a no-op there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseEntry: parseEntry, guessCategory: guessCategory, DEFAULT_CATEGORIES: DEFAULT_CATEGORIES };
}
