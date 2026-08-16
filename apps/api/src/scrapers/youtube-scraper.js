/**
 * YouTube Scraper
 * Pure HTTP scraper (Puppeteer-free).
 * Monitors channel RSS feeds, downloads captions directly, and summarizes via the central Summarizer.
 *
 * FAILPROOF THREE-LAYER TRANSCRIPT PIPELINE:
 * - Layer 1: yt-dlp --write-subs --write-auto-subs (auto/uploaded captions, no audio download).
 * - Layer 2: yt-dlp audio download + Gemini 3.1 Flash Lite speech-to-text.
 * - Layer 3: Google Search Grounding via Gemini 2.5 Flash (reconstructs video content from web).
 * - Automatically cleans up all temporary files to maintain zero disk footprint.
 */

const axios = require('axios');
const { spawn } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

class YoutubeScraper {
  constructor(database, summarizer) {
    this.database = database;
    this.summarizer = summarizer;
    this.checkInterval = 60 * 60 * 1000; // Hourly check
    this.intervalId = null;
    // Track consecutive fatal errors (404/deleted channel) per source so we can
    // auto-deactivate dead channels instead of retrying them forever.
    this.consecutiveFatal = {};
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    
    // Initialize standard Gemini client for audio transcription using process.env.GEMINI_API_KEY
    this.geminiKey = process.env.GEMINI_API_KEY || '';
    this.genAI = this.geminiKey ? new GoogleGenerativeAI(this.geminiKey) : null;
  }

  start() {
    logger.info('🚀 Youtube HTTP Scraper initialized (monitors channels hourly)...');
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
    logger.info('🔄 Running YouTube channel scraper session...');
    try {
      const allSources = this.database.getAllSources();
      const activeYoutube = allSources.filter(s => s.is_active === 1 && s.type.endsWith('youtube'));

      if (activeYoutube.length === 0) {
        logger.warn('⚠️ No active YouTube sources. Add one with type "YouTube" in Sources dashboard.');
      }

      for (const source of activeYoutube) {
        await this.scrapeChannel(source);
      }
    } catch (err) {
      logger.error(`Error in scrapeAll YouTube: ${err.message}`);
    }
  }

  async scrapeChannel(source) {
    try {
      let channelId = source.source_id.trim();
      if (source.name) source.name = source.name.trim();

      // Resolve handles/URLs dynamically via Axios
      if (!channelId.startsWith('UC') || channelId.length !== 24) {
        logger.info(`🔍 Resolving YouTube channel handle/URL for: "${source.name}" (${channelId})`);
        try {
          channelId = await this.resolveChannelId(channelId);
          // Update database cache
          this.database.db.prepare('UPDATE sources SET source_id = ? WHERE id = ?').run(channelId, source.id);
          // Keep in-memory object in sync so upsertScraperHealth uses the resolved ID
          source.source_id = channelId;
          logger.info(`✅ Resolved "${source.name}" to channel ID: ${channelId}`);
        } catch (resolveErr) {
          logger.error(`❌ Failed to resolve handle "${channelId}" for "${source.name}": ${resolveErr.message}`);
          return;
        }
      }

      const instanceId = this.database.ensureSourceInstance(
        source.id,
        source.type,
        `yt_channel_${channelId}`,
        source.name,
        'channel'
      );

      logger.info(`📡 Scraping YouTube RSS feed for: "${source.name}" (ID: ${channelId})`);
      const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
      let res;
      try {
        res = await axios.get(url, {
          headers: { 'User-Agent': this.userAgent },
          timeout: 15000
        });
      } catch (httpErr) {
        const status = httpErr.response?.status;
        const fatal = status === 404 || status === 410 || status === 500 || status === 503;
        if (fatal) {
          this.consecutiveFatal[source.id] = (this.consecutiveFatal[source.id] || 0) + 1;
          const strikes = this.consecutiveFatal[source.id];
          if (status === 404) {
            logger.warn(`⚠️ YouTube channel "${source.name}" (${channelId}) not found (404). Channel may have been deleted or ID is invalid.`);
          } else {
            logger.warn(`⚠️ YouTube channel "${source.name}" (${channelId}) HTTP ${status}.`);
          }
          this.database.upsertScraperHealth(source.source_id, source.type, false,
            status === 404 ? 'Channel not found (404)' : `HTTP ${status}`);
          // Auto-deactivate sources that fail fatally 3 times in a row (dead channel).
          if (strikes >= 3 && this.database.toggleSource) {
            logger.error(`❌ YouTube channel "${source.name}" failed ${strikes} consecutive times (${status}). Auto-deactivating source.`);
            this.database.toggleSource(source.id, false);
            this.database.upsertScraperHealth(source.source_id, source.type, false, 'Auto-deactivated (dead channel)');
            delete this.consecutiveFatal[source.id];
          }
        } else if (status === 403) {
          logger.warn(`⚠️ YouTube channel "${source.name}" (${channelId}) access forbidden (403). May be private or restricted.`);
          this.database.upsertScraperHealth(source.source_id, source.type, false, 'Access forbidden (403)');
          this.consecutiveFatal[source.id] = 0;
        } else {
          logger.error(`❌ HTTP error scraping YouTube RSS for "${source.name}": ${httpErr.message}`);
          this.database.upsertScraperHealth(source.source_id, source.type, false, httpErr.message);
        }
        return;
      }

      if (!res.data) {
        logger.warn(`⚠️ Empty response from YouTube RSS for ${source.name}`);
        return;
      }

      const videos = this.parseFeedXml(res.data);
      if (videos.length === 0) {
        logger.info(`ℹ️ No videos found in RSS feed for ${source.name}.`);
        return;
      }

      // Process latest 3 videos
      const latestVideos = videos.slice(0, 3);
      for (const video of latestVideos) {
        const dbId = `yt_${video.id}`;
        
        // Check if already processed
        const exists = this.database.db.prepare('SELECT 1 FROM messages WHERE message_id = ?').get(dbId);
        if (exists) continue;

        logger.info(`🎥 Processing new video: "${video.title}" (ID: ${video.id}) from "${source.name}"`);
        
        let transcript = '';
        let summary = '';

        // Step 0: Direct HTTP caption fetch (most reliable, no yt-dlp)
        try {
          transcript = await this.fetchTranscriptDirect(video.id);
        } catch (err) {
          logger.debug(`Direct caption fetch failed for ${video.id}: ${err.message}`);
        }

        // Step 1: Try yt-dlp subtitle/transcript download (backup)
        if (!transcript || transcript.length < 100) {
          try {
            transcript = await this.fetchTranscript(video.id);
          } catch (err) {
            logger.warn(`yt-dlp subtitle fetch unavailable for video ${video.id}.`);
          }
        }

        // Step 2: Gemini Audio Fallback if standard subtitles failed or returned empty
        if (!transcript || transcript.length < 100) {
          logger.info(`🎙️ Triggering Gemini Audio Fallback for video ${video.id}...`);
          try {
            transcript = await this.transcribeAudioWithGemini(video.id);
          } catch (audioErr) {
            logger.error(`❌ Gemini Audio Fallback failed for video ${video.id}: ${audioErr.message}`);
          }
        }

        // Step 3: Summarize via unified pipeline
        try {
          if (transcript && transcript.length > 50) {
            summary = await this.summarizer.summarizeYoutubeVideo(video.title, transcript, source.type);
          }
        } catch (sumErr) {
          logger.error(`Error summarizing video ${video.id}: ${sumErr.message}`);
        }

        if (!summary || summary.includes('Failed to generate')) {
          summary = `📄 <b>New video published:</b> ${video.title}\n🔗 https://youtu.be/${video.id}`;
        }

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
          instanceFk: instanceId
        });

        logger.info(`✅ Successfully processed video summary for "${video.title}"`);
      }

      this.database.upsertScraperHealth(
        source.source_id, source.type,
        videos.length > 0,
        videos.length === 0 ? 'No videos found in RSS feed' : null
      );
    } catch (err) {
      logger.error(`Error scraping channel ${source.name}: ${err.message}`);
      this.database.upsertScraperHealth(source.source_id, source.type, false, err.message);
    }
  }

  /**
   * LAYER 2: yt-dlp Audio Download + Gemini Speech-to-Text
   * - Uses the system yt-dlp binary (installed in Dockerfile) to download the lowest-quality audio.
   * - yt-dlp natively handles YouTube bot detection without needing cookies or a browser.
   * - Optionally uses a cookies.txt file if present for age-restricted or private videos.
   * - Sends the downloaded audio buffer inline to Gemini 3.1 Flash Lite for transcription.
   * - Falls back to Google Search Grounding (Layer 3) if yt-dlp itself fails.
   */
  async transcribeAudioWithGemini(videoId) {
    if (!this.genAI) {
      throw new Error('Gemini API key is not configured.');
    }

    const tempDir = path.resolve(__dirname, '../../data/temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const outputPath = path.join(tempDir, `${videoId}.m4a`);
    let cookiePath = null;

    try {
      logger.info(`📥 [yt-dlp] Downloading lowest-quality audio for video ${videoId}...`);

      // Build yt-dlp arguments
      const ytdlpArgs = [
        `https://www.youtube.com/watch?v=${videoId}`,
        '--format', 'bestaudio/worstaudio/best', // Prefer audio, no strict bitrate filter (causes "format not available")
        '--extract-audio',
        '--audio-format', 'm4a',
        '--audio-quality', '9',            // Lowest quality = smallest file
        '--no-playlist',
        '--no-warnings',
        '--quiet',
        '--no-progress',
        '--output', outputPath
      ];

      // Export YouTube cookies from database to Netscape-format temp file for yt-dlp
      cookiePath = path.resolve(__dirname, `../../data/yt_cookies_${videoId}.txt`);
      const ytCookies = this.database.getCookies('youtube');
      if (ytCookies && Array.isArray(ytCookies) && ytCookies.length > 0) {
        const netscapeLines = ytCookies.map((c) => {
          const domain = c.domain || '.youtube.com';
          const domainFlag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
          const p = c.path || '/';
          const secure = c.secure ? 'TRUE' : 'FALSE';
          const expires = c.expirationDate || Math.floor(Date.now() / 1000) + 86400 * 365;
          return `${domain}\t${domainFlag}\t${p}\t${secure}\t${expires}\t${c.name}\t${c.value}`;
        });
        fs.writeFileSync(cookiePath, `# Netscape HTTP Cookie File\n${netscapeLines.join('\n')}\n`);
        ytdlpArgs.push('--cookies', cookiePath);
        logger.debug(`🍪 Exported ${ytCookies.length} YouTube cookies from DB to yt-dlp.`);
      }

      // Run yt-dlp as a child process
      await new Promise((resolve, reject) => {
        const proc = spawn('yt-dlp', ytdlpArgs);
        let stderr = '';

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim()}`.substring(0, 300)));
          }
        });

        proc.on('error', (err) => {
          reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
        });
      });

      const audioBytes = fs.readFileSync(outputPath);
      logger.info(`🎙️ [yt-dlp] Downloaded ~${Math.round(audioBytes.length / 1024)} KB audio. Sending to Gemini 3.1 Flash Lite...`);

      // Construct native inline multimodal part for Gemini
      const audioPart = {
        inlineData: {
          data: audioBytes.toString('base64'),
          mimeType: 'audio/mp4'
        }
      };

      const model = this.genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
      const prompt = 'Transcribe this audio accurately. Write it in the original language (Hindi/English/mixed). Provide a clean, readable text output with no timestamps.';

      const result = await model.generateContent([prompt, audioPart]);
      const transcript = result.response.text();

      logger.info(`✅ Gemini Audio transcription completed (~${transcript.length} chars generated)`);
      return transcript;

    } catch (ytdlpErr) {
      logger.warn(`⚠️ yt-dlp audio download failed: ${ytdlpErr.message}. Cascading to Layer 3: Google Search Grounding...`);

      try {
        const model = this.genAI.getGenerativeModel({
          model: 'gemini-2.5-flash',
          tools: [{ googleSearch: {} }]
        });

        const prompt = `Search Google for transcripts, details, articles, or summaries of the YouTube video: https://youtu.be/${videoId}.
Reconstruct a detailed outline of this video's contents, focusing specifically on credit cards, hacks, strategic tricks, savings, or shopping offers discussed.
Provide a complete, long text explanation (~500 words) of the video content.`;

        const result = await model.generateContent(prompt);
        const searchOutput = result.response.text();

        logger.info(`✅ Google Search Grounding retrieved outline successfully (~${searchOutput.length} chars generated)`);
        return searchOutput;
      } catch (groundingErr) {
        logger.error(`❌ Google Search Grounding failed: ${groundingErr.message}`);
        throw new Error(`Both yt-dlp and Google Search Grounding failed: ${groundingErr.message}`);
      }
    } finally {
      // Always cleanup temporary audio and cookie files to maintain zero disk footprint
      if (fs.existsSync(outputPath)) {
        try {
          fs.unlinkSync(outputPath);
          logger.debug(`🧹 Cleaned up temporary audio file: ${outputPath}`);
        } catch (e) {
          logger.debug(`Could not clean up temp file ${outputPath}: ${e.message}`);
        }
      }
      if (fs.existsSync(cookiePath)) {
        try {
          fs.unlinkSync(cookiePath);
          logger.debug(`🧹 Cleaned up temporary cookie file: ${cookiePath}`);
        } catch (e) {
          logger.debug(`Could not clean up temp cookie file ${cookiePath}: ${e.message}`);
        }
      }
    }
  }

  async resolveChannelId(input) {
    let cleanUrl = input.trim();
    if (!cleanUrl.startsWith('http')) {
      if (cleanUrl.startsWith('@')) {
        cleanUrl = `https://www.youtube.com/${cleanUrl}`;
      } else {
        cleanUrl = `https://www.youtube.com/@${cleanUrl}`;
      }
    }

    logger.debug(`Resolving YouTube channel via HTTP: ${cleanUrl}`);
    const res = await axios.get(cleanUrl, {
      headers: { 
        'User-Agent': this.userAgent,
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 15000
    });

    const html = res.data;
    
    // Pattern 1: standard metadata itemprop
    const match = html.match(/<meta[^>]*itemprop="channelId"[^>]*content="([^"]+)"/);
    if (match) return match[1];

    // Pattern 2: direct JSON config channelId value
    const match2 = html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/);
    if (match2) return match2[1];

    // Pattern 3: ytInitialData navigationEndpoint payload
    const match3 = html.match(/"browseId":"(UC[a-zA-Z0-9_-]{22})"/);
    if (match3) return match3[1];

    // Pattern 4: RSS link href resolution
    const match4 = html.match(/href="https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=(UC[a-zA-Z0-9_-]{22})"/);
    if (match4) return match4[1];

    throw new Error('Could not discover Channel ID inside the YouTube page HTML structure.');
  }

  parseFeedXml(xml) {
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;
    const videos = [];
    while ((match = entryRegex.exec(xml)) !== null) {
      const entry = match[1];
      const videoIdMatch = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
      const titleMatch = entry.match(/<title>([^<]+)<\/title>/);
      const publishedMatch = entry.match(/<published>([^<]+)<\/published>/);

      if (videoIdMatch && titleMatch) {
        videos.push({
          id: videoIdMatch[1],
          title: titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
          published: publishedMatch ? new Date(publishedMatch[1]) : new Date()
        });
      }
    }
    return videos;
  }

  /**
   * LAYER 0: Direct HTTP transcript fetch (no yt-dlp, no cookies needed).
   * Fetches the video page, extracts the player response JSON, and fetches
   * captions directly from YouTube's caption API endpoint.
   */
  async fetchTranscriptDirect(videoId) {
    logger.debug(`Fetching captions directly via HTTP for: ${videoId}`);
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const res = await axios.get(videoUrl, {
      headers: { 'User-Agent': this.userAgent, 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 15000
    });
    const html = res.data;

    let playerResponse = null;
    const match = html.match(/ytInitialPlayerResponse\s*=\s*({.*?});\s*(?:var\s|<\/script|\n)/);
    if (match) {
      try { playerResponse = JSON.parse(match[1]); } catch (e) { /* ignore */ }
    }

    if (!playerResponse) {
      const fallback = html.match(/"captions":\s*({.*?}),\s*"videoDetails/);
      if (fallback) {
        try {
          const captionsPart = JSON.parse(`{${fallback[1]}}`);
          playerResponse = { captions: captionsPart };
        } catch (e) { /* ignore */ }
      }
    }

    if (!playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
      throw new Error('No caption tracks found in YouTube page data');
    }

    const tracks = playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
    const prefLangs = ['en', 'hi', 'en-US', 'en-GB'];
    let bestTrack = null;
    for (const lang of prefLangs) {
      bestTrack = tracks.find(t => t.languageCode === lang);
      if (bestTrack) break;
    }
    if (!bestTrack) bestTrack = tracks[0];
    if (!bestTrack) throw new Error('No suitable caption track found');

    let baseUrl = bestTrack.baseUrl;
    if (baseUrl.includes('&fmt=') || !baseUrl.includes('fmt=')) {
      baseUrl += (baseUrl.includes('?') ? '&' : '?') + 'fmt=srv3';
    }
    const captionRes = await axios.get(baseUrl, {
      headers: { 'User-Agent': this.userAgent },
      timeout: 15000
    });

    const xml = captionRes.data;
    const textSegments = xml.match(/<text[^>]*>(.*?)<\/text>/g) || [];
    const lines = textSegments.map(seg => {
      const textMatch = seg.match(/<text[^>]*>(.*?)<\/text>/);
      if (!textMatch) return '';
      return textMatch[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/<[^>]*>/g, '')
        .trim();
    }).filter(Boolean);

    const text = lines.join('\n');
    logger.debug(`✅ Direct caption fetch succeeded (~${text.length} chars, language: ${bestTrack.languageCode})`);
    return text;
  }

  async fetchTranscript(videoId) {
    logger.debug(`Fetching subtitles via yt-dlp --write-subs for: ${videoId}`);

    const tempDir = path.resolve(__dirname, '../../data/temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const outputTemplate = path.join(tempDir, `sub_${videoId}`);
    const ytdlpArgs = [
      `https://www.youtube.com/watch?v=${videoId}`,
      '--write-subs', '--write-auto-subs',
      '--sub-langs', 'en,hi',
      '--skip-download',
      '--convert-subs', 'srt',
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '--no-progress',
      '--extractor-retries', '3',
      '--output', outputTemplate
    ];

    let cookiePath = null;
    const ytCookies = this.database.getCookies('youtube');
    if (ytCookies && Array.isArray(ytCookies) && ytCookies.length > 0) {
      cookiePath = path.resolve(__dirname, `../../data/yt_cookies_${videoId}.txt`);
      const netscapeLines = ytCookies.map((c) => {
        const domain = c.domain || '.youtube.com';
        const domainFlag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
        const p = c.path || '/';
        const secure = c.secure ? 'TRUE' : 'FALSE';
        const expires = c.expirationDate || Math.floor(Date.now() / 1000) + 86400 * 365;
        return `${domain}\t${domainFlag}\t${p}\t${secure}\t${expires}\t${c.name}\t${c.value}`;
      });
      fs.writeFileSync(cookiePath, `# Netscape HTTP Cookie File\n${netscapeLines.join('\n')}\n`);
      ytdlpArgs.push('--cookies', cookiePath);
      logger.debug(`🍪 Exported ${ytCookies.length} YouTube cookies for subtitle fetch.`);
    }

    let subFiles = [];

    try {
      await new Promise((resolve, reject) => {
        const proc = spawn('yt-dlp', ytdlpArgs);
        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`yt-dlp exited code ${code}: ${stderr.trim()}`.substring(0, 300)));
        });
        proc.on('error', (err) => reject(new Error(`Failed to spawn yt-dlp: ${err.message}`)));
      });

      subFiles = fs.readdirSync(tempDir)
        .filter(f => f.startsWith(`sub_${videoId}`) && f.endsWith('.srt'))
        .sort((a, b) => {
          const pref = ['en', 'hi'];
          const ra = pref.findIndex(p => a.includes(`.${p}.`));
          const rb = pref.findIndex(p => b.includes(`.${p}.`));
          return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
        });

      if (subFiles.length === 0) {
        throw new Error('No subtitle files found after yt-dlp run');
      }

      const subPath = path.join(tempDir, subFiles[0]);
      const content = fs.readFileSync(subPath, 'utf-8');

      const text = content
        .replace(/\d+\s*\n\d{2}:\d{2}:\d{2}[,\.]\d+ --> \d{2}:\d{2}:\d{2}[,\.]\d+/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/^\s*[\r\n]/gm, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      logger.debug(`✅ yt-dlp subtitle fetch succeeded (~${text.length} chars from ${subFiles[0]})`);
      return text;
    } finally {
      for (const f of subFiles || []) {
        try { fs.unlinkSync(path.join(tempDir, f)); } catch (e) { /* ignore */ }
      }
      if (cookiePath && fs.existsSync(cookiePath)) {
        try { fs.unlinkSync(cookiePath); } catch (e) { /* ignore */ }
      }
    }
  }
}

module.exports = YoutubeScraper;
