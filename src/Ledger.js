/**
 * Reads and writes the "Ledger" and "Categories" tabs of the bound spreadsheet.
 */

var LEDGER_SHEET_NAME = 'Ledger';
var CATEGORIES_SHEET_NAME = 'Categories';
var OPTIONS_SHEET_NAME = 'Options';
var BUDGETS_SHEET_NAME = 'Budgets';
// New columns are only ever appended on the right so existing rows and formulas keep their letters.
var LEDGER_HEADERS = ['ID', 'Timestamp', 'Date', 'Type', 'Category', 'Amount', 'Description', 'Payment', 'Raw', 'Account', 'For', 'App'];

function getLedgerSheet_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(LEDGER_SHEET_NAME);
  if (!sheet) throw new Error('Ledger sheet not found. Run setupSpreadsheet() first.');
  return sheet;
}

function getCategoriesSheet_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CATEGORIES_SHEET_NAME);
  if (!sheet) throw new Error('Categories sheet not found. Run setupSpreadsheet() first.');
  return sheet;
}

function getOptionsSheet_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(OPTIONS_SHEET_NAME);
  if (!sheet) throw new Error('Options sheet not found. Run setupSpreadsheet() first.');
  return sheet;
}

/**
 * Accounts/cards, the payment methods each supports, and the people you spend on.
 * Edited by hand in the Options tab; see parseOptions() in Parser.js for the row format.
 */
function readOptions() {
  return parseOptions(getOptionsSheet_().getDataRange().getValues().slice(1));
}

function getBudgetsSheet_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(BUDGETS_SHEET_NAME);
  if (!sheet) throw new Error('Budgets sheet not found. Run setupSpreadsheet() first.');
  return sheet;
}

/**
 * The six (or however many) named budgets/allowances. Edited by hand in the Budgets
 * tab; see parseBudgets() in Parser.js for the row format.
 */
function readBudgets() {
  return parseBudgets(getBudgetsSheet_().getDataRange().getValues().slice(1));
}

/**
 * When budget accrual started - set once by setupBudgetsSheet_() and never moved, so
 * re-running setup doesn't reset everyone's accrued balance back to one month's worth.
 */
function getBudgetStartDate() {
  var raw = PropertiesService.getScriptProperties().getProperty('BUDGET_START_DATE');
  if (raw) return new Date(raw);
  var firstOfMonth = new Date();
  firstOfMonth.setDate(1);
  firstOfMonth.setHours(0, 0, 0, 0);
  return firstOfMonth;
}

function readLedgerRowsForBudgets_() {
  var sheet = getLedgerSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, LEDGER_HEADERS.length).getValues();
  return values.map(function (row) {
    return { date: row[2], type: row[3], category: row[4], amount: row[5], account: row[9] };
  });
}

/**
 * All budgets' balance as of `startDate` (computeBudgetBalance(..., startDate) for
 * each), from a single read of the Ledger - cheaper than one sheet scan per budget.
 */
function computeAllBudgetBalances_(startDate) {
  var budgets = readBudgets();
  if (budgets.length === 0) return [];
  var ledgerRows = readLedgerRowsForBudgets_();
  return budgets.map(function (b) {
    return { name: b.name, balance: computeBudgetBalance(b, budgets, ledgerRows, startDate), public: b.public };
  });
}

/**
 * The real running balance per budget, "as per transaction history" - rolls over
 * unspent (or over-budget) amounts month to month, back to BUDGET_START_DATE. This is
 * what /budget (and the Dashboard's BUDGETBALANCE() cells) show.
 * @returns {Array<{name:string, balance:number, public:boolean}>}
 */
function getBudgetBalances() {
  return computeAllBudgetBalances_(getBudgetStartDate());
}

/**
 * "Spending power": each budget reset to its flat monthlyTarget on the 1st, decremented
 * only by *this* month's spend - no rollover of a prior month's leftover or overspend.
 * This is the same formula as getBudgetBalances(), just evaluated from the start of the
 * current month instead of the global BUDGET_START_DATE (monthsAccrued_ then always
 * resolves to exactly 1). This is what the auto-shown line after a save, and /month, use
 * for Public budgets - it's meant to be safe to glance at, and "how much of this month's
 * allowance is left" is a simpler, more honest answer to that than a rollover total.
 * @returns {Array<{name:string, balance:number, public:boolean}>}
 */
function getMonthlySpendingPowers() {
  var firstOfMonth = new Date();
  firstOfMonth.setDate(1);
  firstOfMonth.setHours(0, 0, 0, 0);
  return computeAllBudgetBalances_(firstOfMonth);
}

/**
 * Custom Sheets function - usable directly in a cell as =BUDGETBALANCE("Daily"). Lets
 * the Dashboard's Budgets table recalculate live (on open/edit) instead of only updating
 * when setupSpreadsheet() is re-run. Apps Script custom functions run in a restricted
 * context but reading the bound spreadsheet and Script Properties both work fine there.
 * @param {string} name - must match a Name in the Budgets tab exactly
 * @returns {number|string} the current balance, or an error string if the name isn't found
 */
function BUDGETBALANCE(name) {
  var match = getBudgetBalances().find(function (b) { return b.name === name; });
  return match ? match.balance : 'No budget named "' + name + '"';
}

/** Same as BUDGETBALANCE(), but this month's flat allowance (no rollover) - see getMonthlySpendingPowers(). */
function SPENDINGPOWER(name) {
  var match = getMonthlySpendingPowers().find(function (b) { return b.name === name; });
  return match ? match.balance : 'No budget named "' + name + '"';
}

/**
 * Last-used account/method, tracked per entry type - and, for Income specifically, per
 * category too. Income isn't one habit the way spending roughly is: salary/passive
 * income reliably lands on one account while, say, trading/IPO gains land on another, so
 * a single shared "last Income account" would have the two overwrite each other's
 * default every time they alternate. Spending stays one flat bucket (no category
 * granularity) - that pattern is coarser in practice and splitting it would just mean
 * more one-off corrections needed before each category "warms up."
 */
function lastPaymentKey_(entryType, category) {
  if (entryType !== 'Income') return 'LAST_PAYMENT_SPENDING';
  return 'LAST_PAYMENT_INCOME:' + (category || '');
}

function getLastPayment(entryType, category) {
  var raw = PropertiesService.getScriptProperties().getProperty(lastPaymentKey_(entryType, category));
  return raw ? JSON.parse(raw) : {};
}

function setLastPayment(entryType, category, account, method) {
  PropertiesService.getScriptProperties().setProperty(lastPaymentKey_(entryType, category), JSON.stringify({ account: account, method: method }));
}

/**
 * @returns {Array<{type:string,category:string,keywords:string[]}>}
 */
function readCategories() {
  var sheet = getCategoriesSheet_();
  var values = sheet.getDataRange().getValues();
  return values.slice(1)
    .filter(function (row) { return row[0]; })
    .map(function (row) {
      var keywords = String(row[2] || '').split(',').map(function (k) { return k.trim(); }).filter(Boolean);
      return { type: String(row[0]), category: String(row[1]), keywords: keywords };
    });
}

/**
 * Categories you can switch an entry to. Income entries only see income categories;
 * everything else sees expense and transfer categories, so picking "Credit Card Bill"
 * on a mis-guessed entry also flips it to a Transfer.
 * @returns {Array<{type:string,category:string}>}
 */
function getSelectableCategories(entryType) {
  var allowed = entryType === 'Income' ? ['Income'] : ['Expense', 'Transfer'];
  return readCategories()
    .filter(function (c) { return allowed.indexOf(c.type) !== -1; })
    .map(function (c) { return { type: c.type, category: c.category }; });
}

/**
 * Resolves a parsed entry's `dateOffsetDays` (from the regex fallback, e.g. "yesterday"
 * -> -1) or `date` (an LLM-supplied YYYY-MM-DD) into an actual Date for the Ledger's
 * Date column. Falls back to now/today when the message didn't specify anything.
 */
function resolveEntryDate_(entry) {
  var now = new Date();
  if (typeof entry.dateOffsetDays === 'number') {
    var d = new Date(now);
    d.setDate(d.getDate() + entry.dateOffsetDays);
    return d;
  }
  if (entry.date && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
    var parts = entry.date.split('-').map(Number);
    // Local calendar date at the current time-of-day, not UTC midnight - avoids an
    // off-by-one day near midnight IST if this ever ran in a UTC-anchored context.
    return new Date(parts[0], parts[1] - 1, parts[2], now.getHours(), now.getMinutes(), now.getSeconds());
  }
  return now;
}

/**
 * @param {{type:string, amount:number, category:string, description:string, payment:string, raw:string, account:string, forWho:string, app:string, dateOffsetDays?:number, date?:string}} entry
 * @returns {string} the generated row ID
 */
function appendEntry(entry) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getLedgerSheet_();
    var id = Utilities.getUuid();
    var now = new Date();
    var effectiveDate = resolveEntryDate_(entry);
    var isCredit = entry.type === 'Income' || isAllocationCategory(entry.category);
    var signedAmount = isCredit ? Math.abs(entry.amount) : -Math.abs(entry.amount);
    sheet.appendRow([
      id,
      now,
      effectiveDate,
      entry.type,
      entry.category,
      signedAmount,
      entry.description,
      entry.payment || '',
      entry.raw,
      entry.account || '',
      entry.forWho || '',
      entry.app || ''
    ]);
    return id;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Deletes the last data row in the Ledger. Returns the deleted row as an object, or null if empty.
 */
function deleteLastEntry() {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getLedgerSheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return null; // header only
    var values = sheet.getRange(lastRow, 1, 1, LEDGER_HEADERS.length).getValues()[0];
    sheet.deleteRow(lastRow);
    var record = {};
    LEDGER_HEADERS.forEach(function (h, i) { record[h] = values[i]; });
    return record;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Column A is the ID. A single-column read + indexOf is fine at personal-ledger scale
 * (one sheet call, no per-row loop) and safer than trusting a row position, since rows
 * can move (deletes) and a single message can append more than one row.
 * @returns {number} the sheet row number, or -1 if not found
 */
function findRowById_(sheet, id) {
  if (sheet.getLastRow() < 2) return -1; // header only, or empty - getRange needs >=1 row
  var ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return -1;
}

var FIELD_COLUMNS = { type: 4, category: 5, description: 7, payment: 8, account: 10, forWho: 11, app: 12 };

/**
 * Patches specific fields of an already-saved row, recomputing the signed Amount if
 * `type` or `category` changes (same credit/debit rule as appendEntry - category alone
 * can flip it, e.g. correcting into or out of an " Allocation" category). Used by the
 * bot's post-save correction buttons (category/account/method/person taps).
 * @param {string} id
 * @param {{type?:string, category?:string, account?:string, payment?:string, app?:string, forWho?:string}} patch
 * @returns {boolean} true if a row was found and updated
 */
function updateEntryField(id, patch) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getLedgerSheet_();
    var row = findRowById_(sheet, id);
    if (row === -1) return false;

    Object.keys(patch).forEach(function (field) {
      var col = FIELD_COLUMNS[field];
      if (col) sheet.getRange(row, col).setValue(patch[field]);
    });

    if (patch.type || patch.category) {
      var effectiveType = patch.type || sheet.getRange(row, FIELD_COLUMNS.type).getValue();
      var effectiveCategory = patch.category || sheet.getRange(row, FIELD_COLUMNS.category).getValue();
      var amountCell = sheet.getRange(row, 6);
      var isCredit = effectiveType === 'Income' || isAllocationCategory(effectiveCategory);
      var signed = isCredit ? Math.abs(amountCell.getValue()) : -Math.abs(amountCell.getValue());
      amountCell.setValue(signed);
    }
    return true;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Deletes one specific row by ID (for the bot's per-message Undo button) rather than
 * whatever happens to be the last row - safer when a message produced multiple entries
 * or another message was logged in between. deleteLastEntry() (below) is unchanged and
 * keeps backing the /undo command, which is intentionally "undo whatever's most recent."
 * @returns {boolean} true if a row was found and deleted
 */
function deleteEntryById_(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getLedgerSheet_();
    var row = findRowById_(sheet, id);
    if (row === -1) return false;
    sheet.deleteRow(row);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function sumAmountsSince_(sinceDate) {
  var sheet = getLedgerSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { income: 0, expense: 0, net: 0 };

  var data = sheet.getRange(2, 1, lastRow - 1, LEDGER_HEADERS.length).getValues();
  var income = 0, expense = 0;
  data.forEach(function (row) {
    var date = row[2];
    var type = row[3];
    var amount = row[5];
    if (!(date instanceof Date) || date < sinceDate) return;
    // Transfers (card bills, SIPs, moves between own accounts) are neither income nor spend.
    if (type === 'Income') income += amount;
    else if (type === 'Expense') expense += amount;
  });
  return { income: income, expense: expense, net: income + expense };
}

function summaryForToday() {
  var start = new Date();
  start.setHours(0, 0, 0, 0);
  return sumAmountsSince_(start);
}

function summaryForMonth() {
  var start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return sumAmountsSince_(start);
}
