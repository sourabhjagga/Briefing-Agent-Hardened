const axios = require('axios');
const logger = require('../logger');

class RssScraper {
  constructor(database, sendSystemAlert) {
    this.database = database;
    this.sendSystemAlert = sendSystemAlert;
    this.active = false;
    this.interval = null;
    this.consecutiveFailures = {};
    this.isSessionAlerted = false;
  }

  async start() {
    logger.info('📡 RSS/Atom feed scraper initialized (checks feeds every 10 min)...');
    this.active = true;
    await this.scrape();
    this.interval = setInterval(() => this.scrape(), 10 * 60 * 1000);
  }

  stop() {
    this.active = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async scrape() {
    const sources = this.database.getAllSources().filter(s => s.is_active && s.type.endsWith('rss') && s.url);

    for (const source of sources) {
      if (!this.active) break;

      const instanceFk = this.database.ensureSourceInstance(
        source.id, source.type, source.source_id, source.name, 'rss'
      );

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
          continue;
        }

        let saved = 0;
        for (const item of items.slice(0, 10)) {
          const guid = item.guid || item.link || `rss-${item.title}-${item.date}`;
          const messageId = `rss_${Buffer.from(guid).toString('base64').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 60)}`;

          let link = item.link || '';
          if (link && !link.includes('utm_source')) {
            const sep = link.includes('?') ? '&' : '?';
            link += `${sep}utm_source=rss`;
          }

          const summary = item.summary || '';
          this.database.saveMessage({
            messageId,
            groupName: source.name,
            groupId: source.source_id,
            chatType: 'rss',
            senderName: source.name,
            body: item.title + (summary ? `\n\n${summary}` : '') + `\n🔗 ${link}`,
            timestamp: item.date ? Math.floor(new Date(item.date).getTime() / 1000) : Math.floor(Date.now() / 1000),
            sourceType: source.type,
            instanceFk,
            url: link,
          });
          saved++;
        }

        logger.info(`✅ RSS: ${source.name} — saved ${saved} new items`);
        this.database.upsertScraperHealth(source.source_id, source.type, true, null);
        this.consecutiveFailures[source.source_id] = 0;
      } catch (err) {
        logger.error(`RSS feed error for ${source.name}: ${err.message}`);
        this.consecutiveFailures[source.source_id] = (this.consecutiveFailures[source.source_id] || 0) + 1;
        this.database.upsertScraperHealth(source.source_id, source.type, false, err.message);

        if (this.consecutiveFailures[source.source_id] >= 3 && !this.isSessionAlerted && this.sendSystemAlert) {
          this.sendSystemAlert(`⚠️ <b>RSS Feed Failure</b>\n\nFeed "${source.name}" (${source.url}) has failed ${this.consecutiveFailures[source.source_id]} consecutive times.\nError: ${err.message}`);
          this.isSessionAlerted = true;
        }
      }
    }
  }

  _parseFeed(xml) {
    const rssItems = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      rssItems.push(this._extractRssItem(match[1]));
    }
    if (rssItems.length > 0) return rssItems;

    const atomItems = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    while ((match = entryRegex.exec(xml)) !== null) {
      atomItems.push(this._extractAtomItem(match[1]));
    }
    return atomItems;
  }

  _extractRssItem(entry) {
    const get = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
      const m = entry.match(re);
      if (!m) return '';
      let val = m[1].trim();
      if (val.startsWith('<![CDATA[') && val.endsWith(']]>')) {
        val = val.slice(9, -3).trim();
      }
      return val;
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
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
      const m = entry.match(re);
      if (!m) return '';
      let val = m[1].trim();
      if (val.startsWith('<![CDATA[') && val.endsWith(']]>')) {
        val = val.slice(9, -3).trim();
      }
      return val;
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
