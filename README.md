# finance-tracker

Log expenses and income from Telegram; they land as rows in a Google Sheet with a
Dashboard tab. See `/Users/yatharthvaish/.claude/plans/effervescent-twirling-globe.md`
for the design rationale.

- `src/Parser.js` — pure text parsing (`"60 snacks"` → `{type, amount, category, ...}`), unit tested.
- `src/Telegram.js` — Bot API wrapper (send/edit messages, inline keyboards).
- `src/Ledger.js` — reads/writes the `Ledger` and `Categories` sheets.
- `src/Main.js` — `doPost(e)`, the webhook entry point.
- `src/Setup.js` — `setupSpreadsheet()` builds the Ledger/Categories/Dashboard tabs and charts.

## One-time setup

### 1. Create the bot

Message [@BotFather](https://t.me/BotFather) on Telegram, run `/newbot`, and save the token it gives you.

### 2. Enable the Apps Script API and log in with clasp

1. Visit `https://script.google.com/home/usersettings` and turn on the Apps Script API.
2. `npx @google/clasp login` (opens a browser for Google OAuth; only needed once per machine).

### 3. Create the bound Apps Script project + Sheet

`clasp create` refuses to run in a folder that already has an `appsscript.json`, so create it
in a scratch folder first and copy the generated script ID back into this repo:

```bash
mkdir -p /tmp/finance-tracker-clasp-init && cd /tmp/finance-tracker-clasp-init
npx @google/clasp create --type sheets --title "Finance Tracker"
cat .clasp.json   # copy the "scriptId" value
```

Back in this repo, create `.clasp.json` (safe to commit — it only holds the project's
scriptId, no secrets):

```bash
cd ~/code/projects/finance-tracker
cat > .clasp.json <<EOF
{"scriptId":"PASTE_THE_SCRIPT_ID_HERE","rootDir":"src"}
EOF
npx @google/clasp push
```

Open the Sheet (the URL clasp printed in step 3, or find "Finance Tracker" in Google Drive).

### 4. Configure Script Properties and run setup

In the Sheet: **Extensions → Apps Script**, then **Project Settings (gear icon) → Script Properties**, add:

- `BOT_TOKEN` — from BotFather
- `WEBHOOK_SECRET` — any long random string you make up (e.g. `openssl rand -hex 16`)

Back in the code editor, run `setupSpreadsheet` once (Google will ask you to authorize the
script — approve it). This builds the Ledger, Categories, and Dashboard tabs.

### 5. Deploy as a web app

**Deploy → New deployment → type: Web app** → execute as *Me*, who has access: *Anyone*.
Copy the `/exec` URL it gives you.

Add one more Script Property:

- `WEBHOOK_URL` — the `/exec` URL you just copied

Run `setWebhook` from the code editor (or the **Finance Tracker** menu in the Sheet once you reload it).

### 6. Point the bot at your chat

Open a DM with your bot on Telegram and send anything. It replies with your chat ID.
Add a final Script Property:

- `ALLOWED_CHAT_ID` — the number it gave you

From now on, only messages from that chat are accepted.

## Everyday use

```text
60 snacks              → expense, auto-categorized as Food
+50000 salary          → income, categorized as Salary
1.2k rent              → expense, 1200, categorized as Rent
```

Tap a payment button (UPI/Cash/Card/Bank) to save, or **Change category** to override the guess.

Commands: `/today`, `/month`, `/undo`, `/help`.

## Development

```bash
npm test                 # runs test/parser.test.js with node's built-in test runner
npx @google/clasp push   # after editing anything in src/
```

`src/Parser.js` has a Node-compatible `module.exports` guard at the bottom so it can be
unit tested outside Apps Script; the rest of `src/*.js` depends on Apps Script globals
(`SpreadsheetApp`, `UrlFetchApp`, etc.) and can only really be exercised by running the
bot for real.

## Later (not built yet)

A separate Trades sheet for stocks/IPOs, feeding realized gains into the Ledger as income.
See the plan file for the full backlog.
