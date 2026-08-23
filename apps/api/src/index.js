/**
 * CC & Deals Briefing Agent — Main Entry Point
 *
 * 1. Initializes the optimized pre-compiled database layer.
 * 2. Seeds default CC & Deals categories and loads all custom categories.
 * 3. Creates Telegram bot instances for each active category.
 * 4. Starts pure socket-based WhatsApp and Telegram listeners in background.
 * 5. Schedules daily briefings staggered by 45 seconds per category.
 * 6. Runs Express server exposing source CRUD, category CRUD, schedule CRUD, OTP, and session cookies APIs.
 * 7. Handles graceful shutdowns under Coolify and Docker containers.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const logger = require('./logger');

// CRASH GUARDS — never let a stray rejected promise or uncaught exception
// take down the whole process. The WhatsApp (Baileys) socket and external
// integrations frequently throw asynchronously; without these handlers a
// single rejection restarts the entire agent. Log loudly, keep running.
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Promise Rejection: ${reason instanceof Error ? reason.stack : JSON.stringify(reason)}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.stack || err}`);
});

const MessageDatabase = require('./database');
const WhatsAppListener = require('./whatsapp');
const TelegramUserListener = require('./telegram-user');
const TelegramBotDispatcher = require('./telegram-bot');
const Summarizer = require('./summarizer');
const Scheduler = require('./scheduler');

const WebScraper = require('./scrapers/web-scraper');
const YoutubeScraper = require('./scrapers/youtube-scraper');
const ApiScraper = require('./scrapers/api-scraper');
const RssScraper = require('./scrapers/rss-scraper');
const EmailScraper = require('./scrapers/email-scraper');

function validateConfig() {
  const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'GEMINI_API_KEY'];
  const missing = required.filter(key => !process.env[key] || process.env[key].includes('_here'));
  if (missing.length > 0) {
    logger.error('Missing configuration! Set these in .env:');
    missing.forEach(key => logger.error(`  ❌ ${key}`));
    process.exit(1);
  }

  if (!process.env.OPENROUTER_API_KEY) {
    logger.warn('⚠️ OPENROUTER_API_KEY is not set. AI fallback models will be unavailable if Gemini fails.');
  }

  if (!process.env.WHATSAPP_ADMIN_JID) {
    logger.warn('⚠️ WHATSAPP_ADMIN_JID is not set. WhatsApp alert delivery via sendSystemAlert will be skipped.');
  }
}

function parseIdParam(rawId) {
  const id = parseInt(rawId, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function syncCategoryRuntime(category, botInstances, scheduler, database, summarizer) {
  if (!category) return;

  const existingBot = botInstances.get(category.slug);

  if (existingBot) {
    existingBot.stop().catch(err => {
      logger.warn(`Failed to stop existing bot for "${category.slug}": ${err.message}`);
    });
    botInstances.delete(category.slug);
  }

  if (category.is_active && category.bot_token && category.chat_id) {
    try {
      const newBot = new TelegramBotDispatcher(
        category.bot_token,
        category.chat_id,
        database,
        summarizer,
        category.slug,
        category.ai_prompt || undefined
      );
      botInstances.set(category.slug, newBot);
      newBot.start().catch(err => logger.error(`Bot start failed for category "${category.slug}": ${err.message}`));
      logger.info(`🔄 Synced bot runtime for category: ${category.slug}`);
    } catch (err) {
      logger.error(`Failed to sync bot runtime for category "${category.slug}": ${err.message}`);
    }
  }

  scheduler.updateBotInstances(botInstances);
  scheduler.reload();
}

function createBotInstances(database, summarizer) {
  const categories = database.getActiveCategories();
  const botInstances = new Map();

  for (const cat of categories) {
    const token = cat.bot_token;
    const chatId = cat.chat_id;

    if (!token || !chatId) {
      logger.warn(`⚠️ Category "${cat.display_name}" (${cat.slug}) is missing bot_token or chat_id. Skipping bot creation.`);
      continue;
    }

    try {
      const bot = new TelegramBotDispatcher(
        token,
        chatId,
        database,
        summarizer,
        cat.slug,
        cat.ai_prompt || undefined
      );
      botInstances.set(cat.slug, bot);
      logger.info(`🤖 Created bot instance for category: ${cat.display_name} (${cat.slug})`);
    } catch (err) {
      logger.error(`Failed to create bot for category "${cat.slug}": ${err.message}`);
    }
  }

  return botInstances;
}

function startDashboardServer(database, whatsapp, telegramUser, scheduler, summarizer, botInstances, scrapers = {}) {
  const PORT = parseInt(process.env.HEALTH_PORT || '3000', 10);
  const app = express();

  // ── API authentication gate (hardening) ─────────────────────────────
  // All /api/* routes require the DASHBOARD_API_KEY header, EXCEPT:
  //  - /health (public, used by load balancer / Coolify)
  //  - /api/webhook/:sourceId (external webhook sources; HMAC-verified per source when secret set)
  // The webhook route is excluded because external senders cannot know the dashboard key.
  // The dashboard (static export) must be configured with NEXT_PUBLIC_API_KEY
  // (or served by a proxy that injects the header) so browser calls authenticate.
  const DASHBOARD_API_KEY = process.env.DASHBOARD_API_KEY;
  app.use('/api', (req, res, next) => {
    const isSourceWebhook = /^\/webhook\/[^/]+$/.test(req.path);
    if (isSourceWebhook) {
      return next();
    }
    if (!DASHBOARD_API_KEY) {
      logger.warn('DASHBOARD_API_KEY not set — API access disabled. Set it via env to enable the dashboard API.');
      return res.status(503).json({ error: 'API access disabled: DASHBOARD_API_KEY not configured' });
    }
    const provided = req.headers['x-api-key'];
    if (!provided || provided !== DASHBOARD_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  app.use(express.json());
  // Disable redirect so /sources doesn't get redirected to /sources/ (which breaks the catch-all)
  app.use(express.static(path.join(__dirname, '../public'), { redirect: false }));

  app.get('/health', (req, res) => {
    const waStatus = whatsapp.getStatus();
    const msgCount = database.getTodayMessageCount('');
    res.json({
      healthy: true,
      whatsapp: waStatus.isReady ? 'connected' : 'connecting',
      // Do NOT expose the pairing QR publicly — it is a session-hijack token.
      // The dashboard's WhatsApp page fetches /api/whatsapp/qr directly (auth-gated).
      messagesToday: msgCount,
      targetGroups: waStatus.targetCount,
      uptime: Math.floor(process.uptime()),
    });
  });

  app.get('/api/health', (req, res) => {
    try {
      res.json(database.getAllScraperHealth());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/stats', (req, res) => {
    try {
      const sourceCounts = database.getMessageCountBySourceType();
      const todayCounts = database.getTodayMessageCountBySourceType();
      const todayMap = {};
      for (const row of todayCounts) {
        todayMap[row.source_type] = row.count;
      }
      const fullCounts = sourceCounts.map(row => ({
        source_type: row.source_type,
        total: row.count,
        today: todayMap[row.source_type] || 0
      }));
      res.json({
        whatsappTotalMessages: database.getTotalWhatsAppMessages(),
        scraperStats: fullCounts
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Debug endpoint to verify message collection
  app.get('/api/debug/messages', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const messages = database.db.prepare(`
        SELECT m.id, m.groupName, m.groupId, m.chatType, m.senderName, 
               m.body, m.timestamp, m.sourceType, m.instanceFk,
               si.source_fk, s.name as sourceName, s.type as sourceType
        FROM messages m
        LEFT JOIN source_instances si ON m.instance_fk = si.id
        LEFT JOIN sources s ON si.source_fk = s.id
        ORDER BY m.timestamp DESC
        LIMIT ?
      `).all(limit);
      
      const counts = database.db.prepare(`
        SELECT sourceType, COUNT(*) as count 
        FROM messages 
        GROUP BY sourceType
      `).all();
      
      res.json({ recent: messages, bySourceType: counts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/sources', (req, res) => {
    try {
      res.json(database.getAllSources());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/source-stats', (req, res) => {
    try {
      const sources = database.getAllSources();
      const healthMap = {};
      for (const h of database.getScraperHealth()) {
        healthMap[h.source_id] = h;
      }

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

  const SINGLE_WORD = /^[a-z]+$/;

  app.post('/api/sources', (req, res) => {
    try {
      const { name, source_id, type, category_slug, url, is_private } = req.body;
      if (!name || !source_id || !type || !category_slug) return res.status(400).json({ error: 'Missing fields (name, source_id, type, category_slug required)' });
      if (!SINGLE_WORD.test(type)) return res.status(400).json({ error: 'Type must be a single lowercase word' });
      if (!SINGLE_WORD.test(category_slug)) return res.status(400).json({ error: 'Category must be a single lowercase word' });
      const effectiveType = `${category_slug}-${type}`;
      database.addSource(name, source_id.trim(), effectiveType, category_slug, url || null, is_private ? 1 : 0);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/sources/:id', (req, res) => {
    try {
      const id = parseIdParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID' });
      database.deleteSource(id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/sources/:id', (req, res) => {
    try {
      const id = parseIdParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID' });
      const { name, type, category_slug, is_active, url, is_private } = req.body;
      if (type && !SINGLE_WORD.test(type)) return res.status(400).json({ error: 'Type must be a single lowercase word' });
      if (category_slug && !SINGLE_WORD.test(category_slug)) return res.status(400).json({ error: 'Category must be a single lowercase word' });
      if (is_active !== undefined) {
        database.toggleSource(id, is_active);
      }
      if (name !== undefined || type !== undefined || category_slug !== undefined || url !== undefined || is_private !== undefined) {
        const source = database.getAllSources().find(s => s.id === id);
        if (source) {
          const finalType = type || source.type;
          const finalCategorySlug = category_slug !== undefined ? category_slug : source.category_slug;
          const effectiveType = finalCategorySlug && !finalType.startsWith(finalCategorySlug + '-')
            ? `${finalCategorySlug}-${finalType}`
            : finalType;
          const finalUrl = url !== undefined ? url : source.url;
          const finalIsPrivate = is_private !== undefined ? (is_private ? 1 : 0) : source.is_private;
          database.updateSource(id, name || source.name, effectiveType, finalCategorySlug, finalUrl, finalIsPrivate);
        }
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/categories', (req, res) => {
    try {
      // Redact bot_token and chat_id — the client only needs to know whether
      // they are set, never the values. Tokens are write-only (POST/PATCH).
      const rows = database.getAllCategories().map(({ bot_token, chat_id, ...rest }) => ({
        ...rest,
        bot_token: bot_token ? '***' : null,
        chat_id: chat_id ? '***' : null,
      }));
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/categories', async (req, res) => {
    try {
      const { slug, display_name, bot_token, chat_id, ai_prompt, delivery_channel, whatsapp_delivery_jid } = req.body;
      if (!slug || !display_name) {
        return res.status(400).json({ error: 'Missing slug or display_name' });
      }
      if (!/^[a-z0-9-]+$/.test(slug)) {
        return res.status(400).json({ error: 'Slug must be lowercase letters, numbers, and hyphens only' });
      }
      database.addCategory(slug, display_name, bot_token, chat_id, ai_prompt, delivery_channel, whatsapp_delivery_jid);

      const createdCategory = database.getCategoryBySlug(slug);
      syncCategoryRuntime(createdCategory, botInstances, scheduler, database, summarizer);

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/categories/:id', async (req, res) => {
    try {
      const id = parseIdParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID' });

      const { display_name, bot_token, chat_id, ai_prompt, is_active, delivery_channel, whatsapp_delivery_jid } = req.body;
      const existingCategory = database.getAllCategories().find(c => c.id === id);
      if (!existingCategory) return res.status(404).json({ error: 'Category not found' });

      const isToggleOnly =
        is_active !== undefined &&
        display_name === undefined &&
        bot_token === undefined &&
        chat_id === undefined &&
        ai_prompt == null &&
        delivery_channel === undefined &&
        whatsapp_delivery_jid === undefined;

      if (isToggleOnly) {
        database.toggleCategory(id, is_active ? 1 : 0);
        const refreshedCategory = database.getAllCategories().find(c => c.id === id);
        syncCategoryRuntime(refreshedCategory, botInstances, scheduler, database, summarizer);
        return res.json({ success: true });
      }

      // Never accept empty-string writes for secret fields (the dashboard
      // redacts them on GET, so the edit form submits empty -> keep existing).
      if (bot_token === '') bot_token = existingCategory.bot_token;
      if (chat_id === '') chat_id = existingCategory.chat_id;
      if (bot_token === undefined) bot_token = existingCategory.bot_token;
      if (chat_id === undefined) chat_id = existingCategory.chat_id;

      if (!display_name) return res.status(400).json({ error: 'Missing display_name' });

      // FIX: pass is_active as its own explicit argument so it lands in the
      // correct column. Previously the call had is_active in the delivery_channel
      // position, silently corrupting delivery_channel and whatsapp_delivery_jid.
      database.updateCategory(
        id,
        display_name,
        bot_token,
        chat_id,
        ai_prompt,
        is_active !== undefined ? (is_active ? 1 : 0) : existingCategory.is_active,
        delivery_channel || existingCategory.delivery_channel,
        whatsapp_delivery_jid !== undefined ? whatsapp_delivery_jid : existingCategory.whatsapp_delivery_jid
      );

      const updatedCat = database.getAllCategories().find(c => c.id === id);
      syncCategoryRuntime(updatedCat, botInstances, scheduler, database, summarizer);

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/categories/:id', async (req, res) => {
    try {
      const id = parseIdParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID' });

      const allCats = database.getAllCategories();
      const cat = allCats.find(c => c.id === id);

      if (cat && (cat.slug === 'cc' || cat.slug === 'deals')) {
        return res.status(400).json({ error: 'Cannot delete built-in CC or Deals categories' });
      }

      // Delete children first (FK: sources.category_slug REFERENCES categories)
      if (cat) {
        const catSources = database.getSourcesByCategory(cat.slug);
        catSources.forEach(s => database.deleteSource(s.id));
        database.deleteScheduleRulesByCategory(cat.slug);

        if (botInstances.has(cat.slug)) {
          try { await botInstances.get(cat.slug).stop(); } catch (e) { /* ignore */ }
          botInstances.delete(cat.slug);
          scheduler.updateBotInstances(botInstances);
        }
      }

      database.deleteCategory(id);

      scheduler.reload();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/categories/:id/test', async (req, res) => {
    try {
      const id = parseIdParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID' });
      const cat = database.getAllCategories().find(c => c.id === id);
      if (!cat) return res.status(404).json({ error: 'Category not found' });
      const channel = (cat.delivery_channel || 'telegram').toLowerCase();
      const results = [];
      if (channel === 'telegram' || channel === 'both') {
        if (!cat.bot_token || !cat.chat_id) {
          results.push({ channel: 'telegram', success: false, error: 'Bot token or chat ID not configured' });
        } else {
          try {
            const { Telegraf } = require('telegraf');
            const testBot = new Telegraf(cat.bot_token);
            await testBot.telegram.sendMessage(
              cat.chat_id,
              `🧪 <b>Test Message</b>\n\n✅ Category "${cat.display_name}" is configured correctly!\nBot token and Chat ID verified successfully.`,
              { parse_mode: 'HTML' }
            );
            results.push({ channel: 'telegram', success: true });
          } catch (e) {
            results.push({ channel: 'telegram', success: false, error: e.message });
          }
        }
      }
      if ((channel === 'whatsapp' || channel === 'both') && cat.whatsapp_delivery_jid) {
        try {
          if (whatsapp && whatsapp.isReady) {
            await whatsapp.sendMessage(cat.whatsapp_delivery_jid, `🧪 Test Message\n\nCategory "${cat.display_name}" is configured correctly!\nWhatsApp delivery JID verified successfully.`);
            results.push({ channel: 'whatsapp', success: true });
          } else {
            results.push({ channel: 'whatsapp', success: false, error: 'WhatsApp not connected' });
          }
        } catch (e) {
          results.push({ channel: 'whatsapp', success: false, error: e.message });
        }
      } else if ((channel === 'whatsapp' || channel === 'both') && !cat.whatsapp_delivery_jid) {
        results.push({ channel: 'whatsapp', success: false, error: 'WhatsApp delivery JID not configured' });
      }
      const allOk = results.every(r => r.success);
      res.json({ success: allOk, results, message: allOk ? 'Test messages sent successfully!' : 'Some channels failed' });
    } catch (err) {
      res.status(500).json({ error: `Test failed: ${err.message}` });
    }
  });

  // ── Source Types API ──────────────────────────────────────────────────────────

  app.get('/api/source-types', (req, res) => {
    try {
      res.json(database.getAllSourceTypes());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/source-types', (req, res) => {
    try {
      const { slug, display_name } = req.body;
      if (!slug || !display_name) {
        return res.status(400).json({ error: 'Missing slug or display_name' });
      }
      if (!/^[a-z]+$/.test(slug)) {
        return res.status(400).json({ error: 'Slug must be a single lowercase word, no hyphens or numbers' });
      }
      const existing = database.getSourceTypeBySlug(slug);
      if (existing) {
        return res.status(409).json({ error: `Source type "${slug}" already exists` });
      }
      database.insertSourceType(slug, display_name);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/source-types/:id', (req, res) => {
    try {
      const id = parseIdParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID' });
      const { display_name } = req.body;
      if (!display_name) return res.status(400).json({ error: 'Missing display_name' });
      database.updateSourceType(id, display_name);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/source-types/:id', (req, res) => {
    try {
      const id = parseIdParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID' });
      database.deleteSourceType(id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Schedules API ─────────────────────────────────────────────────────────────

  app.get('/api/schedules', (req, res) => {
    try {
      const rules = database.getAllScheduleRules();
      const liveStatus = scheduler.getStatus();
      const liveIds = new Set(liveStatus.map(j => j.ruleId));
      const enriched = rules.map(r => ({ ...r, is_running: liveIds.has(r.id) }));
      res.json(enriched);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/schedules/:slug', (req, res) => {
    try {
      const rules = database.getScheduleRules(req.params.slug);
      res.json(rules);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/schedules/trigger', async (req, res) => {
    try {
      const { slug } = req.body;
      logger.info(`⚡ Manual trigger via API${slug ? ` for category: ${slug}` : ' for all categories'}.`);
      scheduler.triggerNow(slug || null).catch(e =>
        logger.error(`Manual trigger error: ${e.message}`)
      );
      res.json({ success: true, message: slug ? `Brief triggered for "${slug}"` : 'Brief triggered for all categories' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/trigger', async (req, res) => {
    try {
      const { slug } = req.body;
      logger.info(`⚡ [legacy /api/trigger] Manual trigger${slug ? ` for: ${slug}` : ' for all'}.`);
      scheduler.triggerNow(slug || null).catch(e =>
        logger.error(`Manual trigger error: ${e.message}`)
      );
      res.json({ success: true, message: slug ? `Brief triggered for "${slug}"` : 'Brief triggered for all categories' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/schedules', (req, res) => {
    try {
      const { category_slug, cron_expression, label } = req.body;
      if (!category_slug || !cron_expression || !label) {
        return res.status(400).json({ error: 'Missing category_slug, cron_expression, or label' });
      }
      const cron = require('node-cron');
      if (!cron.validate(cron_expression)) {
        return res.status(400).json({ error: `Invalid cron expression: "${cron_expression}"` });
      }
      const cat = database.getCategoryBySlug(category_slug);
      if (!cat) {
        return res.status(404).json({ error: `Category "${category_slug}" not found` });
      }
      database.addScheduleRule(category_slug, cron_expression, label);
      scheduler.reload();
      logger.info(`📅 New schedule rule added for "${category_slug}": ${label} (${cron_expression})`);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/schedules/:id', (req, res) => {
    try {
      const id = parseIdParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID' });
      const { cron_expression, label, is_active } = req.body;
      if (is_active !== undefined && !cron_expression && !label) {
        database.toggleScheduleRule(id, is_active ? 1 : 0);
        scheduler.reload();
        return res.json({ success: true });
      }
      if (!cron_expression || !label) {
        return res.status(400).json({ error: 'Missing cron_expression or label' });
      }
      const cron = require('node-cron');
      if (!cron.validate(cron_expression)) {
        return res.status(400).json({ error: `Invalid cron expression: "${cron_expression}"` });
      }
      database.updateScheduleRule(
        id,
        cron_expression,
        label,
        is_active !== undefined ? (is_active ? 1 : 0) : 1
      );
      scheduler.reload();
      logger.info(`📅 Schedule rule #${id} updated.`);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/schedules/:id/toggle', (req, res) => {
    try {
      const id = parseIdParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID' });
      const { is_active } = req.body;
      if (is_active === undefined) return res.status(400).json({ error: 'Missing is_active' });
      database.toggleScheduleRule(id, is_active ? 1 : 0);
      scheduler.reload();
      logger.info(`📅 Schedule rule #${id} toggled to ${is_active ? 'active' : 'paused'}.`);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/schedules/:id', (req, res) => {
    try {
      const id = parseIdParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID' });
      database.deleteScheduleRule(id);
      scheduler.reload();
      logger.info(`📅 Schedule rule #${id} deleted.`);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/telegram/status', (req, res) => {
    const status = telegramUser.getStatus();
    res.json({ isReady: status.isReady, tempPhone: status.tempPhone });
  });

  app.post('/api/telegram/send-code', async (req, res) => {
    try {
      const { phoneNumber } = req.body;
      if (!phoneNumber) return res.status(400).json({ error: 'Missing phone number' });
      await telegramUser.sendCode(phoneNumber);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/telegram/submit-code', async (req, res) => {
    try {
      const { code, password } = req.body;
      if (!code) return res.status(400).json({ error: 'Missing OTP code' });
      await telegramUser.submitCode(code, password);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/telegram/logout', async (req, res) => {
    try {
      await telegramUser.logout();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/telegram/discover', async (req, res) => {
    try {
      const channels = await telegramUser.discoverGroups();
      res.json(channels);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // WhatsApp discovery
  app.get('/api/whatsapp/discover', async (req, res) => {
    try {
      if (!whatsapp) {
        return res.status(503).json({ error: 'WhatsApp not configured' });
      }
      const groups = await whatsapp.discoverChats();
      res.json(groups);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/whatsapp/sources', (req, res) => {
    try {
      const allSources = database.getAllSources().filter(s => s.type.endsWith('-whatsapp'));
      res.json(allSources);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/whatsapp/sources', (req, res) => {
    try {
      const { name, source_id, category_slug } = req.body;
      if (!name || !source_id || !category_slug) {
        return res.status(400).json({ error: 'Missing name, source_id, or category_slug' });
      }
      const type = `${category_slug}-whatsapp`;
      database.addSource(name, source_id.trim(), type, category_slug);
      if (whatsapp && typeof whatsapp._refreshTargets === 'function') {
        whatsapp._refreshTargets();
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/whatsapp/sources/:id', (req, res) => {
    try {
      const id = parseIdParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID' });
      database.deleteSource(id);
      if (whatsapp && typeof whatsapp._refreshTargets === 'function') {
        whatsapp._refreshTargets();
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // WhatsApp QR Code endpoint - returns QR code as PNG image
  // Pass ?force=1 to regenerate QR (invalidates previous one)
  app.get('/api/whatsapp/qr', async (req, res) => {
    if (!whatsapp) {
      return res.status(503).json({ error: 'WhatsApp not configured' });
    }
    const force = req.query.force === '1' || req.query.force === 'true';
    let qr = null;
    if (typeof whatsapp.fetchFreshQr === 'function') {
      qr = await whatsapp.fetchFreshQr(force);
    }
    if (!qr) {
      qr = whatsapp.getStatus().qr;
    }
    if (!qr) {
      return res.status(404).json({ error: 'No QR code available' });
    }
    // Extract base64 and send as PNG
    const base64 = qr.replace(/^data:image\/png;base64,/, '').replace(/^data:image\/webp;base64,/, '');
    try {
      const img = Buffer.from(base64, 'base64');
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.send(img);
    } catch (err) {
      res.status(500).json({ error: 'Failed to decode QR code' });
    }
  });

  app.get('/api/cookies', (req, res) => {
    try {
      const SITES = ['youtube', 'technofino', 'desidime', 'reddit'];
      const result = SITES.map(site => {
        const row = database.getCookies(site);
        const filePath = path.resolve(__dirname, `../data/${site}_cookies.json`);
        const fileExists = fs.existsSync(filePath);
        let updatedAt = null;
        let expiresAt = null;
        if (row) {
          try {
            const meta = database.db.prepare('SELECT updated_at FROM cookies_store WHERE site = ?').get(site);
            updatedAt = meta ? meta.updated_at : null;
          } catch (e) { /* ignore */ }
          try {
            const cookies = typeof row === 'string' ? JSON.parse(row) : row;
            if (Array.isArray(cookies) && cookies.length > 0) {
              const now = Math.floor(Date.now() / 1000);
              let minExpiry = null;
              let allSession = true;
              for (const c of cookies) {
                if (c.expires && c.expires > 0) {
                  allSession = false;
                  if (minExpiry === null || c.expires < minExpiry) minExpiry = c.expires;
                }
              }
              expiresAt = allSession ? null : minExpiry;
            }
          } catch (e) { /* ignore */ }
        } else if (fileExists) {
          const stat = fs.statSync(filePath);
          updatedAt = stat.mtime.toISOString();
        }
        const isExpired = expiresAt ? Math.floor(Date.now() / 1000) > expiresAt : null;
        return { site, has_cookies: !!(row || fileExists), updated_at: updatedAt, expires_at: expiresAt, is_valid: expiresAt ? !isExpired : (row || fileExists ? null : false) };
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  function parseCookiesInput(input) {
    if (typeof input !== 'string') return Array.isArray(input) ? input : null;
    const trimmed = input.trim();
    // Try JSON array first
    if (trimmed.startsWith('[')) {
      try { return JSON.parse(trimmed); }
      catch (e) { return null; }
    }
    // Try Netscape HTTP Cookie File format
    const lines = trimmed.split('\n');
    const cookies = [];
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) continue;
      const parts = trimmedLine.split('\t');
      if (parts.length < 7) continue;
      const [domain, , path, secure, expires, name, ...rest] = parts;
      cookies.push({
        domain: domain || '',
        path: path || '/',
        secure: secure === 'TRUE',
        expires: parseInt(expires, 10) || 0,
        expirationDate: parseInt(expires, 10) || 0,
        name: name || '',
        value: rest.join('\t') || '',
      });
    }
    return cookies.length > 0 ? cookies : null;
  }

  app.post('/api/cookies', (req, res) => {
    try {
      const { site, cookies } = req.body;
      if (!site || !cookies) return res.status(400).json({ error: 'Missing site or cookies payload' });
      const VALID_SITES = ['youtube', 'technofino', 'desidime', 'reddit'];
      if (!VALID_SITES.includes(site)) {
        return res.status(400).json({ error: `Invalid site. Must be one of: ${VALID_SITES.join(', ')}` });
      }
      const parsedCookies = parseCookiesInput(cookies);
      if (!parsedCookies || parsedCookies.length === 0) {
        return res.status(400).json({ error: 'Invalid cookies format. Paste a JSON array or a Netscape HTTP Cookie File.' });
      }
      database.saveCookies(site, parsedCookies);
      try {
        const targetPath = path.resolve(__dirname, `../data/${site}_cookies.json`);
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(targetPath, JSON.stringify(parsedCookies, null, 2), 'utf8');
      } catch (fileErr) {
        logger.debug(`Could not write cookies to file: ${fileErr.message}`);
      }
      logger.info(`🔐 Saved ${parsedCookies.length} cookies for ${site}.`);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/cookies/:site', (req, res) => {
    try {
      const { site } = req.params;
      const VALID_SITES = ['youtube', 'technofino', 'desidime', 'reddit'];
      if (!VALID_SITES.includes(site)) {
        return res.status(400).json({ error: `Invalid site. Must be one of: ${VALID_SITES.join(', ')}` });
      }
      database.deleteCookies(site);
      [path.resolve(__dirname, `../data/${site}_cookies.json`),
       path.resolve(__dirname, `../../data/${site}_cookies.json`)].forEach(p => {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      });
      logger.info(`❌ Deleted cookies for ${site}.`);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Database cleanup endpoint — clears messages, consolidates forum types, removes null source_type
  app.post('/api/admin/cleanup-db', (req, res) => {
    try {
      // 1. Clear messages and source_instances
      database.db.prepare('DELETE FROM messages').run();
      database.db.prepare('DELETE FROM source_instances').run();
      logger.info('Cleared messages and source_instances tables');

      // 2. Consolidate cc-forum -> cc-forums
      const forumSources = database.db.prepare('SELECT id, name FROM sources WHERE type = ?').all('cc-forum');
      for (const src of forumSources) {
        database.db.prepare('UPDATE sources SET type = ? WHERE id = ?').run('cc-forums', src.id);
        logger.info(`Updated source ${src.name} (id: ${src.id}) -> cc-forums`);
      }

      // 3. Reset WhatsApp scraper health
      database.db.prepare('DELETE FROM scraper_health WHERE source_type LIKE ?').run('%whatsapp%');
      logger.info('Reset WhatsApp scraper health');

      // 4. Verify
      const msgCount = database.db.prepare('SELECT COUNT(*) as c FROM messages').get();
      const sources = database.db.prepare('SELECT id, name, type FROM sources WHERE type LIKE ?').all('%forum%');

      res.json({
        success: true,
        message: 'Database cleanup complete',
        messagesCleared: msgCount.c,
        forumSourcesUpdated: forumSources.length,
        remainingForumSources: sources
      });
    } catch (err) {
      logger.error(`Database cleanup failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Session persistence verification endpoint
  app.get('/api/admin/verify-sessions', async (req, res) => {
    try {
      const results = {
        whatsapp: { connected: false },
        telegramUser: { authorized: false },
        volumes: { appData: false }
      };

      // Check Baileys WhatsApp connection
      if (whatsapp) {
        const status = typeof whatsapp.getStatus === 'function' ? whatsapp.getStatus() : {};
        results.whatsapp.connected = !!status.isReady;
      }

      // Check Telegram User
      if (telegramUser) {
        results.telegramUser.authorized = telegramUser.isListening || false;
      }

      // Check volume mounts
      const fs = require('fs');
      results.volumes.appData = fs.existsSync('/app/data');

      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Force WhatsApp reconnection (triggers new QR generation) — GET/POST for dashboard convenience
  app.all('/api/admin/force-whatsapp-reconnect', async (req, res) => {
    try {
      if (!whatsapp || typeof global.restartWhatsApp !== 'function') {
        return res.status(503).json({ error: 'WhatsApp not configured' });
      }

      await global.restartWhatsApp(true);

      logger.info('WhatsApp restart triggered - new QR will be generated');

      res.json({
        success: true,
        message: 'WhatsApp restart triggered. A new QR will be generated shortly.'
      });
    } catch (err) {
      logger.error(`Force reconnect failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Reset WhatsApp connection (wipe session for fresh QR) — clears stale/removed session
  app.delete('/api/admin/reset-whatsapp', async (req, res) => {
    try {
      if (!whatsapp) {
        return res.status(503).json({ error: 'WhatsApp not configured' });
      }
      await global.restartWhatsApp(true);
      logger.info('WhatsApp session reset - new QR will be generated');
      res.json({
        success: true,
        message: 'WhatsApp connection reset. Scan the new QR to re-pair.'
      });
    } catch (err) {
      logger.error(`Reset WhatsApp failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/cookies/status', (req, res) => {
    const cookieSites = database.getAllCookieSites();
    const seen = new Set();
    for (const row of cookieSites) seen.add(row.site);
    const filePaths = fs.readdirSync(path.resolve(__dirname, '../data')).filter(f => f.endsWith('_cookies.json'));
    for (const f of filePaths) seen.add(f.replace('_cookies.json', ''));
    const result = {};
    for (const site of seen) {
      const row = database.getCookies(site);
      const filePath = path.resolve(__dirname, `../data/${site}_cookies.json`);
      result[site] = !!(row || fs.existsSync(filePath));
    }
    res.json(result);
  });

  app.post('/api/cookies/import', (req, res) => {
    try {
      const { site, cookies } = req.body;
      if (!site || !cookies) return res.status(400).json({ error: 'Missing site or cookies payload' });
      const VALID_SITES = ['youtube', 'technofino', 'desidime', 'reddit'];
      if (!VALID_SITES.includes(site)) {
        return res.status(400).json({ error: `Invalid site. Must be one of: ${VALID_SITES.join(', ')}` });
      }
      const parsedCookies = parseCookiesInput(cookies);
      if (!parsedCookies || parsedCookies.length === 0) {
        return res.status(400).json({ error: 'Invalid cookies format. Paste a JSON array or a Netscape HTTP Cookie File.' });
      }
      database.saveCookies(site, parsedCookies);
      // Write to both paths so scrapers and API both find the file
      const cookiePaths = [
        path.resolve(__dirname, `../data/${site}_cookies.json`),
        path.resolve(__dirname, `../../data/${site}_cookies.json`),
      ];
      for (const targetPath of cookiePaths) {
        try {
          const dir = path.dirname(targetPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(targetPath, JSON.stringify(parsedCookies, null, 2), 'utf8');
        } catch (fileErr) {
          logger.debug(`Could not write cookies to ${targetPath}: ${fileErr.message}`);
        }
      }
      logger.info(`🔐 Saved imported cookies for ${site} successfully in DB & files.`);
      const SITE_SCRAPER_MAP = { technofino: 'web', desidime: 'web', reddit: 'web', youtube: 'youtube' };
      const scraperKey = SITE_SCRAPER_MAP[site];
      if (scraperKey && scrapers[scraperKey]) {
        scrapers[scraperKey].scrape().catch(e => logger.error(`Immediate ${site} scrape fail: ${e.message}`));
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

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

      // HMAC verification — fail CLOSED. Webhook sources must configure
      // WEBHOOK_SECRET_<SOURCEID>; missing secret = reject, missing signature = reject.
      const secretKey = process.env[`WEBHOOK_SECRET_${sourceId.toUpperCase()}`];
      if (!secretKey) {
        return res.status(401).json({ error: 'Webhook source has no WEBHOOK_SECRET_ configured' });
      }
      const crypto = require('crypto');
      const signature = req.headers['x-hub-signature-256'] || req.headers['x-signature-256'] || '';
      if (!signature) {
        return res.status(401).json({ error: 'Missing signature' });
      }
      const computed = crypto.createHmac('sha256', secretKey).update(JSON.stringify(payload)).digest('hex');
      // Accept "sha256=<hex>" or bare hex; timing-safe compare
      const provided = String(signature).replace(/^sha256=/, '');
      const a = Buffer.from(provided, 'utf8');
      const b = Buffer.from(computed, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'Invalid signature' });
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

  // Serve Next.js static export HTML routes
  // e.g. /sources -> sources.html, /categories -> categories.html
  // Also serves files inside subdirectories (e.g. /sources/ -> /sources.html)
  app.get('/*splat', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'API route not found' });
    }
    const publicDir = path.join(__dirname, '../public');
    // Normalize: strip trailing slash and ensure we try .html
    let cleanPath = req.path.replace(/\/+$/, '') || '/';
    const htmlPath = path.join(publicDir, cleanPath.endsWith('.html') ? cleanPath : cleanPath + '.html');
    const indexPath = path.join(publicDir, 'index.html');
    // Containment: never serve files outside publicDir
    const contained = (p) => path.normalize(p).startsWith(publicDir + path.sep);
    if (contained(htmlPath) && fs.existsSync(htmlPath)) {
      res.sendFile(htmlPath);
    } else {
      // Also try: if path has a directory with the same name, serve its index.html
      // e.g. /sources/other -> /sources/other.html, or fallback to index
      const dirIndexPath = path.join(publicDir, cleanPath, 'index.html');
      if (contained(dirIndexPath) && fs.existsSync(dirIndexPath)) {
        res.sendFile(dirIndexPath);
      } else {
        res.sendFile(indexPath);
      }
    }
  });

  const server = app.listen(PORT, () => {
    logger.info(`🌐 Dashboard Server successfully started on port ${PORT} — http://localhost:${PORT}`);
  });
  return server;
}

async function main() {
  logger.info('🚀 CC & Deals Brief Agent Clean-Slate Starting...');
  logger.info('================================================');

  validateConfig();

  const database = new MessageDatabase();
  database.seedDefaultCategories(
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.TELEGRAM_CHAT_ID,
    process.env.DEALS_BOT_TOKEN || null,
    process.env.TELEGRAM_CHAT_ID
  );

  const summarizer = new Summarizer(process.env.GEMINI_API_KEY, process.env.OPENROUTER_API_KEY);
  const botInstances = createBotInstances(database, summarizer);

  let whatsapp;
  let telegramUser;

  const WhatsAppListener = require('./whatsapp');
  const TelegramUserListener = require('./telegram-user');
  whatsapp = new WhatsAppListener(database, null);
  telegramUser = new TelegramUserListener(database, null);
  
  const scheduler = new Scheduler(summarizer, botInstances, database, whatsapp);

  const sendSystemAlert = async (message) => {
    logger.warn(`🚨 [System Alert] ${message}`);
    const plainMessage = message.replace(/<[^>]*>/g, '');

    const ccBotInstance = botInstances.get('cc');
    if (ccBotInstance) {
      try {
        await ccBotInstance.sendMessage(`🚨 <b>Session Alert</b>\n\n${message}`);
      } catch (err) {
        logger.error(`Failed to send Telegram system alert: ${err.message}`);
      }
    }

    const adminJid = process.env.WHATSAPP_ADMIN_JID;
    if (adminJid && whatsapp) {
      try {
        await whatsapp.sendMessage(adminJid, `🚨 *Session Alert*\n\n${plainMessage}`);
      } catch (err) {
        logger.error(`Failed to send WhatsApp system alert: ${err.message}`);
      }
    }
  };

  if (whatsapp) {
    whatsapp.onAlert = sendSystemAlert;
  }
  if (telegramUser) {
    telegramUser.onAlert = sendSystemAlert;
  }

  const apiScraper = new ApiScraper(database, sendSystemAlert);

  // Global restart function
  global.restartWhatsApp = async (force = false) => {
    logger.warn('🔄 Received global request to restart WhatsApp client...');
    if (whatsapp && typeof whatsapp.stop === 'function') {
      await whatsapp.stop();
      if (force) {
        const authPath = path.resolve(__dirname, '../data/baileys_auth');
        if (fs.existsSync(authPath)) {
          fs.rmSync(authPath, { recursive: true, force: true });
          logger.info('🧹 Forcing clean session. Cleared baileys_auth credentials folder.');
        }
      }
      setTimeout(() => {
        whatsapp.start().catch(err => logger.error(`WhatsApp restart failed: ${err.message}`));
      }, 5000);
    }
  };

  const webScraper = new WebScraper(database, sendSystemAlert);
  const youtubeScraper = new YoutubeScraper(database, summarizer);
  const emailScraper = new EmailScraper(database, sendSystemAlert);
  const rssScraper = new RssScraper(database, sendSystemAlert);

  const scrapers = {
    web: webScraper,
    youtube: youtubeScraper,
    api: apiScraper,
    rss: rssScraper,
    email: emailScraper,
  };

  const healthServer = startDashboardServer(
    database, whatsapp, telegramUser, scheduler, summarizer, botInstances, scrapers
  );

  for (const [slug, bot] of botInstances) {
    try {
      const connected = await bot.start();
      if (!connected) {
        logger.warn(`⚠️ Telegram Bot for category "${slug}" failed to connect.`);
      }
    } catch (err) {
      logger.error(`Telegram Bot for category "${slug}" crashed on start: ${err.message}`);
    }
  }

  // Start WhatsApp listener
  if (whatsapp) {
    whatsapp.start().catch(err => logger.error(`WhatsApp listener failed: ${err.message}`));
  }
  
  if (telegramUser) {
    telegramUser.start().catch(err => logger.error(`Telegram user listener failed: ${err.message}`));
  }
  
  scheduler.start();

  webScraper.start();
  youtubeScraper.start();
  emailScraper.start();
  apiScraper.start();
  rssScraper.start();

  for (const [slug, bot] of botInstances) {
    try {
      if (slug === 'cc') {
        await bot.sendStartupNotification();
      } else {
        const cat = database.getCategoryBySlug(slug);
        const displayName = cat ? cat.display_name : slug.toUpperCase();
        await bot.sendMessage(`🟢 <b>${displayName} Brief Agent Started</b>\nAll scrapers operational.`);
      }
    } catch (err) {
      logger.warn(`Failed to send startup notification for "${slug}": ${err.message}`);
    }
  }

  const shutdown = async (signal) => {
    logger.info(`\n${signal} signal received. Powering down gracefully...`);
    scheduler.stop();
    webScraper.stop();
    youtubeScraper.stop();
    emailScraper.stop();
    rssScraper.stop();
    apiScraper.stop();
    
    // Stop WhatsApp
    if (whatsapp) {
      await whatsapp.stop();
    }
    
    await telegramUser.logout();
    for (const [, bot] of botInstances) {
      try { await bot.stop(); } catch (e) { /* ignore */ }
    }
    // Drain HTTP first so in-flight requests don't hit a closed DB
    await new Promise(resolve => healthServer.close(resolve));
    database.close();
    logger.info('Graceful shutdown complete. Bye! 👋');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(`Fatal boot error: ${err.message}`);
  logger.error(err.stack);
  process.exit(1);
});
