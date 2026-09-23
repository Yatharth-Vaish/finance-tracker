const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEntry } = require('../src/Parser.js');

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
