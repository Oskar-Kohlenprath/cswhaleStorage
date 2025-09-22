// src/mover.js
const { ipcMain } = require('electron');
const axios = require('axios'); 

class Mover {
    constructor(logger, itemEnricher) {
    this.logger = logger;
    this.itemEnricher = itemEnricher;
    this.DELAY_MS = 130;
    this.MOVER_ACTIVITY_TTL = 300000; // 5 minutes
    this.setupIPCHandlers();
    
    // Track activity
    this.updateMoverActivity();
  }

  updateMoverActivity() {
    global.lastMoverActivity = Date.now();
    this.logger.info('Mover activity updated');
  }

  isMoverActive() {
    if (!global.lastMoverActivity) return false;
    const timeSinceActivity = Date.now() - global.lastMoverActivity;
    return timeSinceActivity < this.MOVER_ACTIVITY_TTL;
  }

  // src/mover.js - Change the handler names to be unique
  setupIPCHandlers() {
    const self = this;
    
    // Load all mover data
    ipcMain.handle('mover-load-data', async () => {
      self.updateMoverActivity();
      return await self.loadMoverData();
    });

    // Get storage contents
    ipcMain.handle('mover-get-storage-contents', async (event, storageId) => {
      self.updateMoverActivity();
      return await self.getStorageContents(storageId);
    });

    // Execute move
    ipcMain.handle('mover-execute-move', async (event, moveData) => {
      self.updateMoverActivity();
      return await self.executeMove(moveData);
    });

        ipcMain.handle('mover-get-current-account', async () => {
      return await self.getCurrentAccount();
    });
    
    ipcMain.handle('mover-switch-account', async (event, steamId) => {
      return await self.switchAccount(steamId);
    });
    
    ipcMain.handle('mover-get-all-accounts', async () => {
      return await self.getAllAccounts();
    });
  }

  async loadMoverData() {
    try {
      const user = global.user;
      const csgo = global.csgo;
      
      // Check if we're in a valid session
      if (!user || !csgo || !csgo.haveGCSession) {
        // Add a check to see if we're just temporarily disconnected
        if (global.isReconnecting) {
          this.logger.info('Currently reconnecting to Steam...');
          return { 
            success: false, 
            connected: false,
            error: 'Reconnecting to Steam, please wait...' 
          };
        }
        
        // Check if background trade check is running
        if (global.backgroundTradeCheckActive) {
          this.logger.info('Background trade check is active, waiting...');
          return { 
            success: false, 
            connected: false,
            error: 'System busy with background operations, please try again' 
          };
        }
        
        this.logger.info('Not connected to Steam, checking for saved accounts...');
        
        // Return connection status and available accounts
        const keytar = require('keytar');
        const SERVICE_NAME = require('electron').app.isPackaged
          ? "cs-assets-service"
          : "cs-assets-service-dev";
        const ACCOUNTS_KEY = "cs-assets-stored-accounts";
        
        const accountsData = await keytar.getPassword(SERVICE_NAME, ACCOUNTS_KEY);
        const accounts = accountsData ? JSON.parse(accountsData) : [];
        
        return { 
          success: false, 
          connected: false,
          accounts: accounts.map(acc => ({
            steamId: acc.steamId,
            displayName: acc.displayName,
            avatarUrl: acc.avatarUrl,
            hasToken: !!(acc.refreshToken && acc.refreshToken.trim() !== '')
          })),
          error: 'Not connected to Steam' 
        };
      }

      // Check if we have a stable connection
      if (!csgo.haveGCSession) {
        this.logger.warn('Steam connected but no GC session');
        return {
          success: false,
          connected: false,
          error: 'Waiting for game coordinator connection...'
        };
      }

      this.logger.info('Loading mover data...');

      // Get inventory with error handling
      let inventory = [];
      try {
        inventory = await this.getInventory();
      } catch (invError) {
        this.logger.error('Failed to load inventory:', invError);
        // Continue with empty inventory rather than failing completely
      }
      
      // Get storage units with error handling
      let storageUnits = [];
      try {
        storageUnits = await this.getStorageUnits();
      } catch (storageError) {
        this.logger.error('Failed to load storage units:', storageError);
        // Continue with empty storage units
      }
      
      // Calculate stats
      const inventoryCount = inventory.length;
      const totalItems = inventoryCount + storageUnits.reduce((sum, unit) => {
        return sum + unit.itemCount;
      }, 0);

      // Log summary
      this.logger.info(`Mover data loaded: ${inventoryCount} inventory items, ${storageUnits.length} storage units`);

      return {
        success: true,
        connected: true,
        inventory: inventory,
        storageUnits: storageUnits,
        inventoryCount: inventoryCount,
        totalItems: totalItems,
        steamId: user.steamID ? user.steamID.getSteamID64() : null
      };

    } catch (error) {
      this.logger.error('Failed to load mover data:', error);
      this.logger.error('Error Stack:', error.stack);
      
      // Check if it's a session-related error
      if (error.message && error.message.includes('SessionReplaced')) {
        return { 
          success: false, 
          connected: false, 
          error: 'Session was replaced. Please refresh and try again.' 
        };
      }
      
      return { 
        success: false, 
        connected: false, 
        error: error.message || 'Unknown error occurred' 
      };
    }
  }

  async getInventory() {
    const community = global.community;
    const user = global.user;
    
    return new Promise((resolve, reject) => {
      if (!community || !user || !user.steamID) {
        resolve([]);
        return;
      }

      community.getUserInventoryContents(
        user.steamID,
        730,
        2,
        false,
        async (err, inventory) => {
          if (err) {
            this.logger.error('Failed to get inventory:', err);
            resolve([]);
            return;
          }

          // Steam Web API already gives us everything we need
          const items = inventory.map(item => ({
            assetid: item.assetid,
            market_hash_name: item.market_hash_name || item.market_name || item.name,
            icon_url: item.icon_url,
            tradable: item.tradable,
            category: item.type || 'weapon',
            // Extract wear from market_hash_name if present
            wear: this.extractWear(item.market_hash_name || item.market_name || '')
          }));

          this.logger.info(`Inventory fetched: ${items.length} items`);
          resolve(items);
        }
      );
    });
  }

  // Helper to extract wear from name
  extractWear(name) {
    if (name.includes('Factory New')) return 'FN';
    if (name.includes('Minimal Wear')) return 'MW';
    if (name.includes('Field-Tested')) return 'FT';
    if (name.includes('Well-Worn')) return 'WW';
    if (name.includes('Battle-Scarred')) return 'BS';
    return null;
  }

  async getStorageUnits() {
    const csgo = global.csgo;
    
    return new Promise((resolve) => {
      setTimeout(() => {
        if (!csgo || !csgo.inventory || csgo.inventory.length === 0) {
          resolve([]);
          return;
        }
        
        const storageUnits = csgo.inventory.filter(function(item) {
          return typeof item.casket_contained_item_count !== 'undefined';
        });
        
        const units = storageUnits.map(function(unit) {
          return {
            id: unit.id,
            name: unit.custom_name || 'Storage Unit',
            itemCount: unit.casket_contained_item_count || 0
          };
        });
        
        resolve(units);
      }, 2000);
    });
  }

 async getStorageContents(storageId) {
  try {
    const csgo = global.csgo;
    
    if (!csgo) {
      return { success: false, error: 'Not connected' };
    }

    // Add retry logic
    let lastError = null;
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const items = await new Promise((resolve, reject) => {
          // Increase timeout to 30 seconds
          const timeout = setTimeout(() => {
            this.logger.warn(`Storage load timeout (attempt ${attempt}/${maxRetries})`);
            reject(new Error(`Timeout loading storage contents (attempt ${attempt}/${maxRetries})`));
          }, 30000); // Changed from 10000 to 30000
          
          csgo.getCasketContents(storageId, async (err, items) => {
            clearTimeout(timeout);
            if (err) {
              reject(err);
              return;
            }
            resolve(items || []);
          });
        });

        // If we got here, the request succeeded
        this.logger.info(`Storage loaded successfully on attempt ${attempt}`);
        
        // Rest of your existing enrichment code...
        const enrichedItems = [];
        for (const item of items) {
          try {
            let itemData = {
              assetid: item.id,
              market_hash_name: 'Unknown Item',
              icon_url: '',
              category: 'weapon',
              wear: null
            };

            if (this.itemEnricher && this.itemEnricher.initialized) {
              const enriched = await this.itemEnricher.enrichItem(item);
              itemData.market_hash_name = enriched.market_hash_name || 'Unknown';
              itemData.category = enriched.item_type || 'weapon';
              itemData.wear = enriched.item_wear_name;
            }

            enrichedItems.push(itemData);
          } catch (enrichErr) {
            this.logger.error('Failed to enrich storage item:', enrichErr);
            enrichedItems.push({
              assetid: item.id,
              market_hash_name: 'Unknown Item',
              icon_url: '',
              category: 'weapon'
            });
          }
        }

        // Now batch request icons from Flask - DEDUPLICATED
        if (enrichedItems.length > 0) {
          try {
            const uniqueNames = [...new Set(enrichedItems.map(item => item.market_hash_name))];
            
            this.logger.info(`Storage has ${enrichedItems.length} items`);
            this.logger.info(`Unique item types: ${uniqueNames.length}`);
            
            const deviceToken = await global.keytar.getPassword(global.SERVICE_NAME, global.DEVICE_TOKEN_KEY);
            
            const iconResponse = await axios.post(
              `${global.API_BASE_URL}/get_item_icons`,
              {
                items: uniqueNames.map(name => ({
                  market_hash_name: name
                })),
                device_token: deviceToken
              },
              {
                headers: {
                  'Content-Type': 'application/json'
                },
                timeout: 10000 // Add timeout for icon request too
              }
            );

            if (iconResponse.data && iconResponse.data.icons) {
              const iconMap = iconResponse.data.icons;
              
              this.logger.info(`Received icons for ${Object.keys(iconMap).length} unique items`);
              
              const sampleName = Object.keys(iconMap)[0];
              if (sampleName) {
                this.logger.info(`Sample icon URL: ${iconMap[sampleName]}`);
              }
              
              let iconsMapped = 0;
              enrichedItems.forEach(item => {
                if (iconMap[item.market_hash_name]) {
                  item.icon_url = iconMap[item.market_hash_name];
                  iconsMapped++;
                }
              });
              
              this.logger.info(`Successfully mapped icons to ${iconsMapped} items`);
            } else {
              this.logger.warn('No icons in response data');
            }
          } catch (iconError) {
            this.logger.warn('Failed to get icons from Flask:', iconError.message);
            // Continue without icons - not critical
          }
        }

        const itemsWithIcons = enrichedItems.filter(item => item.icon_url).length;
        this.logger.info(`Returning ${enrichedItems.length} items, ${itemsWithIcons} with icons`);

        return {
          success: true,
          items: enrichedItems
        };

      } catch (attemptError) {
        lastError = attemptError;
        this.logger.warn(`Attempt ${attempt} failed:`, attemptError.message);
        
        if (attempt < maxRetries) {
          // Wait before retrying (exponential backoff)
          const waitTime = 2000 * attempt; // 2 seconds, 4 seconds, 6 seconds
          this.logger.info(`Waiting ${waitTime}ms before retry...`);
          await this.delay(waitTime);
        }
      }
    }

    // All retries failed
    this.logger.error('All retry attempts failed for storage contents');
    throw lastError;

  } catch (error) {
    this.logger.error('Failed to get storage contents:', error);
    return { success: false, error: error.message };
  }
}

  async executeMove(moveData) {
    try {
      // Mark operation as active
      global.activeMoveCount = (global.activeMoveCount || 0) + 1;
      
      const csgo = global.csgo;
      const direction = moveData.direction;
      const items = moveData.items;
      const storageId = moveData.storageId;
      
      if (!csgo) {
        return { success: false, error: 'Not connected' };
      }

      this.logger.info(`Moving ${items.length} items ${direction}`);
      
      for (let i = 0; i < items.length; i++) {
        // Update activity every 10 items to keep TTL fresh
        if (i % 10 === 0) {
          this.updateMoverActivity();
        }
        
        const assetId = items[i];
        
        if (direction === 'to_storage') {
          csgo.addToCasket(storageId, assetId);
        } else {
          csgo.removeFromCasket(storageId, assetId);
        }
        
        await this.delay(this.DELAY_MS);
      }

      this.logger.info(`Successfully moved ${items.length} items`);
      
      return { success: true };

    } catch (error) {
      this.logger.error('Failed to execute move:', error);
      return { success: false, error: error.message };
    } finally {
      // Always decrement counter
      global.activeMoveCount = Math.max(0, (global.activeMoveCount || 1) - 1);
    }
  }

  delay(ms) {
    return new Promise(function(resolve) {
      setTimeout(resolve, ms);
    });
  }


   async getCurrentAccount() {
    try {
      const user = global.user;
      if (!user || !user.steamID) {
        return { success: false, account: null };
      }
      
      // Get account details from saved accounts
      const keytar = require('keytar');
      const SERVICE_NAME = require('electron').app.isPackaged
        ? "cs-assets-service"
        : "cs-assets-service-dev";
      const ACCOUNTS_KEY = "cs-assets-stored-accounts";
      
      const accountsData = await keytar.getPassword(SERVICE_NAME, ACCOUNTS_KEY);
      const accounts = accountsData ? JSON.parse(accountsData) : [];
      
      const currentSteamId = user.steamID.getSteamID64();
      const currentAccount = accounts.find(acc => acc.steamId === currentSteamId);
      
      return {
        success: true,
        account: currentAccount ? {
          steamId: currentAccount.steamId,
          displayName: currentAccount.displayName,
          avatarUrl: currentAccount.avatarUrl
        } : {
          steamId: currentSteamId,
          displayName: 'Unknown User',
          avatarUrl: null
        }
      };
    } catch (error) {
      this.logger.error('Failed to get current account:', error);
      return { success: false, account: null };
    }
  }

  async getAllAccounts() {
    try {
      const keytar = require('keytar');
      const SERVICE_NAME = require('electron').app.isPackaged
        ? "cs-assets-service"
        : "cs-assets-service-dev";
      const ACCOUNTS_KEY = "cs-assets-stored-accounts";
      
      const accountsData = await keytar.getPassword(SERVICE_NAME, ACCOUNTS_KEY);
      const accounts = accountsData ? JSON.parse(accountsData) : [];
      
      // Get current account if connected
      let currentSteamId = null;
      if (global.user && global.user.steamID) {
        currentSteamId = global.user.steamID.getSteamID64();
      }
      
      return {
        success: true,
        accounts: accounts.map(acc => ({
          steamId: acc.steamId,
          displayName: acc.displayName,
          avatarUrl: acc.avatarUrl,
          hasToken: !!(acc.refreshToken && acc.refreshToken.trim() !== ''),
          isCurrent: acc.steamId === currentSteamId
        }))
      };
    } catch (error) {
      this.logger.error('Failed to get accounts:', error);
      return { success: false, accounts: [] };
    }
  }

  // src/mover.js - Replace the switchAccount function (lines 270-326)
async switchAccount(steamId) {
  try {
    this.logger.info(`Switching to account ${steamId}...`);
    this.updateMoverActivity();
    
    // Use the global function from main.js
    const result = await global.ensureCorrectSteamSession(steamId);
    
    if (!result.success) {
      if (result.needsLogin) {
        this.logger.info(`Account ${steamId} needs login`);
        return {
          success: false,
          needsLogin: true,
          error: 'Please login to this account first'
        };
      }
      throw new Error(result.error || 'Failed to switch account');
    }
    
    await this.delay(2000);
    
    this.logger.info(`Successfully switched to account ${steamId}`);
    
    return {
      success: true,
      message: `Switched to account ${steamId}`
    };
    
  } catch (error) {
    this.logger.error('Failed to switch account:', error);
    return {
      success: false,
      error: error.message
    };
  }
}


}

module.exports = Mover;
