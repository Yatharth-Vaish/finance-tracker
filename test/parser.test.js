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
