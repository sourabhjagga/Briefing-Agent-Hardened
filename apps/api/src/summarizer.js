/**
 * AI Summarizer Module
 * Handles message grouping, keyword-based smart sampling, token size estimation,
 * batching, and unified model fallback chain using Gemini and OpenRouter.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const logger = require('./logger');

const OPENROUTER_TIMEOUT = parseInt(process.env.OPENROUTER_TIMEOUT || '120000', 10);

// Define a central, easily swappable fallback registry
// Gemini models sourced from Google's current model catalog (verified June 2026).
// OpenRouter models are free-tier only; cross-referenced against OpenRouter API as of June 2026.
// Order: highest capability first, progressively lighter fallbacks.
const FALLBACK_MODELS = [
  // ---- Gemini (Google AI Studio) ----
  { provider: 'gemini', id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (Primary)' },
  { provider: 'gemini', id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash (Frontier)' },
  { provider: 'gemini', id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite (Fastest)' },
  { provider: 'gemini', id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (Reasoning)' },
  { provider: 'gemini', id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite (Budget)' },
  { provider: 'gemini', id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },

  // ---- OpenRouter Free Tier ----
  { provider: 'openrouter', id: 'nousresearch/hermes-3-llama-3.1-405b:free', name: 'OR: Hermes 3 405B' },
  { provider: 'openrouter', id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'OR: Nemotron Ultra 550B' },
  { provider: 'openrouter', id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'OR: Nemotron Super 120B' },
  { provider: 'openrouter', id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'OR: Llama 3.3 70B' },
  { provider: 'openrouter', id: 'qwen/qwen3-coder:free', name: 'OR: Qwen 3 Coder' },
  { provider: 'openrouter', id: 'google/gemma-4-31b-it:free', name: 'OR: Gemma 4 31B' },
  { provider: 'openrouter', id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'OR: Nemotron Nano 30B' },
  { provider: 'openrouter', id: 'qwen/qwen3-next-80b-a3b-instruct:free', name: 'OR: Qwen 3 Next 80B' },
  { provider: 'openrouter', id: 'openai/gpt-oss-120b:free', name: 'OR: GPT-OSS 120B' },
  { provider: 'openrouter', id: 'nvidia/nemotron-nano-9b-v2:free', name: 'OR: Nemotron Nano 9B' },
  { provider: 'openrouter', id: 'google/gemma-4-26b-a4b-it:free', name: 'OR: Gemma 4 26B' },
  { provider: 'openrouter', id: 'cohere/north-mini-code:free', name: 'OR: Cohere North Mini' }
];

class Summarizer {
  constructor(geminiKey, openrouterKey) {
    this.geminiKey = geminiKey;
    this.openrouterKey = openrouterKey;
    
    this.genAI = geminiKey ? new GoogleGenerativeAI(geminiKey) : null;
    
    if (this.genAI) logger.info('🤖 Primary AI: Google Gemini Studio ready.');
    if (this.openrouterKey) logger.info('🤖 Secondary AI: OpenRouter Free Fallbacks ready.');
  }

  async generateSummary(messages, customPrompt = undefined) {
    if (!messages || messages.length === 0) return this._noMessagesTemplate();

    const groupedMessages = this._groupByChat(messages);
    const fullPrompt = this._buildBriefPrompt(groupedMessages, null, customPrompt);
    if (!fullPrompt) return this._noMessagesTemplate();

    const estimatedTokens = fullPrompt.length / 4;
    logger.info(`Estimated prompt token size: ~${Math.round(estimatedTokens)} tokens.`);

    if (estimatedTokens > 200000) {
      logger.warn('Token size exceeds 200K. Executing multi-stage batch processing...');
      return this._batchAndSummarize(groupedMessages);
    }

    return this._callAIWithFallback(fullPrompt, groupedMessages);
  }

  async answerQuestion(question, contextMessages) {
    const msgText = contextMessages.length > 0
      ? contextMessages.map(m => {
          const ts = m.timestamp ? Number(m.timestamp) * 1000 : Date.now();
          const date = new Date(ts).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
          const safeName = m.group_name || 'Unknown';
          return `[${date} | ${safeName}] ${m.sender_name || 'Unknown'}: ${m.body}`;
        }).join('\n')
      : 'No relevant messages found in the database.';

    const prompt = `You are a credit card expert assistant for Indian credit card users.
Answer the following question based ONLY on the messages provided below.
If the answer is not in the messages, say so clearly.

QUESTION: ${question}

CONTEXT MESSAGES:
${msgText}

Provide a concise, accurate, and actionable answer. Use Indian Rupee (₹) symbol where relevant.`;

    try {
      const result = await this._callAIWithFallback(prompt, {}, true);
      return result || 'Sorry, I could not generate an answer. Try rephrasing your question.';
    } catch (err) {
      logger.error(`answerQuestion failed: ${err.message}`);
      return 'Sorry, an error occurred while answering. Please try again.';
    }
  }

  async summarizeYoutubeVideo(title, transcript, sourceType) {
    const isCreditCard = sourceType === 'cc-youtube';
    const focusArea = isCreditCard 
      ? 'Credit Card hacks, reward point valuations, devaluations, bank transfer strategies, or fee waiver tricks.'
      : 'Shopping discount codes, price errors, freebies, cashback promotions, bank card discounts, or hot seasonal sales.';

    const prompt = `You are a professional financial strategist and shopping deal hunter.
Summarize the following YouTube video transcript. Translate it to English if it is in Hindi.

VIDEO TITLE: ${title}

FOCUS AREA:
Strictly isolate and extract any: ${focusArea}

RAW TRANSCRIPT DATA:
${transcript}

OUTPUT RULES:
1. Summarize the video in 4-6 bullet points maximum. Keep it highly actionable and strategic.
2. If the video does NOT contain any direct hacks, strategical tricks, or specific offers (e.g. it is just standard news or generic talk), state that clearly in 1 sentence, and summarize the general topic briefly.
3. Be concise. Avoid conversational fluff or introductory text. Use bold <b> HTML tags for card names/platforms. No markdown. Use ₹ symbol for currency.`;

    try {
      const summary = await this._callAIWithFallback(prompt, {}, true);
      return summary || `Failed to generate summary for video: "${title}"`;
    } catch (err) {
      logger.error(`YouTube summarization failed: ${err.message}`);
      return `Failed to generate summary: ${err.message}\nTopic covers: "${title}"`;
    }
  }

  async _callAIWithFallback(prompt, groupedMessages, isBatchSubtask = false) {
    for (const model of FALLBACK_MODELS) {
      logger.info(`Attempting generation with model: ${model.name}...`);
      try {
        let summary = null;
        
        if (model.provider === 'gemini' && this.genAI) {
          const gm = this.genAI.getGenerativeModel({ model: model.id });
          const result = await gm.generateContent(prompt);
          summary = result.response.text();
        } else if (model.provider === 'openrouter' && this.openrouterKey) {
          const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: model.id,
            messages: [{ role: 'user', content: prompt }]
          }, {
            headers: {
              'Authorization': `Bearer ${this.openrouterKey}`,
              'Content-Type': 'application/json'
            },
            timeout: OPENROUTER_TIMEOUT
          });
          summary = res.data?.choices?.[0]?.message?.content || '';
        }

        if (summary && summary.trim().length > 0) {
          logger.info(`✅ Successful generation using: ${model.name}`);
          return isBatchSubtask ? summary : this._formatSummary(summary);
        }
      } catch (error) {
        logger.warn(`❌ Model ${model.name} failed: ${error.message}`);
      }
    }

    logger.error('🚨 Critical: All primary and fallback AI models in the registry failed.');
    return isBatchSubtask ? null : this._fallbackSummary(groupedMessages);
  }

  async _batchAndSummarize(groupedMessages) {
    const groupNames = Object.keys(groupedMessages);
    const batchSize = Math.max(1, Math.ceil(groupNames.length / 3));
    
    let combinedSummaries = '';
    
    for (let i = 0; i < groupNames.length; i += batchSize) {
      const batchNumber = Math.floor(i / batchSize) + 1;
      const batchGroups = {};
      groupNames.slice(i, i + batchSize).forEach(g => { batchGroups[g] = groupedMessages[g]; });
      
      logger.info(`Processing Batch ${batchNumber}...`);
      const batchPrompt = this._buildBriefPrompt(batchGroups, 1000); 
      
      const batchSummary = await this._callAIWithFallback(batchPrompt, batchGroups, true);
      if (batchSummary) {
        combinedSummaries += `\n\n--- BATCH ${batchNumber} ---\n${batchSummary}`;
      }
      
      await new Promise(r => setTimeout(r, 5000));
    }

    const finalPrompt = `You are "CC Brief AI".
I have processed a massive amount of credit card messages in batches. 
Below are the raw summaries of each batch. 
Combine them into ONE final, cohesive daily brief.

BATCH SUMMARIES:
${combinedSummaries}

OUTPUT FORMAT (strict Telegram HTML — no markdown):
Format matching a cohesive brief, strictly categorized.

STRICT RULES:
- ONLY use Telegram-safe HTML tags: <b>, <i>, <code>, <u>, <s>, <a>. Nothing else.
- Use <b>bold</b> for bank/card names.
- DO NOT hallucinate. Keep it concise.`;

    logger.info('Generating final master brief from batch summaries...');
    return this._callAIWithFallback(finalPrompt, groupedMessages);
  }

  _buildBriefPrompt(groupedMessages, maxOverride = null, customPrompt = undefined) {
    const maxMsgs = maxOverride || parseInt(process.env.MAX_MESSAGES_FOR_SUMMARY, 10) || 2000;
    const groupCount = Object.keys(groupedMessages).length;
    let messageText = '';
    let totalIncluded = 0;

    for (const [groupName, msgs] of Object.entries(groupedMessages)) {
      const limit = Math.max(10, Math.floor(maxMsgs / groupCount));
      const sampled = this._smartSample(msgs, Math.min(limit, msgs.length));
      const validSampled = sampled.filter(m => m.body && m.body.trim().length > 2);
      if (validSampled.length === 0) continue;

      messageText += `\n--- SOURCE: ${groupName} (${msgs.length} msgs total) ---\n`;
      for (const msg of validSampled) {
        const ts = msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now();
        const time = new Date(ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
        messageText += `[${time}] ${msg.sender_name || 'Unknown'}: ${msg.body}\n`;
        totalIncluded++;
      }
    }

    if (totalIncluded === 0) return null;

    const today = this._todayLabel();
    const urlMap = this._extractDealUrls(groupedMessages);
    const urlMapEntries = Object.entries(urlMap);
    const urlMapSection = urlMapEntries.length > 0
      ? `\n⚠️ DEAL URL REFERENCE MAP — CRITICAL:\nEvery deal listed below MUST use the exact URL from this map for its <a href> link.\nDO NOT invent, omit, or modify any URL. Copy them character-for-character.\n${urlMapEntries.map(([title, url]) => `• ${title}\n  URL: ${url}`).join('\n')}\n`
      : '';

    if (customPrompt) {
      return `You are a premium briefing specialist AI.
Your specific persona/instructions:
${customPrompt}

SOURCES MONITORED TODAY:
${Object.keys(groupedMessages).map(g => `• ${g}`).join('\n')}
${urlMapSection}
MESSAGES DATA:
${messageText}

OUTPUT FORMAT (strict Telegram HTML — no markdown):
📰 <b>Daily Briefing</b>
📅 ${today}

(Organize the brief into logical, clean sections with clear headings and bullet points using premium emojis. Under each category, format each item cleanly and select only high-value entries.)

🤖 <i>Generated by Briefing AI</i>

STRICT RULES:
- ONLY use Telegram-safe HTML tags: <b>, <i>, <code>, <u>, <s>, <a>. Nothing else. Do NOT use markdown.
- 🔗 LINKS ARE MANDATORY: Every single deal item MUST end with an <a href="EXACT_URL_FROM_MAP">View Deal</a> or <a href="EXACT_URL_FROM_MAP">Get Deal</a> link. Use the DEAL URL REFERENCE MAP above to find the correct URL for each deal. If a deal has no URL in the map, omit that deal entirely — do NOT include it without a link.
- Format all prices in bold (e.g., <b>₹2,316</b>) and wrap bank card names in bold (e.g. <b>SBI Card</b>).
- Wrap platform names, coupons, or steps in <code>code</code> tags.
- DO NOT hallucinate. Every link, name, and price MUST correspond exactly to the MESSAGES DATA above.`;
    }

    return `You are "CC Brief AI", an expert Indian credit card strategist and forensic analyst.

Task: Analyze the following messages from ${groupCount} WhatsApp groups/channels/forums from today (${today}).
Goal: Produce a smart, actionable daily brief focused on "Hidden Value" for credit card power users.

SOURCES MONITORED TODAY:
${Object.keys(groupedMessages).map(g => `• ${g}`).join('\n')}

CRITICAL ANALYTICAL TASKS:
1. **The "Why"**: Explain *motivation* behind discussions. Don't just list topics.
2. **Loophole Hunting**: Search for specific hacks, workarounds, or "clever" maneuvers:
   - Platforms (PayZapp, Mobikwik, CRED, etc.) bypassing reward restrictions
   - MCC (Merchant Category Code) tricks for high rewards on excluded categories
   - Gift card / voucher arbitrage paths
   - Specific biller IDs that still give rewards
3. **Benefit Analysis**: Clearly state HOW people benefit.
4. **Cross-Group Patterns**: Highlight common topics discussed in multiple groups.

MESSAGES DATA:
${messageText}

OUTPUT FORMAT (strict Telegram HTML — no markdown):
💳 <b>CC Daily Brief</b>
📅 ${today}

🚀 <b>HOT DEALS & BREAKING NEWS</b>
- (Top 2-3 high-impact items: devaluations, launches, limited offers)

💡 <b>KEY DISCUSSIONS & STRATEGY</b>
- (WHY people are talking about certain cards/banks today)
- (Connect dots between groups)

🔓 <b>HACKS, LOOPHOLES & WORKAROUNDS</b>
- (Specific actionable steps, not vague advice)
- (If none found, write "No specific hacks identified today")

📊 <b>STATS</b>
- Total Messages Analyzed: ${totalIncluded}
- Active Sources: ${groupCount}

🤖 <i>Generated by CC Brief AI</i>

STRICT RULES:
- ONLY use Telegram-safe HTML tags: <b>, <i>, <code>, <u>, <s>, <a>. Nothing else.
- Use <b>bold</b> for bank/card names (e.g., <b>HDFC Infinia</b>).
- Use <code>code</code> for biller IDs, platform names, steps.
- Use ₹ (Rupee symbol) for all amounts.
- DO NOT hallucinate. Base all content strictly on the messages above.`;
  }

  _extractDealUrls(groupedMessages) {
    const urlMap = {};
    const anchorRegex = /<a[^>]*\s+href\s*=\s*["']([^"']+)["'][^>]*>/i;
    const titlePatterns = [
      /🔥\s*<b>Deal:<\/b>\s*([^\n<]{5,100})/,
      /📌\s*<b>Title:<\/b>\s*([^\n<]{5,100})/,
      /•\s*<b>([^<]{5,100})<\/b>/,
    ];

    for (const msgs of Object.values(groupedMessages)) {
      for (const msg of msgs) {
        if (!msg.body) continue;
        const anchorMatch = anchorRegex.exec(msg.body);
        if (!anchorMatch) continue;
        const url = anchorMatch[1];
        if (!url || !url.startsWith('http')) continue;

        let title = null;
        for (const pattern of titlePatterns) {
          const m = msg.body.match(pattern);
          if (m) {
            title = m[1].replace(/<[^>]+>/g, '').trim().substring(0, 80);
            break;
          }
        }

        if (!title) {
          title = msg.body.replace(/<[^>]+>/g, '').trim().split('\n')[0].substring(0, 80);
        }

        if (title) {
          urlMap[title] = url;
        }
      }
    }
    return urlMap;
  }

  _smartSample(messages, maxCount) {
    if (messages.length <= maxCount) return messages;
    const highKW = [
      'launch', 'new card', 'devaluation', 'change', 'update', 'offer', 'cashback',
      'reward', 'milestone', 'fee', 'lounge', 'upgrade', 'rbi', 'hdfc', 'sbi',
      'icici', 'axis', 'amex', 'kotak', 'idfc', 'indusind', 'infinia', 'diners',
      'regalia', 'magnus', 'breaking', 'important', 'alert', 'confirmed', 'hack',
      'trick', 'loophole', 'mcc', 'payzapp', 'cred', 'mobikwik', 'voucher',
      'gift card', 'arbitrage', 'waiver', 'accelerate', 'bonus'
    ];
    const lowKW = ['good morning', 'thanks', 'ok', 'yes', 'no', 'lol', 'haha', 'nice', 'welcome', 'hi', 'hello', 'congrats', '👍', '🙏', 'gm'];
    const scored = messages.map((msg) => {
      let score = 0;
      const body = (msg.body || '').toLowerCase();
      for (const kw of highKW) { if (body.includes(kw)) score += 3; }
      for (const kw of lowKW) { if (body.includes(kw)) score -= 2; }
      if (body.length > 100) score += 2;
      if (body.length > 300) score += 3;
      if (body.length < 10) score -= 3;
      if (msg.is_forwarded) score += 1;
      if (body.includes('http')) score += 2;
      return { ...msg, _score: score };
    });
    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, maxCount);
  }

  _groupByChat(messages) {
    const groups = {};
    for (const msg of messages) {
      const g = msg.group_name || 'Unknown';
      if (!groups[g]) groups[g] = [];
      groups[g].push(msg);
    }
    return groups;
  }

  _formatSummary(text) {
    let summary = text.trim();
    summary = summary.replace(/\*\*(.*?)\*\*/gs, '<b>$1</b>');
    summary = summary.replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/gs, '<i>$1</i>');
    summary = summary.replace(/__(.*?)__/gs, '<u>$1</u>');
    summary = summary.replace(/<\/?(?!(?:b|i|code|a|u|s|pre|em|strong|ins|del)\b)[^>]+>/g, '');
    summary = this._repairTelegramHtml(summary);
    return summary;
  }

  _repairTelegramHtml(html) {
    const pairedTags = ['b', 'i', 'u', 's', 'code', 'pre', 'em', 'strong', 'a'];
    for (const tag of pairedTags) {
      const openRegex  = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
      const closeRegex = new RegExp(`</${tag}>`, 'gi');
      const openCount  = (html.match(openRegex)  || []).length;
      const closeCount = (html.match(closeRegex) || []).length;

      if (openCount > closeCount) {
        html += `</${tag}>`.repeat(openCount - closeCount);
      } else if (closeCount > openCount) {
        let seen = 0;
        html = html.replace(new RegExp(`</${tag}>`, 'gi'), (match) => {
          seen++;
          return seen <= openCount ? match : '';
        });
      }
    }
    return html;
  }

  _todayLabel() {
    return new Date().toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
  }

  _noMessagesTemplate() {
    const today = this._todayLabel();
    return `💳 <b>CC Daily Brief</b>\n📅 ${today}\n\n📭 <b>No messages captured today</b>\n\nThe agent is running but no messages have been received from monitored groups yet.\n\n🤖 <i>CC Brief Agent</i>`;
  }

  _fallbackSummary(groupedMessages) {
    const today = this._todayLabel();
    let total = 0;
    let groupSummary = '';
    for (const [name, msgs] of Object.entries(groupedMessages)) {
      total += msgs.length;
      groupSummary += `\n• <b>${name}</b>: ${msgs.length} messages`;
    }
    return `💳 <b>CC Daily Brief</b>\n📅 ${today}\n\n⚠️ <b>AI Unavailable — Raw Stats</b>\nTotal: ${total} messages\n\nSources:${groupSummary}\n\n<i>All AI models failed. Check API keys and connectivity.</i>\n\n🤖 <i>CC Brief Agent</i>`;
  }
}

module.exports = Summarizer;
