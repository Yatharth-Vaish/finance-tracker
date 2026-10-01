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
    .addItem('Run setup (Ledger / Categories / Options / Budgets / Dashboard)', 'setupSpreadsheet')
    .addItem('Start Telegram polling', 'setupPolling')
    .addItem('Generate poll secret (for low-latency external cron)', 'generatePollSecret')
    .addToUi();
}

function setupSpreadsheet() {
  var ss = SpreadsheetApp.getActive();
  setupLedgerSheet_(ss);
  setupCategoriesSheet_(ss);
  setupOptionsSheet_(ss);
  setupBudgetsSheet_(ss);
  ensureAllocationCategories_(ss); // needs Budgets to exist first
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

function setupBudgetsSheet_(ss) {
  var sheet = ss.getSheetByName(BUDGETS_SHEET_NAME) || ss.insertSheet(BUDGETS_SHEET_NAME);
  var headers = ['Name', 'Account', 'Categories', 'MonthlyTarget', 'Residual', 'Public'];

  if (sheet.getLastRow() === 0) {
    // src/LocalOptions.js's LOCAL_BUDGETS holds your real allowances; without it the
    // generic DEFAULT_BUDGETS from Parser.js are used. Either way this only seeds an
    // empty tab - afterwards the sheet is the source of truth, same as Options/Categories.
    var seed = (typeof LOCAL_BUDGETS !== 'undefined') ? LOCAL_BUDGETS : DEFAULT_BUDGETS;
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.getRange(2, 1, seed.length, headers.length).setValues(seed);
  }
  sheet.getRange('C1').setNote('Comma list restricting which categories count against this budget. Only needed when two budgets share one Account (e.g. Travel/Gifts on the same card) - empty means everything spent from that Account counts.');
  sheet.getRange('D1').setNote('Reference only - not used in the balance calculation, which is pure transaction-matching (nothing counts until it\'s actually logged). This is just what you intend to move in each period, to compare against the real Balance.');
  sheet.getRange('E1').setNote('TRUE for exactly one budget: "whatever is left" after every amount actually logged as moved into another budget is set aside from this month\'s Salary income. Ignores MonthlyTarget.');
  sheet.getRange('F1').setNote('TRUE = safe to show automatically (after a save, on /month). FALSE = only shown when you ask with /budget or /balance.');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);

  // Set once, never moved by a re-run - resetting it would exclude everything logged
  // before that date from every budget's real balance.
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('BUDGET_START_DATE')) {
    var firstOfMonth = new Date();
    firstOfMonth.setDate(1);
    firstOfMonth.setHours(0, 0, 0, 0);
    props.setProperty('BUDGET_START_DATE', firstOfMonth.toISOString());
  }
}

/**
 * Auto-creates a "<budget name> Allocation" Transfer category in the Categories tab for
 * every non-residual budget, if it doesn't already exist - this is the category that
 * credits (rather than debits) a budget's account; see isAllocationCategory() in
 * Parser.js. Generated from the Budgets tab rather than hand-maintained, so the two
 * never drift out of sync. Idempotent, same append-only pattern as setupCategoriesSheet_.
 */
function ensureAllocationCategories_(ss) {
  var budgets = readBudgets().filter(function (b) { return !b.residual; });
  if (budgets.length === 0) return;

  var sheet = getCategoriesSheet_();
  var existingKeys = {};
  readCategories().forEach(function (c) { existingKeys['Transfer\u0001' + c.category] = true; });

  var missing = budgets
    .map(function (b) { return b.name + ' Allocation'; })
    .filter(function (category) { return !existingKeys['Transfer\u0001' + category]; });

  if (missing.length > 0) {
    var rows = missing.map(function (category) {
      return ['Transfer', category, category.toLowerCase()];
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
  }
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
  writeIncomeAllocationChart_(sheet, row);
  row += BLOCK_ROWS;
  writeBreakdown_(sheet, row, 'This Month by Category (Expenses)', expenseCategories, 'E', Charts.ChartType.PIE);
  row += BLOCK_ROWS;
  writeBreakdown_(sheet, row, 'This Month by Account (Expenses)', options.accounts.map(function (a) { return a.name; }), 'J', Charts.ChartType.COLUMN);
  row += BLOCK_ROWS;
  writeBreakdown_(sheet, row, 'This Month by Person (Expenses)', options.people.map(function (p) { return p.name; }), 'K', Charts.ChartType.PIE);
  row += BLOCK_ROWS;
  writeBreakdown_(sheet, row, 'This Month by UPI App (Expenses)', apps, 'L', Charts.ChartType.COLUMN);
  row += BLOCK_ROWS;
  writeBudgetsTable_(sheet, row);
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
  // Transfer rows in an " Allocation" category (e.g. "Daily Allocation") are credits -
  // money arriving in a budget's account - stored positive, unlike every other Transfer
  // category (bills, SIPs, savings), which are debits and stay negative. Filtering to
  // F:F<0 picks up only the real "money left the building" transfers without needing to
  // enumerate category names here.
  sheet.getRange('B8').setFormula(
    '=-SUMIFS(Ledger!F:F, Ledger!C:C, ">="&' + MONTH_START + ', Ledger!D:D, "Transfer", Ledger!F:F, "<0")'
  ).setNumberFormat(INR_FORMAT);
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

  // A plain-text caption next to the chart, not just the built-in legend, so the color
  // -> meaning mapping doesn't depend on how legibly Sheets renders the legend itself.
  sheet.getRange(startRow, 6)
    .setValue('Bars: green = Income, red = Expense (left axis)  ·  Blue line = Cumulative Net (right axis)')
    .setFontStyle('italic').setFontSize(9);

  var chart = sheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(sheet.getRange(headerRow, 1, rows.length + 1, 4))
    .setPosition(headerRow, 6, 0, 0)
    .setOption('title', 'Income vs Expense by Month')
    .setOption('legend', { position: 'top', textStyle: { fontSize: 12 } })
    .setOption('series', {
      0: { color: '#34A853' },                                    // Income
      1: { color: '#EA4335' },                                    // Expense
      2: { type: 'line', color: '#4285F4', targetAxisIndex: 1 }    // Cumulative Net
    })
    .setOption('hAxis', { title: 'Month' })
    .setOption('vAxes', { 0: { title: 'Income / Expense (₹)' }, 1: { title: 'Cumulative Net (₹)' } })
    .setOption('height', 300)
    .build();
  sheet.insertChart(chart);
}

/**
 * Where this month's income actually went: spent, tied up in bills/SIPs, moved to
 * explicit savings, or still sitting unallocated. Mirrors the user's own mental model of
 * their accounts (a slice out to spending, a slice to obligations/investing, a slice to
 * deliberate savings, the rest is free money) rather than re-showing the expense-category
 * breakdown. "Bills/SIPs" and "Savings" are specific Transfer categories (see
 * DEFAULT_CATEGORIES in Parser.js); other transfers (own-account moves, Zaggle-style
 * conversions) are left out of this chart entirely since they don't change how much is
 * actually left for the user, just which account holds it.
 */
function writeIncomeAllocationChart_(sheet, startRow) {
  sheet.getRange(startRow, 1).setValue('This Month: Where Your Income Went').setFontWeight('bold');
  var headerRow = startRow + 1;
  sheet.getRange(headerRow, 1, 1, 2).setValues([['', 'Amount']]).setFontWeight('bold');

  var spentRow = headerRow + 1;
  var billsRow = headerRow + 2;
  var savingsRow = headerRow + 3;
  var leftoverRow = headerRow + 4;

  sheet.getRange(spentRow, 1, 4, 1).setValues([
    ['Spent (Expenses)'],
    ['Bills / SIPs'],
    ['Savings'],
    ['Left over']
  ]);

  var inMonth = 'Ledger!C:C, ">="&' + MONTH_START;
  var transferCategory = function (category) {
    return 'SUMIFS(Ledger!F:F, ' + inMonth + ', Ledger!D:D, "Transfer", Ledger!E:E, "' + category + '")';
  };
  // B4/B5 are the This Month Income/Expense tiles from writeTiles_. Expense and Transfer
  // amounts are stored negative, so each formula negates to get a positive magnitude.
  sheet.getRange(spentRow, 2).setFormula('=-B5');
  sheet.getRange(billsRow, 2).setFormula('=-(' + transferCategory('Credit Card Bill') + '+' + transferCategory('SIP / Investment') + ')');
  sheet.getRange(savingsRow, 2).setFormula('=-' + transferCategory('Savings'));
  sheet.getRange(leftoverRow, 2).setFormula('=MAX(0, B4-B' + spentRow + '-B' + billsRow + '-B' + savingsRow + ')');
  sheet.getRange(spentRow, 2, 4, 1).setNumberFormat(INR_FORMAT);

  sheet.getRange(startRow, 6)
    .setValue('Red = Spent  ·  Yellow = Bills/SIPs  ·  Dark green = Savings  ·  Lemon green = Left over')
    .setFontStyle('italic').setFontSize(9);

  var chart = sheet.newChart()
    .setChartType(Charts.ChartType.PIE)
    .addRange(sheet.getRange(headerRow, 1, 5, 2))
    .setPosition(headerRow, 6, 0, 0)
    .setOption('title', 'This Month: Income Allocation')
    .setOption('colors', ['#EA4335', '#FBBC04', '#0B8043', '#CDDC39']) // red, yellow, dark green, lemon green
    .setOption('legend', { position: 'top', textStyle: { fontSize: 12 } })
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

/**
 * All budgets (public and private - this is the private Sheet, nobody else sees it).
 * Target is the reference "what should move each period" figure from the Budgets tab;
 * Balance (BUDGETBALANCE()) and This Month (SPENDINGPOWER()) are both live custom-function
 * cells (Ledger.js) computed from real logged transactions, so this stays current without
 * re-running setup. A chart makes the target-vs-actual gap visible at a glance - the
 * whole point of this table existing, since pure transaction-matching means a budget
 * reads ₹0 until its allocation is actually logged, not just assumed.
 *
 * Both formulas pass `Ledger!A2:L` as a second, unused argument - purely so Sheets knows
 * these cells depend on the Ledger range and recalculates them when it changes
 * (including a manual edit, e.g. correcting a mis-logged row). Without that argument the
 * only real argument is a literal string, so Sheets has no cell reference to watch and
 * this can show a stale cached value indefinitely - see BUDGETBALANCE's docstring.
 */
function writeBudgetsTable_(sheet, startRow) {
  sheet.getRange(startRow, 1).setValue('Budgets (not shown automatically in Telegram unless Public)').setFontWeight('bold');
  var headerRow = startRow + 1;
  sheet.getRange(headerRow, 1, 1, 5).setValues([['Budget', 'Monthly Target', 'Balance', 'This Month', 'Public?']]).setFontWeight('bold');

  var budgets = readBudgets();
  var first = headerRow + 1;
  sheet.getRange(first, 1, budgets.length, 1).setValues(budgets.map(function (b) { return [b.name]; }));
  sheet.getRange(first, 2, budgets.length, 1).setValues(budgets.map(function (b) { return [b.residual ? '' : b.monthlyTarget]; }));
  sheet.getRange(first, 3, budgets.length, 1).setFormulas(budgets.map(function (b) { return ['=BUDGETBALANCE("' + b.name + '", Ledger!A2:L)']; }));
  sheet.getRange(first, 4, budgets.length, 1).setFormulas(budgets.map(function (b) { return ['=SPENDINGPOWER("' + b.name + '", Ledger!A2:L)']; }));
  sheet.getRange(first, 5, budgets.length, 1).setValues(budgets.map(function (b) { return [b.public ? 'Yes' : 'No']; }));
  sheet.getRange(first, 2, budgets.length, 3).setNumberFormat(INR_FORMAT);

  var chart = sheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(sheet.getRange(headerRow, 1, budgets.length + 1, 3)) // Budget, Monthly Target, Balance
    .setPosition(headerRow, 7, 0, 0)
    .setOption('title', 'Target vs Actual Balance per Budget')
    .setOption('legend', { position: 'top', textStyle: { fontSize: 12 } })
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
