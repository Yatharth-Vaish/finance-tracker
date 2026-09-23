# finance-tracker

Telegram bot → Google Sheets cash flow ledger, running entirely on Google Apps Script
(no server, no hosting cost). Full design plan: `~/.claude/plans/effervescent-twirling-globe.md`.

## Layout

- `src/*.js` — Apps Script source, pushed to Google with `clasp push`. Deployed via the
  Apps Script editor (Deploy → Web app), not via any CI here.
- `src/Parser.js` is the only file that's pure JS with no Apps Script globals — it has a
  `module.exports` guard at the bottom so `test/parser.test.js` can run it under plain Node.
  Every other `src/*.js` file depends on `SpreadsheetApp`, `UrlFetchApp`, `PropertiesService`,
  `CacheService`, etc., which only exist inside the Apps Script runtime — don't try to unit
  test those directly; changes to them are verified by running the bot for real (see README).
- `.clasp.json` holds the bound script's `scriptId` and `rootDir: "src"`. It has no secrets
  and is committed.
- Real secrets (`BOT_TOKEN`, `WEBHOOK_SECRET`, `ALLOWED_CHAT_ID`, `WEBHOOK_URL`) live in
  Apps Script's Script Properties, set through the Apps Script editor UI — never in this repo.

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
- `doPost` always returns 200 (`ok`), even on internal errors (caught and logged) — Telegram
  retries aggressively on non-200s, and retries are already deduped via `update_id`, so a
  hard failure response would just cause pointless retry storms.

## Testing

`npm test` runs `test/parser.test.js`. There is no test harness for the Apps Script side;
changes to `Main.js` / `Ledger.js` / `Telegram.js` / `Setup.js` need a real push + manual
Telegram round-trip to verify (see README's Verification section in the plan file).
