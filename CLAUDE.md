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
- `.clasp.json` holds the bound script's `scriptId` and `rootDir: "src"`. It's gitignored
  (see `.clasp.json.example`) — the real one points at this specific Google account's own
  script/Sheet, and committing it would let anyone who clones the repo without reading the
  README accidentally push to that live script.
- Real secrets (`BOT_TOKEN`, `ALLOWED_CHAT_ID`, `GEMINI_API_KEY`) live in Apps Script's
  Script Properties, set through the Apps Script editor UI — never in this repo.

## Privacy (important)

This repo is public. Real bank/card/person names must never be committed - not in code,
tests, README examples or commit messages. They live in the private Sheet's `Options` tab,
seeded from `src/LocalOptions.js`, which is gitignored (but still pushed to Apps Script by
clasp). `DEFAULT_OPTIONS` in `Parser.js` and every test fixture must stay generic. Before
any `git push`, grep the staged diff for real account/bank/person names.

## Conventions

- Ledger amounts are **signed**: expenses and transfers negative, income positive. Income
  and spending totals are computed by the `Type` column (`Income` / `Expense`), never by the
  sign of the amount - `Transfer` rows (card bills, SIPs, own-account moves) must stay out of
  both. Don't reintroduce a separate income/expense split across sheets.
- Ledger columns are only ever appended on the right (`Account`, `For`, `App` after `Raw`) so
  existing rows and formula column letters never shift; setup fills missing headers only.
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
- `Gemini.js` is a fallback chain, not a hard dependency: `parseEntryLLM_` returns `null`
  (not an empty array) on a missing key, an HTTP failure, or zero usable entries, and
  `Main.js` falls back to the regex `parseEntry`. Never let a Gemini failure make the bot
  go silent — if you touch this path, keep a working fallback on every failure branch.
- The contract between `Gemini.js`/`sanitizeLlmEntries` (in `Parser.js`) and
  `applyDefaults` is exact-name-or-blank: an LLM-produced `account`/`forWho`/`app` that
  doesn't exactly match (case-insensitively) a real name from the `Options` tab gets
  cleared to `''`, never passed through as a guess. A blank is what `applyDefaults`
  already knows how to fill sensibly (last used, then first configured); a wrong-but-
  plausible-looking name would silently write bad data instead.
- Entries save immediately on parse now (no more tap-to-confirm) — see `handleMessage_`
  in `Main.js`. Corrections happen after the fact via `updateEntryField`/`deleteEntryById_`
  in `Ledger.js`, both of which look up the row **by ID** (`findRowById_`, a single
  column-A scan), never by row position. Don't optimize this into "remember the row
  index" — a message can append more than one row, and other rows can be deleted in
  between, so position drifts but the ID doesn't.

## Testing

`npm test` runs `test/parser.test.js`. There is no test harness for the Apps Script side;
changes to `Main.js` / `Ledger.js` / `Telegram.js` / `Setup.js` need a real push + manual
Telegram round-trip to verify (see README's Verification section in the plan file).
