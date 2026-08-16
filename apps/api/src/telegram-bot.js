/**
 * Telegram Bot Module
 * Pushes briefings and handles interactive bot commands (/brief, /ask, /search, etc.) via Telegraf.
 * Implements a compiler-grade single-pass tag balancer stack and robust HTML-safety chunking.
 */

const { Telegraf } = require('telegraf');
const logger = require('./logger');

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const VALID_TAGS = new Set(['b', 'i', 'u', 's', 'a', 'code', 'pre', 'em', 'strong', 'span', 'br', 'p']);

function sanitizeMarkdown(text) {
    const parts = [];
    const tagStack = [];
    let lastIdx = 0;
    const tagRe = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;
    let match;

    while ((match = tagRe.exec(text)) !== null) {
        if (match.index > lastIdx) {
            parts.push(esc(text.slice(lastIdx, match.index)));
        }

        const tag = match[0];
        const tagName = match[1].toLowerCase();
        const isClosing = tag.startsWith('</');

        if (isClosing) {
            if (tagStack.length > 0 && tagStack[tagStack.length - 1] === tagName) {
                tagStack.pop();
                parts.push(tag);
            }
        } else if (VALID_TAGS.has(tagName)) {
            tagStack.push(tagName);
            parts.push(tag);
        } else {
            parts.push(esc(tag));
        }

        lastIdx = tagRe.lastIndex;
    }

    if (lastIdx < text.length) {
        parts.push(esc(text.slice(lastIdx)));
    }

    while (tagStack.length > 0) {
        parts.push(`</${tagStack.pop()}>`);
    }

    return parts.join('');
}

const MAX_MESSAGE_LENGTH = 4096;

function splitMessage(text) {
    if (text.length <= MAX_MESSAGE_LENGTH) {
        return [text];
    }

    const chunks = [];
    let currentChunk = '';

    const lines = text.split('\n');
    for (const line of lines) {
        if (currentChunk.length + line.length + 1 > MAX_MESSAGE_LENGTH) {
            chunks.push(currentChunk);
            currentChunk = line;
        } else {
            currentChunk += (currentChunk.length > 0 ? '\n' : '') + line;
        }
    }
    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks.map((chunk, index) => `(${index + 1}/${chunks.length})\n${chunk}`);
}


class TelegramBotDispatcher {
  constructor(botToken, chatId, database, summarizer, sourcePrefix = 'cc', customPrompt = undefined) {
    if (!botToken) throw new Error('Telegram bot token required. Set TELEGRAM_BOT_TOKEN in .env');
    if (!chatId) throw new Error('Telegram chat ID required. Set TELEGRAM_CHAT_ID in .env');

    this.chatId = chatId;
    this.database = database;
    this.summarizer = summarizer;
    this.sourcePrefix = sourcePrefix;
    this.customPrompt = customPrompt;
    
    this.interactive = !!(database && summarizer);
    
    let agent;
    const proxyUrl = process.env.TELEGRAM_PROXY;
    if (proxyUrl) {
      if (proxyUrl.startsWith('socks')) {
        const { SocksProxyAgent } = require('socks-proxy-agent');
        agent = new SocksProxyAgent(proxyUrl);
        logger.info(`🔌 Routing Telegram Bot through SOCKS proxy: ${proxyUrl}`);
      } else {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        agent = new HttpsProxyAgent(proxyUrl);
        logger.info(`🔌 Routing Telegram Bot through HTTP proxy: ${proxyUrl}`);
      }
    }

    this.bot = new Telegraf(botToken, agent ? { telegram: { agent } } : undefined);

    if (this.interactive) {
      this._setupCommands();
    }
  }

  async start() {
    try {
      if (this.interactive) {
        logger.info(`📱 Starting Telegram Bot polling for @${this.sourcePrefix.toUpperCase()} Agent...`);
        this.bot.launch().catch(err => {
          logger.error(`Telegraf bot launch error: ${err.message}`);
        });
      }
      const botInfo = await this.bot.telegram.getMe();
      logger.info(`✅ Telegram Bot verified: @${botInfo.username}`);
      return true;
    } catch (err) {
      logger.error(`Telegram startup verification failed: ${err.message}`);
      return false;
    }
  }

  _setupCommands() {
    this.bot.use(async (ctx, next) => {
      const currentChatId = String(ctx.chat?.id);
      if (currentChatId !== String(this.chatId)) {
        logger.warn(`🔒 Unauthorized bot access attempt from Chat ID: ${currentChatId}`);
        return;
      }
      await next();
    });

    this.bot.command(['start', 'help'], async (ctx) => {
      await ctx.replyWithHTML(
        `🤖 <b>${this.sourcePrefix === 'cc' ? 'Credit Card' : 'Hot Deals'} Briefing Bot</b>\n\n` +
        `/brief — Generate today's summary now\n` +
        `/status — Show agent status &amp; active groups\n` +
        `/groups — List all monitored groups/channels\n` +
        `/ask &lt;question&gt; — Ask AI about credit cards/deals\n` +
        `/search &lt;keyword&gt; — Search past messages\n` +
        `/stats — View 7-day statistics\n` +
        `/total — Total messages stored in DB\n` +
        `/test — Verify latest message from all sources\n` +
        `/help — Show this help manual\n\n` +
        `<i>Briefings are sent automatically at 6 AM, 2 PM &amp; 10 PM IST</i>`
      );
    });

    this.bot.command('brief', async (ctx) => {
      await ctx.reply('⏳ Generating today\'s brief from all monitored groups. Please wait...');
      try {
        const messages = this.database.getTodayMessages(this.sourcePrefix);
        if (messages.length === 0) {
          await ctx.replyWithHTML('📭 <b>No messages collected today yet.</b>\n\nMake sure your WhatsApp/Telegram groups are active.');
          return;
        }
        const summary = await this.summarizer.generateSummary(messages, this.customPrompt);
        await this.sendMessage(summary);
      } catch (err) {
        logger.error(`/brief error: ${err.message}`);
        await ctx.replyWithHTML(`⚠️ <b>Error generating brief:</b> ${esc(err.message)}`);
      }
    });

    this.bot.hears(/^\/ask\s+(.+)$/i, async (ctx) => {
      const question = ctx.match[1];
      await ctx.reply('🔍 Searching and analyzing message repository...');
      try {
        const keywords = question.split(/\s+/).filter(w => w.length > 3);
        let allMessages = [];
        for (const kw of keywords) {
          const msgs = this.database.searchMessages(kw, 15, this.sourcePrefix);
          allMessages.push(...msgs);
        }
        
        const seen = new Set();
        allMessages = allMessages.filter(m => {
          const key = `${m.timestamp}-${m.body?.substring(0, 50)}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const answer = await this.summarizer.answerQuestion(question, allMessages);
        await this.sendMessage(`💡 <b>Answer</b>\n\n${answer}\n\n<i>Based on ${allMessages.length} relevant historical messages</i>`);
      } catch (err) {
        logger.error(`/ask error: ${err.message}`);
        await ctx.replyWithHTML(`⚠️ <b>Error:</b> ${esc(err.message)}`);
      }
    });

    this.bot.hears(/^\/search\s+(.+)$/i, async (ctx) => {
      const keyword = ctx.match[1];
      try {
        const results = this.database.searchMessages(keyword, 10, this.sourcePrefix);
        if (results.length === 0) {
          await ctx.replyWithHTML(`🔍 No messages found matching: <b>${esc(keyword)}</b>`);
          return;
        }

        let response = `🔍 <b>Search: "${esc(keyword)}"</b> (${results.length} results)\n\n`;
        for (const r of results) {
          const date = new Date(r.timestamp * 1000).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
          const snippet = (r.body || '').substring(0, 150);
          response += `📅 ${date} | <b>${esc(r.group_name)}</b>\n${esc(snippet)}\n\n`;
        }
        await this.sendMessage(response);
      } catch (err) {
        logger.error(`/search error: ${err.message}`);
        await ctx.replyWithHTML(`⚠️ <b>Error:</b> ${esc(err.message)}`);
      }
    });

    this.bot.command('stats', async (ctx) => {
      try {
        const stats = this.database.getStats(7, this.sourcePrefix);
        const today = this.database.getTodayMessageCount(this.sourcePrefix);
        let response = `📊 <b>7-Day Statistics</b>\n\nTotal messages: <b>${stats.totalMessages}</b>\nToday: <b>${today}</b>\n\n<b>By Source:</b>\n`;
        for (const g of stats.byGroup) {
          const icon = g.chat_type === 'channel' ? '📢' : g.chat_type === 'forum' ? '🌐' : '👥';
          response += `${icon} ${esc(g.group_name)}: <b>${g.count}</b>\n`;
        }
        await ctx.replyWithHTML(response);
      } catch (err) {
        logger.error(`/stats error: ${err.message}`);
        await ctx.replyWithHTML(`⚠️ <b>Error:</b> ${esc(err.message)}`);
      }
    });

    this.bot.command('groups', async (ctx) => {
      try {
        const allSources = this.database.getAllSources().filter(s => s.type.startsWith(this.sourcePrefix + '-'));
        if (allSources.length === 0) {
          await ctx.reply('ℹ️ No target sources configured for this agent.');
          return;
        }

        const activeToday = new Set(
          this.database.getTodayActiveGroups(this.sourcePrefix).map(g => (g.group_id || '').toLowerCase())
        );

        let response = `🔍 <b>Monitored Sources</b> — ${allSources.length} configured\n`;
        response += `<i>✅ = active today  ⏳ = waiting for post</i>\n\n`;

        for (const s of allSources) {
          const isActive = activeToday.has(s.source_id.toLowerCase());
          const statusIcon = isActive ? '✅' : '⏳';
          let icon = '👥';
          if (s.type.includes('forum')) icon = '🌐';
          if (s.type.includes('telegram')) icon = '📢';
          if (s.type.includes('reddit')) icon = '👽';
          if (s.type.includes('youtube')) icon = '🎥';

          response += `${statusIcon} ${icon} ${esc(s.name)}\n<code>${s.source_id}</code>\n\n`;
        }

        const activeCount = allSources.filter(s => activeToday.has(s.source_id.toLowerCase())).length;
        response += `📊 <b>${activeCount}/${allSources.length}</b> sources active today.`;
        
        await this.sendMessage(response);
      } catch (err) {
        logger.error(`/groups error: ${err.message}`);
        await ctx.replyWithHTML(`⚠️ <b>Error:</b> ${esc(err.message)}`);
      }
    });

    this.bot.command('status', async (ctx) => {
      try {
        const today = this.database.getTodayMessageCount(this.sourcePrefix);
        const activeGroups = this.database.getTodayActiveGroups(this.sourcePrefix);
        const allSources = this.database.getAllSources().filter(s => s.is_active === 1 && s.type.startsWith(this.sourcePrefix + '-'));

        let response = `🟢 <b>Agent Active & Running</b>\n\n`;
        response += `📨 Messages collected today: <b>${today}</b>\n`;
        response += `👥 Active sources today: <b>${activeGroups.length}</b>/${allSources.length}\n\n`;

        if (activeGroups.length > 0) {
          response += `<b>Active Today:</b>\n`;
          for (const g of activeGroups) {
            const icon = g.chat_type === 'channel' ? '📢' : g.chat_type === 'forum' ? '🌐' : '👥';
            response += `${icon} ${esc(g.group_name)}: ${g.count} msgs\n`;
          }
        } else {
          response += `⚠️ No messages captured yet today. Monitoring active...`;
        }

        await ctx.replyWithHTML(response);
      } catch (err) {
        logger.error(`/status error: ${err.message}`);
        await ctx.replyWithHTML(`⚠️ <b>Error:</b> ${esc(err.message)}`);
      }
    });

    this.bot.command('total', async (ctx) => {
      try {
        const stats = this.database.getStats(365, this.sourcePrefix);
        const todayCount = this.database.getTodayMessageCount(this.sourcePrefix);
        await ctx.replyWithHTML(
          `📊 <b>Database Stats</b>\n\n` +
          `Total messages stored: <b>${stats.totalMessages}</b>\n` +
          `Messages collected today: <b>${todayCount}</b>\n\n` +
          `<i>Note: Database automatically cleans up logs older than 30 days.</i>`
        );
      } catch (err) {
        await ctx.replyWithHTML(`⚠️ <b>Error:</b> ${esc(err.message)}`);
      }
    });

    this.bot.command('test', async (ctx) => {
      await ctx.reply('⏳ Requesting latest message verification status across all sources...');
      try {
        const allSources = this.database.getAllSources().filter(s => s.is_active === 1 && s.type.startsWith(this.sourcePrefix + '-'));
        if (allSources.length === 0) {
          await ctx.reply('ℹ️ No active sources configured for verification.');
          return;
        }

        let report = `🔍 <b>Source Verification Status</b>\n`;
        report += `<i>Checking latest captured post in SQLite from each source...</i>\n\n`;

        for (const s of allSources) {
          const lastMsg = this.database.getLatestMessageBySourceFk(s.id);

          let icon = '👥';
          if (s.type.includes('forum')) icon = '🌐';
          if (s.type.includes('telegram')) icon = '📢';
          if (s.type.includes('reddit')) icon = '👽';
          if (s.type.includes('youtube')) icon = '🎥';

          report += `${icon} <b>${esc(s.name)}</b>\n`;

          if (lastMsg) {
            const time = new Date(lastMsg.timestamp * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
            const date = new Date(lastMsg.timestamp * 1000).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
            const cleanBody = (lastMsg.body || '').replace(/<[^>]*>/g, '');
            const snippet = cleanBody.substring(0, 120);
            report += `📅 ${date} | 🕘 ${time} | 👤 ${esc(lastMsg.sender_name || 'System')}\n`;
            report += `<code>${esc(snippet)}${cleanBody.length > 120 ? '...' : ''}</code>\n\n`;
          } else {
            report += `⚠️ <i>No messages captured yet in database. (Waiting for new posts)</i>\n\n`;
          }
        }

        await this.sendMessage(report);
      } catch (err) {
        logger.error(`/test error: ${err.message}`);
        await ctx.replyWithHTML(`⚠️ <b>Error:</b> ${esc(err.message)}`);
      }
    });
  }

  async sendMessage(text) {
    try {
      const rawChunks = splitMessage(text);
      const chunks = rawChunks.map(c => sanitizeMarkdown(c));
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        await this.bot.telegram.sendMessage(this.chatId, chunk, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true }
        });
        if (chunks.length > 1) {
          await new Promise(r => setTimeout(r, 800));
        }
      }
      logger.info(`✅ Dispatched Telegram message summary successfully (${chunks.length} parts).`);
      return true;
    } catch (error) {
      logger.error(`Failed to dispatch Telegram message: ${error.message}`);
      try {
        const plain = text.replace(/<[^>]*>/g, '');
        const chunks = splitMessage(plain);
        for (const chunk of chunks) {
            await this.bot.telegram.sendMessage(this.chatId, chunk);
            if (chunks.length > 1) {
                await new Promise(r => setTimeout(r, 800));
            }
        }
        logger.info('✅ Dispatched Telegram message via plain text fallback successfully.');
        return true;
      } catch (fallbackErr) {
        logger.error(`Telegram plain text fallback also failed: ${fallbackErr.message}`);
      }
      return false;
    }
  }

  async sendStartupNotification() {
    const today = new Date().toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    const allSources = this.database.getAllSources().filter(s => s.is_active === 1 && s.type.startsWith(this.sourcePrefix + '-'));
    
    const msg =
      `🟢 <b>${this.sourcePrefix === 'cc' ? 'CC' : 'Hot Deals'} Brief Agent Started</b>\n\n` +
      `📱 Monitoring <b>${allSources.length}</b> active sources\n` +
      `🌐 All scrapers fully operational\n` +
      `⏰ Scheduled briefings: 6 AM, 2 PM &amp; 10 PM IST\n\n` +
      `📅 ${today} | 🕘 ${time}\n\n` +
      `Type /help to see commands or /status to inspect active groups.`;
    return this.sendMessage(msg);
  }

  async stop() {
    this.bot.stop();
    logger.info('Telegram Bot dispatcher stopped.');
  }
}

module.exports = TelegramBotDispatcher;
