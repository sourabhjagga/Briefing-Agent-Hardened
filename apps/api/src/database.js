/**
 * Database Module
 * High-performance, pre-compiled query layer for storing, retrieving, and searching messages/sources.
 * Includes per-category schedule_rules and scraper_health tables.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

class DatabaseManager {
  // Default fallback ensures the app never crashes if DB_PATH env var is
  // missing or undefined (e.g. Coolify env panel override not configured).
  // Honours DB_PATH so operators can relocate the DB without code changes.
  constructor(dbPath = process.env.DB_PATH || '/app/data/messages.db') {
    const resolvedPath = path.resolve(dbPath);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this._initSchema();
    this._migrateScraperHealth();
    this._migrateDuplicateCategories();
    this._migrateStaleScraperHealth();
    this._compileStatements();
    logger.info(`✅ Database initialized: ${resolvedPath}`);
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE,
        group_id TEXT,
        group_name TEXT,
        chat_type TEXT DEFAULT 'group',
        sender_name TEXT,
        sender_id TEXT,
        body TEXT,
        timestamp INTEGER,
        source_type TEXT,
        is_reply INTEGER DEFAULT 0,
        reply_to TEXT,
        media_type TEXT,
        url TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_source_type ON messages(source_type);
      CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id);

      CREATE TABLE IF NOT EXISTS daily_briefs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brief_date TEXT NOT NULL,
        category_slug TEXT NOT NULL DEFAULT 'cc',
        brief_text TEXT,
        message_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(brief_date, category_slug)
      );

      CREATE TABLE IF NOT EXISTS summary_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        summary_date TEXT,
        message_count INTEGER,
        summary_text TEXT,
        sent_to_telegram INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        source_id TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        bot_token TEXT,
        chat_id TEXT,
        ai_prompt TEXT,
        is_active INTEGER DEFAULT 1,
        delivery_channel TEXT DEFAULT 'telegram',
        whatsapp_delivery_jid TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS schedule_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_slug TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        label TEXT,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- scraper_health: source_id is UNIQUE so ON CONFLICT(source_id) works
      -- in the upsert prepared statement. Existing installs without the
      -- UNIQUE constraint are handled by _migrateScraperHealth() below.
      CREATE TABLE IF NOT EXISTS scraper_health (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL,
        last_success DATETIME,
        last_attempt DATETIME,
        error_count INTEGER DEFAULT 0,
        last_error TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS source_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS cookies_store (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site TEXT UNIQUE NOT NULL,
        cookies_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS source_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_fk INTEGER NOT NULL REFERENCES sources(id) ON DELETE SET NULL,
        instance_type TEXT NOT NULL,
        group_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        chat_type TEXT DEFAULT 'group',
        UNIQUE(source_fk, group_id)
      );
    `);

    // Migrate: add instance_fk column to messages
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN instance_fk INTEGER REFERENCES source_instances(id) ON DELETE SET NULL`);
      logger.info('📊 Migrated: added instance_fk column to messages');
    } catch (e) { /* already exists */ }

    // Migrate: per-category daily briefs (was UNIQUE(brief_date) only — categories clobbered each other)
    try {
      const hasSlug = this.db.prepare(`PRAGMA table_info(daily_briefs)`).all().some(c => c.name === 'category_slug');
      if (!hasSlug) {
        this.db.transaction(() => {
          this.db.exec(`
            ALTER TABLE daily_briefs RENAME TO daily_briefs_old;
            CREATE TABLE daily_briefs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              brief_date TEXT NOT NULL,
              category_slug TEXT NOT NULL DEFAULT 'cc',
              brief_text TEXT,
              message_count INTEGER DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(brief_date, category_slug)
            );
            INSERT INTO daily_briefs (brief_date, category_slug, brief_text, message_count, created_at)
              SELECT brief_date, 'cc', brief_text, message_count, created_at FROM daily_briefs_old;
            DROP TABLE daily_briefs_old;
          `);
        })();
        logger.info('📊 Migrated: daily_briefs now keyed by (brief_date, category_slug)');
      }
    } catch (e) {
      logger.warn(`daily_briefs migration skipped: ${e.message}`);
    }

    // Migrate: add delivery_channel column if not present (for existing installs)
    try {
      this.db.exec(`ALTER TABLE categories ADD COLUMN delivery_channel TEXT DEFAULT 'telegram'`);
      logger.info('📊 Migrated: added delivery_channel column to categories');
    } catch (e) { /* already exists */ }

    // Migrate: add whatsapp_delivery_jid column if not present
    try {
      this.db.exec(`ALTER TABLE categories ADD COLUMN whatsapp_delivery_jid TEXT`);
      logger.info('📊 Migrated: added whatsapp_delivery_jid column to categories');
    } catch (e) { /* already exists */ }

    // Migrate: add category_slug column to sources for category assignment
    try {
      this.db.exec(`ALTER TABLE sources ADD COLUMN category_slug TEXT REFERENCES categories(slug)`);
      logger.info('📊 Migrated: added category_slug column to sources');
    } catch (e) { /* already exists */ }

    // Migrate: add url column to sources for per-target URL storage
    try {
      this.db.exec(`ALTER TABLE sources ADD COLUMN url TEXT`);
      logger.info('📊 Migrated: added url column to sources');
    } catch (e) { /* already exists */ }

    // Migrate: add is_private column to sources for forum auth tracking
    try {
      this.db.exec(`ALTER TABLE sources ADD COLUMN is_private INTEGER DEFAULT 0`);
      logger.info('📊 Migrated: added is_private column to sources');
    } catch (e) { /* already exists */ }

    // Migrate: add last_brief_timestamp column to categories for incremental processing
    try {
      this.db.exec(`ALTER TABLE categories ADD COLUMN last_brief_timestamp INTEGER DEFAULT 0`);
      logger.info('📊 Migrated: added last_brief_timestamp column to categories');
    } catch (e) { /* already exists */ }
  }

  /**
   * Migrate scraper_health to ensure source_id has a UNIQUE constraint.
   *
   * SQLite does not support ALTER TABLE ADD UNIQUE, so the only way to add
   * a UNIQUE constraint to an existing table is to recreate it.
   * This is safe: scraper_health is purely operational/ephemeral health data
   * and losing it on first upgrade has zero impact on message history or briefs.
   */
  _migrateScraperHealth() {
    try {
      const indexes = this.db.prepare(`PRAGMA index_list(scraper_health)`).all();
      const uniqueOnSourceId = indexes.some(idx => {
        if (!idx.unique) return false;
        const cols = this.db.prepare(`PRAGMA index_info(${idx.name})`).all();
        return cols.some(c => c.name === 'source_id');
      });

      if (uniqueOnSourceId) {
        return; // Already migrated or freshly created with UNIQUE — nothing to do.
      }

      logger.info('🔧 Migrating scraper_health: adding UNIQUE constraint on source_id...');

      this.db.exec(`
        ALTER TABLE scraper_health RENAME TO scraper_health_old;

        CREATE TABLE scraper_health (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL UNIQUE,
          source_type TEXT NOT NULL,
          last_success DATETIME,
          last_attempt DATETIME,
          error_count INTEGER DEFAULT 0,
          last_error TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO scraper_health (source_id, source_type, last_success, last_attempt, error_count, last_error, updated_at)
        SELECT source_id, source_type, last_success, last_attempt, error_count, last_error, updated_at
        FROM scraper_health_old
        WHERE id IN (
          SELECT MAX(id) FROM scraper_health_old GROUP BY source_id
        );

        DROP TABLE scraper_health_old;
      `);

      logger.info('✅ scraper_health migration complete.');
    } catch (err) {
      logger.warn(`⚠️ scraper_health migration warning (non-fatal): ${err.message}`);
    }
  }

  /**
   * Merge duplicate "cc-forum" category into "cc-forums".
   * The user may have accidentally created a "cc-forum" slug (typo) alongside
   * the correct "cc-forums" slug. This migrates all sources, schedule rules,
   * AND scraper_health entries from the typo category, then deletes it.
   *
   * Scraper_health has its own copy of source_type, so it MUST be updated
   * separately or the dashboard badges will still show the old slug.
   */
  _migrateDuplicateCategories() {
    try {
      let dirty = false;

      // Step 1: If the typo exists as a category row, merge/rename and drop it.
      const typoCat = this.db.prepare(`SELECT id FROM categories WHERE slug = 'cc-forum'`).get();
      if (typoCat) {
        const correctCat = this.db.prepare(`SELECT id FROM categories WHERE slug = 'cc-forums'`).get();
        if (correctCat) {
          this.db.prepare(`UPDATE sources SET category_slug = 'cc-forums' WHERE category_slug = 'cc-forum'`).run();
          this.db.prepare(`UPDATE schedule_rules SET category_slug = 'cc-forums' WHERE category_slug = 'cc-forum'`).run();
        } else {
          this.db.prepare(`UPDATE categories SET slug = 'cc-forums' WHERE slug = 'cc-forum'`).run();
          this.db.prepare(`UPDATE sources SET category_slug = 'cc-forums' WHERE category_slug = 'cc-forum'`).run();
          this.db.prepare(`UPDATE schedule_rules SET category_slug = 'cc-forums' WHERE category_slug = 'cc-forum'`).run();
        }
        this.db.prepare(`DELETE FROM categories WHERE slug = 'cc-forum'`).run();
        dirty = true;
      }

      // Step 2: Fix sources.type — replace cc-forum- prefix with cc-forums- prefix.
      const fixedSources = this.db.prepare(
        `UPDATE sources SET type = REPLACE(type, 'cc-forum-', 'cc-forums-') WHERE type LIKE 'cc-forum-%'`
      ).run();
      if (fixedSources.changes > 0) {
        logger.info(`🔧 Fixed ${fixedSources.changes} sources.type entries: cc-forum- → cc-forums-`);
        dirty = true;
      }

      // Step 3: Fix scraper_health.source_type — same prefix fix.
      // This is the critical step that was missing. Without it the dashboard
      // still shows "cc-forum" badges even after the sources table is fixed.
      const fixedHealth = this.db.prepare(
        `UPDATE scraper_health SET source_type = REPLACE(source_type, 'cc-forum-', 'cc-forums-') WHERE source_type LIKE 'cc-forum-%'`
      ).run();
      if (fixedHealth.changes > 0) {
        logger.info(`🔧 Fixed ${fixedHealth.changes} scraper_health.source_type entries: cc-forum- → cc-forums-`);
        dirty = true;
      }

      if (dirty) logger.info('🔧 Duplicate cc-forum → cc-forums migration complete.');
    } catch (err) {
      logger.warn(`⚠️ Duplicate category migration warning (non-fatal): ${err.message}`);
    }
  }

  /**
   * Remove stale scraper_health rows — entries whose source_id no longer
   * matches any row in the sources table.
   *
   * This catches:
   *   - YouTube handle→channel-ID leftover rows (scraper used to write the
   *     @handle as source_id on first scrape, then resolved to UCxxxx on
   *     subsequent scrapes, leaving an orphan)
   *   - Sources that were deleted from the dashboard but left a health row
   *   - Any other source_id that has been changed out from under the health table
   */
  _migrateStaleScraperHealth() {
    try {
      const stale = this.db.prepare(`
        SELECT sh.id FROM scraper_health sh
        LEFT JOIN sources s ON s.source_id = sh.source_id
        WHERE s.id IS NULL
      `).all();

      if (stale.length === 0) return;

      const deleteStmt = this.db.prepare(`DELETE FROM scraper_health WHERE id = ?`);
      for (const row of stale) {
        deleteStmt.run(row.id);
      }
      logger.info(`🔧 Cleaned up ${stale.length} stale scraper_health rows (source_id not found in sources table).`);
    } catch (err) {
      logger.warn(`⚠️ Stale scraper_health cleanup warning (non-fatal): ${err.message}`);
    }
  }

  _compileStatements() {
    this.statements = {
      insertMessage: this.db.prepare(`
        INSERT OR IGNORE INTO messages
          (message_id, group_id, group_name, chat_type, sender_name, sender_id, body, timestamp, source_type, is_reply, reply_to, media_type, url)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getTodayMessages: this.db.prepare(`
        SELECT * FROM messages
        WHERE source_type LIKE ? AND timestamp >= ?
        ORDER BY timestamp ASC
      `),
      getTodayMessageCount: this.db.prepare(`
        SELECT COUNT(*) as count FROM messages
        WHERE source_type LIKE ? AND timestamp >= ?
      `),
      getTodayActiveGroups: this.db.prepare(`
        SELECT group_name, group_id, chat_type, COUNT(*) as count
        FROM messages
        WHERE source_type LIKE ? AND timestamp >= ?
        GROUP BY group_id
        ORDER BY count DESC
      `),
      getMessagesSinceLastBrief: this.db.prepare(`
        SELECT * FROM messages
        WHERE source_type LIKE ? AND timestamp > ?
        ORDER BY timestamp ASC
      `),
      getLastBriefTimestamp: this.db.prepare(`
        SELECT last_brief_timestamp FROM categories WHERE slug = ?
      `),
      updateLastBriefTimestamp: this.db.prepare(`
        UPDATE categories SET last_brief_timestamp = ? WHERE slug = ?
      `),
      searchMessages: this.db.prepare(`
        SELECT * FROM messages
        WHERE body LIKE ? AND source_type LIKE ?
        ORDER BY timestamp DESC
        LIMIT ?
      `),
      getMessagesByTopic: this.db.prepare(`
        SELECT * FROM messages
        WHERE body LIKE ? AND timestamp >= ?
        ORDER BY timestamp DESC
        LIMIT 50
      `),
      saveBrief: this.db.prepare(`
        INSERT OR REPLACE INTO daily_briefs (brief_date, category_slug, brief_text, message_count)
        VALUES (?, ?, ?, ?)
      `),
      getBrief: this.db.prepare(`
        SELECT * FROM daily_briefs WHERE brief_date = ?
      `),
      getAllBriefs: this.db.prepare(`
        SELECT brief_date, message_count, created_at FROM daily_briefs ORDER BY created_at DESC LIMIT ?
      `),
      saveSummary: this.db.prepare(`
        INSERT INTO summary_log (summary_date, message_count, summary_text, sent_to_telegram)
        VALUES (?, ?, ?, ?)
      `),
      getStatsTotal: this.db.prepare(`
        SELECT COUNT(*) as total FROM messages WHERE timestamp >= ? AND source_type LIKE ?
      `),
      getStatsByGroup: this.db.prepare(`
        SELECT group_name, chat_type, COUNT(*) as count 
        FROM messages WHERE timestamp >= ? AND source_type LIKE ?
        GROUP BY group_name ORDER BY count DESC
      `),
      getMessageCountBySourceType: this.db.prepare(`
        SELECT source_type, COUNT(*) as count
        FROM messages
        GROUP BY source_type
        ORDER BY count DESC
      `),
      getTodayMessageCountBySourceType: this.db.prepare(`
        SELECT source_type, COUNT(*) as count
        FROM messages
        WHERE timestamp >= ?
        GROUP BY source_type
        ORDER BY count DESC
      `),
      getTodayMessageCountBySourceTypeWithNames: this.db.prepare(`
        SELECT source_type, group_name, COUNT(*) as count
        FROM messages
        WHERE timestamp >= ?
        GROUP BY source_type, group_name
        ORDER BY count DESC
      `),
      getTotalMessageCountBySourceTypeWithNames: this.db.prepare(`
        SELECT source_type, group_name, COUNT(*) as count
        FROM messages
        GROUP BY source_type, group_name
        ORDER BY count DESC
      `),
      getTotalWhatsAppMessages: this.db.prepare(`
        SELECT COUNT(*) as count FROM messages WHERE source_type LIKE ?
      `),
      cleanup: this.db.prepare(`
        DELETE FROM messages WHERE timestamp < ?
      `),
      getAllSources: this.db.prepare(`
        SELECT * FROM sources ORDER BY created_at DESC
      `),
      getActiveSourcesByType: this.db.prepare(`
        SELECT source_id FROM sources WHERE type = ? AND is_active = 1
      `),
      getWhatsAppSources: this.db.prepare(`
        SELECT * FROM sources WHERE type = ? AND is_active = 1 ORDER BY created_at DESC
      `),
      getSourcesByCategory: this.db.prepare(`
        SELECT * FROM sources WHERE type LIKE ? ORDER BY created_at DESC
      `),
      getLatestMessageForSource: this.db.prepare(`
        SELECT body, timestamp, sender_name
        FROM messages
        WHERE source_type = ?
          AND (
            LOWER(group_name) LIKE ?
            OR LOWER(group_id) = ?
            OR LOWER(group_id) LIKE ?
            OR LOWER(message_id) LIKE ?
          )
        ORDER BY timestamp DESC
        LIMIT 1
      `),
      addSource: this.db.prepare(`
        INSERT INTO sources (name, source_id, type, is_active, category_slug, url, is_private)
        VALUES (?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET 
          name=excluded.name, 
          type=excluded.type, 
          category_slug=excluded.category_slug,
          url=excluded.url,
          is_private=excluded.is_private,
          is_active=1
      `),
      addSourceInactive: this.db.prepare(`
        INSERT INTO sources (name, source_id, type, is_active, url, is_private)
        VALUES (?, ?, ?, 0, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET 
          name=excluded.name, 
          type=excluded.type,
          url=excluded.url,
          is_private=excluded.is_private,
          is_active=0
      `),
      toggleSource: this.db.prepare(`UPDATE sources SET is_active = ? WHERE id = ?`),
      updateSource: this.db.prepare(`UPDATE sources SET name = ?, type = ?, category_slug = ?, url = ?, is_private = ? WHERE id = ?`),
      deleteSource: this.db.prepare(`DELETE FROM sources WHERE id = ?`),
      getAllCategories: this.db.prepare(`SELECT * FROM categories ORDER BY created_at ASC`),
      getActiveCategories: this.db.prepare(`SELECT * FROM categories WHERE is_active = 1 ORDER BY created_at ASC`),
      getCategoryBySlug: this.db.prepare(`SELECT * FROM categories WHERE slug = ?`),
      getCategoryById: this.db.prepare(`SELECT * FROM categories WHERE id = ?`),
      insertCategory: this.db.prepare(`
        INSERT INTO categories (slug, display_name, bot_token, chat_id, ai_prompt, is_active, delivery_channel, whatsapp_delivery_jid)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `),
      updateCategory: this.db.prepare(`
        UPDATE categories
        SET display_name = ?, bot_token = ?, chat_id = ?, ai_prompt = ?,
            is_active = ?, delivery_channel = ?, whatsapp_delivery_jid = ?
        WHERE id = ?
      `),
      toggleCategory: this.db.prepare(`UPDATE categories SET is_active = ? WHERE id = ?`),
      deleteCategory: this.db.prepare(`DELETE FROM categories WHERE id = ?`),
      getAllScheduleRules: this.db.prepare(`SELECT * FROM schedule_rules ORDER BY category_slug, id`),
      getScheduleRulesByCategory: this.db.prepare(`SELECT * FROM schedule_rules WHERE category_slug = ? ORDER BY id`),
      insertScheduleRule: this.db.prepare(`
        INSERT INTO schedule_rules (category_slug, cron_expression, label, is_active)
        VALUES (?, ?, ?, 1)
      `),
      updateScheduleRule: this.db.prepare(`
        UPDATE schedule_rules SET cron_expression = ?, label = ?, is_active = ? WHERE id = ?
      `),
      toggleScheduleRule: this.db.prepare(`UPDATE schedule_rules SET is_active = ? WHERE id = ?`),
      deleteScheduleRule: this.db.prepare(`DELETE FROM schedule_rules WHERE id = ?`),
      deleteScheduleRulesByCategory: this.db.prepare(`DELETE FROM schedule_rules WHERE category_slug = ?`),
      getScraperHealthForSource: this.db.prepare(
        `SELECT error_count, last_success FROM scraper_health WHERE source_id = ?`
      ),
      // ON CONFLICT(source_id) now works because source_id has UNIQUE constraint
      upsertScraperHealth: this.db.prepare(`
        INSERT INTO scraper_health (source_id, source_type, last_success, last_attempt, error_count, last_error, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(source_id) DO UPDATE SET
          last_success = excluded.last_success,
          last_attempt = excluded.last_attempt,
          error_count = excluded.error_count,
          last_error = excluded.last_error,
          updated_at = CURRENT_TIMESTAMP
      `),
      getScraperHealth: this.db.prepare(`SELECT * FROM scraper_health ORDER BY updated_at DESC`),
      getAllSourceTypes: this.db.prepare(`SELECT * FROM source_types ORDER BY created_at ASC`),
      getSourceTypeBySlug: this.db.prepare(`SELECT * FROM source_types WHERE slug = ?`),
      insertSourceType: this.db.prepare(`INSERT INTO source_types (slug, display_name) VALUES (?, ?) ON CONFLICT(slug) DO NOTHING`),
      updateSourceType: this.db.prepare(`UPDATE source_types SET display_name = ? WHERE id = ?`),
      deleteSourceType: this.db.prepare(`DELETE FROM source_types WHERE id = ?`),
      saveCookies: this.db.prepare(`
        INSERT INTO cookies_store (site, cookies_json) VALUES (?, ?)
        ON CONFLICT(site) DO UPDATE SET cookies_json = excluded.cookies_json, updated_at = CURRENT_TIMESTAMP
      `),
      getCookies: this.db.prepare(`SELECT cookies_json FROM cookies_store WHERE site = ?`),
      getAllCookieSites: this.db.prepare(`SELECT site, updated_at FROM cookies_store`),
      deleteCookies: this.db.prepare(`DELETE FROM cookies_store WHERE site = ?`),
      ensureSourceInstance: this.db.prepare(`
        INSERT OR IGNORE INTO source_instances (source_fk, instance_type, group_id, group_name, chat_type)
        VALUES (?, ?, ?, ?, ?)
      `),
    };
  }

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

  /**
   * Alias for insertMessage() — some scrapers call saveMessage() directly.
   * Added to fix the TypeError crash seen across all scraper modules.
   */
  saveMessage(data) {
    return this.insertMessage(data);
  }

  _istDayStart() {
    const now = Date.now();
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    return Math.floor((Math.floor((now + IST_OFFSET_MS) / 86400000) * 86400000 - IST_OFFSET_MS) / 1000);
  }

  getTodayMessages(sourcePrefix) {
    return this.statements.getTodayMessages.all(`${sourcePrefix}%`, this._istDayStart());
  }

  getTodayMessageCount(sourcePrefix) {
    return this.statements.getTodayMessageCount.get(`${sourcePrefix}%`, this._istDayStart()).count;
  }

  getTodayActiveGroups(sourcePrefix) {
    return this.statements.getTodayActiveGroups.all(`${sourcePrefix}%`, this._istDayStart());
  }

  getMessagesSinceLastBrief(sourcePrefix, sinceTimestamp) {
    return this.statements.getMessagesSinceLastBrief.all(`${sourcePrefix}%`, sinceTimestamp);
  }

  getLastBriefTimestamp(categorySlug) {
    return this.statements.getLastBriefTimestamp.get(categorySlug)?.last_brief_timestamp || 0;
  }

  updateLastBriefTimestamp(categorySlug, timestamp) {
    this.statements.updateLastBriefTimestamp.run(timestamp, categorySlug);
  }

  searchMessages(keyword, limit = 20, sourcePrefix = '') {
    const pattern = `%${keyword}%`;
    const typePattern = sourcePrefix ? `${sourcePrefix}%` : '%';
    return this.statements.searchMessages.all(pattern, typePattern, limit);
  }

  getMessagesByTopic(topic, days = 7) {
    const since = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    return this.statements.getMessagesByTopic.all(`%${topic}%`, since);
  }

  saveBrief(date, briefText, messageCount, categorySlug = 'cc') {
    this.statements.saveBrief.run(date, categorySlug || 'cc', briefText, messageCount);
    if (categorySlug && categorySlug !== 'cc') {
      logger.info(`[DB] saveBrief called for category "${categorySlug}" — stored in shared daily_briefs table.`);
    }
  }

  getBrief(date) {
    return this.statements.getBrief.get(date);
  }

  getAllBriefs(limit = 30) {
    return this.statements.getAllBriefs.all(limit);
  }

  saveSummary(date, messageCount, summaryText, sentToTelegram, categorySlug = 'cc') {
    this.statements.saveSummary.run(date, messageCount, summaryText, sentToTelegram ? 1 : 0);
    if (categorySlug && categorySlug !== 'cc') {
      logger.info(`[DB] saveSummary called for category "${categorySlug}" — stored in shared summary_log table.`);
    }
  }

  getStats(days = 7, sourcePrefix = 'cc') {
    const since = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    const total = this.statements.getStatsTotal.get(since, `${sourcePrefix}%`).total;
    const groups = this.statements.getStatsByGroup.all(since, `${sourcePrefix}%`);
    return { totalMessages: total, byGroup: groups };
  }

  getMessageCountBySourceType() {
    return this.statements.getMessageCountBySourceType.all();
  }

  getTodayMessageCountBySourceType() {
    return this.statements.getTodayMessageCountBySourceType.all(this._istDayStart());
  }

  getTodayMessageCountBySourceTypeWithNames() {
    return this.statements.getTodayMessageCountBySourceTypeWithNames.all(this._istDayStart());
  }

  getTotalMessageCountBySourceTypeWithNames() {
    return this.statements.getTotalMessageCountBySourceTypeWithNames.all();
  }

  getTotalWhatsAppMessages() {
    return this.statements.getTotalWhatsAppMessages.get('%whatsapp%').count;
  }

  cleanup(daysToKeep = 30) {
    const cutoff = Math.floor(Date.now() / 1000) - daysToKeep * 24 * 60 * 60;
    const result = this.statements.cleanup.run(cutoff);
    if (result.changes > 0) {
      logger.info(`🧹 Cleaned up ${result.changes} messages older than ${daysToKeep} days`);
    }
  }

  ensureSourceInstance(sourceFk, instanceType, groupId, groupName, chatType) {
    this.statements.ensureSourceInstance.run(sourceFk, instanceType, groupId, groupName, chatType);
    const row = this.db.prepare(
      `SELECT id FROM source_instances WHERE source_fk = ? AND group_id = ?`
    ).get(sourceFk, groupId);
    return row ? row.id : null;
  }

  updateSourceInstanceName(sourceFk, newName) {
    this.db.prepare(
      `UPDATE source_instances SET group_name = ? WHERE source_fk = ?`
    ).run(newName, sourceFk);
  }

  getAllSources() { return this.statements.getAllSources.all(); }
  getActiveSourcesByType(type) { return this.statements.getActiveSourcesByType.all(type).map(r => r.source_id); }
  getSourcesByCategory(categorySlug) { return this.statements.getSourcesByCategory.all(`${categorySlug}-%`); }
  getSourcesByTypeWildcard(typePattern) { return this.statements.getSourcesByCategory.all(typePattern); }

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

  getLatestMessageForSource(sourceType, cleanName, cleanSourceId) {
    return this.statements.getLatestMessageForSource.get(
      sourceType,
      `%${cleanName}%`,
      cleanSourceId,
      `%${cleanSourceId}%`,
      `%${cleanSourceId}%`
    );
  }

  addSource(name, sourceId, type, categorySlug = null, url = null, isPrivate = 0) {
    this.statements.addSource.run(name, sourceId, type, categorySlug, url || null, isPrivate);
  }
  addSourceInactive(name, sourceId, type, url = null, isPrivate = 0) {
    this.statements.addSourceInactive.run(name, sourceId, type, url || null, isPrivate);
  }
  toggleSource(id, isActive) { this.statements.toggleSource.run(isActive ? 1 : 0, id); }
  updateSource(id, name, type, categorySlug = null, url = null, isPrivate = 0) {
    this.statements.updateSource.run(name, type, categorySlug, url || null, isPrivate, id);
  }
  deleteSource(id) {
    const stmt = this.db.prepare('DELETE FROM source_instances WHERE source_fk = ?');
    this.db.transaction(() => {
      stmt.run(id);
      this.statements.deleteSource.run(id);
    })();
  }
  getAllCategories() { return this.statements.getAllCategories.all(); }
  getActiveCategories() { return this.statements.getActiveCategories.all(); }
  getCategoryBySlug(slug) { return this.statements.getCategoryBySlug.get(slug); }
  getCategoryById(id) { return this.statements.getCategoryById.get(id); }

  insertCategory(slug, displayName, botToken, chatId, aiPrompt, deliveryChannel = 'telegram', whatsappDeliveryJid = null) {
    return this.statements.insertCategory.run(slug, displayName, botToken, chatId, aiPrompt, deliveryChannel, whatsappDeliveryJid);
  }

  updateCategory(id, displayName, botToken, chatId, aiPrompt, isActive = 1, deliveryChannel = 'telegram', whatsappDeliveryJid = null) {
    this.statements.updateCategory.run(displayName, botToken, chatId, aiPrompt, isActive ? 1 : 0, deliveryChannel, whatsappDeliveryJid, id);
  }

  toggleCategory(id, isActive) { this.statements.toggleCategory.run(isActive ? 1 : 0, id); }
  deleteCategory(id) { this.statements.deleteCategory.run(id); }

  addCategory(slug, displayName, botToken, chatId, aiPrompt, deliveryChannel = 'telegram', whatsappDeliveryJid = null) {
    return this.insertCategory(slug, displayName, botToken, chatId, aiPrompt, deliveryChannel, whatsappDeliveryJid);
  }

  getAllSourceTypes() { return this.statements.getAllSourceTypes.all(); }
  getSourceTypeBySlug(slug) { return this.statements.getSourceTypeBySlug.get(slug); }
  insertSourceType(slug, displayName) { this.statements.insertSourceType.run(slug, displayName); }
  updateSourceType(id, displayName) { this.statements.updateSourceType.run(displayName, id); }
  deleteSourceType(id) { this.statements.deleteSourceType.run(id); }

  seedDefaultSourceTypes() {
    const defaults = [
      { slug: 'forums', display_name: 'Forums' },
      { slug: 'reddit', display_name: 'Reddit' },
      { slug: 'youtube', display_name: 'YouTube' },
      { slug: 'whatsapp', display_name: 'WhatsApp' },
      { slug: 'telegram', display_name: 'Telegram' },
      { slug: 'rss', display_name: 'RSS' },
      { slug: 'email', display_name: 'Email' },
      { slug: 'api', display_name: 'JSON API' },
      { slug: 'generic-webhook', display_name: 'Webhook' },
    ];

    let seeded = 0;
    for (const st of defaults) {
      try {
        const existing = this.getSourceTypeBySlug(st.slug);
        if (!existing) {
          this.insertSourceType(st.slug, st.display_name);
          seeded++;
        }
      } catch (err) {
        logger.warn(`seedDefaultSourceTypes: could not seed "${st.slug}": ${err.message}`);
      }
    }

    if (seeded > 0) {
      logger.info(`🌱 Seeded ${seeded} default source types.`);
    }
  }

  getAllScheduleRules() { return this.statements.getAllScheduleRules.all(); }
  getScheduleRulesByCategory(slug) { return this.statements.getScheduleRulesByCategory.all(slug); }
  getScheduleRules(slug) { return this.getScheduleRulesByCategory(slug); }

  insertScheduleRule(categorySlug, cronExpression, label) {
    return this.statements.insertScheduleRule.run(categorySlug, cronExpression, label);
  }

  addScheduleRule(categorySlug, cronExpression, label) {
    return this.insertScheduleRule(categorySlug, cronExpression, label);
  }

  updateScheduleRule(id, cronExpression, label, isActive) {
    this.statements.updateScheduleRule.run(cronExpression, label, isActive ? 1 : 0, id);
  }

  toggleScheduleRule(id, isActive) { this.statements.toggleScheduleRule.run(isActive ? 1 : 0, id); }
  deleteScheduleRule(id) { this.statements.deleteScheduleRule.run(id); }
  deleteScheduleRulesByCategory(slug) { this.statements.deleteScheduleRulesByCategory.run(slug); }

  seedDefaultSchedules() {
    const existing = this.getAllScheduleRules();
    if (existing.length > 0) return;

    const defaults = [
      { slug: 'cc',    cron: '0 6 * * *',  label: '6 AM Brief'  },
      { slug: 'cc',    cron: '0 14 * * *', label: '2 PM Brief'  },
      { slug: 'cc',    cron: '0 22 * * *', label: '10 PM Brief' },
      { slug: 'deals', cron: '0 6 * * *',  label: '6 AM Brief'  },
      { slug: 'deals', cron: '0 14 * * *', label: '2 PM Brief'  },
      { slug: 'deals', cron: '0 22 * * *', label: '10 PM Brief' },
    ];

    for (const d of defaults) {
      try { this.insertScheduleRule(d.slug, d.cron, d.label); } catch (e) { /* ignore */ }
    }
    logger.info('📅 Seeded default schedule rules for cc and deals categories.');
  }

  /**
   * Seed the default 'cc' and 'deals' categories on first boot.
   * Called by index.js main() immediately after constructing DatabaseManager.
   * If the categories already exist (slug UNIQUE), the INSERT is silently skipped.
   *
   * @param {string} ccBotToken         - Telegram bot token for the CC category
   * @param {string} ccChatId           - Telegram chat ID for the CC category
   * @param {string|null} dealsBotToken - Telegram bot token for the Deals category
   * @param {string} dealsChatId        - Telegram chat ID for the Deals category
   */
  seedDefaultCategories(ccBotToken, ccChatId, dealsBotToken, dealsChatId) {
    const defaults = [
      {
        slug: 'cc',
        display_name: 'CC & Finance',
        bot_token: ccBotToken || null,
        chat_id: ccChatId || null,
        ai_prompt: null,
        delivery_channel: 'telegram',
        whatsapp_delivery_jid: null,
      },
      {
        slug: 'deals',
        display_name: 'Deals & Offers',
        bot_token: dealsBotToken || null,
        chat_id: dealsChatId || null,
        ai_prompt: null,
        delivery_channel: 'telegram',
        whatsapp_delivery_jid: null,
      },
    ];

    let seeded = 0;
    for (const cat of defaults) {
      try {
        const existing = this.getCategoryBySlug(cat.slug);
        if (!existing) {
          this.insertCategory(
            cat.slug, cat.display_name, cat.bot_token, cat.chat_id,
            cat.ai_prompt, cat.delivery_channel, cat.whatsapp_delivery_jid
          );
          seeded++;
        } else if (!existing.bot_token && cat.bot_token) {
          // Update tokens if they were null on a previous first-run
          this.updateCategory(
            existing.id, existing.display_name, cat.bot_token, cat.chat_id,
            existing.ai_prompt, existing.is_active,
            existing.delivery_channel, existing.whatsapp_delivery_jid
          );
        }
      } catch (err) {
        logger.warn(`seedDefaultCategories: could not seed "${cat.slug}": ${err.message}`);
      }
    }

    if (seeded > 0) {
      logger.info(`🌱 Seeded ${seeded} default categor${seeded === 1 ? 'y' : 'ies'} (cc, deals).`);
    }

    // Also seed default schedule rules if none exist yet
    this.seedDefaultSchedules();

    // Seed default source types (forums, reddit, youtube, whatsapp, telegram)
    this.seedDefaultSourceTypes();
  }

  getWhatsAppTargets(categorySlug) {
    const type = `${categorySlug}-whatsapp`;
    return this.statements.getWhatsAppSources.all(type);
  }

  saveCookies(site, cookiesArray) {
    try { this.statements.saveCookies.run(site, JSON.stringify(cookiesArray)); }
    catch (err) { logger.error(`Failed to save cookies for ${site} in DB: ${err.message}`); }
  }

  getCookies(site) {
    try {
      const row = this.statements.getCookies.get(site);
      return row ? JSON.parse(row.cookies_json) : null;
    } catch (err) {
      logger.error(`Failed to get cookies for ${site}: ${err.message}`);
      return null;
    }
  }

  getAllCookieSites() {
    try { return this.statements.getAllCookieSites.all(); }
    catch (err) { return []; }
  }

  deleteCookies(site) {
    try { this.statements.deleteCookies.run(site); }
    catch (err) { logger.error(`Failed to delete cookies for ${site} in DB: ${err.message}`); }
  }

  upsertScraperHealth(sourceId, sourceType, success, errorMsg = null) {
    const now = new Date().toISOString();
    try {
      const existing = this.statements.getScraperHealthForSource.get(sourceId);
      const errCount = success ? 0 : (existing ? existing.error_count + 1 : 1);
      const lastSuccess = success ? now : (existing?.last_success || null);
      this.statements.upsertScraperHealth.run(
        sourceId, sourceType, lastSuccess, now, errCount, errorMsg
      );
    } catch (err) {
      logger.warn(`Could not update scraper health for ${sourceId}: ${err.message}`);
    }
  }

  getScraperHealth() {
    try { return this.statements.getScraperHealth.all(); }
    catch (err) { return []; }
  }

  getAllScraperHealth() { return this.getScraperHealth(); }

  close() {
    this.db.close();
    logger.info('Database connection closed.');
  }
}

module.exports = DatabaseManager;
