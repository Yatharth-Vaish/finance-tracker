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
tests, README examples or commit messages. They live in the private Sheet's `Options` and
`Budgets` tabs, seeded from `src/LocalOptions.js` (`LOCAL_OPTIONS` and `LOCAL_BUDGETS`),
which is gitignored (but still pushed to Apps Script by clasp). `DEFAULT_OPTIONS` /
`DEFAULT_BUDGETS` in `Parser.js` and every test fixture must stay generic. Before any
`git push`, grep the staged diff for real account/bank/person names.

The `Budgets` tab's `Public` column is a second, user-facing layer of the same concern:
even generic-looking numbers (an account's real balance, an investment transfer amount)
can be sensitive if the user glances at the chat in front of someone. Only budgets marked
`Public` appear automatically (after a save, on `/month`); everything else requires the
user to deliberately run `/budget`. Don't make a new auto-shown message include a
non-public budget's balance, even in passing.

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
- Don't reintroduce a Telegram webhook (`doPost` registered with `setWebhook`). It was the
  original design but Apps Script Web Apps always answer with an HTTP 302, which
  Telegram's webhook client won't follow — Telegram logs "Wrong response from the webhook:
  302 Found" and never delivers reliably. Polling is the fix, not a stopgap.
- **`doGet()` in `Main.js` is a different thing — a self-triggered poll, not a Telegram
  webhook.** `.github/workflows/poll-relay.yml` (GitHub Actions, free/unlimited since this
  repo is public) calls it every ~15s to run `pollUpdates()` more often than Apps Script's
  own 1-minute trigger floor allows, which is what actually lowers latency (see README
  "Lower latency"). Free cron services (cron-job.org, Cloudflare Cron Triggers) were tried
  first and dropped — both floor at 1-minute intervals too, no faster than the native
  trigger already is; GitHub Actions works around this by looping internally within one
  5-minute-scheduled run rather than relying on sub-minute external scheduling, which
  nothing free actually offers. A normal HTTP client follows Apps Script's 302 fine — it's
  only Telegram's webhook validator that rejects it — so this doesn't hit the problem
  above. `doGet()` is gated by `?key=` matching the `POLL_SECRET` Script Property
  (generated via the **Finance Tracker → Generate poll secret** menu item in `Setup.js`,
  works from either the Sheet's menu or the editor's Run button — `SpreadsheetApp.getUi()`
  throws from the latter, so it's wrapped in try/catch with `Logger.log` as a fallback
  surface for the value): the Web App has to be deployed with "Anyone" access for the
  Actions workflow to call it with no auth step of its own, so the secret is the only
  thing stopping a stranger who finds the URL from burning your Apps Script execution
  quota. The actual URL and secret live only as GitHub repo secrets
  (`FINANCE_TRACKER_WEBAPP_URL`, `FINANCE_TRACKER_POLL_SECRET`), never committed. The
  native 1-minute trigger from `setupPolling` stays installed regardless, as a fallback —
  GitHub doesn't guarantee `schedule:` runs fire exactly on time, so if the workflow is
  delayed or stops, polling degrades to 1-minute instead of going silent.
- `pollUpdates()` takes `LockService.getScriptLock()` (non-blocking, `tryLock(0)`) around
  its whole body, so the native trigger and the Actions relay's `doGet()` calls can't
  process the same Telegram update twice if they land close together. A poll that loses
  the race just returns immediately rather than queuing — the next call (relay or trigger)
  picks up whatever's still unprocessed via `LAST_UPDATE_ID`, so nothing is lost, only
  delayed by one cycle.
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
- **Last-used account tracking is split by entry type, and Income further by category** —
  `getLastPayment(type, category)`/`setLastPayment(type, category, ...)` in `Ledger.js`.
  Spending (`Expense`/`Transfer`) is one flat bucket regardless of category - that
  pattern is coarser in practice (mostly the same one or two accounts), and splitting it
  would just mean more one-off corrections before each category "warms up." Income is
  split per category (`'Income:Salary'`, `'Income:Trading/IPO'`, ...), because unlike
  spending, a single person's income categories routinely land on *different* accounts
  on a stable schedule (salary always to one account, market gains to another) - a flat
  bucket would have those alternate and clobber each other's default every time. This
  started as one bug fix (a salary deposit silently inherited whatever account was last
  *spent* from, inflating that account's budget by the full salary amount with no visible
  error) and was refined into category-aware buckets once the real usage pattern became
  clear. Each entry in a multi-leg message must look up its own type+category bucket
  (`parseMessageEntries_`) rather than one shared `last` for the whole batch.
- **`applyDefaults` never guesses an Income account with zero signal** — the final
  `accounts[0]` fallback in `Parser.js` only applies to non-Income entries. An Income
  entry with no named account, no matched app, and no prior Income account on record
  gets `account: ''`, which the confirmation message shows as `Into: —` rather than a
  specific (and possibly wrong) account. This is deliberate: a wrong *expense* account is
  low-stakes and gets noticed; a wrong *income* account silently misattributes real money
  into the wrong budget, which is the bug above. Don't "fix" the blank by reintroducing a
  fallback here.
- Entries save immediately on parse now (no more tap-to-confirm) — see `handleMessage_`
  in `Main.js`. Corrections happen after the fact via `updateEntryField`/`deleteEntryById_`
  in `Ledger.js`, both of which look up the row **by ID** (`findRowById_`, a single
  column-A scan), never by row position. Don't optimize this into "remember the row
  index" — a message can append more than one row, and other rows can be deleted in
  between, so position drifts but the ID doesn't.
- Budgets are **pure transaction-matching**, not an assumed monthly allowance —
  `computeBudgetBalance` in `Parser.js` sums every real logged amount that matches a
  budget (`matchesBudget_`), full stop. A budget reads **₹0 until its funding is actually
  logged**, not its `MonthlyTarget` — that target is reference-only (shown next to the
  live balance so the user can compare what *should* move against what *has*). This was
  a deliberate reversal of an earlier accrual design (`monthlyTarget * monthsElapsed -
  spend`, which assumed the full target was available from day 1): the user explicitly
  rejected that once he saw it produce numbers that didn't match reality (a budget
  showing its full target before he'd actually transferred anything). If you're tempted
  to reintroduce an assumed-target formula, don't — it was tried and explicitly undone.
- **Credits need a sign exception.** A `Transfer` row is normally always a debit (stored
  negative — money left the named `Account`). The one exception: a category ending in
  `" Allocation"` (e.g. `"Daily Allocation"`) is **money arriving** in that budget's
  account, stored positive (`isAllocationCategory`, checked in both `appendEntry` and
  `updateEntryField` in `Ledger.js`). The category name is always `<budget.name>
  Allocation` by convention (`allocationCategoryFor_`) — no separate column links a
  budget to its funding category. These rows are auto-created in the Categories tab by
  `ensureAllocationCategories_` (`Setup.js`) from whatever budgets exist; don't hand-list
  them anywhere else, or they'll drift out of sync with the Budgets tab. `Income` rows
  are always credits too, with no category restriction — that's how a budget like Zaggle
  gets funded (via its existing `Income` category) without needing an Allocation category
  of its own.
- **Two distinct readings, same formula, different `startDate`** (`Ledger.js`):
  - `getBudgetBalances()` — the real **balance**, every matching transaction since
    `BUDGET_START_DATE` (Script Property, set once by `setupBudgetsSheet_`, never reset
    by a later run — that would exclude everything logged before the new date). Shown via
    `/budget`/`/balance`, and the Dashboard's `BUDGETBALANCE()` cells.
  - `getMonthlySpendingPowers()` — **spending power**, the same formula from the 1st of
    *this* month only, ignoring anything from before. This is what the auto-shown line
    after a save, and `/month`, use for `Public` budgets — safe to glance at, and scoped
    to what's actually happened this month. Don't collapse these into one reading.
- Two budgets can share one physical `Account` (e.g. Travel and Gifting both funded from
  one card) via the `Categories` filter on the *debit* side — each uses its own `<name>
  Allocation` category on the *credit* side, so one never accidentally funds or debits
  the other. They're still computed **fully independently**; one going negative never
  reduces or caps the other (confirmed with the user via a concrete worked trip example
  in the plan file — still valid under this formula, just without an assumed target).
- `findMatchingBudgets(entry, budgets)` answers "which budget(s) does this entry affect"
  by reusing `matchesBudget_` directly on a parsed entry (not a saved ledger row — same
  shape, just not yet dated/appended). It's shown in the save confirmation (`budgetLine_`
  in `Main.js`) so that's visible at the moment of logging, not just something to work
  out later from Account + Category. Deliberately excludes residual budgets, same reason
  as `computeBudgetBalance` doesn't run `matchesBudget_` for them — they don't use that
  rule at all, so a "match" would be fabricated, not just unhelpful.
- **`BUDGETBALANCE()`/`SPENDINGPOWER()` must always be called with the `Ledger!A2:L`
  second argument** (`writeBudgetsTable_` in `Setup.js`) — this was a real, confirmed bug:
  without a cell reference in the formula, Sheets' dependency graph has nothing to watch,
  so a manual Ledger edit (e.g. correcting a mis-logged row) silently leaves these cells
  showing a stale cached value, not the corrected one. The second argument is never read
  by either function — its only job is making Sheets recalculate when the Ledger changes.
  If you add another custom function that reads the Ledger via `SpreadsheetApp` rather
  than through its own arguments, it needs the same treatment.
- **Both parsing paths need to know the account→budget mapping, not just the category
  names.** This was a real confirmed bug: the Gemini prompt originally explained what an
  `" Allocation"` category *means* but never said *which account* each one is tied to, so
  Gemini had no way to connect "money to [the Daily account]" with "Daily Allocation" and fell back to
  the generic `"Own Account Transfer"`. `buildParsePrompt_` (`Gemini.js`) now takes
  `budgets` and spells out the exact category→account mapping explicitly. The regex
  fallback has its own, smaller version of the same fix:
  `upgradeToAllocationCategory_` (`Parser.js`) upgrades a `parseEntry` result from the
  generic `"Own Account Transfer"` to a budget's own `"<name> Allocation"` category when
  the message named that budget's exact funding account — but only from that one generic
  category, never from a more specific match (`Credit Card Bill`, `SIP / Investment`,
  etc.), since those mean something deliberately different even when the account happens
  to coincide. Both `parseEntry` and `parseEntryLLM_`/`buildParsePrompt_` now take an
  optional `budgets` argument for this — if you add a third entry point for parsing a
  message, it needs `budgets` passed through too, or it'll regress to the original bug.

## Testing

`npm test` runs `test/parser.test.js`. There is no test harness for the Apps Script side;
changes to `Main.js` / `Ledger.js` / `Telegram.js` / `Setup.js` need a real push + manual
Telegram round-trip to verify (see README's Verification section in the plan file).
