const { ImapFlow } = require('imapflow');
const logger = require('../logger');

class EmailScraper {
  constructor(database, sendSystemAlert) {
    this.database = database;
    this.sendSystemAlert = sendSystemAlert;
    this.checkInterval = 5 * 60 * 1000;
    this.intervalId = null;
    this.maximumPollPerCycle = 10;
  }

  start() {
    logger.info('📧 Email IMAP scraper initialized (polls every 5 min)...');
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
      .filter(s => s.is_active && s.type.endsWith('email') && s.url);

    if (sources.length === 0) {
      logger.debug('📧 No active email sources found.');
      return;
    }

    const host = process.env.EMAIL_IMAP_HOST || 'imap.gmail.com';
    const port = parseInt(process.env.EMAIL_IMAP_PORT || '993', 10);
    const user = process.env.EMAIL_USER;
    const password = process.env.EMAIL_PASSWORD;

    if (!user || !password) {
      logger.warn('📧 IMAP credentials not configured (EMAIL_USER, EMAIL_PASSWORD). Skipping email scraping.');
      return;
    }

    const client = new ImapFlow({
      host,
      port,
      secure: true,
      auth: { user, pass: password },
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        for (const source of sources) {
          await this._scrapeSource(client, source);
        }
      } finally {
        lock.release();
      }

      await client.logout();
    } catch (err) {
      logger.error(`📧 IMAP connection error: ${err.message}`);
    }
  }

  async _scrapeSource(client, source) {
    try {
      const sourceEmail = source.url.trim().toLowerCase();
      if (!sourceEmail) return;

      const searchQuery = `UNSEEN FROM "${sourceEmail}"`;
      const messages = [];

      for await (const msg of client.fetch(searchQuery, { envelope: true, source: true })) {
        const from = msg.envelope.from?.[0]?.address || '';
        if (from.toLowerCase() !== sourceEmail) continue;

        const subject = msg.envelope.subject || '(No subject)';
        let plainText = '';
        try {
          const src = msg.source.toString();
          const textPlainMatch = src.match(/Content-Type:\s*text\/plain[\s\S]*?\n\n([\s\S]*?)(?=\n--|\nContent-|$)/i);
          if (textPlainMatch) {
            plainText = textPlainMatch[1].trim();
          } else {
            plainText = src.replace(/<[^>]*>/g, '').trim();
          }
          if (plainText.length > 2000) {
            plainText = plainText.substring(0, 2000) + '...';
          }
        } catch (e) { /* ignore parse errors */ }

        const messageId = `email:${msg.envelope.messageId || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;

        messages.push({
          uid: msg.uid,
          messageId,
          body: `${subject}\n\n${plainText}`,
        });

        if (messages.length >= this.maximumPollPerCycle) break;
      }

      if (messages.length === 0) {
        this.database.upsertScraperHealth(source.source_id, source.type, true, null);
        return;
      }

      const instanceFk = this.database.ensureSourceInstance(
        source.id, source.type, source.source_id, source.name, 'email'
      );

      let saved = 0;
      const seenUids = [];
      for (const msg of messages) {
        this.database.saveMessage({
          messageId: msg.messageId,
          groupName: source.name,
          groupId: source.source_id,
          chatType: 'email',
          sourceType: source.type,
          body: msg.body,
          senderName: source.name,
          timestamp: Math.floor(Date.now() / 1000),
          instanceFk,
        });
        saved++;
        if (msg.uid) seenUids.push(msg.uid);
      }

      if (seenUids.length > 0) {
        await client.messageFlagsAdd({ uid: seenUids }, ['\\Seen']);
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
