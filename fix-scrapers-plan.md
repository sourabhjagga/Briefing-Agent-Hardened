# Plan: Fix DesiDime, Reddit, and TechnoFino Scrapers

## Issue Analysis from Logs

### 1. DesiDime - Returns 0 deals consistently
- **Log evidence**: `"Successfully parsed 0 deals from DesiDime"` every 15 minutes
- **Root cause**: CSS selectors in `_scrapeGeneric` don't match current DesiDime DOM structure
- **Solution**: Update selectors with more robust, modern patterns

### 2. Reddit (Credit Card Subreddit) - 800+ consecutive failures
- **Log evidence**: `"Credit Card Subreddit returned 0 items (consecutive failures: 815)"`
- **Root cause**: All 3 layers failing:
  - Layer 1 (JSON API): Reddit now requires auth for `/new.json` endpoints
  - Layer 2 (Puppeteer + cookies): Selectors outdated, cookies may be expired
  - Layer 3 (RSS2JSON): May be rate-limited or blocked
- **Solution**: 
  - Add Reddit API authentication (OAuth)
  - Update Puppeteer selectors for new Reddit UI (shreddit-post)
  - Add better error logging for each layer

### 3. Technofino - Actually WORKING (misunderstanding in request)
- **Log evidence**: `"Found 24 threads in technofino Super Premium"`, `"Found 26 threads in Technofino CC Payments"`, plus RSS working
- **Status**: No fix needed - working correctly via Puppeteer + RSS fallback

---

## Implementation Plan

### Phase 1: Fix DesiDime Scraper (High Priority)
**File**: `apps/api/src/scrapers/web-scraper.js`

1. Replace `PRIMARY_SELECTOR` with comprehensive selector array
2. Update `titleEl` finder with broader patterns
3. Add debug logging to output body sample when 0 items found
4. Expand fallback link matcher to catch `/coupon/`, `/offer/`, `/deals/` patterns

### Phase 2: Fix Reddit Scraper (High Priority)
**File**: `apps/api/src/scrapers/web-scraper.js`

1. **Layer 1 (JSON API)**: 
   - Add Reddit OAuth support using `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` env vars
   - Or switch to Reddit's public RSS feeds as primary
   
2. **Layer 2 (Puppeteer)**:
   - Update selectors for new Reddit UI (`shreddit-post`, `faceplate-tracker`)
   - Add wait for network idle
   - Better error handling for auth walls

3. **Layer 3 (RSS)**:
   - Use Reddit's native `.rss` feeds instead of rss2json.com
   - Example: `https://www.reddit.com/r/{sub}/new/.rss`

4. **Logging**: Add INFO level logging for each layer attempt/failure (not just DEBUG)

### Phase 3: Add Configuration (Medium Priority)
**Files**: `apps/api/src/scrapers/web-scraper.js` + `.env.example`

1. Add Reddit OAuth credentials to `.env.example`
2. Make subreddit list configurable
3. Add alert threshold configuration per source

---

## Code Changes Required

### DesiDime Selector Updates
```javascript
// Replace single PRIMARY_SELECTOR string with array of modern selectors
const PRIMARY_SELECTORS = [
  'article.deal-card',
  'div.deal-card', 
  'div[class*="deal-card"]',
  'li.post-unit',
  'div.post-unit',
  'article[class*="deal"]',
  'div[class*="deal-item"]',
  'li[class*="deal"]',
  '.deal-item',
  '.post-item',
  '.deal-container',
  '.thread-item',
  '.topic-item',
  '.discussion-item',
  'div[class*="thread"]',
  'div[class*="topic"]',
  'li[class*="post"]',
  'li[class*="topic"]'
];

// Update title finder to use more patterns
const titleEl = row.find(
  'h2 a, h3 a, h4 a, .deal-title a, .post-title a, .thread-title a, .topic-title a, .title a, a.deal-link, a[href*="/deal/"], a[href*="/coupon/"], a[href*="/offer/"]'
).first();
```

### Reddit Layer 1 - Use RSS instead of JSON API
```javascript
// Reddit provides native RSS feeds - no auth needed
async _scrapeViaRSS(sub, sourceType, sourceName, instanceId) {
  const rssUrl = `https://www.reddit.com/r/${sub}/new/.rss`;
  // Parse with cheerio xmlMode
}
```

### Reddit Layer 2 - Updated Puppeteer Selectors
```javascript
// New Reddit UI uses shreddit-post, faceplate-tracker
await page.waitForSelector('shreddit-post, faceplate-tracker, [data-testid="post-container"]', { timeout: 15000 });

$('shreddit-post, faceplate-tracker, [data-testid="post-container"]').each(...)
```

---

## Environment Variables to Add
```bash
# Reddit API (optional - for higher rate limits)
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
REDDIT_USER_AGENT=cc-brief-agent/v1

# DesiDime/TechnoFino cookies (already supported via dashboard)
```

---

## Testing Strategy
1. Deploy to staging/Coolify
2. Check logs for:
   - DesiDime: `"Successfully parsed X deals from DesiDime"` with X > 0
   - Reddit: Layer-specific success logs
   - No more consecutive failure alerts
3. Verify data quality in dashboard `/sources` and `/api/source-stats`

---

## Rollback Plan
If issues arise:
1. Revert `web-scraper.js` to previous commit
2. Redeploy via Coolify (pulls latest Docker image)
3. Monitor for 24 hours
