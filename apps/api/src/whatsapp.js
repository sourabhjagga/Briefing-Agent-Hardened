/**
 * WhatsApp Module
 * Pure Node.js socket connection using @whiskeysockets/baileys (Puppeteer-free).
 * Mapped to data/baileys_auth session folder for 100% persistent authentication.
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

/**
 * Determines whether a session error is unrecoverable and requires
 * the auth store to be wiped before reconnecting.
 * 
 * "Over 2000 messages into the future" is a RECOVERABLE decryption failure
 * caused by counter mismatch on historical messages, NOT session key corruption.
 * It should NOT trigger session wipe.
 */
function isSessionCorruptionError(err) {
  if (!err || !err.message) return false;
  const msg = err.message;
  // Only treat truly fatal session corruption as wipe-worthy
  return (
    msg.includes('Bad MAC') ||
    // REMOVED: "Over 2000 messages into the future" - recoverable counter mismatch
    // REMOVED: generic "SessionError" - too broad, catches recoverable errors
    msg.includes('Session corrupted') ||  // Explicit session corruption
    msg.includes('Invalid session') ||     // Explicit session invalid
    msg.includes('corrupted session')      // Explicit session corruption
  );
}

class WhatsAppListener {
  constructor(database, onAlert) {
    this.database = database;
    this.onAlert = onAlert;
    this.isReady = false;
    this.messageCount = 0;
    this.isSessionAlerted = false;
    this.latestQr = null;
    this.sock = null;
    this.targetIds = new Set();
    this.authPath = path.resolve(__dirname, '../data/baileys_auth');
    this.chatNameMapFile = path.resolve(__dirname, '../data/chat-name-map.json');
    this.chatNameMap = {};
    // Guard flag to prevent concurrent session-wipe+restart cycles
    this._sessionWipeInProgress = false;

    // Guard flag to prevent concurrent start() calls from creating
    // overlapping sockets (health-check + connection.update + manual restarts).
    this._startInProgress = false;
    
    // Hardened Baileys: reconnection state
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 10;
    this._baseReconnectDelay = 10000;    // 10s initial
    this._maxReconnectDelay = 300000;    // 5min max
    this._backoffMultiplier = 2;         // exponential backoff
    this._lastReconnectTime = 0;
    this._minReconnectInterval = 5000;   // min 5s between reconnects
    
    // QR code cooldown to prevent rapid QR regeneration
    this._lastQrGenerated = 0;
    this._qrCooldownMs = 60000;          // 1min between QR generations
    
    // Connection health monitoring
    this._healthCheckInterval = null;
    this._lastHealthCheck = 0;
    // Consecutive non-open health checks before forcing a reconnect.
    // Guards against transient states (e.g. a socket mid-handshake) killing
    // a healthy connection on a single blip.
    this._staleCheckCount = 0;
    this._maxStaleChecks = 2;

    // Discovery rate-limit: full group/newsletter sync at most once per hour.
    // Running it on every reconnect is what triggers WhatsApp rate-overlimit
    // and the 60s "Timed Out" newsletters query every ~70s.
    this._lastDiscoveryTime = 0;
    this._discoveryCooldownMs = 60 * 60 * 1000;
    
    // Load cached chat names
    if (fs.existsSync(this.chatNameMapFile)) {
      try {
        this.chatNameMap = JSON.parse(fs.readFileSync(this.chatNameMapFile, 'utf8'));
      } catch (err) {
        logger.error(`Failed to parse chat-name-map: ${err.message}`);
      }
    }

    this._refreshTargets();
  }

  /**
   * Calculate exponential backoff delay for reconnection
   */
  _getReconnectDelay() {
    const now = Date.now();
    
    // Respect minimum interval between reconnects
    if (now - this._lastReconnectTime < 5000) {
      this._reconnectAttempts = Math.max(0, this._reconnectAttempts - 1);
    }
    
    // Cap attempts
    if (this._reconnectAttempts >= 10) {
      logger.warn('Max reconnect attempts (10) reached. Resetting counter.');
      this._reconnectAttempts = 0;
    }
    
    const delay = Math.min(
      10000 * Math.pow(2, this._reconnectAttempts),
      300000
    );
    
    this._reconnectAttempts++;
    this._lastReconnectTime = now;
    return delay;
  }

  /**
   * Start connection health monitoring
   */
  _startHealthCheck() {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
    }
    this._healthCheckInterval = setInterval(() => {
      this._performHealthCheck();
    }, 60000); // Check every 60s
  }

  /**
   * Stop health monitoring
   */
  _stopHealthCheck() {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
  }

  /**
   * Perform connection health check
   */
  _performHealthCheck() {
    if (!this.sock || !this.isReady) return;
    if (this._startInProgress) return; // a reconnect is already underway

    const now = Date.now();
    if (now - this._lastHealthCheck < 30000) return;
    this._lastHealthCheck = now;

    try {
      // Baileys >= 6.7 wraps the raw WebSocket in a WebSocketClient exposing
      // isOpen/isClosed getters (raw ws lives at .socket). Older versions expose
      // the raw WebSocket directly. Normalize both into a boolean "isOpen".
      const wsClient = this.sock.ws;
      let isOpen = false;
      if (wsClient) {
        if (typeof wsClient.isOpen === 'boolean') {
          isOpen = wsClient.isOpen;
        } else if (typeof wsClient.readyState === 'number') {
          isOpen = wsClient.readyState === 1; // WebSocket.OPEN
        }
      }

      if (!isOpen) {
        this._staleCheckCount++;
        if (this._staleCheckCount < this._maxStaleChecks) {
          logger.warn(`WebSocket not open (check ${this._staleCheckCount}/${this._maxStaleChecks}), waiting to confirm stale before forcing reconnect...`);
          return;
        }
        this._staleCheckCount = 0;
        logger.warn('WebSocket connection stale (not OPEN for consecutive checks), forcing reconnect...');
        this.isReady = false;
        // Do NOT call start() here. Ending the socket fires connection.update
        // 'close', whose handler schedules the reconnect with backoff. Calling
        // start() directly races that handler and creates overlapping sockets,
        // which rejects in-flight requests with "Boom: Connection Closed".
        this.sock.end(new Error('health-check-stale-connection')).catch(() => {});
      } else {
        this._staleCheckCount = 0;
      }
    } catch (e) {
      logger.debug(`Health check error: ${e.message}`);
    }
  }

  /**
   * Check if QR code generation should be rate limited
   */
  _shouldGenerateQr() {
    const now = Date.now();
    if (now - this._lastQrGenerated < this._qrCooldownMs) {
      logger.warn(`QR code generation rate limited (cooldown: ${this._qrCooldownMs/1000}s)`);
      return false;
    }
    this._lastQrGenerated = now;
    return true;
  }

  /**
   * Reset reconnection state on successful connection
   */
  _resetReconnectState() {
    this._reconnectAttempts = 0;
    this._lastReconnectTime = 0;
    this._startHealthCheck();
  }

  /**
   * Wipes the Baileys auth folder and schedules a fresh start().
   * Safe to call multiple times - only runs once per corruption event.
   */
  _handleSessionCorruption(reason) {
    if (this._sessionWipeInProgress) {
      logger.warn(`Session wipe already in progress, skipping duplicate trigger (reason: ${reason})`);
      return;
    }
    this._sessionWipeInProgress = true;
    logger.error(`WhatsApp session corruption detected (${reason}). Wiping auth and restarting...`);
    try {
      if (this.sock) {
        this.sock.end(new Error('session-corruption-wipe')).catch(() => {});
        this.sock = null;
      }
    } catch (_) { /* ignore */ }
    try {
      if (fs.existsSync(this.authPath)) {
        fs.rmSync(this.authPath, { recursive: true, force: true });
        logger.info('Cleared baileys_auth credentials folder due to session corruption.');
      }
    } catch (err) {
      logger.error(`Failed to clear auth path during session corruption recovery: ${err.message}`);
    }
    this.isReady = false;
    this._reconnectAttempts = 0; // Reset reconnection attempts after wipe
    setTimeout(() => {
      this._sessionWipeInProgress = false;
      logger.info('Restarting WhatsApp socket in clean state after session corruption...');
      this.start();
    }, 5000);
  }

  _refreshTargets() {
    try {
      const allSources = this.database.getAllSources();
      const whatsappSources = allSources.filter(s => s.is_active === 1 && s.type.endsWith('-whatsapp'));
      
      this.targetIds = new Set(whatsappSources.map(s => s.source_id.trim().toLowerCase()));

      let updated = false;
      whatsappSources.forEach(s => {
        if (s.source_id && s.name) {
          const id = s.source_id.trim().toLowerCase();
          if (!this.chatNameMap[id]) {
            this.chatNameMap[id] = s.name;
            updated = true;
          }
        }
      });

      for (const id of Object.keys(this.chatNameMap)) {
        if (!this.targetIds.has(id) && !id.includes('@g.us') && !id.includes('@newsletter')) {
          delete this.chatNameMap[id];
          updated = true;
        }
      }

      if (updated) {
        this._saveChatNameMap();
      }

      logger.info(`Mapped ${this.targetIds.size} active WhatsApp targets for strict ID filtering.`);
    } catch (err) {
      logger.error(`Failed to refresh WhatsApp targets: ${err.message}`);
    }
  }

  async start() {
    if (this._startInProgress) {
      logger.warn('start() already in progress — skipping concurrent call.');
      return;
    }
    this._startInProgress = true;
    logger.info('Initializing WhatsApp Baileys socket client...');
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
      
      const { version, isLatest } = await fetchLatestBaileysVersion().catch((err) => {
        logger.warn(`Could not dynamically fetch WA Web version: ${err.message}. Using stable fallback.`);
        return { version: [2, 3000, 1015024227], isLatest: false };
      });
      logger.info(`WhatsApp client running with version [${version.join('.')}] (Latest: ${isLatest})`);

      this.sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Chrome (Ubuntu)', 'Chrome', '110.0.5481.177'],
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('chats.set', ({ chats }) => {
        if (chats && Array.isArray(chats)) {
          let count = 0;
          chats.forEach(c => {
            if (c && c.id) {
              const id = c.id.toLowerCase().trim();
              if (id.includes('@newsletter') || id.includes('@g.us')) {
                const name = c.name || (id.includes('@newsletter') ? 'WhatsApp Channel' : 'WhatsApp Group');
                this.chatNameMap[id] = name;
                count++;
              }
            }
          });
          if (count > 0) {
            this._saveChatNameMap();
            logger.info(`Synced ${count} active groups/newsletters from history sync (chats.set).`);
          }
        }
      });

      this.sock.ev.on('chats.upsert', (chats) => {
        if (chats && Array.isArray(chats)) {
          let count = 0;
          chats.forEach(c => {
            if (c && c.id) {
              const id = c.id.toLowerCase().trim();
              if (id.includes('@newsletter') || id.includes('@g.us')) {
                const name = c.name || (id.includes('@newsletter') ? 'WhatsApp Channel' : 'WhatsApp Group');
                this.chatNameMap[id] = name;
                count++;
              }
            }
          });
          if (count > 0) {
            this._saveChatNameMap();
            logger.info(`Synced ${count} new/updated groups/newsletters (chats.upsert).`);
          }
        }
      });

      this.sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
        let count = 0;
        if (chats && Array.isArray(chats)) {
          chats.forEach(c => {
            if (c && c.id) {
              const id = c.id.toLowerCase().trim();
              if (id.includes('@newsletter') || id.includes('@g.us')) {
                const name = c.name || (id.includes('@newsletter') ? 'WhatsApp Channel' : 'WhatsApp Group');
                this.chatNameMap[id] = name;
                count++;
              }
            }
          });
        }
        if (contacts && Array.isArray(contacts)) {
          contacts.forEach(c => {
            if (c && c.id) {
              const id = c.id.toLowerCase().trim();
              if (id.includes('@newsletter') || id.includes('@g.us')) {
                const name = c.name || c.notify || (id.includes('@newsletter') ? 'WhatsApp Channel' : 'WhatsApp Group');
                this.chatNameMap[id] = name;
                count++;
              }
            }
          });
        }
        if (count > 0) {
          this._saveChatNameMap();
          logger.info(`Synced ${count} active groups/newsletters from history sync (messaging-history.set).`);
        }
        
        if (messages && Array.isArray(messages)) {
            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;
                try {
                    await this._processIncomingMessage(msg);
                } catch (err) {
                    // Handle "Over 2000 messages into the future" gracefully - skip message, don't wipe session
                    if (err.message && err.message.includes('Over 2000 messages into the future')) {
                        logger.warn(`Skipping historical message due to counter mismatch (recoverable): ${err.message}`);
                        continue;
                    }
                    if (isSessionCorruptionError(err)) {
                        this._handleSessionCorruption(err.message);
                    } else {
                        logger.error(`Error processing history message: ${err.message}`);
                    }
                }
            }
        }
      });

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          // Rate limit QR code generation to prevent spam
          if (!this._shouldGenerateQr()) {
            logger.warn('QR code generation rate limited - skipping');
          } else {
            logger.info('========================================');
            logger.info('  SCAN THIS QR CODE WITH YOUR WHATSAPP');
            logger.info('========================================');
            qrcode.generate(qr, { small: true });
            qrcode.generate(qr, { small: true });
            this.latestQr = qr;

            const adminJid = process.env.WHATSAPP_ADMIN_JID;
            if (adminJid) {
              this.sendMessage(adminJid, `New WhatsApp QR code generated. Please scan to continue.`);
            }
          }
        }

        if (connection === 'close') {
          this.isReady = false;
          this.latestQr = null;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const errorMessage = lastDisconnect?.error?.message;
          const errorDetail = lastDisconnect?.error?.output?.payload?.error || lastDisconnect?.error?.output?.payload?.message || '';
          
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          // Detect session corruption on connection close
          if (lastDisconnect?.error && isSessionCorruptionError(lastDisconnect.error)) {
            this._handleSessionCorruption(errorMessage || 'connection.update close');
            return;
          }
          
          logger.warn(`WhatsApp connection closed. Reason: ${errorMessage || 'unknown'} (${errorDetail}). Code: ${statusCode}. Reconnecting: ${shouldReconnect}`);
          
          if (!this.isSessionAlerted && this.onAlert && !shouldReconnect) {
            this.onAlert('WhatsApp Session Expired / Logged Out. Your WhatsApp session has been logged out. Please open the Web Dashboard and re-scan the QR code.');
            this.isSessionAlerted = true;
          }

          if (shouldReconnect) {
            const delay = this._getReconnectDelay();
            logger.info(`WhatsApp reconnecting in ${Math.round(delay/1000)}s (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})...`);
            setTimeout(() => this.start(), delay);
          } else {
            logger.error('WhatsApp session logged out. Automatically clearing session and generating fresh QR code...');
            try {
              if (fs.existsSync(this.authPath)) {
                fs.rmSync(this.authPath, { recursive: true, force: true });
                logger.info('Successfully cleared baileys_auth credentials folder.');
              }
              setTimeout(() => {
                logger.info('Restarting WhatsApp socket in clean state to generate fresh QR...');
                this.start();
              }, 5000);
            } catch (err) {
              logger.error(`Failed to automatically clear auth path: ${err.message}`);
            }
          }
        } else if (connection === 'open') {
          this.isReady = true;
          this.isSessionAlerted = false;
          this.latestQr = null;
          this._resetReconnectState(); // Reset reconnect state & start health check
          logger.info('WhatsApp socket client successfully connected!');
          await this._discoverChats();
        }
      });

      this.sock.ev.on('messages.upsert', async (upsert) => {
        const { messages, type } = upsert;
        if (type !== 'notify') return;

        for (const msg of messages) {
          if (!msg.message || msg.key.fromMe) continue;
          
          try {
            await this._processIncomingMessage(msg);
          } catch (err) {
            // Handle "Over 2000 messages into the future" gracefully - skip message, don't wipe session
            if (err.message && err.message.includes('Over 2000 messages into the future')) {
              logger.warn(`Skipping incoming message due to counter mismatch (recoverable): ${err.message}`);
              continue;
            }
            if (isSessionCorruptionError(err)) {
              this._handleSessionCorruption(err.message);
              break; // Stop processing further messages; session is being reset
            }
            logger.error(`Error processing incoming WhatsApp message: ${err.message}`);
          }
        }
      });

      this._startInProgress = false;
    } catch (err) {
      // Handle "Over 2000 messages into the future" on startup gracefully
      if (err.message && err.message.includes('Over 2000 messages into the future')) {
        logger.warn(`Startup counter mismatch (recoverable), continuing: ${err.message}`);
        this._startInProgress = false;
        return;
      }
      if (isSessionCorruptionError(err)) {
        this._handleSessionCorruption(err.message);
      } else {
        logger.error(`Failed to start WhatsApp socket client: ${err.message}`);
        setTimeout(() => this.start(), 30000);
      }
      this._startInProgress = false;
    }
  }

  async _processIncomingMessage(msg) {
    const remoteJid = (msg.key.remoteJid || '').toLowerCase();
    
    this._refreshTargets();

    if (!this.targetIds.has(remoteJid)) return;

    const chatName = this.chatNameMap[remoteJid] || msg.pushName || remoteJid.split('@')[0];
    this.chatNameMap[remoteJid] = chatName;
    this._saveChatNameMap();

    const body = msg.message?.conversation || 
                 msg.message?.extendedTextMessage?.text || 
                 msg.message?.imageMessage?.caption || 
                 msg.message?.videoMessage?.caption || 
                 '';

    if (!body) return;

    const isChannel = remoteJid.includes('@newsletter');
    const senderName = msg.pushName || 'WhatsApp User';
    const senderNumber = msg.key.participant ? msg.key.participant.split('@')[0] : '';
    const timestamp = msg.messageTimestamp ? parseInt(msg.messageTimestamp, 10) : Math.floor(Date.now() / 1000);

    const messageData = {
      messageId: msg.key.id,
      groupName: chatName,
      groupId: remoteJid,
      chatType: isChannel ? 'channel' : 'group',
      senderName: senderName,
      senderNumber: senderNumber,
      body: body,
      timestamp: timestamp,
      hasMedia: !!(msg.message?.imageMessage || msg.message?.videoMessage),
      mediaCaption: body,
      isForwarded: !!(msg.message?.extendedTextMessage?.contextInfo?.isForwarded),
      sourceType: 'cc-whatsapp'
    };

    const matchingSource = this.database.getAllSources().find(
      s => s.source_id.trim().toLowerCase() === remoteJid && s.is_active === 1
    );
    messageData.sourceType = matchingSource ? matchingSource.type : 'cc-whatsapp';

    if (matchingSource) {
      const instanceId = this.database.ensureSourceInstance(
        matchingSource.id,
        matchingSource.type,
        remoteJid,
        chatName,
        isChannel ? 'channel' : 'group'
      );
      messageData.instanceFk = instanceId;
    }

    this.database.saveMessage(messageData);
    this.messageCount++;

    logger.debug(`[WhatsApp: ${chatName}] ${senderName}: ${body.substring(0, 60)}`);
  }

  async _discoverChats() {
    const now = Date.now();
    if (now - this._lastDiscoveryTime < this._discoveryCooldownMs) {
      logger.debug('Skipping chat discovery (rate-limited, ran recently).');
      return;
    }
    this._lastDiscoveryTime = now;

    logger.info('Syncing WhatsApp participating chats...');
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      Object.keys(groups).forEach(id => {
        this.chatNameMap[id.toLowerCase()] = groups[id].subject;
      });
      this._saveChatNameMap();
      logger.info(`Synced ${Object.keys(groups).length} participating groups from account.`);
    } catch (err) {
      logger.error(`WhatsApp group discovery failed: ${err.message}`);
    }

    this._syncNewsletters();
  }

  async _syncNewsletters() {
    try {
      logger.info('Fetching subscribed WhatsApp newsletters/channels...');
      let newsletters = null;
      const fetchPromise = (async () => {
        if (typeof this.sock.newsletterGetSubscribed === 'function') {
          return await this.sock.newsletterGetSubscribed();
        }
        if (typeof this.sock.query === 'function') {
          const result = await this.sock.query({
            tag: 'iq',
            attrs: { to: '@s.whatsapp.net', xmlns: 'w:mex', type: 'get' },
            content: [{ tag: 'query', attrs: {}, content: [{ tag: 'list_type', attrs: { v: '2' } }] }]
          });
          return result?.content ? result.content.map(c => ({
            id: c.attrs?.id || c.attrs?.jid,
            name: c.attrs?.name || c.attrs?.subject || 'WhatsApp Channel'
          })).filter(n => n.id) : null;
        }
        return null;
      })();

      // Bound the query with a hard timeout so a hanging request can never
      // block the process or pile up as unhandled rejections.
      newsletters = await Promise.race([
        fetchPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('newsletter sync timed out')), 30000))
      ]);

      if (newsletters?.length > 0) {
        newsletters.forEach(n => {
          const id = (n.id || n.jid).toLowerCase();
          this.chatNameMap[id] = n.name || n.subject || 'WhatsApp Channel';
        });
        this._saveChatNameMap();
        logger.info(`Synced ${newsletters.length} newsletters/channels.`);
      } else {
        logger.info('No newsletters returned.');
      }
    } catch (newsErr) {
      logger.warn(`Could not sync newsletters: ${newsErr.message}`);
    }
  }

  _saveChatNameMap() {
    try {
      fs.writeFileSync(this.chatNameMapFile, JSON.stringify(this.chatNameMap, null, 2), 'utf8');
    } catch (err) {
      logger.error(`Failed to save chat-name-map: ${err.message}`);
    }
  }

  async discoverChats() {
    await this._discoverChats();
    return this.getAllChats();
  }

  getAllChats() {
    return Object.keys(this.chatNameMap).map(id => ({
      id,
      name: this.chatNameMap[id]
    }));
  }

  async sendMessage(jid, text) {
    try {
      if (!this.isReady) {
        logger.warn(`WhatsApp not ready, skipping message to ${jid}`);
        return;
      }
      await this.sock.sendMessage(jid, { text });
      logger.info(`Sent WhatsApp message to ${jid}`);
    } catch (err) {
      logger.error(`Failed to send WhatsApp message to ${jid}: ${err.message}`);
    }
  }

  getStatus() {
    return {
      isReady: this.isReady,
      messageCount: this.messageCount,
      targetCount: this.targetIds.size,
      qr: this.latestQr
    };
  }

  async stop() {
    if (this.sock) {
      await this.sock.end();
      this.isReady = false;
      logger.info('WhatsApp socket connection closed cleanly');
    }
  }
}

module.exports = WhatsAppListener;
