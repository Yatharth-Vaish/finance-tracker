// Copy this file to src/LocalOptions.js and put your real accounts/people in it.
// src/LocalOptions.js is gitignored, so your names stay out of the repo; clasp still
// pushes it to your own Apps Script project, where it seeds the Options tab on first setup.
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
