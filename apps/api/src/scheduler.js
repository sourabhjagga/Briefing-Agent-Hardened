/**
 * Scheduler Module
 * Per-category, DB-driven schedule rules. Supports multiple daily slots, pause/resume, run-now.
 * Falls back to hardcoded defaults (6 AM / 2 PM / 10 PM IST) if no DB rules exist for a category.
 */

const cron = require('node-cron');
const logger = require('./logger');

class Scheduler {
  constructor(summarizer, botInstances, database, whatsapp) {
    this.summarizer = summarizer;
    this.botInstances = botInstances; // Map<slug, TelegramBotDispatcher>
    this.database = database;
    this.whatsapp = whatsapp;
    this.jobs = []; // { job, ruleId, categorySlug, label }
  }

  start() {
    this._armAllRules();

    // Daily DB cleanup at 3:00 AM IST
    const cleanupJob = cron.schedule('0 3 * * *', () => {
      logger.info('🧹 Running daily SQLite database cleanup...');
      this.database.cleanup();
    }, { timezone: 'Asia/Kolkata' });
    this.jobs.push({ job: cleanupJob, ruleId: null, categorySlug: '__cleanup', label: 'DB Cleanup' });

    const active = this.jobs.filter(j => j.ruleId !== null);
    logger.info(`📅 Scheduler armed: ${active.length} rule(s) across ${new Set(active.map(j => j.categorySlug)).size} categories.`);
  }

  _armAllRules() {
    // Stop existing category jobs (keep __cleanup)
    this.jobs = this.jobs.filter(j => {
      if (j.ruleId !== null) { j.job.stop(); return false; }
      return true;
    });

    const allRules = this.database.getAllScheduleRules();

    if (allRules.length === 0) {
      // Seed defaults then re-read
      this.database.seedDefaultSchedules();
      const seeded = this.database.getAllScheduleRules();
      return this._armRules(seeded);
    }

    this._armRules(allRules);
  }

  _armRules(rules) {
    for (const rule of rules) {
      if (!rule.is_active) continue;
      if (!cron.validate(rule.cron_expression)) {
        logger.warn(`⚠️ Invalid cron expression "${rule.cron_expression}" for rule #${rule.id} (${rule.category_slug}). Skipping.`);
        continue;
      }
      const job = cron.schedule(rule.cron_expression, async () => {
        logger.info(`📅 [${rule.category_slug}] "${rule.label}" brief triggered (rule #${rule.id}).`);
        await this._runSingleCategoryBrief(rule.category_slug);
      }, { timezone: 'Asia/Kolkata' });
      this.jobs.push({ job, ruleId: rule.id, categorySlug: rule.category_slug, label: rule.label });
    }
  }

  /**
   * Reload all schedule rules from DB and re-arm. Called after dashboard updates a schedule.
   */
  reload() {
    logger.info('🔄 Reloading scheduler rules from database...');
    this._armAllRules();
    const active = this.jobs.filter(j => j.ruleId !== null);
    logger.info(`📅 Scheduler reloaded: ${active.length} active rule(s).`);
  }

  async _runSingleCategoryBrief(slug, isManualTrigger = false) {
    const botInstance = this.botInstances.get(slug);
    if (!botInstance) {
      logger.warn(`⚠️ No bot instance for category "${slug}". Skipping.`);
      return;
    }
    const cat = this.database.getCategoryBySlug(slug);
    await this._runSummaryJob(slug, botInstance, cat ? cat.ai_prompt : undefined, isManualTrigger);
  }

  /**
   * Run all active categories at once (manual trigger or legacy global slot).
   * Staggered by 30 seconds between categories.
   */
  async _runAllCategoryBriefs() {
    const categories = this.database.getActiveCategories();
    logger.info(`📂 Running briefs for ${categories.length} active categories...`);
    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      const botInstance = this.botInstances.get(cat.slug);
      if (!botInstance) {
        logger.warn(`⚠️ No bot instance found for category "${cat.slug}". Skipping.`);
        continue;
      }
      if (i > 0) {
        logger.info(`⏳ Staggering "${cat.display_name}" briefing by 30 seconds...`);
        await new Promise(r => setTimeout(r, 30000));
      }
      await this._runSummaryJob(cat.slug, botInstance, cat.ai_prompt, true);
    }
  }

  async _runSummaryJob(sourcePrefix, telegramInstance, customPrompt = undefined, isManualTrigger = false) {
    logger.info(`=== STARTING ${sourcePrefix.toUpperCase()} BRIEFING GENERATION ===`);
    const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    const nowTimestamp = Math.floor(Date.now() / 1000);
    try {
      // Get messages since last brief (or all today's messages if manual trigger or first run)
      let messages;
      if (isManualTrigger) {
        // Manual trigger: process all messages from today
        messages = this.database.getTodayMessages(sourcePrefix);
        logger.info(`[${sourcePrefix}] Manual trigger: processing all ${messages.length} messages from today.`);
      } else {
        // Scheduled run: get messages since last brief
        const lastBriefTs = this.database.getLastBriefTimestamp(sourcePrefix);
        if (lastBriefTs > 0) {
          messages = this.database.getMessagesSinceLastBrief(sourcePrefix, lastBriefTs);
          logger.info(`[${sourcePrefix}] Incremental: found ${messages.length} new messages since last brief (ts: ${lastBriefTs}).`);
        } else {
          // First run ever: process all today's messages
          messages = this.database.getTodayMessages(sourcePrefix);
          logger.info(`[${sourcePrefix}] First run: processing all ${messages.length} messages from today.`);
        }
      }
      
      const category = this.database.getCategoryBySlug(sourcePrefix);
      const deliveryChannel = category?.delivery_channel || 'telegram';
      const adminJid = process.env.WHATSAPP_ADMIN_JID;

      if (messages.length === 0) {
        logger.info(`[${sourcePrefix}] Skipping brief — 0 new messages since last brief.`);
        const shouldSendWhatsApp = deliveryChannel === 'whatsapp' || deliveryChannel === 'both';
        const shouldSendTelegram = deliveryChannel === 'telegram' || deliveryChannel === 'both';
        const deliveryJid = category?.whatsapp_delivery_jid || adminJid;
        
        // Still update the timestamp so we don't re-check these messages
        if (!isManualTrigger) {
          this.database.updateLastBriefTimestamp(sourcePrefix, nowTimestamp);
        }
        
        if (shouldSendWhatsApp && deliveryJid) {
          await this.whatsapp.sendMessage(deliveryJid, `🤷‍♂️ *No new updates!*\n\nNo new messages captured from your monitored ${sourcePrefix.toUpperCase()} sources since the last brief.`);
        }
        if (shouldSendTelegram && telegramInstance) {
          try {
            await telegramInstance.sendMessage(`🤷‍♂️ <b>No new updates!</b>\n\nNo new messages captured from your monitored ${sourcePrefix.toUpperCase()} sources since the last brief.`);
          } catch (e) {
            logger.error(`Failed to send Telegram 'No updates' for ${sourcePrefix}: ${e.message}`);
          }
        }
        return;
      }

      const groups = this.database.getTodayActiveGroups(sourcePrefix);
      logger.info(`[${sourcePrefix}] Active groups: ${groups.map(g => `${g.group_name}(${g.count})`).join(', ')}`);
      
      const summary = await this.summarizer.generateSummary(messages, customPrompt);
      
      // Delivery: WhatsApp
      const shouldSendWhatsApp = deliveryChannel === 'whatsapp' || deliveryChannel === 'both';
      const shouldSendTelegram = deliveryChannel === 'telegram' || deliveryChannel === 'both';
      
      if (shouldSendWhatsApp) {
        const plainSummary = summary.replace(/<[^>]*>/g, '');
        const deliveryJid = category?.whatsapp_delivery_jid || adminJid;
        
        if (deliveryJid) {
          try {
            const sent = await this.whatsapp.sendMessage(deliveryJid, plainSummary);
            if (sent) {
              logger.info(`✅ WhatsApp briefing sent to delivery target: ${deliveryJid}`);
            } else {
              logger.warn(`⚠️ WhatsApp briefing NOT sent to ${deliveryJid} (connection not ready or send failed).`);
            }
          } catch (err) {
            logger.error(`Failed to send WhatsApp briefing to ${deliveryJid}: ${err.message}`);
          }
        } else {
          logger.warn(`⚠️ No WhatsApp delivery target configured for category "${sourcePrefix}". Skipping WhatsApp delivery.`);
        }
      }
      
      // Delivery: Telegram
      if (shouldSendTelegram && telegramInstance) {
        try {
          await telegramInstance.sendMessage(summary);
        } catch (e) {
          logger.error(`Failed to send Telegram briefing for ${sourcePrefix}: ${e.message}`);
        }
      }

      // Update last brief timestamp AFTER successful delivery
      if (!isManualTrigger) {
        this.database.updateLastBriefTimestamp(sourcePrefix, nowTimestamp);
      }
      
      // Persist briefs and summaries
      try {
        if (typeof this.database.saveSummary === 'function') {
          this.database.saveSummary(today, messages.length, summary, true, sourcePrefix);
        }
        if (typeof this.database.saveBrief === 'function') {
          this.database.saveBrief(today, summary, messages.length, sourcePrefix);
        }
        logger.info(`[${sourcePrefix}] Brief and summary persisted to database.`);
      } catch (dbErr) {
        logger.warn(`[${sourcePrefix}] Could not persist brief to database: ${dbErr.message}`);
      }
      
      logger.info(`=== ${sourcePrefix.toUpperCase()} BRIEFING COMPLETED ===`);
    } catch (error) {
      logger.error(`[${sourcePrefix}] Briefing generation failed: ${error.message}`);
      try {
        const category = this.database.getCategoryBySlug(sourcePrefix);
        const deliveryChannel = category?.delivery_channel || 'telegram';
        const shouldSendWhatsApp = deliveryChannel === 'whatsapp' || deliveryChannel === 'both';
        const shouldSendTelegram = deliveryChannel === 'telegram' || deliveryChannel === 'both';
        const adminJid = process.env.WHATSAPP_ADMIN_JID;
        const deliveryJid = category?.whatsapp_delivery_jid || adminJid;
        
        if (shouldSendWhatsApp && deliveryJid) {
          const plainError = `⚠️ *Briefing Error*\n\nFailed to generate today's ${sourcePrefix.toUpperCase()} summary.\nError: ${error.message}`;
          await this.whatsapp.sendMessage(deliveryJid, plainError);
        }
        if (shouldSendTelegram && telegramInstance) {
            await telegramInstance.sendMessage(
              `⚠️ <b>Briefing Error</b>\n\nFailed to generate today's ${sourcePrefix.toUpperCase()} summary.\nError: ${error.message}`
            );
        }
      } catch (e) {
        logger.error(`Could not dispatch error notification: ${e.message}`);
      }
    }
  }

  async triggerNow(slug) {
    if (slug) {
      logger.info(`⚡ Manual trigger for category: ${slug}`);
      await this._runSingleCategoryBrief(slug, true);
    } else {
      logger.info('⚡ Manual summary trigger requested across all profiles.');
      await this._runAllCategoryBriefs();
    }
  }

  getStatus() {
    return this.jobs
      .filter(j => j.ruleId !== null)
      .map(j => ({ ruleId: j.ruleId, categorySlug: j.categorySlug, label: j.label, active: true }));
  }

  updateBotInstances(newBotInstances) {
    this.botInstances = newBotInstances;
    logger.info(`🔄 Scheduler bot instances updated. Active: ${Array.from(this.botInstances.keys()).join(', ')}`);
  }

  stop() {
    logger.info('Stopping all scheduler cron jobs...');
    this.jobs.forEach(j => j.job.stop());
    this.jobs = [];
    logger.info('Scheduler successfully stopped.');
  }
}

module.exports = Scheduler;
