/**
 * One-time (and re-runnable) setup: builds the Ledger, Categories and Dashboard tabs.
 * Run setupSpreadsheet() once from the Apps Script editor after the first `clasp push`,
 * and again any time you add a category/payment method in code or want to reset the
 * Dashboard formulas/charts. Re-running is safe: it never deletes existing Ledger rows
 * or Categories you've added by hand - it only adds what's missing.
 */

var INR_FORMAT = '₹#,##0';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Finance Tracker')
    .addItem('Run setup (Ledger / Categories / Options / Dashboard)', 'setupSpreadsheet')
    .addItem('Start Telegram polling', 'setupPolling')
    .addToUi();
}

function setupSpreadsheet() {
  var ss = SpreadsheetApp.getActive();
  setupLedgerSheet_(ss);
  setupCategoriesSheet_(ss);
  setupOptionsSheet_(ss);
  setupDashboardSheet_(ss);

  var defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && defaultSheet.getLastRow() === 0) ss.deleteSheet(defaultSheet);

  ss.setActiveSheet(ss.getSheetByName('Dashboard'));
  ss.moveActiveSheet(1);
  SpreadsheetApp.flush();
  Logger.log('Setup complete.');
}

function setupLedgerSheet_(ss) {
  var sheet = ss.getSheetByName(LEDGER_SHEET_NAME) || ss.insertSheet(LEDGER_SHEET_NAME);

  // Fill only header cells that are empty, so a re-run adds newly introduced columns
  // (Account / For / App) without touching existing headers or any logged rows.
  var headerRange = sheet.getRange(1, 1, 1, LEDGER_HEADERS.length);
  var existing = headerRange.getValues()[0];
  var merged = LEDGER_HEADERS.map(function (h, i) { return existing[i] || h; });
  headerRange.setValues([merged]).setFontWeight('bold');

  sheet.setFrozenRows(1);
  sheet.getRange('B:C').setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange('F:F').setNumberFormat(INR_FORMAT);

  // Re-applying validation never touches existing cell values.
  var typeRule = SpreadsheetApp.newDataValidation().requireValueInList(['Expense', 'Income', 'Transfer']).build();
  sheet.getRange('D2:D').setDataValidation(typeRule);
  // Payment values now come from the Options tab, so a fixed list would only get in the way.
  sheet.getRange('H2:H').clearDataValidations();

  sheet.autoResizeColumns(1, LEDGER_HEADERS.length);
}

function setupCategoriesSheet_(ss) {
  var sheet = ss.getSheetByName(CATEGORIES_SHEET_NAME) || ss.insertSheet(CATEGORIES_SHEET_NAME);
  var headers = ['Type', 'Category', 'Keywords'];

  if (sheet.getLastRow() === 0) {
    var rows = DEFAULT_CATEGORIES.map(function (c) { return [c.type, c.category, c.keywords.join(', ')]; });
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  } else {
    // Sheet already exists (possibly hand-edited) - only append DEFAULT_CATEGORIES
    // entries that aren't already present, keyed by Type+Category. Never overwrite or
    // remove rows the user added or edited themselves.
    var existing = readCategories();
    var existingKeys = {};
    existing.forEach(function (c) { existingKeys[c.type + '\u0001' + c.category] = true; });

    var missing = DEFAULT_CATEGORIES.filter(function (c) {
      return !existingKeys[c.type + '\u0001' + c.category];
    });
    if (missing.length > 0) {
      var newRows = missing.map(function (c) { return [c.type, c.category, c.keywords.join(', ')]; });
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, headers.length).setValues(newRows);
    }
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}

function setupOptionsSheet_(ss) {
  var sheet = ss.getSheetByName(OPTIONS_SHEET_NAME) || ss.insertSheet(OPTIONS_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    // src/LocalOptions.js is a gitignored file holding your real account/people names;
    // without it the generic DEFAULT_OPTIONS from Parser.js are used. Either way this only
    // seeds an empty tab - afterwards the sheet is the source of truth.
    var seed = (typeof LOCAL_OPTIONS !== 'undefined') ? LOCAL_OPTIONS : DEFAULT_OPTIONS;
    var headers = ['Kind', 'Name', 'Methods', 'Aliases'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.getRange(2, 1, seed.length, headers.length).setValues(seed);
  }
  sheet.getRange('A1').setNote('Account or Person. The first Person is the default "For".');
  sheet.getRange('C1').setNote('Accounts only. Comma-separated ways to pay from it. "UPI:GPay" = UPI via the GPay app; anything else (Card, Cash, ...) is a plain method.');
  sheet.getRange('D1').setNote('Short words you can type inside a message to pick this row without tapping, e.g. "250 gift partner gpay". The first Person never needs one.');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 4);
}

var MONTH_START = '(EOMONTH(TODAY(),-1)+1)';
var BLOCK_ROWS = 17; // vertical space reserved per table + chart

function setupDashboardSheet_(ss) {
  var sheet = ss.getSheetByName('Dashboard') || ss.insertSheet('Dashboard');
  sheet.clear();
  sheet.getCharts().forEach(function (c) { sheet.removeChart(c); });

  sheet.getRange('A1').setValue('Finance Dashboard').setFontSize(18).setFontWeight('bold');
  sheet.getRange('A2').setValue('Updated: ' + new Date().toLocaleString());

  writeTiles_(sheet);

  var options = readOptions();
  var apps = [];
  options.accounts.forEach(function (a) {
    a.methods.forEach(function (m) { if (m.app && apps.indexOf(m.app) === -1) apps.push(m.app); });
  });
  var expenseCategories = readCategories()
    .filter(function (c) { return c.type === 'Expense'; })
    .map(function (c) { return c.category; });

  var row = 10;
  writeMonthlyTable_(sheet, row);
  row += BLOCK_ROWS;
  writeBreakdown_(sheet, row, 'This Month by Category (Expenses)', expenseCategories, 'E', Charts.ChartType.PIE);
  row += BLOCK_ROWS;
  writeBreakdown_(sheet, row, 'This Month by Account (Expenses)', options.accounts.map(function (a) { return a.name; }), 'J', Charts.ChartType.COLUMN);
  row += BLOCK_ROWS;
  writeBreakdown_(sheet, row, 'This Month by Person (Expenses)', options.people.map(function (p) { return p.name; }), 'K', Charts.ChartType.PIE);
  row += BLOCK_ROWS;
  writeBreakdown_(sheet, row, 'This Month by UPI App (Expenses)', apps, 'L', Charts.ChartType.COLUMN);
  row += BLOCK_ROWS;
  writeRecentEntries_(sheet, row);

  sheet.autoResizeColumns(1, 5);
}

function writeTiles_(sheet) {
  var labels = ['This Month Income', 'This Month Expense', 'Net', 'Savings Rate', 'Transfers Out (bills, SIPs, savings)'];
  var byType = function (type, sign) {
    return '=' + sign + 'SUMIFS(Ledger!F:F, Ledger!C:C, ">="&' + MONTH_START + ', Ledger!D:D, "' + type + '")';
  };
  sheet.getRange('A4:A8').setValues(labels.map(function (l) { return [l]; })).setFontWeight('bold');
  sheet.getRange('B4:B6').setFormulas([[byType('Income', '')], [byType('Expense', '')], ['=B4+B5']]).setNumberFormat(INR_FORMAT);
  sheet.getRange('B7').setFormula('=IFERROR(B6/B4, 0)').setNumberFormat('0.0%');
  sheet.getRange('B8').setFormula(byType('Transfer', '-')).setNumberFormat(INR_FORMAT);
}

function writeMonthlyTable_(sheet, startRow) {
  sheet.getRange(startRow, 1).setValue('Last 12 Months').setFontWeight('bold');
  var headerRow = startRow + 1;
  sheet.getRange(headerRow, 1, 1, 4).setValues([['Month', 'Income', 'Expense', 'Cumulative Net']]).setFontWeight('bold');

  var rows = [];
  for (var i = 11; i >= 0; i--) {
    var r = headerRow + 1 + (11 - i);
    var from = '(EOMONTH(TODAY(),-' + (i + 1) + ')+1)';
    var before = '(EOMONTH(TODAY(),-' + i + ')+1)'; // exclusive, so entries with a time on the last day count
    var inMonth = 'Ledger!C:C, ">="&' + from + ', Ledger!C:C, "<"&' + before;
    rows.push([
      '=TEXT(' + from + ',"mmm yyyy")',
      '=SUMIFS(Ledger!F:F, ' + inMonth + ', Ledger!D:D, "Income")',
      '=SUMIFS(Ledger!F:F, ' + inMonth + ', Ledger!D:D, "Expense")',
      (11 - i === 0) ? '=B' + r + '+C' + r : '=D' + (r - 1) + '+B' + r + '+C' + r
    ]);
  }
  sheet.getRange(headerRow + 1, 1, rows.length, 4).setFormulas(rows);
  sheet.getRange(headerRow + 1, 2, rows.length, 3).setNumberFormat(INR_FORMAT);

  var chart = sheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(sheet.getRange(headerRow, 1, rows.length + 1, 4))
    .setPosition(headerRow, 6, 0, 0)
    .setOption('title', 'Income vs Expense by Month')
    .setOption('series', { 2: { type: 'line', targetAxisIndex: 1 } })
    .setOption('vAxes', { 0: { title: 'Income / Expense' }, 1: { title: 'Cumulative Net' } })
    .setOption('height', 300)
    .build();
  sheet.insertChart(chart);
}

/**
 * This month's expenses grouped by one Ledger column (`ledgerCol`), one row per label plus a
 * last row for whatever isn't covered (old entries logged before the column existed, or a
 * renamed option), so the table always adds up to the Expense tile. Transfers are excluded.
 */
function writeBreakdown_(sheet, startRow, title, labels, ledgerCol, chartType) {
  sheet.getRange(startRow, 1).setValue(title).setFontWeight('bold');
  var headerRow = startRow + 1;
  sheet.getRange(headerRow, 1, 1, 2).setValues([['', 'Amount']]).setFontWeight('bold');

  var first = headerRow + 1;
  var rows = labels.map(function (label, i) {
    var r = first + i;
    return [label, '=-SUMIFS(Ledger!F:F, Ledger!C:C, ">="&' + MONTH_START + ', Ledger!D:D, "Expense", Ledger!' + ledgerCol + ':' + ledgerCol + ', $A' + r + ')'];
  });
  var last = first + rows.length - 1;
  rows.push(['(not assigned)', '=-$B$5' + (rows.length ? '-SUM(B' + first + ':B' + last + ')' : '')]);

  sheet.getRange(first, 1, rows.length, 2).setValues(rows.map(function (r) { return [r[0], '']; }));
  sheet.getRange(first, 2, rows.length, 1).setFormulas(rows.map(function (r) { return [r[1]]; })).setNumberFormat(INR_FORMAT);

  var chart = sheet.newChart()
    .setChartType(chartType)
    .addRange(sheet.getRange(headerRow, 1, rows.length + 1, 2))
    .setPosition(headerRow, 6, 0, 0)
    .setOption('title', title)
    .setOption('height', 300)
    .build();
  sheet.insertChart(chart);
}

function writeRecentEntries_(sheet, startRow) {
  sheet.getRange(startRow, 1).setValue('Last 10 Entries').setFontWeight('bold');
  var headerRow = startRow + 1;
  sheet.getRange(headerRow, 1, 1, 7).setValues([['Date', 'Type', 'Category', 'Amount', 'Description', 'Account', 'For']]).setFontWeight('bold');
  var formula = '=IFERROR(QUERY(Ledger!A2:L,"select C,D,E,F,G,J,K order by B desc limit 10",0),"No entries yet")';
  sheet.getRange(headerRow + 1, 1).setFormula(formula);
  sheet.getRange(headerRow + 1, 1, 10, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange(headerRow + 1, 4, 10, 1).setNumberFormat(INR_FORMAT);
}
