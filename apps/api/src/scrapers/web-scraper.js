const cheerio = require('cheerio');
const axios = require('axios');
const logger = require('../logger');
const browserManager = require('../browser-manager');

class WebScraper {
  constructor(database, onAlert) {
    this.database = database;
    this.onAlert = onAlert;
    this.checkInterval = 15 * 60 * 1000;
    this.intervalId = null;
    this.siteConfig = {
      technofino:  { alertThreshold: 2, cookiesSite: 'technofino', checkInterval: 45 * 60 * 1000 },
      desidime:    { alertThreshold: 3, cookiesSite: 'desidime', checkInterval: 15 * 60 * 1000 },
      reddit:      { alertThreshold: 3, cookiesSite: 'reddit', checkInterval: 15 * 60 * 1000 },
    };
    this.consecutiveFailures = {};
    this.isSessionAlerted = {};
  }

  async start() {
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
    const targets = allSources.filter(s => {
      if (!s.is_active) return false;
      const isReddit = s.type.endsWith('reddit');
      const isForum = s.type.endsWith('forums');
      if (!isForum && !isReddit) return false;
      if (isForum && !s.url) return false;
      return true;
    });
    if (targets.length === 0) {
      logger.warn('⚠️ No active web sources found in database.');
      return;
    }

    let page = null;
    try {
      page = await browserManager.newPage();

      for (const target of targets) {
        const siteKey = target.type.endsWith('reddit')
          ? 'reddit'
          : this._getSiteKey(target.source_id);
        const config = this.siteConfig[siteKey] || { alertThreshold: 3, cookiesSite: siteKey };

        await this._injectCookies(page, config.cookiesSite);

        if (siteKey === 'reddit') {
          await this._scrapeReddit(target, page);
        } else {
          await this._scrapeGeneric(target, page);
        }

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
        name: c.name,
        value: c.value,
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
      const essentialKeysMap = {
        technofino: ['xf_user', 'xf_session', 'xf_csrf', 'xf_notice_dismiss'],
        desidime: ['dd_auth_token', 'at', '_session_id', '_desidime_session', 'remember_user_token'],
        reddit: ['reddit_session', 'token', 'session_tracker', 'loid', 'edgebucket'],
      };
      const essentialKeys = essentialKeysMap[site] || [];

      const mergedMap = {};
      originalCookies.forEach(c => { mergedMap[c.name] = c; });

      newCookies.forEach(c => {
        if (essentialKeys.includes(c.name) && mergedMap[c.name] && !c.value) {
          return;
        }
        mergedMap[c.name] = c;
      });

      this.database.saveCookies(site, Object.values(mergedMap));
    } catch (e) { /* ignore */ }
  }

  async _scrapeGeneric(target, page) {
    const siteKey = this._getSiteKey(target.source_id);
    const config = this.siteConfig[siteKey] || { alertThreshold: 3, cookiesSite: siteKey };

    if (!this.consecutiveFailures[target.id]) {
      this.consecutiveFailures[target.id] = 0;
    }

    const instanceId = this.database.ensureSourceInstance(
      target.id, target.type, target.source_id, target.name, 'forum'
    );

    try {
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45000 });

      if (siteKey === 'technofino') {
        try {
          await page.waitForSelector('.structItem--thread, .structItem--post', { timeout: 15000 });
        } catch (e) {
          logger.debug(`Timeout waiting for structItem selector on "${target.name}". Processing raw DOM...`);
        }
      } else {
        const PRIMARY_SELECTOR = 'li.post-unit, article.deal-card, .deal-item, .post-card, .thread-item, .topic-item, .discussion-item, div[class*="deal"], div[class*="post"], div[class*="topic"], li[class*="post"], li[class*="topic"]';
        try {
          await page.waitForSelector(`${PRIMARY_SELECTOR}, a[href*="/deals/"]`, { timeout: 15000 });
        } catch (e) {
          logger.debug(`Timeout waiting for primary selector on "${target.name}". Processing current DOM structure...`);
        }
      }

      const html = await page.content();
      const $ = cheerio.load(html);
      const items = [];

      if (siteKey === 'technofino') {
        $('.structItem--thread, .structItem--post').each((i, el) => {
          const row = $(el);
          const titleEl = row.find('.structItem-title a').last();
          const authorEl = row.find('.structItem-startDate a, .username').first();
          const dateEl = row.find('.structItem-startDate time, time[datetime]').first();

          let link = titleEl.attr('href') || '';
          if (link && !link.startsWith('http')) {
            link = 'https://technofino.in' + link;
          }

          const idMatch = link.match(/\.(\d+)\/?$/);
          const uniqueId = idMatch ? idMatch[1] : Math.random().toString(36).slice(2);

          if (titleEl.length > 0) {
            items.push({
              id: `forum_${uniqueId}`,
              title: titleEl.text().trim(),
              author: authorEl.length > 0 ? authorEl.text().trim() : 'Forum User',
              link: link,
              datetime: dateEl.attr('datetime') || null
            });
          }
        });

        if (items.length === 0) {
          logger.warn(`⚠️ Found 0 threads in "${target.name}" via DOM — attempting RSS fallback.`);
          try {
            const rssUrl = target.url.endsWith('/') ? `${target.url}index.rss` : `${target.url}/index.rss`;

            let cookieString = '';
            const cookiesArray = this.database.getCookies(config.cookiesSite);
            if (cookiesArray && Array.isArray(cookiesArray)) {
              cookieString = cookiesArray.map(c => `${c.name}=${c.value}`).join('; ');
            }

            // Retry transient 5xx/network errors (Technofino returns 503 under load).
            let response = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                response = await axios.get(rssUrl, {
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Cookie': cookieString
                  },
                  timeout: 10000
                });
                break;
              } catch (rssRetryErr) {
                const status = rssRetryErr.response?.status;
                if (attempt === 3 || (status && status < 500 && status !== 429)) {
                  throw rssRetryErr;
                }
                logger.warn(`⏳ RSS fetch attempt ${attempt}/3 failed (${status || rssRetryErr.message}), retrying in ${attempt * 2}s...`);
                await new Promise(r => setTimeout(r, attempt * 2000));
              }
            }

            const $rss = cheerio.load(response.data, { xmlMode: true });
            $rss('item').each((i, el) => {
              const item = $rss(el);
              const title = item.children('title').text();
              let link = item.children('link').text();
              const author = item.children('dc\\:creator').text() || 'Forum User';
              const pubDate = item.children('pubDate').text();

              if (link && !link.startsWith('http')) link = 'https://technofino.in' + link;
              const idMatch = link.match(/\.(\d+)\/?$/);
              const uniqueId = idMatch ? idMatch[1] : Math.random().toString(36).slice(2);

              items.push({
                id: `forum_${uniqueId}`,
                title: title.trim(),
                author: author.trim(),
                link: link,
                datetime: pubDate
              });
            });
            logger.info(`✅ RSS Fallback succeeded. Found ${items.length} threads in "${target.name}".`);
          } catch (rssErr) {
            logger.error(`❌ RSS Fallback failed for "${target.name}": ${rssErr.message}`);
          }
        } else {
          logger.info(`✅ Found ${items.length} threads in "${target.name}"`);
        }
      } else {
        // Enhanced DesiDime selectors - updated for current DOM structure
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
        ].join(', ');

        $(PRIMARY_SELECTORS).each((i, el) => {
          if (i >= 25) return;
          const row = $(el);
          // Try multiple title selectors in order of specificity
          const titleEl = row.find(
            'h2 a, h3 a, h4 a, .deal-title a, .post-title a, .thread-title a, .topic-title a, .title a, a.deal-link, a[href*="/deal/"], a[href*="/coupon/"], a[href*="/offer/"]'
          ).first();
          // Description/merchant
          const descEl = row.find(
            '.deal-desc, .deal-description, .post-desc, .post-description, .merchant, .store-name, .deal-store, .post-merchant, .thread-merchant, p.description, p.desc, .content, .excerpt'
          ).first();
          // Price/discount
          const priceEl = row.find(
            '.deal-price, .price, .discount, .deal-discount, .offer-price, .sale-price, .current-price, [class*="price"], [class*="discount"], [class*="offer"]'
          ).first();

          let link = titleEl.attr('href') || '';
          if (link && !link.startsWith('http')) {
            link = 'https://www.desidime.com' + link;
          }

          const titleText = titleEl.text().trim();
          if (titleText.length > 5) {
            items.push({
              title: titleText,
              link: link,
              description: descEl.length > 0 ? descEl.text().trim() : '',
              price: priceEl.length > 0 ? priceEl.text().trim() : ''
            });
          }
        });

        if (items.length === 0) {
          logger.warn(`⚠️ Primary DOM selectors did not match any deals. Using fallback link matcher...`);
          // Debug: log first 500 chars of body for debugging
          const bodySample = $('body').text().trim().substring(0, 500);
          logger.debug(`DesiDime body sample: ${bodySample}`);
          
          const seen = new Set();
          $('a[href*="/deal/"], a[href*="/coupon/"], a[href*="/offer/"], a[href*="/deals/"], a[href*="/forums/"]').each((i, el) => {
            const l = $(el);
            let href = l.attr('href') || '';
            if (href && !href.startsWith('http')) {
              href = 'https://www.desidime.com' + href;
            }
            if (seen.has(href)) return;
            seen.add(href);

            const text = l.text().trim();
            if (text.length > 15) {
              items.push({
                title: text,
                link: href,
                description: '',
                price: ''
              });
            }
          });
        }

        logger.info(`✅ Successfully parsed ${items.length} deals from DesiDime.`);
      }

      if (items.length > 0) {
        this.consecutiveFailures[target.id] = 0;
        this.isSessionAlerted[target.id] = false;
      } else {
        this.consecutiveFailures[target.id] = (this.consecutiveFailures[target.id] || 0) + 1;
        logger.warn(`⚠️ "${target.name}" returned 0 items (consecutive failures: ${this.consecutiveFailures[target.id]}).`);

        if (this.consecutiveFailures[target.id] >= config.alertThreshold && !this.isSessionAlerted[target.id] && this.onAlert) {
          this.onAlert(
            `⚠️ <b>${target.name} Scraper Issue</b>\n\n${target.name} has returned 0 items for ${config.alertThreshold} consecutive scrapes. Your session cookies may have expired. Please login and export fresh cookies.`
          );
          this.isSessionAlerted[target.id] = true;
        }
      }

      for (const item of items) {
        const timestamp = Math.floor(Date.now() / 1000);

        if (siteKey === 'technofino') {
          this.database.saveMessage({
            messageId: item.id,
            groupName: target.name,
            groupId: target.source_id,
            chatType: 'forum',
            senderName: item.author,
            senderNumber: '',
            body: `${item.title}\nSource: ${item.link}`,
            timestamp,
            hasMedia: false,
            mediaCaption: '',
            isForwarded: false,
            sourceType: target.type,
            instanceFk: instanceId
          });
        } else {
          if (!item.title || !item.link) continue;
          const cleanId = item.link.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 100);
          this.database.saveMessage({
            messageId: `desidime_${cleanId}`,
            groupName: target.name,
            groupId: target.source_id,
            chatType: 'forum',
            senderName: 'DesiDime',
            body: `🔥 <b>Deal:</b> ${item.title}\n` +
                  (item.price ? `💰 <b>Price/Discount:</b> ${item.price}\n` : '') +
                  (item.description ? `📝 <b>Details:</b> ${item.description}\n` : '') +
                  `🔗 <a href="${item.link}">View Deal</a>`,
            timestamp,
            hasMedia: false,
            mediaCaption: '',
            isForwarded: false,
            sourceType: target.type,
            instanceFk: instanceId
          });
        }
      }

      this.database.upsertScraperHealth(
        target.source_id, target.type,
        items.length > 0,
        items.length === 0 ? '0 items found' : null
      );
    } catch (err) {
      logger.error(`Failed to scrape target "${target.name}": ${err.message}`);
      this.database.upsertScraperHealth(target.source_id, target.type, false, err.message);
    }
  }

  async _scrapeReddit(target, page) {
    const sub = this._cleanRedditId(target.source_id);
    if (!sub) return;

    const instanceId = this.database.ensureSourceInstance(
      target.id, target.type, `reddit_${sub}`, target.name, 'forum'
    );

    // Layer order: authenticated Puppeteer first (proven reliable, 884 ingests),
    // native RSS as fallback. Reddit's public .rss endpoint is rate-limited/
    // inconsistent for automated clients, so it should not be the primary path.
    let success = await this._scrapeViaCookies(sub, target.type, target.name, page, instanceId);

    if (!success) {
      success = await this._scrapeViaRSS(sub, target.type, target.name, instanceId);
    }

    this.database.upsertScraperHealth(
      target.source_id, target.type,
      success,
      success ? null : 'All Reddit ingestion layers failed'
    );

    if (!success) {
      logger.error(`❌ All Reddit ingestion layers failed for r/${sub}`);
    }
  }

  async _scrapeViaRSS(sub, sourceType, sourceName, instanceId) {
    logger.info(`Reddit Layer 1: Attempting native RSS feed for r/${sub}`);
    try {
      const rssUrl = `https://www.reddit.com/r/${sub}/new/.rss`;
      const res = await axios.get(rssUrl, {
        headers: { 
          'User-Agent': 'Mozilla/5.0 (compatible; cc-brief-agent/1.0; +https://github.com/sourabhjagga/Briefing-Agent-Copy)'
        },
        timeout: 15000
      });

      const xml = res.data;
      const $ = cheerio.load(xml, { xmlMode: true });
      const posts = [];

      $('item').each((i, el) => {
        if (i >= 15) return;
        const item = $(el);
        const title = item.find('title').text().trim();
        const link = item.find('link').text().trim();
        const author = item.find('author').text().trim() || 'Reddit User';
        const pubDate = item.find('pubDate').text().trim();
        const content = item.find('content\\:encoded, encoded, description').first().text().trim();
        
        const idMatch = link.match(/\/comments\/([a-z0-9]+)\//i);
        const id = idMatch ? idMatch[1] : Math.random().toString(36).slice(2);

        if (title) {
          posts.push({
            id,
            title,
            selftext: content.replace(/<[^>]*>/g, '').trim(),
            permalink: link.replace('https://www.reddit.com', ''),
            author
          });
        }
      });

      if (posts.length > 0) {
        await this._saveRedditPosts(posts, sub, sourceType, sourceName, instanceId);
        logger.info(`✅ Reddit Layer 1 (RSS): Ingested ${posts.length} posts from r/${sub}`);
        return true;
      }
      logger.warn(`Reddit Layer 1 (RSS): No posts found for r/${sub}`);
      return false;
    } catch (err) {
      logger.warn(`Reddit Layer 1 (RSS) failed for r/${sub}: ${err.message}`);
      return false;
    }
  }

  async _scrapeViaCookies(sub, sourceType, sourceName, page, instanceId) {
    const cookiesArray = this.database.getCookies('reddit');
    if (!cookiesArray || cookiesArray.length === 0) {
      logger.info('Reddit Layer 2: Skipping - no session cookies configured in dashboard.');
      return false;
    }

    logger.info(`Reddit Layer 2: Attempting authenticated Puppeteer scraper for r/${sub}`);
    try {
      const sanitized = cookiesArray.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
        path: c.path || '/'
      }));
      await page.setCookie(...sanitized);

      const targetUrl = `https://www.reddit.com/r/${sub}/new/`;
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });

      try {
        // New Reddit UI selectors
        await page.waitForSelector('shreddit-post, faceplate-tracker, [data-testid="post-container"]', { timeout: 15000 });
      } catch (e) {
        logger.warn(`Timeout waiting for Reddit selectors on r/${sub}, trying fallback...`);
      }

      const currentCookies = await page.cookies();
      this._saveUpdatedCookies(currentCookies, 'reddit');

      const html = await page.content();
      const $ = cheerio.load(html);
      const posts = [];

      // New Reddit UI: shreddit-post, faceplate-tracker
      $('shreddit-post, faceplate-tracker, [data-testid="post-container"]').each((i, el) => {
        if (i >= 15) return;
        const art = $(el);
        const title = art.attr('post-title') || art.find('h1, h2, h3, a[href*="/comments/"]').first().text().trim();
        const permalink = art.attr('permalink') || art.find('a[href*="/comments/"]').first().attr('href') || '';
        const author = art.attr('author') || 'Reddit User';
        const id = art.attr('id') ? art.attr('id').replace('t3_', '') : Math.random().toString(36).slice(2);
        const text = art.find('[slot="text-body"], .feed-card-text, [data-click-id="text_body"]').first().text().trim();

        if (title) {
          posts.push({
            id,
            title,
            selftext: text,
            permalink,
            author
          });
        }
      });

      // Fallback for old Reddit or if new selectors fail
      if (posts.length === 0) {
        $('article, .Post, [data-testid="post-container"]').each((i, el) => {
          if (i >= 15) return;
          const art = $(el);
          const title = art.find('h3 a, h2 a, .title a').first().text().trim();
          const link = art.find('a[href*="/comments/"]').first().attr('href') || '';
          const author = art.find('[data-click-id="user"], .author').first().text().trim() || 'Reddit User';
          const id = art.attr('id') ? art.attr('id').replace('t3_', '') : Math.random().toString(36).slice(2);
          const text = art.find('[data-click-id="text_body"], .md, .usertext-body').first().text().trim();

          if (title) {
            posts.push({
              id,
              title,
              selftext: text,
              permalink: link,
              author
            });
          }
        });
      }

      if (posts.length > 0) {
        await this._saveRedditPosts(posts, sub, sourceType, sourceName, instanceId);
        logger.info(`✅ Reddit Layer 2 (Puppeteer): Ingested ${posts.length} posts from r/${sub}`);
        return true;
      }
      logger.warn(`Reddit Layer 2 (Puppeteer): No posts extracted from r/${sub}`);
      return false;
    } catch (err) {
      logger.warn(`Reddit Layer 2 (Puppeteer) failed for r/${sub}: ${err.message}`);
      return false;
    }
  }

  async _saveRedditPosts(posts, sub, sourceType, sourceName, instanceId) {
    for (const post of posts) {
      const id = post.id || Math.random().toString(36).slice(2);
      const title = post.title || '';
      const text = post.selftext || post.text || '';
      const author = post.author || 'Reddit User';
      let link = post.permalink || post.url || '';

      if (link && !link.startsWith('http')) {
        link = 'https://www.reddit.com' + link;
      }

      this.database.saveMessage({
        messageId: `reddit_${id}`,
        groupName: `r/${sub}`,
        groupId: `reddit_${sub}`,
        chatType: 'forum',
        senderName: author,
        senderNumber: '',
        body: `${title}\n\n${text}\nSource: ${link}`,
        timestamp: Math.floor(Date.now() / 1000),
        hasMedia: false,
        mediaCaption: '',
        isForwarded: false,
        sourceType: sourceType,
        instanceFk: instanceId
      });
    }
  }

  _cleanRedditId(str) {
    if (!str) return null;
    let clean = str.trim();
    if (clean.includes('reddit.com/r/')) {
      clean = clean.split('reddit.com/r/').pop();
    }
    if (clean.startsWith('r/')) {
      clean = clean.replace('r/', '');
    }
    return clean.split('/')[0].split('?')[0];
  }
}

module.exports = WebScraper;
