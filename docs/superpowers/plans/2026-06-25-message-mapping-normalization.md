# Message Mapping Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute tasks sequentially. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add `source_instances` table + `instance_fk` on messages so every message has a reliable FK back to its source row, then merge forum+deals+reddit into a single WebScraper, add 4 new scraper types (RSS, Email, JSON API, Webhook), and fix query paths to use FK joins.

**Architecture:** Single `source_instances` lookup table referenced by `messages.instance_fk`. All scrapers call `ensureSourceInstance()` once per source per cycle and pass the returned instance ID with every message. Denormalized columns (`group_name`, `group_id`, `source_type`, `chat_type`) stay on messages for backward compatibility.

**Tech Stack:** SQLite (better-sqlite3), Node.js, Puppeteer, cheerio, gramjs, Baileys, imapflow

**Global Constraints:**
- Database is SQLite at `/app/data/messages.db`
- All scraper source data comes from `sources` DB table
- No historical backfill — new messages only get `instance_fk`
- Denormalized columns on `messages` stay — do NOT drop them
- All scrapers call `ensureSourceInstance()` once per source per cycle (not per-message)
- All scrapers call `upsertScraperHealth()` per source per cycle

---

### Task 1: Data model — source_instances table + instance_fk + ensureSourceInstance

**Files:**
- Modify: `apps/api/src/database.js`

**Interfaces:**
- Produces: `ensureSourceInstance(sourceFk, instanceType, groupId, groupName, chatType)` → returns `instanceId`

- [ ] **Migration in `_initSchema()`**: Add `source_instances` table creation

`database.js:31` — inside `_initSchema()`, after the `cookies_store` table block, add:

```js
CREATE TABLE IF NOT EXISTS source_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_fk INTEGER NOT NULL REFERENCES sources(id) ON DELETE SET NULL,
  instance_type TEXT NOT NULL,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  chat_type TEXT DEFAULT 'group',
  UNIQUE(source_fk, group_id)
);
```

- [ ] **Migration in `_initSchema()`**: Add `instance_fk` column to `messages`

After the source_instances table, add:

```js
try {
  this.db.exec(`ALTER TABLE messages ADD COLUMN instance_fk INTEGER REFERENCES source_instances(id) ON DELETE SET NULL`);
  logger.info('📊 Migrated: added instance_fk column to messages');
} catch (e) { /* already exists */ }
```

- [ ] **Add `ensureSourceInstance` method** before `getAllSources()`:

```js
ensureSourceInstance(sourceFk, instanceType, groupId, groupName, chatType) {
  // UPSERT: insert or ignore, then get the id
  this.statements.ensureSourceInstance.run(sourceFk, instanceType, groupId, groupName, chatType);
  const row = this.db.prepare(
    `SELECT id FROM source_instances WHERE source_fk = ? AND group_id = ?`
  ).get(sourceFk, groupId);
  return row ? row.id : null;
}
```

- [ ] **Add compiled statement** in `_compileStatements()`:

```js
ensureSourceInstance: this.db.prepare(`
  INSERT OR IGNORE INTO source_instances (source_fk, instance_type, group_id, group_name, chat_type)
  VALUES (?, ?, ?, ?, ?)
`),
```

- [ ] **Add `updateSourceInstanceName` method** (for when a source is renamed):

```js
updateSourceInstanceName(sourceFk, newName) {
  this.db.prepare(
    `UPDATE source_instances SET group_name = ? WHERE source_fk = ?`
  ).run(newName, sourceFk);
}
```

- [ ] **Update `insertMessage`** to accept `instance_fk || instanceFk`:

```js
insertMessage(data) {
  const result = this.statements.insertMessage.run(
    data.message_id || data.messageId || null,
    data.group_id || data.groupId || null,
    data.group_name || data.groupName || null,
    data.chat_type || data.chatType || 'group',
    data.sender_name || data.senderName || 'Unknown',
    data.sender_id || data.senderNumber || null,
    data.body || null,
    data.timestamp || null,
    data.source_type || data.sourceType || null,
    (data.is_reply ?? data.isReply) ? 1 : 0,
    data.reply_to || data.replyTo || null,
    data.media_type || data.mediaType || null,
    data.url || null
  );
  // NEW: if instance_fk is provided, set it on the inserted message
  const instanceFk = data.instance_fk || data.instanceFk;
  if (instanceFk && result.lastInsertRowid) {
    this.db.prepare('UPDATE messages SET instance_fk = ? WHERE id = ?').run(instanceFk, result.lastInsertRowid);
  }
  return result.changes > 0;
}
```

(Not changing the prepared statement binding to avoid reordering all params — just do a post-insert UPDATE if instance_fk is provided.)

- [ ] **Run test** — start the server and confirm the tables exist:

```bash
cd /tmp/bac && node -e "
const DatabaseManager = require('./apps/api/src/database');
const db = new DatabaseManager('/tmp/test_mapping.db');
const info = db.db.prepare(\"PRAGMA table_info(source_instances)\").all();
console.log('source_instances columns:', info.map(c => c.name).join(', '));
const msgCols = db.db.prepare(\"PRAGMA table_info(messages)\").all();
console.log('messages has instance_fk:', msgCols.some(c => c.name === 'instance_fk'));
db.close();
require('fs').unlinkSync('/tmp/test_mapping.db');
console.log('PASS');
"
```

---

### Task 2: Thread instanceFk through WhatsApp listener

**Files:**
- Modify: `apps/api/src/whatsapp.js`

**Interfaces:**
- Consumes: `database.ensureSourceInstance(sourceFk, instanceType, groupId, groupName, chatType)` from Task 1

- [ ] **In `_processIncomingMessage()`**, after determining `matchingSource` (line 305-307), call `ensureSourceInstance` and include `instanceFk` in the message data:

Around line 308, replace the existing `messageData.sourceType = ...` assignment and `saveMessage` call with:

```js
const matchingSource = this.database.getAllSources().find(
  s => s.source_id.trim().toLowerCase() === remoteJid && s.is_active === 1
);
messageData.sourceType = matchingSource ? matchingSource.type : 'cc-whatsapp';

// NEW: get or create source_instance and add FK
if (matchingSource) {
  const instanceId = this.database.ensureSourceInstance(
    matchingSource.id,
    matchingSource.type,
    remoteJid,
    chatName,
    isChannel ? 'channel' : 'group'
  );
  messageData.instanceFk = instanceId;
}

this.database.saveMessage(messageData);
```

---

### Task 3: Thread instanceFk + health reporting through Telegram user listener

**Files:**
- Modify: `apps/api/src/telegram-user.js`

**Interfaces:**
- Consumes: `database.ensureSourceInstance(...)` from Task 1, `database.upsertScraperHealth(...)` (existing)

- [ ] **In `_attachListener()`** event handler (around line 198-214), after `matchedSource` is found and before building `messageData`, add `ensureSourceInstance` + `instanceFk`:

```js
if (!matchedSource) return;

// NEW: determine chat type
const chatTypeName = chat.className === 'Channel' ? (chat.megagroup ? 'forum' : 'channel') : 'group';

// NEW: get or create source_instance
const instanceId = this.database.ensureSourceInstance(
  matchedSource.id,
  matchedSource.type,
  chatId,
  chatTitle,
  chatTypeName
);

const messageData = {
  message_id: `tguser-${chatId}-${msg.id}`,
  group_id: chatId,
  group_name: chatTitle,
  chat_type: chatTypeName,
  sender_name: senderName,
  sender_id: senderId,
  body: bodyText,
  timestamp: msg.date,
  source_type: matchedSource.type,
  is_reply: msg.replyTo ? 1 : 0,
  reply_to: msg.replyTo ? String(msg.replyTo.replyToMsgId) : null,
  media_type: msg.media ? msg.media.className : null,
  url: null,
  instanceFk: instanceId,  // NEW
};
```

- [ ] **Add health reporting on connect** in `start()` method (around line 74):

```js
if (isAuthorized) {
  logger.info('✅ Telegram User client authorized. Attaching message listener...');
  // NEW: report health for all active telegram sources
  const tgSources = this.database.getAllSources().filter(
    s => s.is_active === 1 && s.type.includes('telegram')
  );
  for (const src of tgSources) {
    this.database.upsertScraperHealth(src.source_id, src.type, true, null);
  }
  await this._attachListener();
  this.isListening = true;
  return true;
} else {
  // NEW: report failure for telegram sources
  const tgSources = this.database.getAllSources().filter(
    s => s.is_active === 1 && s.type.includes('telegram')
  );
  for (const src of tgSources) {
    this.database.upsertScraperHealth(src.source_id, src.type, false, 'Not authorized');
  }
  logger.warn('⚠️ Telegram User client NOT authorized. Dashboard login required.');
  return false;
}
```

---

### Task 4: Thread instanceFk through YouTube scraper

**Files:**
- Modify: `apps/api/src/scrapers/youtube-scraper.js`

- [ ] **In `scrapeChannel()`**, around line 148 (the `saveMessage` call), add `ensureSourceInstance` and include `instanceFk`:

```js
// Before the loop or at the top of scrapeChannel after resolving channelId:
const instanceId = this.database.ensureSourceInstance(
  source.id,
  source.type,
  `yt_channel_${channelId}`,
  source.name,
  'channel'
);

// Then in the saveMessage block (around line 148):
this.database.saveMessage({
  messageId: dbId,
  groupName: source.name,
  groupId: `yt_channel_${channelId}`,
  chatType: 'channel',
  senderName: source.name,
  senderNumber: '',
  body: `🎥 <b>YouTube Video Summary</b>\n📌 <b>Title:</b> ${video.title}\n📅 <b>Published:</b> ${video.published.toISOString().split('T')[0]}\n\n${summary}\n\n🔗 <b>Watch:</b> https://youtu.be/${video.id}`,
  timestamp: Math.floor(Date.now() / 1000),
  hasMedia: false,
  mediaCaption: '',
  isForwarded: false,
  sourceType: source.type,
  instanceFk: instanceId,  // NEW
});
```

Best to call `ensureSourceInstance` once after resolving the channel ID (before the video loop) and use the same `instanceId` for all videos from that channel.

---

### Task 5: Create WebScraper (merges forum + deals + reddit)

**Files:**
- Create: `apps/api/src/scrapers/web-scraper.js`
- Delete: `apps/api/src/scrapers/forum-scraper.js`
- Delete: `apps/api/src/scrapers/deals-scraper.js`
- Delete: `apps/api/src/scrapers/reddit-scraper.js`

**Interfaces:**
- Consumes: `database.ensureSourceInstance(...)`, `database.upsertScraperHealth(...)`, `browserManager`, `database.getCookies(site)`, `database.saveCookies(site, arr)`
- Produces: `WebScraper` class with `start()`, `stop()`, `scrape()` methods

The WebScraper combines all three into one class. It loads all sources where `type LIKE '%-web'`, then for each source, selects the scraping strategy based on URL pattern and `source_id`:

```js
class WebScraper {
  constructor(database, onAlert) {
    this.database = database;
    this.onAlert = onAlert;
    this.checkInterval = 15 * 60 * 1000; // 15 min default
    this.intervalId = null;
    // Site-specific config
    this.siteConfig = {
      technofino:  { alertThreshold: 2, cookiesSite: 'technofino', checkInterval: 45 * 60 * 1000 },
      desidime:    { alertThreshold: 3, cookiesSite: 'desidime', checkInterval: 15 * 60 * 1000 },
      reddit:      { alertThreshold: 3, cookiesSite: 'reddit', checkInterval: 15 * 60 * 1000 },
    };
    this.consecutiveFailures = {};
    this.isSessionAlerted = {};
  }

  async start() {
    // Determine interval from config or use default
    await this.scrape();
    this.intervalId = setInterval(() => this.scrape(), this.checkInterval);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async scrape() {
    const allSources = this.database.getAllSources();
    const targets = allSources.filter(
      s => s.is_active && s.type.endsWith('-web') && s.url
    );
    if (targets.length === 0) {
      logger.warn('⚠️ No active web sources with URLs found in database.');
      return;
    }

    let page = null;
    try {
      page = await browserManager.newPage();

      for (const target of targets) {
        const siteKey = this._getSiteKey(target.source_id);
        const config = this.siteConfig[siteKey] || { alertThreshold: 3, cookiesSite: siteKey };

        // Inject cookies if available
        await this._injectCookies(page, config.cookiesSite);

        // Determine strategy
        if (siteKey === 'reddit') {
          await this._scrapeReddit(target, page);
        } else {
          await this._scrapeGeneric(target, page);
        }

        // Sync cookies back
        const currentCookies = await page.cookies();
        this._saveUpdatedCookies(currentCookies, config.cookiesSite);

        const delay = Math.floor(Math.random() * 4000) + 3000;
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (err) {
      logger.error(`WebScraper scrape run failed: ${err.message}`);
    } finally {
      if (page) {
        try { await page.close(); } catch (e) { /* ignore */ }
      }
    }
  }

  _getSiteKey(sourceId) {
    const id = sourceId.toLowerCase();
    if (id.includes('technofino')) return 'technofino';
    if (id.includes('desidime')) return 'desidime';
    if (id.includes('reddit')) return 'reddit';
    return id;
  }

  async _injectCookies(page, site) {
    const cookiesArray = this.database.getCookies(site);
    if (cookiesArray && Array.isArray(cookiesArray) && cookiesArray.length > 0) {
      const sanitized = cookiesArray.map(c => ({
        name: c.name, value: c.value,
        domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
        path: c.path || '/'
      }));
      await page.setCookie(...sanitized);
    }
  }

  _saveUpdatedCookies(newCookies, site) {
    if (!newCookies || !Array.isArray(newCookies)) return;
    try {
      const originalCookies = this.database.getCookies(site) || [];
      const mergedMap = {};
      originalCookies.forEach(c => { mergedMap[c.name] = c; });
      newCookies.forEach(c => {
        if (!c.value && mergedMap[c.name]) return;
        mergedMap[c.name] = c;
      });
      this.database.saveCookies(site, Object.values(mergedMap));
    } catch (e) { /* ignore */ }
  }

  async _scrapeGeneric(target, page) {
    // Original forum+deals scraping logic (Puppeteer + cheerio + RSS fallback)
    // Check if target looks like a forum (XenForo) or deals site
    // Use appropriate selectors
    // ... (forum DOM parsing from forum-scraper.js)
    // ... (deals DOM parsing from deals-scraper.js)
    // ... (RSS fallback)
    // Call ensureSourceInstance
    // Save messages with instanceFk
    // Call upsertScraperHealth
  }

  async _scrapeReddit(target, page) {
    // Original Reddit 3-layer logic (JSON API → Puppeteer → RSS)
    // But using the WebScraper's page/browser
    // Call ensureSourceInstance
    // Save messages with instanceFk
    // Call upsertScraperHealth
  }
}
```

(The actual method bodies will be extracted from the existing forum-scraper.js, deals-scraper.js, and reddit-scraper.js files — keeping all the DOM parsing, RSS fallback, and session alert logic identical.)

---

### Task 6: Register WebScraper in index.js + remove old scrapers

**Files:**
- Modify: `apps/api/src/index.js`
- Delete: `apps/api/src/scrapers/forum-scraper.js`
- Delete: `apps/api/src/scrapers/deals-scraper.js`
- Delete: `apps/api/src/scrapers/reddit-scraper.js`

- [ ] **Replace scrapers import** in `index.js`:

Remove:
```js
const ForumScraper = require('./scrapers/forum-scraper');
const DealsScraper = require('./scrapers/deals-scraper');
const RedditScraper = require('./scrapers/reddit-scraper');
```

Add:
```js
const WebScraper = require('./scrapers/web-scraper');
```

- [ ] **Replace scraper instantiation** (around lines 999-1001):

Remove:
```js
const forumScraper = new ForumScraper(database, sendSystemAlert);
const dealsScraper = new DealsScraper(database, sendSystemAlert);
const redditScraper = new RedditScraper(database, sendSystemAlert);
```

Add:
```js
const webScraper = new WebScraper(database, sendSystemAlert);
```

- [ ] **Update scrapers map** (around line 1004-1009):

Replace:
```js
const scrapers = {
  reddit: redditScraper,
  technofino: forumScraper,
  desidime: dealsScraper,
  youtube: youtubeScraper,
};
```

With:
```js
const scrapers = {
  web: webScraper,
  youtube: youtubeScraper,
};
```

- [ ] **Update scraper startup** — replace individual `start()` calls with:
```js
webScraper.start();
youtubeScraper.start();
```

---

### Task 7: RSS Scraper

**Files:**
- Create: `apps/api/src/scrapers/rss-scraper.js`
- Modify: `apps/api/src/index.js` (registration)

- [ ] **Create `rss-scraper.js`**:

```js
const axios = require('axios');
const logger = require('../logger');

class RssScraper {
  constructor(database) {
    this.database = database;
    this.checkInterval = 30 * 60 * 1000; // 30 minutes
    this.intervalId = null;
  }

  start() {
    logger.info('📡 RSS/Atom scraper initialized (checks feeds every 30 min)...');
    this.scrapeAll();
    this.intervalId = setInterval(() => this.scrapeAll(), this.checkInterval);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async scrapeAll() {
    const sources = this.database.getAllSources()
      .filter(s => s.is_active && (s.type === 'cc-rss' || s.type === 'deals-rss') && s.url);

    for (const source of sources) {
      await this._scrapeFeed(source);
    }
  }

  async _scrapeFeed(source) {
    try {
      const res = await axios.get(source.url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BriefingAgent/1.0)' }
      });
      const xml = res.data;
      const items = this._parseFeed(xml);
      if (items.length === 0) {
        logger.info(`ℹ️ No items in feed: ${source.name}`);
        this.database.upsertScraperHealth(source.source_id, source.type, true, null);
        return;
      }

      const instanceId = this.database.ensureSourceInstance(
        source.id, source.type, source.source_id, source.name, 'channel'
      );

      let saved = 0;
      for (const item of items.slice(0, 10)) {
        const guid = item.guid || item.link || `rss-${item.title}-${item.date}`;
        const messageId = `rss_${Buffer.from(guid).toString('base64').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 60)}`;

        // Skip existing
        const exists = this.database.db.prepare('SELECT 1 FROM messages WHERE message_id = ?').get(messageId);
        if (exists) continue;

        this.database.saveMessage({
          messageId,
          groupName: source.name,
          groupId: source.source_id,
          chatType: 'channel',
          senderName: source.name,
          body: `${item.title}\n\n${item.summary || ''}\n🔗 ${item.link}`,
          timestamp: item.date ? Math.floor(new Date(item.date).getTime() / 1000) : Math.floor(Date.now() / 1000),
          sourceType: source.type,
          instanceFk: instanceId,
        });
        saved++;
      }

      logger.info(`✅ RSS: ${source.name} — saved ${saved} new items`);
      this.database.upsertScraperHealth(source.source_id, source.type, true, null);
    } catch (err) {
      logger.error(`RSS feed error for ${source.name}: ${err.message}`);
      this.database.upsertScraperHealth(source.source_id, source.type, false, err.message);
    }
  }

  _parseFeed(xml) {
    // Try RSS 2.0
    const rssItems = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      rssItems.push(this._extractRssItem(match[1]));
    }
    if (rssItems.length > 0) return rssItems;

    // Try Atom
    const atomItems = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    while ((match = entryRegex.exec(xml)) !== null) {
      atomItems.push(this._extractAtomItem(match[1]));
    }
    return atomItems;
  }

  _extractRssItem(entry) {
    const get = (tag) => {
      const m = entry.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`));
      return m ? m[1].trim() : '';
    };
    return {
      title: get('title'),
      link: get('link'),
      summary: get('description'),
      guid: get('guid'),
      date: get('pubDate'),
    };
  }

  _extractAtomItem(entry) {
    const get = (tag) => {
      const m = entry.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`));
      return m ? m[1].trim() : '';
    };
    const linkMatch = entry.match(/<link[^>]*href="([^"]+)"/);
    return {
      title: get('title'),
      link: linkMatch ? linkMatch[1] : '',
      summary: get('summary') || get('content'),
      guid: get('id'),
      date: get('published') || get('updated'),
    };
  }
}

module.exports = RssScraper;
```

- [ ] **Register in `index.js`** — import and instantiate:

```js
const RssScraper = require('./scrapers/rss-scraper');
// ...
const rssScraper = new RssScraper(database);
// ...
scrapers.rss = rssScraper;
rssScraper.start();
```

---

### Task 8: Email Scraper (IMAP)

**Files:**
- Modify: `apps/api/package.json` (add `imapflow` dependency)
- Create: `apps/api/src/scrapers/email-scraper.js`
- Modify: `apps/api/src/index.js` (registration)

- [ ] **Install imapflow**:

```bash
cd /tmp/bac/apps/api && npm install imapflow
```

- [ ] **Create `email-scraper.js`**:

```js
const { ImapFlow } = require('imapflow');
const logger = require('../logger');

class EmailScraper {
  constructor(database) {
    this.database = database;
    this.checkInterval = 15 * 60 * 1000; // 15 minutes
    this.intervalId = null;
    this.client = null;
  }

  start() {
    logger.info('📧 Email scraper initialized (checks inbox every 15 min)...');
    this.scrapeAll();
    this.intervalId = setInterval(() => this.scrapeAll(), this.checkInterval);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.client) {
      this.client.close();
    }
  }

  async scrapeAll() {
    const sources = this.database.getAllSources()
      .filter(s => s.is_active && (s.type === 'cc-email' || s.type === 'deals-email') && s.url);

    if (sources.length === 0) return;

    // IMAP connection is per-scrape-run (reuse for all email sources if same host)
    for (const source of sources) {
      await this._scrapeMailbox(source);
    }
  }

  async _scrapeMailbox(source) {
    // source.url holds the IMAP connection string or mailbox identifier
    // source.source_id holds the mailbox name
    try {
      const imapHost = process.env.IMAP_HOST;
      const imapPort = parseInt(process.env.IMAP_PORT || '993', 10);
      const imapUser = process.env.IMAP_USER;
      const imapPass = process.env.IMAP_PASS;

      if (!imapHost || !imapUser || !imapPass) {
        logger.warn('📧 IMAP credentials not configured (IMAP_HOST, IMAP_USER, IMAP_PASS). Skipping email scraping.');
        return;
      }

      const client = new ImapFlow({
        host: imapHost,
        port: imapPort,
        secure: true,
        auth: { user: imapUser, pass: imapPass },
        logger: false,
      });

      await client.connect();

      const mailbox = await client.mailboxOpen(source.source_id || 'INBOX');
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24h

      const messages = [];
      for await (const msg of client.fetch(`${mailbox.exists - 50}:*`, { envelope: true, source: true })) {
        if (msg.envelope.date < since) continue;
        const subject = msg.envelope.subject || '(No subject)';
        const from = msg.envelope.from?.[0]?.address || 'unknown';
        let body = '';
        try {
          const src = msg.source.toString();
          const bodyMatch = src.match(/<body[^>]*>([\s\S]*)<\/body>/i);
          if (bodyMatch) {
            body = bodyMatch[1].replace(/<[^>]*>/g, '').trim().substring(0, 500);
          } else {
            body = src.replace(/<[^>]*>/g, '').trim().substring(0, 500);
          }
        } catch (e) { /* ignore */ }

        messages.push({
          id: msg.uid,
          subject,
          from,
          body,
          date: msg.envelope.date,
        });
      }

      await client.close();

      if (messages.length === 0) {
        this.database.upsertScraperHealth(source.source_id, source.type, true, null);
        return;
      }

      const instanceId = this.database.ensureSourceInstance(
        source.id, source.type, source.source_id, source.name, 'channel'
      );

      let saved = 0;
      for (const msg of messages) {
        const messageId = `email_${msg.id}`;
        const exists = this.database.db.prepare('SELECT 1 FROM messages WHERE message_id = ?').get(messageId);
        if (exists) continue;

        this.database.saveMessage({
          messageId,
          groupName: source.name,
          groupId: source.source_id,
          chatType: 'channel',
          senderName: msg.from,
          body: `📧 ${msg.subject}\n\n${msg.body}`,
          timestamp: Math.floor(msg.date.getTime() / 1000),
          sourceType: source.type,
          instanceFk: instanceId,
        });
        saved++;
      }

      logger.info(`📧 Email: ${source.name} — saved ${saved} new messages`);
      this.database.upsertScraperHealth(source.source_id, source.type, true, null);
    } catch (err) {
      logger.error(`📧 Email scrape error for ${source.name}: ${err.message}`);
      this.database.upsertScraperHealth(source.source_id, source.type, false, err.message);
    }
  }
}

module.exports = EmailScraper;
```

- [ ] **Register in `index.js`**:

```js
const EmailScraper = require('./scrapers/email-scraper');
// ...
const emailScraper = new EmailScraper(database);
scrapers.email = emailScraper;
emailScraper.start();
```

---

### Task 9: JSON API Scraper

**Files:**
- Create: `apps/api/src/scrapers/api-scraper.js`
- Modify: `apps/api/src/index.js` (registration)

- [ ] **Create `api-scraper.js`**:

```js
const axios = require('axios');
const logger = require('../logger');

class ApiScraper {
  constructor(database) {
    this.database = database;
    this.checkInterval = 15 * 60 * 1000;
    this.intervalId = null;
  }

  start() {
    logger.info('🔌 JSON API scraper initialized (polls endpoints every 15 min)...');
    this.scrapeAll();
    this.intervalId = setInterval(() => this.scrapeAll(), this.checkInterval);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async scrapeAll() {
    const sources = this.database.getAllSources()
      .filter(s => s.is_active && (s.type === 'cc-api' || s.type === 'deals-api') && s.url);

    for (const source of sources) {
      await this._scrapeEndpoint(source);
    }
  }

  async _scrapeEndpoint(source) {
    try {
      const res = await axios.get(source.url, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BriefingAgent/1.0)' }
      });

      const data = res.data;
      if (!data) {
        this.database.upsertScraperHealth(source.source_id, source.type, true, null);
        return;
      }

      // Try to extract items array from common response shapes
      let items = data.items || data.data || data.results || data.posts || data.entries || data;
      if (!Array.isArray(items)) items = [items];

      const instanceId = this.database.ensureSourceInstance(
        source.id, source.type, source.source_id, source.name, 'channel'
      );

      let saved = 0;
      for (const item of items.slice(0, 10)) {
        const title = item.title || item.name || item.headline || '(Untitled)';
        const body = item.body || item.content || item.description || item.text || JSON.stringify(item).substring(0, 500);
        const link = item.link || item.url || item.permalink || source.url;
        const id = item.id || item.guid || Buffer.from(link).toString('base64').substring(0, 20);
        const messageId = `api_${source.source_id}_${id}`.replace(/[^a-zA-Z0-9_]/g, '_');

        const exists = this.database.db.prepare('SELECT 1 FROM messages WHERE message_id = ?').get(messageId);
        if (exists) continue;

        this.database.saveMessage({
          messageId,
          groupName: source.name,
          groupId: source.source_id,
          chatType: 'channel',
          senderName: source.name,
          body: `${title}\n\n${body}\n🔗 ${link}`,
          timestamp: Math.floor(Date.now() / 1000),
          sourceType: source.type,
          instanceFk: instanceId,
        });
        saved++;
      }

      logger.info(`🔌 API: ${source.name} — saved ${saved} new items`);
      this.database.upsertScraperHealth(source.source_id, source.type, true, null);
    } catch (err) {
      logger.error(`🔌 API error for ${source.name}: ${err.message}`);
      this.database.upsertScraperHealth(source.source_id, source.type, false, err.message);
    }
  }
}

module.exports = ApiScraper;
```

- [ ] **Register in `index.js`**:

```js
const ApiScraper = require('./scrapers/api-scraper');
// ...
const apiScraper = new ApiScraper(database);
scrapers.api = apiScraper;
apiScraper.start();
```

---

### Task 10: Webhook Receiver

**Files:**
- Modify: `apps/api/src/index.js` (add routes)

- [ ] **Add webhook POST route** in `index.js` after the cookie routes:

```js
// ─── Webhook Receiver ─────────────────────────────────────────────
app.post('/api/webhook/:sourceId', (req, res) => {
  try {
    const sourceId = req.params.sourceId;
    const source = database.getAllSources().find(
      s => s.source_id === sourceId && s.is_active && s.type.endsWith('-webhook')
    );
    if (!source) {
      return res.status(404).json({ error: 'Webhook source not found or inactive' });
    }

    const payload = req.body;
    if (!payload) {
      return res.status(400).json({ error: 'Empty payload' });
    }

    // HMAC verification if secret is set via env
    const secretKey = process.env[`WEBHOOK_SECRET_${sourceId.toUpperCase()}`];
    if (secretKey) {
      const crypto = require('crypto');
      const signature = req.headers['x-hub-signature-256'] || req.headers['x-signature-256'] || '';
      const computed = crypto.createHmac('sha256', secretKey).update(JSON.stringify(payload)).digest('hex');
      if (!signature.includes(computed)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const instanceId = database.ensureSourceInstance(
      source.id, source.type, source.source_id, source.name, 'channel'
    );

    const title = payload.title || payload.subject || payload.event || 'Webhook Event';
    const body = payload.body || payload.message || payload.text || JSON.stringify(payload).substring(0, 500);
    const messageId = `webhook_${sourceId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    database.saveMessage({
      messageId,
      groupName: source.name,
      groupId: source.source_id,
      chatType: 'channel',
      senderName: source.name,
      body: `🔔 ${title}\n\n${body}`,
      timestamp: Math.floor(Date.now() / 1000),
      sourceType: source.type,
      instanceFk: instanceId,
    });

    database.upsertScraperHealth(source.source_id, source.type, true, null);
    logger.info(`🔔 Webhook: ${source.name} — received event`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Webhook error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
```

---

### Task 11: Update /api/source-stats with JOIN query

**Files:**
- Modify: `apps/api/src/index.js`

- [ ] **Replace the current `/api/source-stats` endpoint** (lines 180-217) with a version that uses `instance_fk`:

```js
app.get('/api/source-stats', (req, res) => {
  try {
    const sources = database.getAllSources();
    const healthMap = {};
    for (const h of database.getScraperHealth()) {
      healthMap[h.source_id] = h;
    }

    // Use instance_fk JOIN instead of source_type::group_name matching
    const todayStart = Math.floor(Date.now() / 1000) - 86400;
    const instanceCounts = database.db.prepare(`
      SELECT si.source_fk, COUNT(m.id) as message_count, 
             SUM(CASE WHEN m.timestamp >= ? THEN 1 ELSE 0 END) as today_count
      FROM source_instances si
      LEFT JOIN messages m ON m.instance_fk = si.id
      GROUP BY si.source_fk
    `).all(todayStart);

    const countMap = {};
    for (const row of instanceCounts) {
      countMap[row.source_fk] = { message_count: row.message_count, today_count: row.today_count };
    }

    const result = sources.map(s => {
      const counts = countMap[s.id] || { message_count: 0, today_count: 0 };
      const health = healthMap[s.source_id] || null;
      return {
        ...s,
        health_status: health
          ? (health.error_count > 3 ? 'error' : health.error_count > 0 ? 'warning' : 'healthy')
          : 'unknown',
        health_last_attempt: health?.last_attempt || null,
        health_last_error: health?.last_error || null,
        message_count: counts.message_count,
        today_count: counts.today_count,
      };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

---

### Task 12: Update /test command with FK lookup

**Files:**
- Modify: `apps/api/src/telegram-bot.js`
- Add: `database.js` — `getLatestMessageBySourceFk()` method

- [ ] **Add method to `database.js`**:

```js
getLatestMessageBySourceFk(sourceFk) {
  return this.db.prepare(`
    SELECT m.body, m.timestamp, m.sender_name, m.group_name
    FROM messages m
    JOIN source_instances si ON si.id = m.instance_fk
    WHERE si.source_fk = ?
    ORDER BY m.timestamp DESC
    LIMIT 1
  `).get(sourceFk);
}
```

- [ ] **Update `/test` command** in `telegram-bot.js` (around line 335-340):

Replace the `getLatestMessageForSource` fuzzy matching with:

```js
const lastMsg = this.database.getLatestMessageBySourceFk(s.id);
```

And remove the `cleanName`/`cleanSourceId` variable computation since it's no longer needed (lines 336-337 can be removed).

---

### Task 13: Remove old scraper files

**Files:**
- Delete: `apps/api/src/scrapers/forum-scraper.js`
- Delete: `apps/api/src/scrapers/deals-scraper.js`
- Delete: `apps/api/src/scrapers/reddit-scraper.js`

- [ ] **Verify nothing imports them anymore** — check `index.js` has no require statements referencing these files.

- [ ] **Delete the files**:

```bash
rm /tmp/bac/apps/api/src/scrapers/forum-scraper.js
rm /tmp/bac/apps/api/src/scrapers/deals-scraper.js
rm /tmp/bac/apps/api/src/scrapers/reddit-scraper.js
```

---

### Task 14: Verify

- [ ] **Start the server** and check for startup errors:

```bash
cd /tmp/bac/apps/api && timeout 15 node -e "
const DatabaseManager = require('./src/database');
const db = new DatabaseManager('/tmp/test_verify.db');
const cols = db.db.prepare('PRAGMA table_info(source_instances)').all();
console.log('source_instances:', cols.map(c => c.name).join(', '));
const msgCols = db.db.prepare('PRAGMA table_info(messages)').all();
console.log('messages has instance_fk:', msgCols.some(c => c.name === 'instance_fk'));

// Test ensureSourceInstance
const db2 = new DatabaseManager('/tmp/test_verify2.db');
const id = db2.ensureSourceInstance(1, 'cc-web', 'test-group', 'Test Source', 'forum');
console.log('instance id:', id);
const id2 = db2.ensureSourceInstance(1, 'cc-web', 'test-group', 'Test Source', 'forum');
console.log('same instance id on repeat call:', id === id2);
db2.close();
require('fs').unlinkSync('/tmp/test_verify.db');
require('fs').unlinkSync('/tmp/test_verify2.db');
console.log('ALL PASS');
" 2>&1
```
