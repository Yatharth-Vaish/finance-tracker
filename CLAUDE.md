# finance-tracker

Telegram bot → Google Sheets cash flow ledger, running entirely on Google Apps Script
(no server, no hosting cost). Full design plan: `~/.claude/plans/effervescent-twirling-globe.md`.

## Layout

- `src/*.js` — Apps Script source, pushed to Google with `clasp push`. No deployment step:
  the bot is polled by a time-driven trigger (`pollUpdates`), not served as a web app.
- `src/Parser.js` is the only file that's pure JS with no Apps Script globals — it has a
  `module.exports` guard at the bottom so `test/parser.test.js` can run it under plain Node.
  Every other `src/*.js` file depends on `SpreadsheetApp`, `UrlFetchApp`, `PropertiesService`,
  `CacheService`, etc., which only exist inside the Apps Script runtime — don't try to unit
  test those directly; changes to them are verified by running the bot for real (see README).
- `.clasp.json` holds the bound script's `scriptId` and `rootDir: "src"`. It has no secrets
  and is committed.
- Real secrets (`BOT_TOKEN`, `ALLOWED_CHAT_ID`) live in Apps Script's Script Properties, set
  through the Apps Script editor UI — never in this repo.

## Conventions

- Ledger amounts are **signed**: expenses negative, income positive. Cash flow = `SUM()`.
  Don't reintroduce a separate income/expense split across sheets — the whole point of one
  signed column is that Dashboard formulas stay one `SUMIFS` each.
- Categories (with their keyword lists for auto-guessing) live in the `Categories` sheet
  tab, not hardcoded in `Main.js`. `Parser.js` exports `DEFAULT_CATEGORIES` as the seed data
  that `Setup.js` writes on first run; after that, the sheet is the source of truth and
  `readCategories()` in `Ledger.js` reads it live.
- Telegram `callback_data` has a 64-byte limit — keep callback prefixes short (`s:`, `c:`,
  `sc:`, `b:`, `ud`, `no`) rather than descriptive strings.
- `pollUpdates` never lets one bad update stop the loop: each update is wrapped in its own
  try/catch (logged, not rethrown), and the `LAST_UPDATE_ID` offset still advances past it.
  Don't remove that per-update try/catch — a single unhandled exception would otherwise
  freeze processing on the same poisoned update forever, since `getUpdates` keeps returning
  it until the offset moves past it.
- Don't reintroduce a webhook (`doPost` + Web app deployment). It was the original design
  but Apps Script Web Apps always answer with an HTTP 302, which Telegram's webhook client
  won't follow — Telegram logs "Wrong response from the webhook: 302 Found" and never
  delivers reliably. Polling is the fix, not a stopgap.

## Testing

`npm test` runs `test/parser.test.js`. There is no test harness for the Apps Script side;
changes to `Main.js` / `Ledger.js` / `Telegram.js` / `Setup.js` need a real push + manual
Telegram round-trip to verify (see README's Verification section in the plan file).
