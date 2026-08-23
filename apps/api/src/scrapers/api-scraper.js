const axios = require('axios');
const logger = require('../logger');

class ApiScraper {
  constructor(database, sendSystemAlert) {
    this.database = database;
    this.sendSystemAlert = sendSystemAlert;
    this.checkInterval = 5 * 60 * 1000;
    this.intervalId = null;
  }

  start() {
    logger.info('🔌 JSON API scraper initialized (polls endpoints every 5 min)...');
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
    let sources = [];
    try {
      sources = this.database.getAllSources()
        .filter(s => s.is_active && s.type.endsWith('api') && s.url);
    } catch (err) {
      logger.error(`📡 Failed to load API sources: ${err.message}`);
      return;
    }

    for (const source of sources) {
      await this._scrapeEndpoint(source);
    }
  }

  async _scrapeEndpoint(source) {
    try {
      const instanceFk = this.database.ensureSourceInstance(
        source.id, source.type, source.source_id, source.name, 'api'
      );

      const res = await axios.get(source.url, {
        timeout: 15000,
        headers: { 'Accept': 'application/json' }
      });

      const data = res.data;
      const items = data.result?.data || data.data?.posts || data.items || (Array.isArray(data) ? data : []);

      let saved = 0;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const messageId = item.id || item.messageId || item.uuid || `api:${source.source_id}:${i}`;
        const message = item.title || item.headline || item.text || item.body || item.content || JSON.stringify(item).slice(0, 500);
        const url = item.link || item.url || item.permalink;
        const messageText = url ? `${message}\n${url}` : message;
        // Stable namespaced ID + timestamp so dedupe works and items show up in briefs
        const publishedTs = item.timestamp || item.published_at || item.date || item.created_at
          ? Math.floor(new Date(item.timestamp || item.published_at || item.date || item.created_at).getTime() / 1000)
          : Math.floor(Date.now() / 1000);

        this.database.saveMessage({
          messageId: `api_${source.source_id}_${messageId}`,
          groupName: source.name,
          groupId: source.source_id,
          chatType: 'api',
          sourceType: source.type,
          body: messageText,
          timestamp: Number.isNaN(publishedTs) || !publishedTs ? Math.floor(Date.now() / 1000) : publishedTs,
          senderName: source.name,
          instanceFk
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
