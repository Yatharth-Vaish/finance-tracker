/**
 * Reads and writes the "Ledger" and "Categories" tabs of the bound spreadsheet.
 */

var LEDGER_SHEET_NAME = 'Ledger';
var CATEGORIES_SHEET_NAME = 'Categories';
var OPTIONS_SHEET_NAME = 'Options';
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

function getLastPayment() {
  var raw = PropertiesService.getScriptProperties().getProperty('LAST_PAYMENT');
  return raw ? JSON.parse(raw) : {};
}

function setLastPayment(account, method) {
  PropertiesService.getScriptProperties().setProperty('LAST_PAYMENT', JSON.stringify({ account: account, method: method }));
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
    var signedAmount = entry.type === 'Income' ? Math.abs(entry.amount) : -Math.abs(entry.amount);
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
 * `type` changes (same sign rule as appendEntry). Used by the bot's post-save
 * correction buttons (category/account/method/person taps).
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

    if (patch.type) {
      var amountCell = sheet.getRange(row, 6);
      var signed = patch.type === 'Income' ? Math.abs(amountCell.getValue()) : -Math.abs(amountCell.getValue());
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
