const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEntry, DEFAULT_CATEGORIES } = require('../src/Parser.js');

test('"60 snacks" is an expense categorized as Food', () => {
  const r = parseEntry('60 snacks');
  assert.equal(r.type, 'Expense');
  assert.equal(r.amount, 60);
  assert.equal(r.category, 'Food');
  assert.equal(r.description, 'snacks');
});

test('"+50000 salary" is income categorized as Salary', () => {
  const r = parseEntry('+50000 salary');
  assert.equal(r.type, 'Income');
  assert.equal(r.amount, 50000);
  assert.equal(r.category, 'Salary');
  assert.equal(r.description, 'salary');
});

test('"income 50000 salary" (word form) is also income', () => {
  const r = parseEntry('income 50000 salary');
  assert.equal(r.type, 'Income');
  assert.equal(r.amount, 50000);
  assert.equal(r.category, 'Salary');
});

test('"1.2k rent" expands the k-shorthand and matches Rent', () => {
  const r = parseEntry('1.2k rent');
  assert.equal(r.type, 'Expense');
  assert.equal(r.amount, 1200);
  assert.equal(r.category, 'Rent');
  assert.equal(r.description, 'rent');
});

test('"₹250 uber" strips the currency symbol and matches Transport', () => {
  const r = parseEntry('₹250 uber');
  assert.equal(r.amount, 250);
  assert.equal(r.category, 'Transport');
  assert.equal(r.description, 'uber');
});

test('"rs 99 netflix" strips the rs prefix and matches Subscriptions', () => {
  const r = parseEntry('rs 99 netflix');
  assert.equal(r.amount, 99);
  assert.equal(r.category, 'Subscriptions');
  assert.equal(r.description, 'netflix');
});

test('a message with no amount returns null so the bot can show help', () => {
  assert.equal(parseEntry('snacks'), null);
  assert.equal(parseEntry(''), null);
  assert.equal(parseEntry('   '), null);
});

test('an unrecognized description falls back to the Other category', () => {
  const r = parseEntry('60 xyz123');
  assert.equal(r.type, 'Expense');
  assert.equal(r.amount, 60);
  assert.equal(r.category, 'Other');
});

test('an unrecognized income description falls back to Other Income', () => {
  const r = parseEntry('+500 xyz123');
  assert.equal(r.type, 'Income');
  assert.equal(r.category, 'Other Income');
});

test('"+8800 zaggle allowance" is categorized as Zaggle Allowance income', () => {
  const r = parseEntry('+8800 zaggle allowance');
  assert.equal(r.type, 'Income');
  assert.equal(r.amount, 8800);
  assert.equal(r.category, 'Zaggle Allowance');
});

const { parseOptions, applyDefaults } = require('../src/Parser.js');

const optionRows = [
  ['Account', 'Alpha Bank', 'UPI:GPay, UPI:Pop, Card', 'alpha'],
  ['Account', 'Beta Bank', 'UPI:GPay, UPI:Paytm', 'beta'],
  ['Account', 'Meal Card', 'Zaggle', 'meal'],
  ['Account', 'Cash', 'Cash', ''],
  ['Person', 'Me', '', ''],
  ['Person', 'Partner', '', 'partner'],
  ['Person', 'Family', '', 'family']
];
const options = parseOptions(optionRows);

test('inline tags pick person, UPI app and account and are stripped from the description', () => {
  const r = parseEntry('250 gift partner pop alpha', undefined, options);
  assert.equal(r.forWho, 'Partner');
  assert.equal(r.app, 'Pop');
  assert.equal(r.account, 'Alpha Bank');
  assert.equal(r.description, 'gift');
  assert.equal(r.category, 'Gifts');
});

test('the default (first) person needs no token and "me" stays in the description', () => {
  const r = parseEntry('60 snacks for me', undefined, options);
  assert.equal(r.forWho, '');
  assert.equal(r.description, 'snacks for me');
});

test('applyDefaults infers the only account that supports a UPI app', () => {
  const r = applyDefaults(parseEntry('80 chai paytm', undefined, options), options);
  assert.equal(r.account, 'Beta Bank');
  assert.equal(r.payment, 'UPI');
  assert.equal(r.app, 'Paytm');
  assert.equal(r.forWho, 'Me');
});

test('applyDefaults reuses the last account and method when the message says nothing', () => {
  const last = { account: 'Meal Card', method: 'Zaggle' };
  const r = applyDefaults(parseEntry('120 lunch', undefined, options), options, last);
  assert.equal(r.account, 'Meal Card');
  assert.equal(r.payment, 'Zaggle');
  assert.equal(r.app, '');
});

test('applyDefaults falls back to the first account and its first method', () => {
  const r = applyDefaults(parseEntry('120 lunch', undefined, options), options);
  assert.equal(r.account, 'Alpha Bank');
  assert.equal(r.method, 'GPay');
});

test('credit card bills and SIPs are Transfers, not expenses', () => {
  const bill = parseEntry('12000 credit card bill', undefined, options);
  assert.equal(bill.type, 'Transfer');
  assert.equal(bill.category, 'Credit Card Bill');
  const sip = parseEntry('24000 sip', undefined, options);
  assert.equal(sip.type, 'Transfer');
  assert.equal(sip.category, 'SIP / Investment');
});

test('keywords match whole words only ("cola" is not "ola")', () => {
  assert.equal(parseEntry('40 cola').category, 'Other');
  assert.equal(parseEntry('40 ola').category, 'Transport');
});

test('an explicit + never becomes a Transfer', () => {
  const r = parseEntry('+500 savings interest');
  assert.equal(r.type, 'Income');
  assert.equal(r.category, 'Interest');
});

const { sanitizeLlmEntries } = require('../src/Parser.js');

test('phrase-based income detection: "sent to me" is Income even without a leading +', () => {
  const r = parseEntry('250 sent to me by my partner', undefined, options);
  assert.equal(r.type, 'Income');
  assert.equal(r.amount, 250);
});

test('"gave me" and "received" are also treated as Income', () => {
  assert.equal(parseEntry('100 gave me for lunch').type, 'Income');
  assert.equal(parseEntry('500 received from friend').type, 'Income');
});

test('sanitizeLlmEntries drops entries with a bad type or zero/non-numeric amount', () => {
  const result = sanitizeLlmEntries([
    { type: 'Bogus', amount: 100, category: 'Food' },
    { type: 'Expense', amount: 0, category: 'Food' },
    { type: 'Expense', amount: 'not a number', category: 'Food' }
  ], DEFAULT_CATEGORIES, options);
  assert.equal(result.length, 0);
});

test('sanitizeLlmEntries takes the absolute value of a negative amount instead of dropping it', () => {
  const r = sanitizeLlmEntries([{ type: 'Expense', amount: -60, category: 'Food' }], DEFAULT_CATEGORIES, options);
  assert.equal(r[0].amount, 60);
});

test('sanitizeLlmEntries falls back to a safe category when the LLM hallucinates one', () => {
  const expense = sanitizeLlmEntries([{ type: 'Expense', amount: 60, category: 'Made Up Category' }], DEFAULT_CATEGORIES, options);
  assert.equal(expense[0].category, 'Other');
  const income = sanitizeLlmEntries([{ type: 'Income', amount: 60, category: 'Made Up Category' }], DEFAULT_CATEGORIES, options);
  assert.equal(income[0].category, 'Other Income');
});

test('sanitizeLlmEntries clears an account/person name that does not exactly match a real one', () => {
  const r = sanitizeLlmEntries([{
    type: 'Expense', amount: 60, category: 'Food', account: 'Some Bank Nobody Configured', forWho: 'A Stranger'
  }], DEFAULT_CATEGORIES, options);
  assert.equal(r[0].account, '');
  assert.equal(r[0].forWho, '');
});

test('sanitizeLlmEntries keeps a real account/person/app name (case-insensitively)', () => {
  const r = sanitizeLlmEntries([{
    type: 'Expense', amount: 60, category: 'Food', account: 'alpha bank', forWho: 'PARTNER', app: 'gpay'
  }], DEFAULT_CATEGORIES, options);
  assert.equal(r[0].account, 'Alpha Bank');
  assert.equal(r[0].forWho, 'Partner');
  assert.equal(r[0].app, 'GPay');
});

test('sanitizeLlmEntries passes a valid multi-entry array through unchanged in shape', () => {
  const r = sanitizeLlmEntries([
    { type: 'Transfer', amount: 357, category: 'Internal Conversion', description: 'partner food off zaggle', account: 'Meal Card' },
    { type: 'Transfer', amount: 357, category: 'Internal Conversion', description: 'zaggle reimbursement', account: 'Beta Bank' }
  ], DEFAULT_CATEGORIES, options);
  assert.equal(r.length, 2);
  assert.equal(r[0].account, 'Meal Card');
  assert.equal(r[1].account, 'Beta Bank');
});

test('sanitizeLlmEntries silently ignores a non-array input', () => {
  assert.deepEqual(sanitizeLlmEntries(null, DEFAULT_CATEGORIES, options), []);
  assert.deepEqual(sanitizeLlmEntries(undefined, DEFAULT_CATEGORIES, options), []);
  assert.deepEqual(sanitizeLlmEntries('not an array', DEFAULT_CATEGORIES, options), []);
});

test('"yesterday" is detected and stripped from the description', () => {
  const r = parseEntry('250 lunch yesterday');
  assert.equal(r.amount, 250);
  assert.equal(r.dateOffsetDays, -1);
  assert.equal(r.description, 'lunch');
});

test('"day before yesterday" resolves to -2, not -1', () => {
  const r = parseEntry('250 lunch day before yesterday');
  assert.equal(r.dateOffsetDays, -2);
  assert.equal(r.description, 'lunch');
});

test('"N days ago" does not get its leading number mistaken for the amount', () => {
  const r = parseEntry('3 days ago 250 lunch');
  assert.equal(r.amount, 250);
  assert.equal(r.dateOffsetDays, -3);
  assert.equal(r.description, 'lunch');
});

test('"today" resolves to offset 0 and is still distinguishable from "no date said"', () => {
  assert.equal(parseEntry('250 lunch today').dateOffsetDays, 0);
  assert.equal('dateOffsetDays' in parseEntry('250 lunch'), false);
});

test('sanitizeLlmEntries passes through a valid YYYY-MM-DD date', () => {
  const r = sanitizeLlmEntries([{ type: 'Expense', amount: 60, category: 'Food', date: '2026-09-20' }], DEFAULT_CATEGORIES, options);
  assert.equal(r[0].date, '2026-09-20');
});

test('sanitizeLlmEntries drops a malformed date instead of passing it through', () => {
  const r = sanitizeLlmEntries([{ type: 'Expense', amount: 60, category: 'Food', date: 'yesterday' }], DEFAULT_CATEGORIES, options);
  assert.equal('date' in r[0], false);
});

const { parseBudgets, computeBudgetBalance } = require('../src/Parser.js');

const budgetRows = [
  ['Daily', 'Alpha Bank', '', 6000, 'FALSE', 'TRUE'],
  ['Food Allowance', 'Meal Card', '', 4000, 'FALSE', 'TRUE'],
  ['Investment', 'Beta Bank', '', 20000, 'FALSE', 'FALSE'],
  ['Travel', 'Gamma Bank', 'Travel', 3000, 'FALSE', 'FALSE'],
  ['Gifting', 'Gamma Bank', 'Gifts', 4000, 'FALSE', 'FALSE'],
  ['Everything Else', 'Alpha Bank', '', 0, 'TRUE', 'FALSE']
];
const budgets = parseBudgets(budgetRows);
const byName = (name) => budgets.find((b) => b.name === name);

function row(date, type, category, account, amount) {
  return { date: new Date(date), type, category, account, amount };
}

test('parseBudgets reads the Budgets tab row shape, including Residual/Public flags', () => {
  assert.equal(budgets.length, 6);
  const residual = byName('Everything Else');
  assert.equal(residual.account, 'Alpha Bank');
  assert.equal(residual.residual, true);
  assert.equal(residual.public, false);
  const daily = byName('Daily');
  assert.equal(daily.monthlyTarget, 6000);
  assert.equal(daily.public, true);
  const travel = byName('Travel');
  assert.deepEqual(travel.categories, ['Travel']);
});

test('a budget with no spend shows its full accrued target', () => {
  const start = new Date('2026-10-01');
  const now = new Date('2026-10-15');
  const balance = computeBudgetBalance(byName('Daily'), budgets, [], start, now);
  assert.equal(balance, 6000);
});

test('accrual steps whole months on the 1st, not prorated by day', () => {
  const start = new Date('2026-10-01');
  const rows = [row('2026-10-05', 'Expense', 'Food', 'Alpha Bank', -2000)];
  assert.equal(computeBudgetBalance(byName('Daily'), budgets, rows, start, new Date('2026-10-20')), 4000);
  assert.equal(computeBudgetBalance(byName('Daily'), budgets, rows, start, new Date('2026-11-01')), 10000);
  assert.equal(computeBudgetBalance(byName('Daily'), budgets, rows, start, new Date('2026-12-15')), 16000);
});

test('Transfer rows count as spend against a budget, not just Expense (e.g. a SIP transfer)', () => {
  const start = new Date('2026-10-01');
  const rows = [row('2026-10-10', 'Transfer', 'SIP / Investment', 'Beta Bank', -12000)];
  assert.equal(computeBudgetBalance(byName('Investment'), budgets, rows, start, new Date('2026-10-15')), 8000);
});

test('Income rows never count as spend', () => {
  const start = new Date('2026-10-01');
  const rows = [row('2026-10-10', 'Income', 'Salary', 'Alpha Bank', 60000)];
  assert.equal(computeBudgetBalance(byName('Daily'), budgets, rows, start, new Date('2026-10-15')), 6000);
});

test('spend before the budget start date is excluded', () => {
  const start = new Date('2026-10-01');
  const rows = [row('2026-09-15', 'Expense', 'Food', 'Alpha Bank', -5000)];
  assert.equal(computeBudgetBalance(byName('Daily'), budgets, rows, start, new Date('2026-10-15')), 6000);
});

test('Travel and Gifting share one account but are tracked fully independently via category', () => {
  const start = new Date('2026-10-01');
  const rows = [row('2026-10-10', 'Expense', 'Travel', 'Gamma Bank', -1000)];
  assert.equal(computeBudgetBalance(byName('Travel'), budgets, rows, start, new Date('2026-10-15')), 2000);
  assert.equal(computeBudgetBalance(byName('Gifting'), budgets, rows, start, new Date('2026-10-15')), 4000);
});

test('the trip scenario: Travel goes negative one month and catches up the next, Gifting is untouched', () => {
  const start = new Date('2026-10-01');
  const tripSpend = [row('2026-10-20', 'Expense', 'Travel', 'Gamma Bank', -5000)];

  const travelMonth1 = computeBudgetBalance(byName('Travel'), budgets, tripSpend, start, new Date('2026-10-25'));
  assert.equal(travelMonth1, -2000);
  const giftMonth1 = computeBudgetBalance(byName('Gifting'), budgets, tripSpend, start, new Date('2026-10-25'));
  assert.equal(giftMonth1, 4000);

  const travelMonth2 = computeBudgetBalance(byName('Travel'), budgets, tripSpend, start, new Date('2026-11-05'));
  assert.equal(travelMonth2, 1000);
  const giftMonth2 = computeBudgetBalance(byName('Gifting'), budgets, tripSpend, start, new Date('2026-11-05'));
  assert.equal(giftMonth2, 8000);
});

test('the residual budget is salary income minus every other budget\'s accrued target minus its own spend', () => {
  const start = new Date('2026-10-01');
  const now = new Date('2026-10-15');
  const rows = [
    row('2026-10-02', 'Income', 'Salary', 'Alpha Bank', 60000),
    row('2026-10-12', 'Expense', 'Shopping', 'Alpha Bank', -8000)
  ];
  // other budgets' accrued targets for 1 month: 6000+4000+20000+3000+4000 = 37000
  assert.equal(computeBudgetBalance(byName('Everything Else'), budgets, rows, start, now), 60000 - 37000 - 8000);
});
