// src/services/backgroundTradeMonitor.js
const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const GlobalOffensive = require('globaloffensive');
const axios = require('axios');

class BackgroundTradeMonitor {
  constructor(logger, keytar, serviceName) {
    this.logger = logger;
    this.keytar = keytar;
    this.serviceName = serviceName;
    this.isRunning = false;
    this.checkInterval = null;
    this.accountSessions = new Map();
    this.lastCheckTime = null;
    this.lastResults = [];
    
    // Configuration
    this.FLASK_TRADE_ENDPOINT = process.env.FLASK_TRADE_ENDPOINT || 
      "https://cswhale-green-dust-4483.fly.dev/api/trade_offers_update";
    this.CHECK_INTERVAL_MINUTES = process.env.CHECK_INTERVAL_MINUTES || 30;
    this.DEVICE_TOKEN_KEY = "cs-assets-device-token";
    this.ACCOUNTS_KEY = "cs-assets-stored-accounts";
  }

  async start() {
    if (this.isRunning) {
      this.logger.warn('Background monitor already running');
      return false;
    }

    this.isRunning = true;
    this.logger.info('Starting background trade monitor...');
    
    // Do initial check after a short delay
    setTimeout(() => {
      this.checkAllAccounts();
    }, 5000);
    
    // Set up interval
    this.checkInterval = setInterval(async () => {
      await this.checkAllAccounts();
    }, this.CHECK_INTERVAL_MINUTES * 60 * 1000);
    
    this.logger.info(`Background monitor started - checking every ${this.CHECK_INTERVAL_MINUTES} minutes`);
    return true;
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    // Clean up all sessions
    for (const [steamId, session] of this.accountSessions) {
      this.cleanupSession(steamId);
    }
    
    this.isRunning = false;
    this.logger.info('Background monitor stopped');
  }

  async getAllAccounts() {
    try {
      const accountsJson = await this.keytar.getPassword(this.serviceName, this.ACCOUNTS_KEY);
      if (!accountsJson) return [];
      return JSON.parse(accountsJson);
    } catch (err) {
      this.logger.error('Error loading accounts from keytar', err);
      return [];
    }
  }

  async getDeviceToken() {
    try {
      return await this.keytar.getPassword(this.serviceName, this.DEVICE_TOKEN_KEY);
    } catch (err) {
      this.logger.error('Error getting device token', err);
      return null;
    }
  }

  async checkAllAccounts() {
    this.logger.info('=== Starting background trade check for all accounts ===');
    const startTime = Date.now();
    
    try {
      // Get all accounts with refresh tokens
      const accounts = await this.getAllAccounts();
      const validAccounts = accounts.filter(acc => 
        acc.refreshToken && acc.refreshToken.trim() !== ''
      );
      
      if (validAccounts.length === 0) {
        this.logger.warn('No accounts with refresh tokens found');
        return [];
      }
      
      this.logger.info(`Found ${validAccounts.length} accounts to check`);
      
      const results = [];
      
      // Check each account sequentially
      for (const account of validAccounts) {
        try {
          this.logger.info(`Checking trades for ${account.displayName || account.steamId}...`);
          const tradeData = await this.checkAccountTrades(account);
          results.push(tradeData);
          
          // Wait 3 seconds between accounts to avoid rate limits
          if (validAccounts.indexOf(account) < validAccounts.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        } catch (error) {
          this.logger.error(`Failed to check ${account.steamId}:`, error);
          results.push({
            steam_id: account.steamId,
            account_name: account.displayName || account.steamId,
            success: false,
            error: error.message,
            timestamp: new Date().toISOString(),
            received_offers: [],
            sent_offers: []
          });
        }
      }
      
      // Store results for status
      this.lastResults = results;
      this.lastCheckTime = new Date();
      
      // Send results to Flask
      await this.sendToFlask(results);
      
      const elapsed = Date.now() - startTime;
      
      // Log summary
      const successful = results.filter(r => r.success).length;
      const totalReceivedOffers = results.reduce((sum, r) => 
        sum + (r.received_offers?.length || 0), 0
      );
      const totalSentOffers = results.reduce((sum, r) => 
        sum + (r.sent_offers?.length || 0), 0
      );
      
      this.logger.info(`=== Trade check complete in ${elapsed}ms ===`);
      this.logger.info(`Checked ${results.length} accounts: ${successful} successful`);
      this.logger.info(`Found ${totalReceivedOffers} received and ${totalSentOffers} sent offers`);
      
      // Send notification if there are new offers
      if (totalReceivedOffers > 0) {
        this.sendNotification(totalReceivedOffers, results);
      }
      
      return results;
      
    } catch (error) {
      this.logger.error('Background check failed:', error);
      return [];
    }
  }

  async checkAccountTrades(account) {
    const { steamId, refreshToken, displayName } = account;
    
    try {
      // Get or create session for this account
      let session = this.accountSessions.get(steamId);
      
      if (!session || !session.user.steamID) {
        this.logger.info(`Creating new session for ${displayName || steamId}`);
        this.cleanupSession(steamId); // Clean up old session if exists
        session = await this.createAccountSession(steamId, refreshToken);
        this.accountSessions.set(steamId, session);
      }
      
      // Fetch trade offers
      const offers = await this.fetchTradeOffers(session.manager);
      
      // Format response
      const tradeData = {
        steam_id: steamId,
        account_name: displayName || steamId,
        success: true,
        timestamp: new Date().toISOString(),
        received_offers: offers.received.map(o => this.formatTradeOffer(o)),
        sent_offers: offers.sent.map(o => this.formatTradeOffer(o))
      };
      
      this.logger.info(`${displayName}: ${offers.received.length} received, ${offers.sent.length} sent`);
      
      return tradeData;
      
    } catch (error) {
      // If session failed, try to clean up and retry once
      if (error.message && (error.message.includes('Not Logged In') || error.message.includes('Invalid'))) {
        this.logger.info(`Session expired for ${displayName}, creating new session...`);
        this.cleanupSession(steamId);
        
        try {
          const newSession = await this.createAccountSession(steamId, refreshToken);
          this.accountSessions.set(steamId, newSession);
          const offers = await this.fetchTradeOffers(newSession.manager);
          
          return {
            steam_id: steamId,
            account_name: displayName || steamId,
            success: true,
            timestamp: new Date().toISOString(),
            received_offers: offers.received.map(o => this.formatTradeOffer(o)),
            sent_offers: offers.sent.map(o => this.formatTradeOffer(o))
          };
        } catch (retryError) {
          throw retryError;
        }
      }
      
      throw error;
    }
  }

  async createAccountSession(steamId, refreshToken) {
    return new Promise((resolve, reject) => {
      const user = new SteamUser();
      const community = new SteamCommunity();
      const manager = new TradeOfferManager({
        steam: user,
        community: community,
        language: 'en',
        pollInterval: -1, // Disable auto-polling
        cancelTime: 300000
      });

      const timeout = setTimeout(() => {
        user.logOff();
        reject(new Error('Session creation timeout'));
      }, 30000);

      let webSessionReceived = false;

      user.on('loggedOn', () => {
        this.logger.info(`Logged on for ${steamId}`);
        user.setPersona(SteamUser.EPersonaState.Online);
      });

      user.on('webSession', (sessionID, cookies) => {
        if (webSessionReceived) return; // Prevent duplicate handling
        webSessionReceived = true;
        
        clearTimeout(timeout);
        community.setCookies(cookies);
        manager.setCookies(cookies, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve({ user, community, manager });
          }
        });
      });

      user.on('error', (err) => {
        clearTimeout(timeout);
        this.logger.error(`Session error for ${steamId}:`, err);
        reject(err);
      });

      // Login with refresh token
      user.logOn({ refreshToken });
    });
  }

  async fetchTradeOffers(manager) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Trade fetch timeout'));
      }, 15000);

      manager.getOffers(
        TradeOfferManager.EOfferFilter.All,  // ← CHANGED TO All
        (err, sent, received) => {
          clearTimeout(timeout);
          if (err) {
            reject(err);
          } else {
            resolve({ sent: sent || [], received: received || [] });
          }
        }
      );
    });
  }

  formatTradeOffer(offer) {
    return {
      offer_id: offer.id,
      partner_steam_id: offer.partner.getSteamID64(),
      state: offer.state,
      state_name: this.getStateName(offer.state),
      is_our_offer: offer.isOurOffer,
      message: offer.message || '',
      created_at: offer.created,
      updated_at: offer.updated,
      expires_at: offer.expires,
      trade_id: offer.tradeID || null,
      items_to_give: (offer.itemsToGive || []).map(item => ({
        assetid: item.assetid,
        appid: item.appid,
        contextid: item.contextid,
        amount: item.amount || 1,
        name: item.name || '',
        market_name: item.market_name || '',
        market_hash_name: item.market_hash_name || ''
      })),
      items_to_receive: (offer.itemsToReceive || []).map(item => ({
        assetid: item.assetid,
        appid: item.appid,
        contextid: item.contextid,
        amount: item.amount || 1,
        name: item.name || '',
        market_name: item.market_name || '',
        market_hash_name: item.market_hash_name || ''
      }))
    };
  }

  getStateName(state) {
    const states = {
      1: 'Invalid',
      2: 'Active',
      3: 'Accepted',
      4: 'Countered',
      5: 'Expired',
      6: 'Canceled',
      7: 'Declined',
      8: 'InvalidItems',
      9: 'NeedsConfirmation',
      10: 'Canceled2FA',
      11: 'InEscrow'
    };
    return states[state] || 'Unknown';
  }

  cleanupSession(steamId) {
    const session = this.accountSessions.get(steamId);
    if (session) {
      try {
        if (session.user) {
          session.user.logOff();
          session.user.removeAllListeners();
        }
        if (session.manager) {
          session.manager.shutdown();
        }
        this.accountSessions.delete(steamId);
        this.logger.info(`Cleaned up session for ${steamId}`);
      } catch (error) {
        this.logger.error(`Error cleaning session for ${steamId}:`, error);
      }
    }
  }

  async sendToFlask(results) {
    try {
      const deviceToken = await this.getDeviceToken();
      if (!deviceToken) {
        this.logger.warn('No device token available, skipping Flask update');
        return;
      }

      // Send to NEW background-sync endpoint
      for (const result of results.filter(r => r.success)) {
        const payload = {
          steam_id: result.steam_id,
          response_data: {
            response: {
              trade_offers_sent: result.sent_offers || [],
              trade_offers_received: result.received_offers || [],
              descriptions: [] // Extract if needed
            }
          }
        };

        const response = await axios.post(
          'https://cswhale-green-dust-4483.fly.dev/api/steam/background-sync', // NEW ENDPOINT
          payload,
          {
            headers: {
              'Authorization': `Bearer ${deviceToken}`,
              'Content-Type': 'application/json'
            },
            timeout: 30000
          }
        );

        this.logger.info(`Background sync response: ${response.status}`);
      }
      
    } catch (error) {
      this.logger.error('Failed to send background sync:', error.message);
    }
  }

  sendNotification(totalOffers, results) {
    const { Notification } = require('electron');
    
    if (!Notification.isSupported()) return;
    
    const accountsWithOffers = results.filter(r => r.received_offers?.length > 0);
    let body = `${totalOffers} new trade offer${totalOffers > 1 ? 's' : ''} received`;
    
    if (accountsWithOffers.length > 0) {
      body += '\n';
      accountsWithOffers.slice(0, 3).forEach(acc => {
        body += `\n${acc.account_name}: ${acc.received_offers.length} offer${acc.received_offers.length > 1 ? 's' : ''}`;
      });
    }
    
    const notification = new Notification({
      title: '🔔 New Trade Offers',
      body: body,
      icon: require('path').join(__dirname, '../../static/images/icons/icon.png')
    });
    
    notification.show();
  }

  // Get status for tray/UI
  getStatus() {
    const sessionCount = this.accountSessions.size;
    const totalReceived = this.lastResults.reduce((sum, r) => 
      sum + (r.received_offers?.length || 0), 0
    );
    const totalSent = this.lastResults.reduce((sum, r) => 
      sum + (r.sent_offers?.length || 0), 0
    );
    
    return {
      isRunning: this.isRunning,
      lastCheckTime: this.lastCheckTime,
      activeSessions: sessionCount,
      checkInterval: this.CHECK_INTERVAL_MINUTES,
      accountsChecked: this.lastResults.length,
      totalReceived,
      totalSent,
      lastResults: this.lastResults
    };
  }
}

module.exports = BackgroundTradeMonitor;