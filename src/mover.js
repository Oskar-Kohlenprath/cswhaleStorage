// src/mover.js
const { ipcMain } = require('electron');

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

          // Enrich items
          const enrichedItems = [];
          for (const item of inventory) {
            try {
              if (this.itemEnricher && this.itemEnricher.initialized) {
                const enriched = await this.itemEnricher.enrichItem(item);
                enrichedItems.push({
                  assetid: item.assetid,
                  market_hash_name: enriched.market_hash_name || item.market_hash_name,
                  icon_url: enriched.icon_url || item.icon_url,
                  tradable: item.tradable,
                  category: enriched.item_type || 'weapon',
                  wear: enriched.item_wear_name
                });
              } else {
                enrichedItems.push({
                  assetid: item.assetid,
                  market_hash_name: item.market_hash_name || 'Unknown',
                  icon_url: item.icon_url || '',
                  tradable: item.tradable,
                  category: 'weapon'
                });
              }
            } catch (enrichErr) {
              this.logger.error('Failed to enrich item:', enrichErr);
              enrichedItems.push({
                assetid: item.assetid,
                market_hash_name: item.market_hash_name || 'Unknown',
                icon_url: item.icon_url || '',
                tradable: item.tradable,
                category: 'weapon'
              });
            }
          }

          resolve(enrichedItems);
        }
      );
    });
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

      // Enrich items
      const enrichedItems = [];
      for (const item of items) {
        try {
          if (this.itemEnricher && this.itemEnricher.initialized) {
            const enriched = await this.itemEnricher.enrichItem(item);
            enrichedItems.push({
              assetid: item.id,
              market_hash_name: enriched.market_hash_name || 'Unknown',
              icon_url: enriched.icon_url || '',
              category: enriched.item_type || 'weapon',
              wear: enriched.item_wear_name
            });
          } else {
            enrichedItems.push({
              assetid: item.id,
              market_hash_name: 'Unknown Item',
              icon_url: '',
              category: 'weapon'
            });
          }
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