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

// Optional: named budgets, each tracked by pure transaction-matching - a budget reads
// ₹0 until you actually log money moving into it (never floored below zero either;
// overspending before logging that period's funding just goes negative). Row format:
// [Name, Account, Categories, MonthlyTarget, Residual, Public]
//   Categories: comma list restricting which categories' spend counts - only needed when
//     two budgets share one Account (e.g. Travel/Gifts both funded from one card below).
//     Empty means everything spent from that Account counts.
//   MonthlyTarget: reference only, shown next to the live balance so you can compare what
//     should move each period against what actually has - not used in the balance itself.
//   Residual: TRUE for at most one budget - "whatever's left" after every amount actually
//     logged as moved into another budget is set aside from Salary income. Ignores MonthlyTarget.
//   Public: TRUE = safe to show automatically (after a save, on /month). FALSE = only
//     shown when you ask with /budget or /balance - use this for anything revealing
//     (savings balances, investment transfers) you don't want visible if someone glances
//     at the chat.
// A budget's funding category is always "<Name> Allocation" (e.g. "Daily Allocation") -
// created automatically in the Categories tab, you don't need to add it yourself. Log
// `10000 daily allocation` (or similar) when you actually move money into a budget's
// account for its balance to reflect that.
var LOCAL_BUDGETS = [
  ['Daily', 'My Bank', '', 10000, 'FALSE', 'TRUE'],
  ['Travel', 'My Credit Card', 'Travel', 5000, 'FALSE', 'FALSE'],
  ['Gifting', 'My Credit Card', 'Gifts', 5000, 'FALSE', 'FALSE'],
  ['Everything Else', 'My Bank', '', 0, 'TRUE', 'FALSE']
];
