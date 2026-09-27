/**
 * Optional LLM parsing via the Gemini API (free tier, https://aistudio.google.com/apikey).
 * This is a fallback CHAIN, not a replacement for Parser.js's regex parser: if
 * GEMINI_API_KEY isn't set, or the call fails, or nothing usable comes back,
 * parseEntryLLM_ returns null and the caller (Main.js) falls back to parseEntry().
 * The bot must never go silent just because Gemini is down or unconfigured.
 */

var DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

function getGeminiApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
}

function getGeminiModel_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;
}

var ENTRY_RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      type: { type: 'STRING', enum: ['Expense', 'Income', 'Transfer'] },
      amount: { type: 'NUMBER' },
      category: { type: 'STRING' },
      description: { type: 'STRING' },
      account: { type: 'STRING' },
      forWho: { type: 'STRING' },
      app: { type: 'STRING' }
    },
    required: ['type', 'amount', 'category', 'description']
  }
};

/**
 * One UrlFetchApp call to Gemini's generateContent endpoint, constrained to return JSON
 * matching ENTRY_RESPONSE_SCHEMA directly - no free-text parsing of the model's reply.
 * @returns {{ok:boolean, entries?:Array<object>, error?:string}}
 */
function callGemini_(prompt) {
  var apiKey = getGeminiApiKey_();
  if (!apiKey) return { ok: false, error: 'GEMINI_API_KEY not set' };

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + getGeminiModel_() + ':generateContent?key=' + encodeURIComponent(apiKey);
  var payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: ENTRY_RESPONSE_SCHEMA }
  };

  var response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    return { ok: false, error: 'UrlFetchApp threw: ' + err };
  }

  if (response.getResponseCode() !== 200) {
    return { ok: false, error: 'HTTP ' + response.getResponseCode() + ': ' + response.getContentText() };
  }

  var body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (err) {
    return { ok: false, error: 'Response was not valid JSON: ' + err };
  }

  var text = body && body.candidates && body.candidates[0] && body.candidates[0].content
    && body.candidates[0].content.parts && body.candidates[0].content.parts[0]
    && body.candidates[0].content.parts[0].text;
  if (!text) return { ok: false, error: 'No text in Gemini response: ' + JSON.stringify(body) };

  var entries;
  try {
    entries = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: 'Gemini text was not valid JSON: ' + text };
  }

  return { ok: true, entries: entries };
}

/**
 * Instructions plus the live categories/accounts/people, so Gemini only ever names
 * things that actually exist in this Sheet - it's told to leave a field blank rather
 * than invent a name, since sanitizeLlmEntries() clears (not guesses) anything that
 * doesn't match exactly, and applyDefaults() then fills blanks in sensibly.
 */
function buildParsePrompt_(text, categories, options) {
  var expenseCats = categories.filter(function (c) { return c.type === 'Expense'; }).map(function (c) { return c.category; });
  var incomeCats = categories.filter(function (c) { return c.type === 'Income'; }).map(function (c) { return c.category; });
  var transferCats = categories.filter(function (c) { return c.type === 'Transfer'; }).map(function (c) { return c.category; });

  var accountLines = options.accounts.map(function (a) {
    var methods = a.methods.map(function (m) { return m.label; }).join(', ');
    return '- ' + a.name + (methods ? ' (' + methods + ')' : '');
  }).join('\n');
  var peopleLines = options.people.map(function (p) { return '- ' + p.name; }).join('\n');

  return [
    'You turn one personal-finance chat message into one or more structured ledger entries.',
    'Reply with ONLY a JSON array matching the response schema. One entry per distinct amount of money that moved.',
    '',
    'Type rules:',
    '- Income: money coming in from outside (salary, someone paying the user back for something the user is NOT also logging as spent, wages).',
    '- Expense: the user spending their own money on something for themselves or someone else.',
    '- Transfer: money moving between the user\'s OWN accounts/cards/allowances - credit card bills, SIP/investment contributions, savings moves, and internal conversions. IMPORTANT: if someone else spends from one of the user\'s own accounts/cards (e.g. a partner paying with the user\'s meal card) and then pays the user back into another of the user\'s own accounts, that whole story is TWO Transfer legs (money left one of the user\'s pools, the equivalent value landed in another) - it is not Income and not the user\'s own Expense, because it nets to zero for the user and nobody outside the user gained or lost money.',
    '',
    'Known expense categories: ' + expenseCats.join(', '),
    'Known income categories: ' + incomeCats.join(', '),
    'Known transfer categories: ' + transferCats.join(', '),
    'Use one of these exact category names. If nothing fits well, use "Other" (expense) or "Other Income" (income).',
    '',
    'Known accounts/cards (name and how you can pay from them):',
    accountLines || '(none configured)',
    '',
    'Known people this could be for:',
    peopleLines || '(none configured)',
    '',
    'For "account", "forWho" and "app": use the exact name from the lists above only if the message clearly names it. Otherwise leave that field as an empty string - do not guess or invent a name.',
    '"amount" is always a positive number.',
    '"description" is a short (a few words) plain-English description of that specific leg.',
    '',
    'Message: ' + JSON.stringify(text)
  ].join('\n');
}

/**
 * @returns {Array<object>|null} sanitized entries ready for applyDefaults()/appendEntry(),
 *          or null if Gemini isn't configured, failed, or returned nothing usable -
 *          the caller must fall back to parseEntry() in that case.
 */
function parseEntryLLM_(text, categories, options) {
  if (!getGeminiApiKey_()) return null;

  var result = callGemini_(buildParsePrompt_(text, categories, options));
  if (!result.ok) {
    Logger.log('Gemini parse failed, falling back to regex parser: ' + result.error);
    return null;
  }

  var entries = sanitizeLlmEntries(result.entries, categories, options);
  if (entries.length === 0) {
    Logger.log('Gemini returned no usable entries, falling back to regex parser. Raw: ' + JSON.stringify(result.entries));
    return null;
  }

  entries.forEach(function (e) { e.raw = text; });
  return entries;
}

/**
 * Debug helper: run from the editor to verify GEMINI_API_KEY/GEMINI_MODEL and the
 * response schema work, in isolation, before trusting this inside the live bot flow.
 */
function testGemini() {
  var categories = readCategories();
  var options = readOptions();
  var sample = 'partner paid 357 from the meal card for their food and sent 357 back to me in my bank account';
  var result = callGemini_(buildParsePrompt_(sample, categories, options));
  Logger.log(JSON.stringify(result, null, 2));
  if (result.ok) {
    Logger.log('Sanitized: ' + JSON.stringify(sanitizeLlmEntries(result.entries, categories, options), null, 2));
  }
  return result;
}
