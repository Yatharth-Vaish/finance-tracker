/**
 * One-time (and re-runnable) setup: builds the Ledger, Categories and Dashboard tabs.
 * Run setupSpreadsheet() once from the Apps Script editor after the first `clasp push`,
 * and again any time you want to reset the Dashboard formulas/charts.
 */

var INR_FORMAT = '₹#,##0';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Finance Tracker')
    .addItem('Run setup (Ledger / Categories / Dashboard)', 'setupSpreadsheet')
    .addItem('Start Telegram polling', 'setupPolling')
    .addToUi();
}

function setupSpreadsheet() {
  var ss = SpreadsheetApp.getActive();
  setupLedgerSheet_(ss);
  setupCategoriesSheet_(ss);
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
  sheet.clear();
  sheet.getRange(1, 1, 1, LEDGER_HEADERS.length).setValues([LEDGER_HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange('B:C').setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange('F:F').setNumberFormat(INR_FORMAT);

  var typeRule = SpreadsheetApp.newDataValidation().requireValueInList(['Expense', 'Income']).build();
  sheet.getRange('D2:D').setDataValidation(typeRule);
  var paymentRule = SpreadsheetApp.newDataValidation().requireValueInList(['UPI', 'Cash', 'Card', 'Bank']).build();
  sheet.getRange('H2:H').setDataValidation(paymentRule);

  sheet.autoResizeColumns(1, LEDGER_HEADERS.length);
}

function setupCategoriesSheet_(ss) {
  var sheet = ss.getSheetByName(CATEGORIES_SHEET_NAME) || ss.insertSheet(CATEGORIES_SHEET_NAME);
  sheet.clear();
  var headers = ['Type', 'Category', 'Keywords'];
  var rows = DEFAULT_CATEGORIES.map(function (c) { return [c.type, c.category, c.keywords.join(', ')]; });
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}

function setupDashboardSheet_(ss) {
  var sheet = ss.getSheetByName('Dashboard') || ss.insertSheet('Dashboard');
  sheet.clear();
  sheet.getCharts().forEach(function (c) { sheet.removeChart(c); });

  sheet.getRange('A1').setValue('Finance Dashboard').setFontSize(18).setFontWeight('bold');
  sheet.getRange('A2').setValue('Updated: ' + new Date().toLocaleString());

  writeTiles_(sheet);
  var monthlyStartRow = 8;
  writeMonthlyTable_(sheet, monthlyStartRow);
  var categoryStartRow = monthlyStartRow + 16;
  writeCategoryTable_(ss, sheet, categoryStartRow);
  var recentStartRow = categoryStartRow + 14;
  writeRecentEntries_(sheet, recentStartRow);

  sheet.autoResizeColumns(1, 6);
}

function writeTiles_(sheet) {
  var labels = ['This Month Income', 'This Month Expense', 'Net', 'Savings Rate'];
  var formulas = [
    '=SUMIFS(Ledger!F:F, Ledger!C:C, ">="&EOMONTH(TODAY(),-1)+1, Ledger!F:F, ">0")',
    '=SUMIFS(Ledger!F:F, Ledger!C:C, ">="&EOMONTH(TODAY(),-1)+1, Ledger!F:F, "<0")',
    '=B4+B5',
    '=IFERROR(B6/B4, 0)'
  ];
  sheet.getRange('A4:A7').setValues(labels.map(function (l) { return [l]; })).setFontWeight('bold');
  sheet.getRange('B4:B6').setFormulas([[formulas[0]], [formulas[1]], [formulas[2]]]).setNumberFormat(INR_FORMAT);
  sheet.getRange('B7').setFormula(formulas[3]).setNumberFormat('0.0%');
}

function writeMonthlyTable_(sheet, startRow) {
  sheet.getRange(startRow, 1).setValue('Last 12 Months').setFontWeight('bold');
  var headerRow = startRow + 1;
  sheet.getRange(headerRow, 1, 1, 4).setValues([['Month', 'Income', 'Expense', 'Cumulative Net']]).setFontWeight('bold');

  var rows = [];
  for (var i = 11; i >= 0; i--) {
    var r = headerRow + 1 + (11 - i);
    var monthStart = '(EOMONTH(TODAY(),-' + (i + 1) + ')+1)';
    var monthEnd = 'EOMONTH(TODAY(),-' + i + ')';
    var monthLabel = '=TEXT(' + monthStart + ',"mmm yyyy")';
    var income = '=SUMIFS(Ledger!F:F, Ledger!C:C, ">="&' + monthStart + ', Ledger!C:C, "<="&' + monthEnd + ', Ledger!F:F, ">0")';
    var expense = '=SUMIFS(Ledger!F:F, Ledger!C:C, ">="&' + monthStart + ', Ledger!C:C, "<="&' + monthEnd + ', Ledger!F:F, "<0")';
    var cumulative = (11 - i === 0)
      ? '=B' + r + '+C' + r
      : '=D' + (r - 1) + '+B' + r + '+C' + r;
    rows.push([monthLabel, income, expense, cumulative]);
  }
  var range = sheet.getRange(headerRow + 1, 1, rows.length, 4);
  range.setFormulas(rows);
  sheet.getRange(headerRow + 1, 2, rows.length, 3).setNumberFormat(INR_FORMAT);

  var dataRange = sheet.getRange(headerRow, 1, rows.length + 1, 4);
  var chart = sheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(dataRange)
    .setPosition(headerRow, 6, 0, 0)
    .setOption('title', 'Income vs Expense by Month')
    .setOption('series', { 2: { type: 'line', targetAxisIndex: 1 } })
    .setOption('vAxes', { 0: { title: 'Income / Expense' }, 1: { title: 'Cumulative Net' } })
    .build();
  sheet.insertChart(chart);
}

function writeCategoryTable_(ss, sheet, startRow) {
  sheet.getRange(startRow, 1).setValue('This Month by Category (Expenses)').setFontWeight('bold');
  var headerRow = startRow + 1;
  sheet.getRange(headerRow, 1, 1, 2).setValues([['Category', 'Amount']]).setFontWeight('bold');

  var expenseCategories = readCategories().filter(function (c) { return c.type === 'Expense'; });
  var rows = expenseCategories.map(function (c) {
    var formula = '=-SUMIFS(Ledger!F:F, Ledger!C:C, ">="&EOMONTH(TODAY(),-1)+1, Ledger!E:E, "' + c.category + '")';
    return [c.category, formula];
  });
  sheet.getRange(headerRow + 1, 1, rows.length, 2).setValues(rows);
  sheet.getRange(headerRow + 1, 2, rows.length, 1).setNumberFormat(INR_FORMAT);

  var dataRange = sheet.getRange(headerRow, 1, rows.length + 1, 2);
  var chart = sheet.newChart()
    .setChartType(Charts.ChartType.PIE)
    .addRange(dataRange)
    .setPosition(headerRow, 6, 0, 0)
    .setOption('title', 'This Month\'s Spend by Category')
    .build();
  sheet.insertChart(chart);
}

function writeRecentEntries_(sheet, startRow) {
  sheet.getRange(startRow, 1).setValue('Last 10 Entries').setFontWeight('bold');
  var headerRow = startRow + 1;
  sheet.getRange(headerRow, 1, 1, 5).setValues([['Date', 'Type', 'Category', 'Amount', 'Description']]).setFontWeight('bold');
  var formula = '=IFERROR(QUERY(Ledger!A2:I,"select C,D,E,F,G order by B desc limit 10",0),"No entries yet")';
  sheet.getRange(headerRow + 1, 1).setFormula(formula);
  sheet.getRange(headerRow + 1, 4, 10, 1).setNumberFormat(INR_FORMAT);
}
