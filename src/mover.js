// src/mover.js
const { ipcMain } = require('electron');
const axios = require('axios'); 

class Mover {
  constructor(logger, itemEnricher) {
    this.logger = logger;
    this.itemEnricher = itemEnricher;
    this.DELAY_MS = 130;
    this.setupIPCHandlers();
  }

  // src/mover.js - Change the handler names to be unique
setupIPCHandlers() {
    const self = this;
    
    // Load all mover data
    ipcMain.handle('mover-load-data', async () => {
      return await self.loadMoverData();
    });

    // Get storage contents - RENAMED to avoid conflict
    ipcMain.handle('mover-get-storage-contents', async (event, storageId) => {
      return await self.getStorageContents(storageId);
    });

    // Execute move - RENAMED for consistency
    ipcMain.handle('mover-execute-move', async (event, moveData) => {
      return await self.executeMove(moveData);
    });
  }

  async loadMoverData() {
    try {
      const user = global.user;
      const csgo = global.csgo;
      
      // Check connection status first
      if (!user || !csgo || !csgo.haveGCSession) {
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

      this.logger.info('Loading mover data...');

      // Get inventory
      const inventory = await this.getInventory();
      
      // Get storage units
      const storageUnits = await this.getStorageUnits();
      
      // Calculate stats
      const inventoryCount = inventory.length;
      const totalItems = inventoryCount + storageUnits.reduce((sum, unit) => {
        return sum + unit.itemCount;
      }, 0);

      return {
        success: true,
        connected: true,
        inventory: inventory,
        storageUnits: storageUnits,
        inventoryCount: inventoryCount,
        totalItems: totalItems
      };

    } catch (error) {
      this.logger.error('Failed to load mover data:', error);
      return { success: false, connected: false, error: error.message };
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

    const items = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout loading storage contents'));
      }, 10000);
      
      csgo.getCasketContents(storageId, async (err, items) => {
        clearTimeout(timeout);
        if (err) {
          reject(err);
          return;
        }
        resolve(items || []);
      });
    });

    // Enrich items first to get market_hash_name
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

    // Now batch request icons from Flask with DETAILED LOGGING
    if (enrichedItems.length > 0) {
      try {
        this.logger.info('=== STARTING ICON FETCH ===');
        this.logger.info('Number of items to get icons for:', enrichedItems.length);
        
        // Log the API base URL
        this.logger.info('API_BASE_URL from global:', global.API_BASE_URL);
        const fullUrl = `${global.API_BASE_URL}/get_item_icons`;
        this.logger.info('Full URL to call:', fullUrl);
        
        // Try to get device token
        let deviceToken = null;
        try {
          this.logger.info('Attempting to get device token...');
          deviceToken = await global.keytar.getPassword(global.SERVICE_NAME, global.DEVICE_TOKEN_KEY);
          this.logger.info('Device token retrieved:', deviceToken ? 'YES (length: ' + deviceToken.length + ')' : 'NO');
        } catch (tokenError) {
          this.logger.error('Failed to get device token:', tokenError.message);
        }
        
        // Prepare request body
        const requestBody = {
          items: enrichedItems.map(item => ({
            market_hash_name: item.market_hash_name
          }))
        };
        this.logger.info('Request body prepared with', requestBody.items.length, 'items');
        this.logger.info('Sample item names:', requestBody.items.slice(0, 3).map(i => i.market_hash_name));
        
        // Prepare headers
        const headers = {
          'Content-Type': 'application/json'
        };
        if (deviceToken) {
          headers['Authorization'] = `Bearer ${deviceToken}`;
          this.logger.info('Authorization header added');
        } else {
          this.logger.info('No Authorization header (no device token)');
        }
        this.logger.info('Headers:', JSON.stringify(headers));
        
        // Make the actual request
        this.logger.info('Making axios POST request to:', fullUrl);
        const iconResponse = await axios.post(fullUrl, requestBody, { headers });
        
        this.logger.info('Response received! Status:', iconResponse.status);
        this.logger.info('Response data keys:', Object.keys(iconResponse.data || {}));
        
        // Map icons back to items
        if (iconResponse.data && iconResponse.data.icons) {
          const iconMap = iconResponse.data.icons;
          this.logger.info('Icon map received with', Object.keys(iconMap).length, 'entries');
          
          enrichedItems.forEach(item => {
            if (iconMap[item.market_hash_name]) {
              item.icon_url = iconMap[item.market_hash_name];
            }
          });
          this.logger.info('Icons successfully mapped to items');
        } else {
          this.logger.warn('No icons in response data');
        }
        
        this.logger.info('=== ICON FETCH COMPLETED ===');
        
      } catch (iconError) {
        this.logger.error('=== ICON FETCH FAILED ===');
        this.logger.error('Error type:', iconError.name);
        this.logger.error('Error message:', iconError.message);
        
        if (iconError.code) {
          this.logger.error('Error code:', iconError.code);
        }
        
        if (iconError.response) {
          this.logger.error('Response status:', iconError.response.status);
          this.logger.error('Response status text:', iconError.response.statusText);
          this.logger.error('Response data:', JSON.stringify(iconError.response.data));
          this.logger.error('Response headers:', JSON.stringify(iconError.response.headers));
        } else if (iconError.request) {
          this.logger.error('Request was made but no response received');
          this.logger.error('Request details:', iconError.request);
        } else {
          this.logger.error('Error setting up request:', iconError.message);
        }
        
        this.logger.error('Full error object:', iconError);
        this.logger.error('Stack trace:', iconError.stack);
        // Continue without icons
      }
    }

    return {
      success: true,
      items: enrichedItems
    };

  } catch (error) {
    this.logger.error('Failed to get storage contents:', error);
    return { success: false, error: error.message };
  }
}

  async executeMove(moveData) {
    try {
      const csgo = global.csgo;
      const direction = moveData.direction;
      const items = moveData.items;
      const storageId = moveData.storageId;
      
      if (!csgo) {
        return { success: false, error: 'Not connected' };
      }

      this.logger.info(`Moving ${items.length} items ${direction}`);
      
      for (let i = 0; i < items.length; i++) {
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
    }
  }

  delay(ms) {
    return new Promise(function(resolve) {
      setTimeout(resolve, ms);
    });
  }
}

module.exports = Mover;