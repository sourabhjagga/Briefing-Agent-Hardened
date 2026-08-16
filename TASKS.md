# Bug Fix Tasks

## CRITICAL
- [x] `database.js` — `insertMessage()` maps both camelCase & snake_case keys
- [x] `summarizer.js` — null-safe `timestamp * 1000` and `sender_name` fallback

## MEDIUM
- [x] `index.js` — wrap `bot.start()` in try-catch, remove `process.exit(1)`
- [x] `index.js` — add `youtubeScraper` to scrapers map
- [x] `index.js` — add `whatsapp._refreshTargets()` after source DELETE
- [x] `database.js` — `addSourceInactive` ON CONFLICT sets `is_active=0`
- [x] `summarizer.js` — anchorRegex supports single quotes & non-first href
- [x] `scheduler.js` — try-catch around Telegram delivery paths

## LOW
- [x] `database.js` — extract `_istDayStart()` helper, eliminate 4x duplication
- [x] `database.js` — `getWhatsAppTargets` uses SQL filter
- [x] `index.js` — remove duplicate `POST /api/cookies/delete`
- [x] `telegram-user.js` — tighten includes() source matching (exact match only)

## Commit
- [x] `c8c66d2` — pushed to `main` on `sourabhjagga/Briefing-Agent-Copy`
