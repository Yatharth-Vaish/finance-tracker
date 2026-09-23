/**
 * Reads and writes the "Ledger" and "Categories" tabs of the bound spreadsheet.
 */

var LEDGER_SHEET_NAME = 'Ledger';
var CATEGORIES_SHEET_NAME = 'Categories';
var LEDGER_HEADERS = ['ID', 'Timestamp', 'Date', 'Type', 'Category', 'Amount', 'Description', 'Payment', 'Raw'];
var PAYMENT_METHODS = ['UPI', 'Cash', 'Card', 'Bank', 'Zaggle'];

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

function getCategoryNames(type) {
  return readCategories()
    .filter(function (c) { return c.type === type; })
    .map(function (c) { return c.category; });
}

/**
 * @param {{type:string, amount:number, category:string, description:string, payment:string, raw:string}} entry
 * @returns {string} the generated row ID
 */
function appendEntry(entry) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getLedgerSheet_();
    var id = Utilities.getUuid();
    var now = new Date();
    var signedAmount = entry.type === 'Expense' ? -Math.abs(entry.amount) : Math.abs(entry.amount);
    sheet.appendRow([
      id,
      now,
      now,
      entry.type,
      entry.category,
      signedAmount,
      entry.description,
      entry.payment || 'UPI',
      entry.raw
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

function sumAmountsSince_(sinceDate) {
  var sheet = getLedgerSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { income: 0, expense: 0, net: 0 };

  var data = sheet.getRange(2, 1, lastRow - 1, LEDGER_HEADERS.length).getValues();
  var income = 0, expense = 0;
  data.forEach(function (row) {
    var date = row[2];
    var amount = row[5];
    if (!(date instanceof Date) || date < sinceDate) return;
    if (amount > 0) income += amount;
    else expense += amount;
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
