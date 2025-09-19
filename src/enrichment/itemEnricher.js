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
    const itemsGameUrl = 'https://cswhale-dev-env.fly.dev/counterstrike/items_game.txt';
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
    const translationsUrl = 'https://cswhale-dev-env.fly.dev/counterstrike/csgo_english.txt';
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
    prefabs: {},
    graffiti_tints: {}  // Added this
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
    // Add graffiti_tints extraction
    if (data.items_game.graffiti_tints) {
      result.graffiti_tints = data.items_game.graffiti_tints;
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
    const itemId = rawItem.id || rawItem.assetid || rawItem.itemid;
    
    if (!this.itemsGame.items || Object.keys(this.itemsGame.items).length === 0) {
      this.logger.error('Items game data not loaded!');
      throw new Error('Game data not initialized');
    }

    // Check for special item types
    const defIndex = rawItem.def_index || rawItem.defindex;
    let itemType = 'weapon';
    
    if (defIndex === 1209) itemType = 'sticker';
    else if (defIndex === 1348) itemType = 'graffiti';
    else if (defIndex === 1201) itemType = 'storage_unit';
    else if (rawItem.music_index !== undefined) itemType = 'music_kit';
    else if (defIndex >= 4001 && defIndex <= 4999) itemType = 'case';
    else if (defIndex >= 1001 && defIndex <= 1200) itemType = 'key';

    // Build the image path
    const imagePath = this.buildImageUrl(rawItem);
    
    const enriched = {
      // IDs
      id: itemId,
      assetid: itemId,
      def_index: defIndex,
      
      // Item type
      item_type: itemType,
      
      // Build name
      item_name: this.buildItemName(rawItem),
      market_hash_name: '', // Will be set to item_name
      
      // Image URLs
      icon_url: imagePath,
      item_url: imagePath,
      
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
    
    // Special handling for stickers
    if (itemType === 'sticker' && rawItem.stickers && rawItem.stickers[0]) {
      enriched.sticker_id = rawItem.stickers[0].sticker_id;
    }
    
    // Handle storage units
    if (itemType === 'storage_unit') {
      enriched.is_storage_unit = true;
      enriched.item_count = rawItem.casket_contained_item_count || 0;
      enriched.custom_name = rawItem.custom_name || 'Storage Unit';
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



getGraffitiTintName(tintId) {
  // First try dynamic data from items_game
  if (this.itemsGame.graffiti_tints) {
    for (const [key, value] of Object.entries(this.itemsGame.graffiti_tints)) {
      if (value.id == tintId) {
        // Convert key format (e.g., "blood_red" to "Blood Red")
        // Special case for SWAT which should stay uppercase
        if (key.toLowerCase() === 'swat_blue') {
          return 'SWAT Blue';
        }
        return key.split('_').map(word => 
          word.charAt(0).toUpperCase() + word.slice(1)
        ).join(' ');
      }
    }
  }
  
  // Fallback to hardcoded map if dynamic data not available
  const tintMap = {
    0: 'Bazooka Pink',
    1: 'Blood Red', 
    2: 'Brick Red',
    3: 'Cash Green',
    4: 'Desert Amber',
    5: 'Dust Brown',
    6: 'Frog Green',
    7: 'Jungle Green',
    8: 'Monarch Blue',
    9: 'Monster Purple',
    10: 'Princess Pink',
    11: 'SWAT Blue',
    12: 'Shark White',
    13: 'Tiger Orange',
    14: 'Tracer Yellow',
    15: 'Violent Violet',
    16: 'War Pig Pink',
    17: 'Wire Blue',
  };
  
  return tintMap[tintId] || '';
}




getAttributeValueBytes(item, defIndex) {
  if (!item.attribute) return null;
  const attr = item.attribute.find(a => a.def_index === defIndex);
  if (!attr || !attr.value_bytes) return null;
  
  // Handle different formats of value_bytes
  if (typeof attr.value_bytes === 'string') {
    // If it's a hex string, convert to buffer
    return Buffer.from(attr.value_bytes, 'hex');
  } else if (Buffer.isBuffer(attr.value_bytes)) {
    return attr.value_bytes;
  } else if (attr.value_bytes.data && Array.isArray(attr.value_bytes.data)) {
    // If it's a buffer-like object with data array
    return Buffer.from(attr.value_bytes.data);
  }
  return null;
}


buildItemName(item) {
  const defIndex = item.def_index || item.defindex;
  const itemDef = this.itemsGame.items?.[defIndex];
  
  // Special handling for stickers (def_index 1209)
  if (defIndex === 1209 && item.stickers && item.stickers[0]) {
    const stickerId = item.stickers[0].sticker_id;
    const stickerKit = this.itemsGame.sticker_kits?.[stickerId];
    if (stickerKit && stickerKit.item_name) {
      const stickerName = this.translate(stickerKit.item_name);
      return stickerName ? `Sticker | ${stickerName}` : `Sticker #${stickerId}`;
    }
    return `Sticker #${stickerId}`;
  }
  
  // Special handling for sealed graffiti (def_index 1348) WITH COLOR
  if (defIndex === 1348 && item.stickers && item.stickers[0]) {
    const stickerId = item.stickers[0].sticker_id;
    const stickerKit = this.itemsGame.sticker_kits?.[stickerId];
    
    if (stickerKit && stickerKit.item_name) {
      const graffitiName = this.translate(stickerKit.item_name);
      
      // Get graffiti tint from attribute 233
      let tintName = '';
      const tintBytes = this.getAttributeValueBytes(item, 233);
      
      if (tintBytes && tintBytes.length >= 4) {
        const tintId = tintBytes.readUInt32LE(0);
        tintName = this.getGraffitiTintName(tintId);
      }
      
      // Build the final name with color if present
      if (tintName) {
        return `Sealed Graffiti | ${graffitiName} (${tintName})`;
      } else {
        return `Sealed Graffiti | ${graffitiName}`;
      }
    }
    return `Sealed Graffiti #${stickerId}`;
  }
  
  // Special handling for music kits
  if (item.music_index !== undefined) {
    const musicKit = this.itemsGame.music_kits?.[item.music_index];
    if (musicKit) {
      const musicName = this.translate(musicKit.loc_name);
      const musicArtist = this.translate(musicKit.loc_description);
      return `Music Kit | ${musicArtist}, ${musicName}`;
    }
  }
  
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

  // Add wear condition for weapons with skins
  // Only add wear if it's a weapon with a skin (has paint_index and paint_wear)
  if (item.paint_index && item.paint_wear !== undefined && item.paint_wear !== null) {
    const wearName = this.getWearName(item.paint_wear);
    if (wearName) {
      baseName = `${baseName} (${wearName})`;
    }
  }

  // Add ★ prefix for special quality items (knives, gloves, etc.)
  if (item.quality === 3) {
    baseName = '★ ' + baseName;
  }

  return baseName;
}


  buildImageUrl(item) {
  const defIndex = item.def_index || item.defindex;
  const itemDef = this.itemsGame.items?.[defIndex];
  
  // Special handling for stickers (def_index 1209)
  if (defIndex === 1209 && item.stickers && item.stickers[0]) {
    const stickerId = item.stickers[0].sticker_id;
    const stickerKit = this.itemsGame.sticker_kits?.[stickerId];
    if (stickerKit) {
      // Check for patch or sticker
      if (stickerKit.patch_material) {
        return `econ/patches/${stickerKit.patch_material}`;
      } else if (stickerKit.sticker_material) {
        return `econ/stickers/${stickerKit.sticker_material}`;
      } else if (stickerKit.image_inventory) {
        return stickerKit.image_inventory;
      }
    }
  }
  
  // Special handling for sealed graffiti
  if (defIndex === 1348 && item.stickers && item.stickers[0]) {
    const stickerId = item.stickers[0].sticker_id;
    const stickerKit = this.itemsGame.sticker_kits?.[stickerId];
    if (stickerKit && stickerKit.image_inventory) {
      return stickerKit.image_inventory;
    }
  }
  
  // Special handling for music kits
  if (item.music_index !== undefined) {
    const musicKit = this.itemsGame.music_kits?.[item.music_index];
    if (musicKit && musicKit.image_inventory) {
      return musicKit.image_inventory;
    }
  }
  
  if (!itemDef) {
    return '';
  }

  // Most items have image_inventory with the CDN hash
  if (itemDef.image_inventory) {
    if (itemDef.image_inventory.startsWith('-9a81')) {
      return itemDef.image_inventory;
    }
    if (itemDef.image_inventory.startsWith('econ/')) {
      return itemDef.image_inventory;
    }
    return itemDef.image_inventory;
  }

  // For weapons with skins
  if (item.paint_index && this.itemsGame.paint_kits?.[item.paint_index]) {
    const paintKit = this.itemsGame.paint_kits[item.paint_index];
    if (paintKit.image_inventory) {
      return paintKit.image_inventory;
    }
    return `econ/default_generated/${itemDef.name}_${paintKit.name}_light_large`;
  }

  // For base weapons
  if (itemDef.baseitem === '1' || itemDef.baseitem === 1) {
    return `econ/weapons/base_weapons/${itemDef.name}`;
  }

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
      let tradeDate;
      
      // Handle both Unix timestamp and ISO string formats
      if (typeof item.tradable_after === 'string') {
        // It's already an ISO date string
        tradeDate = new Date(item.tradable_after);
      } else if (typeof item.tradable_after === 'number') {
        // It's a Unix timestamp (seconds since epoch)
        tradeDate = new Date(item.tradable_after * 1000);
      } else {
        // Unknown format, assume tradable
        //console.warn(`Unknown tradable_after format: ${item.tradable_after}`);
        return true;
      }
      
      // Check if still trade-locked
      if (!isNaN(tradeDate.getTime()) && tradeDate > new Date()) {

        return false;
      }
    }
    
    // Check for other trade restrictions
    if (item.attribute) {
      // Check for "Not Tradable" attribute (different from trade lock)
      const notTradableAttr = item.attribute.find(attr => attr.def_index === 152);
      if (notTradableAttr) {
        return false;
      }
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
