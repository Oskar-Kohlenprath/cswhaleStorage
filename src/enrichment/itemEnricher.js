// src/enrichment/itemEnricher.js
const axios = require('axios');
const VDF = require('@node-steam/vdf');
const fs = require('fs');
const path = require('path');

class ItemEnricher {
  constructor(logger) {
    this.logger = logger;
    this.itemsGame = {};
    this.translations = {};
    this.initialized = false;
    this.initPromise = null;
  }

  async initialize() {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._performInit();
    await this.initPromise;
    this.initialized = true;
  }

  async _performInit() {
    try {
      this.logger.info('Initializing item enricher...');
      
      // Try to load from cache first
      const cacheDir = path.join(require('electron').app.getPath('userData'), 'cache');
      const itemsCachePath = path.join(cacheDir, 'items_game.json');
      const translationsCachePath = path.join(cacheDir, 'translations.json');

      let needsDownload = false;

      if (fs.existsSync(itemsCachePath) && fs.existsSync(translationsCachePath)) {
        try {
          const itemsCacheAge = Date.now() - fs.statSync(itemsCachePath).mtimeMs;
          // Refresh cache if older than 24 hours
          if (itemsCacheAge < 24 * 60 * 60 * 1000) {
            this.itemsGame = JSON.parse(fs.readFileSync(itemsCachePath, 'utf8'));
            this.translations = JSON.parse(fs.readFileSync(translationsCachePath, 'utf8'));
            this.logger.info('Loaded item data from cache');
            return;
          } else {
            needsDownload = true;
          }
        } catch (err) {
          this.logger.warn('Cache files corrupted, redownloading...');
          needsDownload = true;
        }
      } else {
        needsDownload = true;
      }

      if (needsDownload) {
        await this.downloadGameFiles(cacheDir, itemsCachePath, translationsCachePath);
      }
    } catch (error) {
      this.logger.error('Failed to initialize item enricher', error);
      throw error;
    }
  }

  async downloadGameFiles(cacheDir, itemsCachePath, translationsCachePath) {
  this.logger.info('Downloading game files from Valve...');
  
  try {
    // Create cache directory
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    // Download items_game.txt
    this.logger.info('Downloading items_game.txt...');
    const itemsGameUrl = 'https://files.skinledger.com/counterstrike/items_game.txt';
    const itemsResponse = await axios.get(itemsGameUrl, { 
      timeout: 60000, // 60 seconds
      maxContentLength: 100 * 1024 * 1024 // 100MB max
    });
    
    this.logger.info(`Downloaded items_game.txt: ${itemsResponse.data.length} bytes`);
    
    // Parse VDF format
    const parsedItems = VDF.parse(itemsResponse.data);
    this.itemsGame = this.processItemsGame(parsedItems);
    
    this.logger.info(`Parsed ${Object.keys(this.itemsGame.items || {}).length} items`);
    
    // Download translations
    this.logger.info('Downloading translations...');
    const translationsUrl = 'https://files.skinledger.com/counterstrike/csgo_english.txt';
    const transResponse = await axios.get(translationsUrl, { timeout: 30000 });
    
    this.logger.info(`Downloaded translations: ${transResponse.data.length} bytes`);
    
    this.translations = this.processTranslations(transResponse.data);
    
    this.logger.info(`Parsed ${Object.keys(this.translations).length} translations`);
    
    // Save to cache
    fs.writeFileSync(itemsCachePath, JSON.stringify(this.itemsGame), 'utf8');
    fs.writeFileSync(translationsCachePath, JSON.stringify(this.translations), 'utf8');
    
    this.logger.info('Game files downloaded and cached successfully');
  } catch (error) {
    this.logger.error('Failed to download game files', error);
    throw error;
  }
}

  processItemsGame(data) {
    const result = {
      items: {},
      paint_kits: {},
      sticker_kits: {},
      music_kits: {},
      prefabs: {}
    };

    if (data.items_game) {
      if (data.items_game.items) {
        result.items = data.items_game.items;
      }
      if (data.items_game.paint_kits) {
        result.paint_kits = data.items_game.paint_kits;
      }
      if (data.items_game.sticker_kits) {
        result.sticker_kits = data.items_game.sticker_kits;
      }
      if (data.items_game.music_definitions) {
        result.music_kits = data.items_game.music_definitions;
      }
      if (data.items_game.prefabs) {
        result.prefabs = data.items_game.prefabs;
      }
    }

    return result;
  }

  processTranslations(data) {
    const result = {};
    const lines = data.split('\n');
    
    lines.forEach(line => {
      const matches = line.match(/"([^"]+)"\s+"([^"]+)"/);
      if (matches && matches[1] && matches[2]) {
        result[matches[1].toLowerCase()] = matches[2];
      }
    });
    
    return result;
  }

  // Main enrichment function
async enrichItem(rawItem) {
  if (!this.initialized) {
    await this.initialize();
  }

  try {
    // Handle different possible ID fields
    const itemId = rawItem.id || rawItem.assetid || rawItem.itemid;
    
    // Debug log
    if (!this.itemsGame.items || Object.keys(this.itemsGame.items).length === 0) {
      this.logger.error('Items game data not loaded!');
      throw new Error('Game data not initialized');
    }

    // Build the image path
    const imagePath = this.buildImageUrl(rawItem);
    
    const enriched = {
      // IDs
      id: itemId,
      assetid: itemId,
      
      // Use existing fields if available
      def_index: rawItem.def_index || rawItem.defindex,
      
      // Build name
      item_name: this.buildItemName(rawItem),
      market_hash_name: '', // Will be set to item_name
      
      // Image URLs - IMPORTANT: icon_url should be just the path
      icon_url: imagePath, // This is what renderer will use
      item_url: imagePath, // Keep the same
      
      // Trade info
      tradable: this.isTradable(rawItem),
      marketable: true,
      appid: 730,
      
      // Additional data
      raw_data: rawItem
    };
    
    // Set market_hash_name to match item_name
    enriched.market_hash_name = enriched.item_name;
    
    // Add wear if present
    if (rawItem.paint_wear !== undefined) {
      enriched.item_wear_name = this.getWearName(rawItem.paint_wear);
      enriched.item_paint_wear = rawItem.paint_wear;
    }
    
    // Add rarity if present
    if (rawItem.rarity !== undefined) {
      enriched.rarity = rawItem.rarity;
      enriched.rarity_name = this.getRarityName(rawItem.rarity);
    }
    
    // Check for StatTrak
    enriched.stattrak = this.hasStatTrak(rawItem);
    
    // Handle storage units
    if (rawItem.def_index === 1201 || rawItem.defindex === 1201) {
      enriched.is_storage_unit = true;
      enriched.item_count = rawItem.casket_contained_item_count || 0;
      enriched.custom_name = rawItem.custom_name || 'Storage Unit';
      // Storage units have a specific icon
      enriched.icon_url = '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXX7gNTPcUxqAhWSVieFOX71szWCgwsdlZRsuz0L1M1iqrOIGUauNiyzdmKxKWsMrnXkjlQsIthhO5eh9dfdg';
    }

    return enriched;
  } catch (error) {
    this.logger.error(`Failed to enrich item ${JSON.stringify(rawItem).substring(0, 100)}`, error);
    
    // Return minimal enrichment on error
    return {
      id: rawItem.id || rawItem.assetid,
      assetid: rawItem.id || rawItem.assetid,
      market_hash_name: `Unknown Item #${rawItem.def_index || rawItem.defindex || '?'}`,
      item_name: `Unknown Item #${rawItem.def_index || rawItem.defindex || '?'}`,
      icon_url: '',
      item_url: '',
      tradable: true,
      appid: 730,
      error: true
    };
  }
}

  buildItemName(item) {
    const defIndex = item.def_index;
    const itemDef = this.itemsGame.items?.[defIndex];
    
    if (!itemDef) {
      return `Unknown Item #${defIndex}`;
    }

    let baseName = '';
    
    // Get base item name
    if (itemDef.item_name) {
      baseName = this.translate(itemDef.item_name);
    } else if (itemDef.prefab && this.itemsGame.prefabs?.[itemDef.prefab]) {
      const prefab = this.itemsGame.prefabs[itemDef.prefab];
      if (prefab.item_name) {
        baseName = this.translate(prefab.item_name);
      }
    } else {
      baseName = itemDef.name || `Item #${defIndex}`;
    }

    // Add skin name if present
    if (item.paint_index && this.itemsGame.paint_kits?.[item.paint_index]) {
      const paintKit = this.itemsGame.paint_kits[item.paint_index];
      const skinName = this.translate(paintKit.description_tag);
      if (skinName) {
        baseName = `${baseName} | ${skinName}`;
      }
    }

    // Add StatTrak prefix
    if (this.hasStatTrak(item)) {
      baseName = `StatTrak™ ${baseName}`;
    }

    // Add Souvenir prefix
    if (this.isSouvenir(item)) {
      baseName = `Souvenir ${baseName}`;
    }

    return baseName;
  }

  buildImageUrl(item) {
  const defIndex = item.def_index || item.defindex;
  const itemDef = this.itemsGame.items?.[defIndex];
  
  if (!itemDef) {
    return '';
  }

  // Most items have image_inventory with the CDN hash
  if (itemDef.image_inventory) {
    // Check if it starts with a CDN hash (Steam's format)
    if (itemDef.image_inventory.startsWith('-9a81')) {
      return itemDef.image_inventory;
    }
    // Check if it's a path like "econ/weapons/..."
    if (itemDef.image_inventory.startsWith('econ/')) {
      // For paths, we need to get the actual CDN hash
      // For now, return the path - the game files should have the hash
      return itemDef.image_inventory;
    }
    // Otherwise return as-is
    return itemDef.image_inventory;
  }

  // For weapons with skins
  if (item.paint_index && this.itemsGame.paint_kits?.[item.paint_index]) {
    const paintKit = this.itemsGame.paint_kits[item.paint_index];
    // Try to get the image from paint kit
    if (paintKit.image_inventory) {
      return paintKit.image_inventory;
    }
    // Fallback to generated path
    return `econ/default_generated/${itemDef.name}_${paintKit.name}_light_large`;
  }

  // For stickers
  if (item.sticker_id && this.itemsGame.sticker_kits?.[item.sticker_id]) {
    const stickerKit = this.itemsGame.sticker_kits[item.sticker_id];
    if (stickerKit.sticker_material) {
      return `econ/stickers/${stickerKit.sticker_material}`;
    }
  }

  // For base weapons
  if (itemDef.baseitem === '1' || itemDef.baseitem === 1) {
    return `econ/weapons/base_weapons/${itemDef.name}`;
  }

  // Default fallback
  return '';
}

  translate(key) {
    if (!key) return '';
    const cleanKey = key.replace('#', '').toLowerCase();
    return this.translations[cleanKey] || key;
  }

  getWearName(paintWear) {
    if (!paintWear) return null;
    
    const wearLevels = [
      { max: 0.07, name: 'Factory New' },
      { max: 0.15, name: 'Minimal Wear' },
      { max: 0.38, name: 'Field-Tested' },
      { max: 0.45, name: 'Well-Worn' },
      { max: 1.00, name: 'Battle-Scarred' }
    ];

    for (const level of wearLevels) {
      if (paintWear <= level.max) {
        return level.name;
      }
    }

    return 'Battle-Scarred';
  }

  getRarityName(rarity) {
    const rarityMap = {
      1: 'Consumer Grade',
      2: 'Industrial Grade',
      3: 'Mil-Spec',
      4: 'Restricted',
      5: 'Classified',
      6: 'Covert'
    };
    return rarityMap[rarity] || 'Common';
  }

  hasStatTrak(item) {
    return item.attribute?.some(attr => attr.def_index === 80) || false;
  }

  isSouvenir(item) {
    return item.attribute?.some(attr => attr.def_index === 140) || false;
  }

  isTradable(item) {
    // Check various conditions for tradability
    if (item.flags === 10) return false; // Non-tradable flag
    if (item.def_index === 987) return false; // Specific non-tradable items
    
    // Check tradable_after date
    if (item.tradable_after) {
      const tradeDate = new Date(item.tradable_after * 1000);
      if (tradeDate > new Date()) return false;
    }
    
    return true;
  }

  // Batch enrichment for performance
  async enrichItems(items) {
    if (!Array.isArray(items)) {
      return [];
    }

    await this.initialize();
    
    const enrichedItems = [];
    for (const item of items) {
      const enriched = await this.enrichItem(item);
      enrichedItems.push(enriched);
    }
    
    return enrichedItems;
  }
}

module.exports = ItemEnricher;
