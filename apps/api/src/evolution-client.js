/**
 * Evolution API Client for WhatsApp Integration
 * Replaces Baileys-based WhatsAppListener with Evolution API v2 REST client
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('./logger');

class EvolutionApiClient {
  constructor(database, onAlert, config = {}) {
    this.database = database;
    this.onAlert = onAlert;
    
    this.baseUrl = config.baseUrl || process.env.EVOLUTION_API_URL || 'http://evolution-api:8080';
    this.apiKey = config.apiKey || process.env.EVOLUTION_API_KEY;
    this.instanceName = config.instanceName || process.env.EVOLUTION_INSTANCE_NAME || 'cc-brief';
    this.webhookUrl = config.webhookUrl || process.env.EVOLUTION_WEBHOOK_URL;
    this.webhookSecret = config.webhookSecret || process.env.WEBHOOK_SECRET;
    
    this.targetIds = new Set();
    this.chatNameMap = {};
    this.chatNameMapFile = require('path').resolve(__dirname, '../data/chat-name-map.json');
    this.isReady = false;
    this.latestQr = null;
    this.instanceId = null;
    this._monitorInterval = null;
    
    // HTTP client with auth
    this.http = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'apikey': this.apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    // Load cached chat names
    this._loadChatNameMap();
  }

  _loadChatNameMap() {
    const fs = require('fs');
    if (fs.existsSync(this.chatNameMapFile)) {
      try {
        this.chatNameMap = JSON.parse(fs.readFileSync(this.chatNameMapFile, 'utf8'));
      } catch (err) {
        logger.error(`Failed to parse chat-name-map: ${err.message}`);
      }
    }
  }

  _saveChatNameMap() {
    const fs = require('fs');
    try {
      fs.writeFileSync(this.chatNameMapFile, JSON.stringify(this.chatNameMap, null, 2));
    } catch (err) {
      logger.error(`Failed to save chat-name-map: ${err.message}`);
    }
  }

  async initialize() {
    logger.info(`Initializing Evolution API client for instance: ${this.instanceName}`);
    
    try {
      // Check if instance exists
      const exists = await this._instanceExists();
      
      if (!exists) {
        logger.info(`Creating new Evolution API instance: ${this.instanceName}`);
        await this._createInstance();
      } else {
        logger.info(`Instance ${this.instanceName} already exists, connecting...`);
        await this._connectInstance();
      }
      
      // Wait for connection and get QR if needed
      await this._waitForConnection();
      
      // Verify connection is actually open before proceeding
      const finalState = await this.getConnectionState();
      logger.info(`Final WhatsApp connection state after wait: ${finalState}`);
      if (finalState === 'open' || finalState === 'connected') {
        await this._onConnected();
      } else {
        logger.warn(`WhatsApp not connected (state: ${finalState}). Webhook and group sync will be deferred until connection is established.`);
        this.isReady = false;
        // Start background monitor to detect when QR is scanned and connection becomes open
        this._startConnectionMonitor();
      }
      
      logger.info('Evolution API client initialized successfully');
      return true;
    } catch (err) {
      logger.error(`Failed to initialize Evolution API client: ${err.message}`);
      throw err;
    }
  }

  async _onConnected() {
    this.isReady = true;
    logger.info('WhatsApp connection confirmed: open');
    this.latestQr = null;
    
    // Small delay to let Evolution API fully stabilize after connection
    await new Promise(r => setTimeout(r, 2000));
    
    // Setup webhook and sync groups
    if (this.webhookUrl) {
      await this._setupWebhook();
    }
    await this._syncGroups();
  }

  _startConnectionMonitor() {
    if (this._monitorInterval) return;
    logger.info('Starting connection state monitor (polls every 15s)...');
    this._monitorInterval = setInterval(async () => {
      try {
        const state = await this.getConnectionState();
        if (state === 'open' || state === 'connected') {
          logger.info('Connection detected as open by monitor. Setting up webhook and syncing groups...');
          clearInterval(this._monitorInterval);
          this._monitorInterval = null;
          await this._onConnected();
        }
      } catch (err) {
        logger.debug(`Connection monitor error: ${err.message}`);
      }
    }, 15000);
  }

  async stop() {
    logger.info('Stopping Evolution API client...');
    this.isReady = false;
    if (this._monitorInterval) {
      clearInterval(this._monitorInterval);
      this._monitorInterval = null;
    }
  }

  async _instanceExists() {
    try {
      const res = await this.http.get(`/instance/fetchInstances`);
      const instances = res.data || [];
      return instances.some(i => i.name === this.instanceName);
    } catch (err) {
      logger.debug(`Instance check failed: ${err.message}`);
      return false;
    }
  }

  async _createInstance() {
    const res = await this.http.post('/instance/create', {
      instanceName: this.instanceName,
      token: this.apiKey,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      rejectCall: true,
      msgCall: 'Chamada rejeitada automaticamente',
      groupsIgnore: false,
      alwaysOnline: true,
      readMessages: true,
      readStatus: false,
      syncFullHistory: false
    });
    this.instanceId = res.data?.instance?.instanceId || res.data?.instanceId;
    return res.data;
  }

  async resetInstance() {
    logger.info(`Resetting Evolution API instance: ${this.instanceName}`);
    this.isReady = false;
    this.latestQr = null;
    try {
      await this.http.delete(`/instance/delete/${this.instanceName}`);
    } catch (err) {
      logger.debug(`Delete instance: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 3000));
    await this._createInstance();
    await this._connectInstance();
    return true;
  }

  async _connectInstance() {
    try {
      await this.http.get(`/instance/connect/${this.instanceName}`);
    } catch (err) {
      // Ignore if already connecting
      logger.debug(`Connect instance: ${err.message}`);
    }
  }

  async _waitForConnection(maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
      const state = await this.getConnectionState();
      logger.info(`WhatsApp connection state: ${state}`);
      
      if (state === 'open' || state === 'connected') {
        // Don't set isReady here - let initialize() handle it after final verification
        this.latestQr = null;
        return true;
      }
      
      if (state === 'close' || state === 'connecting') {
        // Get QR code
        const qr = await this._getQrCode();
        if (qr) {
          this.latestQr = qr;
          logger.info('QR code generated. Scan with WhatsApp.');
          if (this.onAlert) {
            await this.onAlert(`New WhatsApp QR code generated for instance ${this.instanceName}. Please scan.`);
          }
        }
      }
      
      await new Promise(r => setTimeout(r, 5000));
    }
    
    logger.warn('Max connection attempts reached. Instance may still be connecting.');
    return false;
  }

  async _getQrCode() {
    try {
      const res = await this.http.get(`/instance/connect/${this.instanceName}`);
      const raw = res.data?.qrcode?.base64 || res.data?.base64 || res.data?.qrcode?.code || null;
      if (raw) {
        return raw;
      }
      return null;
    } catch (err) {
      logger.debug(`Get QR failed: ${err.message}`);
      return null;
    }
  }

  async fetchFreshQr(force = false) {
    try {
      const state = await this.getConnectionState();
      if (state === 'open' || state === 'connected') {
        this.latestQr = null;
        return null;
      }
      // Only fetch new QR if we don't have one or explicitly requested
      // Calling /instance/connect generates a NEW QR, invalidating the previous one
      if (!force && this.latestQr) {
        return this.latestQr;
      }
      const qr = await this._getQrCode();
      if (qr) {
        this.latestQr = qr;
        logger.info('QR code fetched');
      }
      return qr || this.latestQr;
    } catch (err) {
      logger.debug(`Fetch fresh QR failed: ${err.message}`);
      return this.latestQr;
    }
  }

  async getConnectionState() {
    try {
      const res = await this.http.get(`/instance/connectionState/${this.instanceName}`);
      return res.data?.instance?.state || res.data?.state || 'unknown';
    } catch (err) {
      logger.debug(`Get connection state failed: ${err.message}`);
      return 'unknown';
    }
  }

  async _setupWebhook() {
    if (!this.webhookUrl) {
      logger.warn('No webhook URL configured, skipping webhook setup');
      return;
    }

    try {
      const webhookEndpoint = `${this.webhookUrl}/api/whatsapp/webhook`;
      logger.debug(`Attempting webhook setup: ${webhookEndpoint}`);
      
      // Evolution API v2.3.7 valid events (from API error response)
      const validEvents = [
        'MESSAGES_UPSERT',
        'MESSAGES_UPDATE',
        'MESSAGES_DELETE',
        'SEND_MESSAGE',
        'CONNECTION_UPDATE',
        'QRCODE_UPDATED',
        'CHATS_SET',
        'CHATS_UPSERT',
        'CHATS_DELETE',
        'CONTACTS_SET',
        'CONTACTS_UPSERT',
        'GROUPS_UPSERT',
        'GROUP_UPDATE',
        'GROUP_PARTICIPANTS_UPDATE',
        'PRESENCE_UPDATE'
      ];
      
      // Try webhook setup with retry - Evolution API v2.3.7 expects webhook object
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.http.post(`/webhook/set/${this.instanceName}`, {
            webhook: {
              enabled: true,
              url: webhookEndpoint,
              webhook_by_events: true,
              webhook_base64: false,
              events: validEvents
            }
          });
          
          logger.info(`Webhook configured for ${this.instanceName} at ${webhookEndpoint}`);
          return;
        } catch (err) {
          const status = err.response?.status;
          const responseData = err.response?.data;
          const errorMsg = responseData ? JSON.stringify(responseData) : err.message;
          logger.error(`Webhook setup attempt ${attempt}/3 failed (${status}): ${errorMsg}`);
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 3000 * attempt));
          }
        }
      }
      logger.error('Webhook setup failed after 3 attempts');
    } catch (err) {
      const status = err.response?.status;
      const responseData = err.response?.data;
      const errorMsg = responseData ? JSON.stringify(responseData) : err.message;
      logger.error(`Failed to setup webhook: ${errorMsg}`, { status });
    }
  }

  async _syncGroups() {
    logger.info('Syncing WhatsApp groups from Evolution API...');
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Evolution API v2.3.7 requires getParticipants query param
        // Increase timeout for this call as it can be slow
        const res = await this.http.get(`/group/fetchAllGroups/${this.instanceName}`, {
          params: { getParticipants: true },
          timeout: 60000
        });
        const groups = res.data || [];
        
        let count = 0;
        for (const group of groups) {
          if (group.id && group.subject) {
            const id = group.id.toLowerCase();
            this.chatNameMap[id] = group.subject;
            count++;
          }
        }
        
        this._saveChatNameMap();
        logger.info(`Synced ${count} groups from Evolution API`);
        
        // Also refresh targets from database
        this._refreshTargets();
        return;
      } catch (err) {
        const status = err.response?.status;
        const responseData = err.response?.data;
        const errorMsg = responseData ? JSON.stringify(responseData) : err.message;
        logger.error(`Group sync attempt ${attempt}/3 failed (${status}): ${errorMsg}`);
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 3000 * attempt));
        }
      }
    }
    logger.error('Group sync failed after 3 attempts');
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

      logger.info(`Mapped ${this.targetIds.size} active WhatsApp targets for filtering`);
    } catch (err) {
      logger.error(`Failed to refresh WhatsApp targets: ${err.message}`);
    }
  }

  async sendMessage(jid, text) {
    // Re-poll live connection state so a dropped socket is detected instead of using stale isReady
    const state = await this.getConnectionState();
    if (state !== 'open' && state !== 'connected') {
      this.isReady = false;
      logger.warn(`Evolution API not ready (state: ${state}), skipping message to ${jid}`);
      return false;
    }
    if (!this.isReady) {
      this.isReady = true;
    }

    try {
      await this.http.post(`/message/sendText/${this.instanceName}`, {
        number: jid.replace('@s.whatsapp.net', '').replace('@g.us', ''),
        text: text,
        delay: 1000,
        linkPreview: false
      });
      logger.info(`Sent WhatsApp message to ${jid}`);
      return true;
    } catch (err) {
      logger.error(`Failed to send WhatsApp message to ${jid}: ${err.message}`);
      return false;
    }
  }

  async handleWebhook(payload, signature) {
    // Verify webhook signature — fail CLOSED. Evolution API signs webhooks with
    // WEBHOOK_SECRET; if it is unset, reject (do not silently accept spoofed events).
    if (!this.webhookSecret) {
      logger.warn('Webhook rejected: WEBHOOK_SECRET not configured');
      return { success: false, error: 'Webhook secret not configured' };
    }
    if (!signature) {
      logger.warn('Webhook rejected: missing signature');
      return { success: false, error: 'Missing signature' };
    }
    const expectedSig = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(JSON.stringify(payload))
      .digest('hex');
    if (signature !== `sha256=${expectedSig}`) {
      logger.warn('Invalid webhook signature');
      return { success: false, error: 'Invalid signature' };
    }

    const { event, data, instance } = payload;
    
    if (instance !== this.instanceName) {
      return { success: true, ignored: true };
    }

    try {
      switch (event) {
        case 'MESSAGES_UPSERT':
          await this._handleMessagesUpsert(data);
          break;
        case 'CONNECTION_UPDATE':
          await this._handleConnectionUpdate(data);
          break;
        case 'QRCODE_UPDATED':
          await this._handleQrCodeUpdated(data);
          break;
        case 'CHATS_SET':
        case 'CHATS_UPSERT':
          await this._handleChatsUpdate(data);
          break;
        case 'GROUPS_UPSERT':
        case 'GROUPS_UPDATE':
          await this._handleGroupsUpdate(data);
          break;
        case 'GROUP_PARTICIPANTS_UPDATE':
          // Handle group participant changes
          break;
      }
    } catch (err) {
      logger.error(`Webhook handler error for ${event}: ${err.message}`);
    }

    return { success: true };
  }

  async _handleMessagesUpsert(data) {
    const { messages } = data;
    if (!messages || !Array.isArray(messages)) return;

    for (const msg of messages) {
      if (!msg.key || msg.key.fromMe) continue;
      
      const remoteJid = msg.key.remoteJid?.toLowerCase();
      if (!remoteJid || !this.targetIds.has(remoteJid)) continue;

      const chatName = this.chatNameMap[remoteJid] || msg.pushName || remoteJid.split('@')[0];
      this.chatNameMap[remoteJid] = chatName;
      this._saveChatNameMap();

      const body = this._extractMessageBody(msg);
      if (!body) continue;

      // Find matching source
      const sources = this.database.getAllSources().filter(
        s => s.is_active === 1 && s.type.endsWith('-whatsapp') && s.source_id.trim().toLowerCase() === remoteJid
      );

      for (const source of sources) {
        const instanceId = this.database.ensureSourceInstance(
          source.id, source.type, source.source_id, source.name, 'whatsapp'
        );

        const messageId = `evolution_${msg.key.id}_${Date.now()}`;
        
        this.database.saveMessage({
          messageId,
          groupName: source.name,
          groupId: source.source_id,
          chatType: 'whatsapp',
          senderName: msg.pushName || 'Unknown',
          body: body,
          timestamp: Math.floor(msg.messageTimestamp || Date.now() / 1000),
          sourceType: source.type,
          instanceFk: instanceId
        });

        this.database.upsertScraperHealth(source.source_id, source.type, true, null);
      }
    }
  }

  _extractMessageBody(msg) {
    const message = msg.message;
    if (!message) return null;

    // Handle different message types
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return `[Image] ${message.imageMessage.caption}`;
    if (message.videoMessage?.caption) return `[Video] ${message.videoMessage.caption}`;
    if (message.documentMessage?.title) return `[Document] ${message.documentMessage.title}`;
    if (message.audioMessage) return '[Audio message]';
    if (message.stickerMessage) return '[Sticker]';
    if (message.locationMessage) return '[Location]';
    if (message.contactMessage) return '[Contact]';
    if (message.reactionMessage) return `[Reaction] ${message.reactionMessage.text}`;
    
    return JSON.stringify(message).substring(0, 200);
  }

  async _handleConnectionUpdate(data) {
    const { state } = data;
    logger.info(`WhatsApp connection state changed: ${state}`);
    
    this.isReady = state === 'open' || state === 'connected';
    
    if (!this.isReady && this.onAlert) {
      const plainMsg = `WhatsApp connection state: ${state}`;
      await this.onAlert(plainMsg);
    }
  }

  async _handleQrCodeUpdated(data) {
    const qr = data?.qrcode?.base64 || data?.qrcode?.code || data?.base64;
    if (qr) {
      this.latestQr = qr;
      logger.info('QR code updated');
      if (this.onAlert) {
        await this.onAlert(`New WhatsApp QR code generated for ${this.instanceName}. Please scan.`);
      }
    }
  }

  async _handleChatsUpdate(data) {
    const chats = data?.chats || data;
    if (!chats || !Array.isArray(chats)) return;

    let count = 0;
    for (const chat of chats) {
      if (chat.id && chat.name) {
        const id = chat.id.toLowerCase();
        if (id.includes('@g.us') || id.includes('@newsletter') || this.targetIds.has(id)) {
          this.chatNameMap[id] = chat.name;
          count++;
        }
      }
    }
    
    if (count > 0) {
      this._saveChatNameMap();
      logger.info(`Synced ${count} chat names from Evolution API`);
    }
  }

  async _handleGroupsUpdate(data) {
    const groups = data?.groups || data;
    if (!groups || !Array.isArray(groups)) return;

    let count = 0;
    for (const group of groups) {
      if (group.id && group.subject) {
        const id = group.id.toLowerCase();
        this.chatNameMap[id] = group.subject;
        count++;
      }
    }
    
    if (count > 0) {
      this._saveChatNameMap();
      logger.info(`Synced ${count} group names from Evolution API`);
    }
  }

  async discoverChats() {
    await this._syncGroups();
    return this.getAllChats();
  }

  getAllChats() {
    const chats = [];
    for (const [id, name] of Object.entries(this.chatNameMap)) {
      if (id.includes('@g.us') || id.includes('@newsletter')) {
        chats.push({ id, name, isGroup: id.includes('@g.us'), isNewsletter: id.includes('@newsletter') });
      }
    }
    return chats;
  }

  getStatus() {
    return {
      isReady: this.isReady,
      qr: this.latestQr,
      messageCount: 0, // Could track separately
      targetCount: this.targetIds.size,
      instanceName: this.instanceName
    };
  }

  async restart() {
    logger.info('Restarting Evolution API client...');
    this.isReady = false;
    await this.initialize();
  }

  async reconnect(force = false) {
    // Alias for restart, with optional force parameter
    return this.restart();
  }
}

module.exports = EvolutionApiClient;