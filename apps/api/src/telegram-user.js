/**
 * Telegram User Listener Module
 * Connects as a real Telegram user session (MTProto) using gramjs (Puppeteer-free).
 * Supports OTP, 2FA verification, channel discovery, and private channel scraping.
 */

const { TelegramClient, Api, password } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class TelegramUserListener {
constructor(database, onAlert) {
    this.database = database;
    this.onAlert = onAlert;
    this.sessionPath = '/app/data/telegram_user_session.txt';
    
    // Debounce session saves to prevent excessive I/O
    this._sessionSaveTimer = null;
    this._sessionSavePending = false;
    
    // Load API credentials strictly from environment — no hardcoded fallbacks.
    // Ensure TELEGRAM_API_ID and TELEGRAM_API_HASH are set in your .env file.
    // Get them from: https://my.telegram.org/apps
    const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
    const apiHash = process.env.TELEGRAM_API_HASH || '';

    if (!apiId || !apiHash) {
      throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment. Get them from https://my.telegram.org/apps');
    }
    
    this.apiId = apiId;
    this.apiHash = apiHash;
    
    let initialSession = '';
    if (fs.existsSync(this.sessionPath)) {
      initialSession = fs.readFileSync(this.sessionPath, 'utf8').trim();
    }
    
    let clientOptions = {
      connectionRetries: 10,
      requestRetries: 5,
      useWSS: false,
    };

    const proxyUrl = process.env.TELEGRAM_PROXY;
    if (proxyUrl) {
      const url = require('url');
      const parsed = url.parse(proxyUrl);
      clientOptions.proxy = {
        ip: parsed.hostname,
        port: parseInt(parsed.port, 10),
        socksType: 5,
      };
      if (parsed.auth) {
        const [username, pass] = parsed.auth.split(':');
        clientOptions.proxy.username = username;
        clientOptions.proxy.password = pass;
      }
      logger.info(`🔌 Routing Telegram User through SOCKS5 proxy: ${parsed.hostname}:${parsed.port}`);
    }

    this.session = new StringSession(initialSession);
    this.client = new TelegramClient(this.session, this.apiId, this.apiHash, clientOptions);
    this.isListening = false;
    this.tempPhone = null;
    this.tempPhoneCodeHash = null;
    this.tempResolver = null;
  }

  async start() {
    try {
      logger.info('📱 Starting Telegram User client...');
      await this.client.connect();
      const isAuthorized = await this.client.isUserAuthorized();
      if (isAuthorized) {
        this._saveSession();
        logger.info('✅ Telegram User client authorized. Attaching message listener...');
        const tgSources = this.database.getAllSources().filter(
          s => s.is_active === 1 && s.type.includes('telegram')
        );
        for (const src of tgSources) {
          this.database.upsertScraperHealth(src.source_id, src.type, true, null);
        }
        await this._attachListener();
        this.isListening = true;
        return true;
      } else {
        const tgSources = this.database.getAllSources().filter(
          s => s.is_active === 1 && s.type.includes('telegram')
        );
        for (const src of tgSources) {
          this.database.upsertScraperHealth(src.source_id, src.type, false, 'Not authorized');
        }
        logger.warn('⚠️ Telegram User client NOT authorized. Dashboard login required.');
        return false;
      }
    } catch (err) {
      const isAuthKeyUnregistered = String(err.errorMessage || err.message || '').includes('AUTH_KEY_UNREGISTERED') || String(err.message || '').includes('AUTH_KEY_UNREGISTERED');
      if (isAuthKeyUnregistered) {
        logger.error('⚠️ Telegram session invalidated (AUTH_KEY_UNREGISTERED). Clearing stored session — dashboard re-login required.');
        try {
          if (fs.existsSync(this.sessionPath)) {
            fs.unlinkSync(this.sessionPath);
            logger.info('Removed invalidated Telegram session file.');
          }
        } catch (e) { /* ignore */ }
        this.session = new StringSession('');
        if (this.onAlert) {
          this.onAlert('⚠️ <b>Telegram User Session Invalidated</b>\n\nThe Telegram user session (AUTH_KEY_UNREGISTERED) has expired. Please re-login via the Web Dashboard.');
        }
        return false;
      }
      logger.error(`Telegram User client start failed: ${err.message}`);
      return false;
    }
  }

  async sendCode(phoneNumber) {
    this.tempPhone = phoneNumber;
    try {
      const result = await this.client.invoke(new Api.auth.SendCode({
        phoneNumber,
        apiId: this.apiId,
        apiHash: this.apiHash,
        settings: new Api.CodeSettings({ allowFlashcall: false, currentNumber: true, allowAppHash: true }),
      }));
      this.tempPhoneCodeHash = result.phoneCodeHash;
      logger.info(`📱 Telegram OTP sent to ${phoneNumber}`);
      return { success: true };
    } catch (err) {
      logger.error(`sendCode error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async submitCode(code, twoFactorPassword = '') {
    if (!this.tempPhone || !this.tempPhoneCodeHash) {
      throw new Error('No active login session. Please send code first.');
    }
    try {
      await this.client.invoke(new Api.auth.SignIn({
        phoneNumber: this.tempPhone,
        phoneCodeHash: this.tempPhoneCodeHash,
        phoneCode: code,
      }));
    } catch (err) {
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        if (!twoFactorPassword) {
          throw new Error('2FA is enabled on this account. Please enter your 2FA password.');
        }
        const passwordInfo = await this.client.invoke(new Api.account.GetPassword());
        const passwordCheck = await password.computeCheck(passwordInfo, twoFactorPassword);
        await this.client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));
      } else {
        throw err;
      }
    }

    this._saveSession();

    await this._attachListener();
    this.isListening = true;
    this.tempPhone = null;
    this.tempPhoneCodeHash = null;
    return { success: true };
  }

  async logout() {
    try {
      await this.client.invoke(new Api.auth.LogOut());
    } catch (e) { /* ignore */ }
    if (fs.existsSync(this.sessionPath)) {
      fs.unlinkSync(this.sessionPath);
    }
    this.isListening = false;
    this.session = new StringSession('');
    this.client = new TelegramClient(this.session, this.apiId, this.apiHash, { connectionRetries: 5 });
    logger.info('✅ Telegram User logged out and session cleared.');
    return { success: true };
  }

  getStatus() {
    return {
      isReady: this.isListening,
      tempPhone: this.tempPhone || null,
    };
  }

  _saveSession() {
    // Debounce session saves to prevent excessive I/O
    if (this._sessionSavePending) {
      clearTimeout(this._sessionSaveTimer);
    }
    this._sessionSavePending = true;
    this._sessionSaveTimer = setTimeout(() => {
      this._sessionSavePending = false;
      this._doSaveSession();
    }, 2000); // 2s debounce
  }

  _doSaveSession() {
    try {
      const sessionString = this.session.save();
      if (sessionString && sessionString.length > 20) {
        const tmp = this.sessionPath + '.tmp';
        fs.writeFileSync(tmp, sessionString, 'utf8');
        fs.renameSync(tmp, this.sessionPath);
        logger.info(`💾 Telegram session saved (${sessionString.length} chars)`);
      } else {
        logger.warn(`⚠️ Telegram _saveSession skipped: ${sessionString ? 'too short (' + sessionString.length + ' chars)' : 'empty string'}`);
      }
    } catch (err) {
      logger.error(`Failed to save Telegram session: ${err.message}`);
    }
  }

  async _attachListener() {
    if (this.isListening) return;
    const { NewMessage, Raw } = require('telegram/events');

    this.client.addEventHandler(async (event) => {
      try {
        const msg = event.message;
        if (!msg || !msg.peerId) return;

        const chat = await event.getChat();
        if (!chat) return;

        const chatId = String(chat.id || '');
        const chatTitle = chat.title || chat.username || chat.firstName || 'Unknown';
        let chatUsername = chat.username ? `@${chat.username}` : chatId;

        // Determine source type based on registered sources
        const allSources = this.database.getAllSources().filter(s => s.is_active === 1);
        let matchedSource = null;
        for (const src of allSources) {
          if (!src.type.includes('telegram')) continue;
          const srcId = src.source_id.replace('@', '').toLowerCase();
          const thisChatId = chatId.toLowerCase();
          const thisUsername = (chat.username || '').toLowerCase();
          if (srcId === thisChatId || srcId === thisUsername) {
            matchedSource = src;
            break;
          }
        }

        if (!matchedSource) return;

        const chatTypeName = chat.className === 'Channel' ? (chat.megagroup ? 'forum' : 'channel') : 'group';

        const instanceId = this.database.ensureSourceInstance(
          matchedSource.id,
          matchedSource.type,
          chatId,
          chatTitle,
          chatTypeName
        );

        const bodyText = msg.message || '';
        if (!bodyText.trim()) return;

        const senderId = msg.fromId ? String(msg.fromId.userId || msg.fromId.channelId || '') : '';
        const senderName = (msg.from?.firstName || msg.from?.username || chat.title || 'Channel');

        const messageData = {
          message_id: `tguser-${chatId}-${msg.id}`,
          group_id: chatId,
          group_name: chatTitle,
          chat_type: chatTypeName,
          sender_name: senderName,
          sender_id: senderId,
          body: bodyText,
          timestamp: msg.date,
          source_type: matchedSource.type,
          is_reply: msg.replyTo ? 1 : 0,
          reply_to: msg.replyTo ? String(msg.replyTo.replyToMsgId) : null,
          media_type: msg.media ? msg.media.className : null,
          url: null,
          instanceFk: instanceId,
        };

        const inserted = this.database.insertMessage(messageData);
        if (inserted) {
          logger.info(`📨 [TGUser] New message from ${chatTitle} (${matchedSource.type}): ${bodyText.substring(0, 80)}`);
        }
      } catch (err) {
        logger.error(`Error processing Telegram user message: ${err.message}`);
      }
    }, new NewMessage({}));

    logger.info('✅ Telegram User message listener attached.');
  }

  async discoverGroups() {
    try {
      const dialogs = await this.client.getDialogs({ limit: 100 });
      const groups = [];
      for (const d of dialogs) {
        if (d.isGroup || d.isChannel) {
          groups.push({
            id: String(d.id),
            title: d.title,
            username: d.entity?.username || null,
            type: d.isChannel ? 'channel' : 'group',
            participantCount: d.entity?.participantsCount || 0,
          });
        }
      }
      return groups;
    } catch (err) {
      logger.error(`discoverGroups error: ${err.message}`);
      return [];
    }
  }
}

module.exports = TelegramUserListener;
