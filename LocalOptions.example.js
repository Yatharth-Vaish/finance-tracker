// Copy this file to src/LocalOptions.js and put your real accounts/people/budgets in it.
// src/LocalOptions.js is gitignored, so your names stay out of the repo; clasp still
// pushes it to your own Apps Script project, where it seeds the Options/Budgets tabs on
// first setup.
// Row format: [Kind, Name, Methods, Aliases]
//   Methods: comma-separated. "UPI:GPay" = UPI through the GPay app; "Card", "Cash" are plain.
//   Aliases: short words you can type in a message to pick the row without tapping.
//   The first Person is the default "For" and needs no alias.
var LOCAL_OPTIONS = [
  ['Account', 'My Bank', 'UPI:GPay, UPI:PhonePe, Card', 'bank'],
  ['Account', 'My Credit Card', 'Card', 'cc'],
  ['Account', 'Cash', 'Cash', 'cash'],
  ['Person', 'Me', '', ''],
  ['Person', 'Partner', '', 'partner'],
  ['Person', 'Family', '', 'family, fam']
];

// Optional: named monthly allowances, each tracked as accrued-target minus matched
// spend (never floored at zero - an over-budget month just reduces next month's
// balance). Row format: [Name, Account, Categories, MonthlyTarget, Residual, Public]
//   Categories: comma list restricting which categories count - only needed when two
//     budgets share one Account (e.g. Travel/Gifts both funded from one card below).
//     Empty means everything spent from that Account counts.
//   Residual: TRUE for at most one budget - "whatever's left" after every other
//     budget's target is set aside from Salary income that month. Ignores MonthlyTarget.
//   Public: TRUE = safe to show automatically (after a save, on /month). FALSE = only
//     shown when you ask with /budget - use this for anything revealing (savings
//     balances, investment transfers) you don't want visible if someone glances at the chat.
var LOCAL_BUDGETS = [
  ['Daily', 'My Bank', '', 10000, 'FALSE', 'TRUE'],
  ['Travel', 'My Credit Card', 'Travel', 5000, 'FALSE', 'FALSE'],
  ['Gifting', 'My Credit Card', 'Gifts', 5000, 'FALSE', 'FALSE'],
  ['Everything Else', 'My Bank', '', 0, 'TRUE', 'FALSE']
];
