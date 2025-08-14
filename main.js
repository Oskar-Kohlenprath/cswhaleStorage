// main.js
require("dotenv").config();
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require('fs');
const os = require('os');


// Steam libraries
const SteamUser = require("steam-user");
const GlobalOffensive = require("globaloffensive");
const SteamCommunity = require("steamcommunity");
const axios = require("axios");
const keytar = require("keytar");
const jwt_decode = require("jwt-decode");
const { autoUpdater } = require("electron-updater");

const ItemEnricher = require('./src/enrichment/itemEnricher');
let itemEnricher; // Define globally


// Constants
const BASE_SERVICE_NAME = "cs-assets-service";
const SERVICE_NAME = app.isPackaged
  ? BASE_SERVICE_NAME
  : `${BASE_SERVICE_NAME}-dev`;
const ACCOUNTS_KEY = "cs-assets-stored-accounts";
const DEVICE_TOKEN_KEY = "cs-assets-device-token";
const DELAY_MS = 130;
const MAX_INVENTORY_SIZE = 1000;
const MAX_CASKET_SIZE = 1000;
const INVENTORY_BUFFER = 50; // Increased buffer for safety
const SAFE_INVENTORY_SIZE = MAX_INVENTORY_SIZE - INVENTORY_BUFFER;
const API_BASE_URL = "https://cswhale-green-dust-4483.fly.dev/api";

// Global variables
let mainWindow;
let user; // SteamUser instance
let csgo; // GlobalOffensive instance
let community; // SteamCommunity instance
let lastReceivedToken = null;
let logStream; // For file logging
let deviceTokenRequestInProgress = false;














/**
 * Enhanced logger with file logging and console output
 */
class Logger {
  constructor() {
    this.setupFileLogging();
  }

  setupFileLogging() {
    try {
      const logDir = path.join(app.getPath('userData'), 'logs');
      
      // Create logs directory if it doesn't exist
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      const date = new Date().toISOString().split('T')[0];
      const logFile = path.join(logDir, `cs-assets-${date}.log`);
      
      logStream = fs.createWriteStream(logFile, { flags: 'a' });
      
      this.info(`Logger initialized. Logs will be saved to: ${logFile}`);
    } catch (err) {
      console.error('Failed to set up file logging:', err);
    }
  }

  log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${level}] ${message}`;
    
    // Log to console
    if (level === 'ERROR') {
      console.error(formattedMessage);
    } else if (level === 'WARN') {
      console.warn(formattedMessage);
    } else {
      console.log(formattedMessage);
    }


    if (typeof message === 'string') {
        message = message.replace(/device_token=[\w-]+/g, 'device_token=[REDACTED]');
    }
    
    // Log to file
    if (logStream) {
      logStream.write(formattedMessage + os.EOL);
    }
    
    // Send to renderer (but not full error objects)
    if (mainWindow && !mainWindow.isDestroyed()) {
      const simplifiedMessage = typeof message === 'object' 
        ? JSON.stringify(message) 
        : message;
      
      mainWindow.webContents.send("log-event", simplifiedMessage);
    }
  }

  info(message) {
    this.log(message, 'INFO');
  }

  warn(message) {
    this.log(message, 'WARN');
  }

  error(message, error) {
    // Log the main message
    this.log(message, 'ERROR');
    
    // If there's an error object, log its details too
    if (error) {
      if (error.stack) {
        this.log(`Error Stack: ${error.stack}`, 'ERROR');
      } else {
        this.log(`Error Details: ${JSON.stringify(error)}`, 'ERROR');
      }
    }
  }
}







const logger = new Logger();




autoUpdater.forceDevUpdateConfig = true;  // Bypass signature verification
autoUpdater.autoDownload = false;         // Let users choose when to download
autoUpdater.autoInstallOnAppQuit = false; // Let users choose when to install


autoUpdater.on('checking-for-update', () => {
    logger.info('Checking for update...');
    logger.info(`Current app version: ${app.getVersion()}`);
    if (mainWindow) {
        mainWindow.webContents.send('update-status', 'Checking for updates...');
    }
});





autoUpdater.on('update-available', (info) => {
    logger.info(`Update available: version ${info.version}`);
    logger.info(`Release date: ${info.releaseDate}`);
    logger.info(`Release notes: ${info.releaseNotes}`);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-available', {
            version: info.version,
            releaseNotes: info.releaseNotes
        });
    }
});

autoUpdater.on('update-not-available', (info) => {
    logger.info('No update available');
    logger.info(`Current version ${app.getVersion()} is the latest`);
});


autoUpdater.on('download-progress', (progressObj) => {
    logger.info(`Download progress: ${Math.round(progressObj.percent)}% (${progressObj.transferred}/${progressObj.total} bytes)`);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-progress', {
            percent: progressObj.percent,
            transferred: progressObj.transferred,
            total: progressObj.total
        });
    }
});

autoUpdater.on('update-downloaded', (info) => {
    logger.info(`Update downloaded: version ${info.version}`);
    logger.info('Update is ready to install');
    
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-downloaded', {
            version: info.version
        });
    }
});



autoUpdater.on('error', (err) => {
    logger.error('Auto-updater error:', err);
    logger.error(`Error message: ${err.message}`);
    logger.error(`Error stack: ${err.stack}`);
    
    if (mainWindow) {
        mainWindow.webContents.send('update-error', err.message);
    }
});



/**
 * Get device token from keytar
 * @returns {Promise<string|null>} Device token or null
 */
async function getDeviceToken() {
  try {
    return await keytar.getPassword(SERVICE_NAME, DEVICE_TOKEN_KEY);
  } catch (err) {
    logger.error("Error getting device token", err);
    return null;
  }
}




async function ensureValidDeviceToken() {
  const token = await getDeviceToken();
  if (!token) {
    // If no token during active session, try to get one
    if (user && user.steamID) {
      const steamId = user.steamID.getSteamID64();
      return await ensureDeviceToken(steamId);
    }
    throw new Error("No device token and no active session");
  }
  return token;
}




async function ensureValidDeviceTokenEnhanced() {
  const token = await getDeviceToken();
  if (!token) {
    // If no token during active session, try to get one
    if (user && user.steamID) {
      const steamId = user.steamID.getSteamID64();
      return await ensureDeviceToken(steamId);
    }
    throw new Error("No device token and no active session");
  }
  
  // Validate token by making a simple API call
  try {
    const testUrl = `${API_BASE_URL}/desktop_steam_accounts`;
    await axios.post(testUrl, { device_token: token }, { timeout: 5000 });
    return token;
  } catch (error) {
    if (error.response && error.response.status === 401) {
      logger.info('Stored device token is invalid, clearing and getting new one...');
      await keytar.deletePassword(SERVICE_NAME, DEVICE_TOKEN_KEY);
      
      if (user && user.steamID) {
        const steamId = user.steamID.getSteamID64();
        return await ensureDeviceToken(steamId);
      }
      throw new Error("Invalid token and no active session");
    }
    throw error;
  }
}














/**
 * Wrapper for API calls that handles device token validation
 * Automatically initiates 2FA flow if token is invalid
 * @param {Function} apiCall - The API call function to wrap
 * @param {any[]} args - Arguments to pass to the API call
 * @returns {Promise<any>} Result of the API call
 */
async function withDeviceTokenRetry(apiCall, ...args) {
  try {
    // First attempt with existing token
    return await apiCall(...args);
  } catch (error) {
    // Check if it's a 401 with invalid device token
    if (error.response && error.response.status === 401) {
      const errorData = error.response.data;
      if (errorData && (errorData.error === 'Invalid device token' || errorData.error === 'Device token required')) {
        logger.info('Device token invalid or missing, initiating 2FA flow...');
        
        // Clear the invalid token from keytar
        await keytar.deletePassword(SERVICE_NAME, DEVICE_TOKEN_KEY);
        
        // Get current steam ID if available
        let steamId = null;
        if (user && user.steamID) {
          steamId = user.steamID.getSteamID64();
        } else {
          // Try to get from the first available account
          const accounts = await getAllAccounts();
          if (accounts.length > 0) {
            steamId = accounts[0].steamId;
          }
        }
        
        if (!steamId) {
          throw new Error('No Steam account available for 2FA');
        }
        
        // Initiate 2FA flow
        const newToken = await ensureDeviceToken(steamId);
        logger.info('New device token obtained, retrying API call...');
        
        // Retry the original API call
        return await apiCall(...args);
      }
    }
    // Re-throw if it's not a token issue
    throw error;
  }
}













/**
 * Create the main application window
 */
function createWindow() {


    let iconPath;
  if (process.platform === 'win32') {
    // Windows needs .ico file
    iconPath = app.isPackaged 
      ? path.join(process.resourcesPath, 'static/images/icons/icon.ico')
      : path.join(__dirname, 'static/images/icons/icon.ico');
  } else if (process.platform === 'darwin') {
    // macOS uses .icns
    iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'static/images/icons/icon.icns')
      : path.join(__dirname, 'static/images/icons/icon.icns');
  } else {
    // Linux uses .png
    iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'static/images/icons/icon.png')
      : path.join(__dirname, 'static/images/icons/icon.png');
  }



    mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      enableRemoteModule: false,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f172a',
    show: false,
  });

  // Create splash screen
  const splash = new BrowserWindow({
    width: 400,
    height: 400,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    center: true,
  });

  splash.loadFile("static/splash.html");
  mainWindow.loadFile("index.html");

  // Show main window when it's ready, and close splash screen
  mainWindow.once('ready-to-show', () => {
    splash.destroy();
    mainWindow.show();
    
    // Check for updates after window is shown
    // Check for updates after window is shown
  if (app.isPackaged) {  // Only in production
      setTimeout(() => {
          logger.info('=== AUTO-UPDATE CHECK ===');
          logger.info(`App version: ${app.getVersion()}`);
          logger.info(`Platform: ${process.platform}`);
          logger.info(`Architecture: ${process.arch}`);
          logger.info(`Electron version: ${process.versions.electron}`);
          
          autoUpdater.checkForUpdatesAndNotify()
              .then(result => {
                  logger.info('Update check initiated successfully');
                  if (result) {
                      logger.info(`Update check result: ${JSON.stringify(result)}`);
                  }
              })
              .catch(err => {
                  logger.error('Update check failed:', err);
                  logger.error(`Error details: ${err.message}`);
                  logger.error(`Network available: ${require('electron').net.isOnline()}`);
              });
      }, 3000);
  }
});


  // Open DevTools only in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
  
  // Handle window close
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}



















/**
 * Initialize application
 */
app.whenReady().then(async () => {
  logger.info("Application starting...");
  
  // Create community instance
  community = new SteamCommunity();
  
  // Initialize window
  createWindow();

  // Validate tokens
  await validateAllStoredTokens();

  

  // Initialize item enricher
  itemEnricher = new ItemEnricher(logger);
  itemEnricher.initialize().catch(err => {
    logger.error('Failed to initialize item enricher', err);
  });



  // Fetch accounts with automatic token refresh if needed
  try {
    const deviceToken = await keytar.getPassword(SERVICE_NAME, DEVICE_TOKEN_KEY);
    if (deviceToken) {
      // Use the enhanced version that handles invalid tokens
      await fetchAndUpdateAccountsFromFlaskEnhanced(deviceToken);
    }
  } catch (err) {
    logger.error("Error fetching accounts on startup", err);
    // If it's a token issue and we have a window, show a message
    if (mainWindow && !mainWindow.isDestroyed() && err.message.includes('token')) {
      mainWindow.webContents.send('device-token-expired');
    }
  }
});



// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});













// IPC handlers for updater
ipcMain.handle('download-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (error) {
    logger.error('Failed to download update:', error);
    return { success: false, error: error.message };
  }
});


// Add IPC handler for device token expiry notification
ipcMain.handle('refresh-device-token', async () => {
  try {
    if (user && user.steamID) {
      const steamId = user.steamID.getSteamID64();
      const newToken = await ensureDeviceToken(steamId);
      return { success: true, token: newToken };
    } else {
      // Get from first available account
      const accounts = await getAllAccounts();
      if (accounts.length > 0) {
        const newToken = await ensureDeviceToken(accounts[0].steamId);
        return { success: true, token: newToken };
      }
    }
    return { success: false, error: 'No Steam account available' };
  } catch (error) {
    logger.error('Failed to refresh device token', error);
    return { success: false, error: error.message };
  }
});


ipcMain.handle('install-update', async () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('check-for-updates', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return { success: true, updateInfo: result?.updateInfo };
  } catch (error) {
    logger.error('Failed to check for updates:', error);
    return { success: false, error: error.message };
  }
});













/**
 * Fetch and update accounts from Flask API
 * @param {string} deviceToken - The device token for authentication
 * @returns {Array} Updated accounts list
 */
// Updated fetchAndUpdateAccountsFromFlask with token retry
async function fetchAndUpdateAccountsFromFlaskEnhanced(deviceToken) {
  const apiCall = async (token) => {
    const serverUrl = `${API_BASE_URL}/desktop_steam_accounts`;
    const resp = await axios.post(serverUrl, { device_token: token || deviceToken });
    return resp;
  };
  
  const resp = await withDeviceTokenRetry(apiCall, deviceToken);
  const steamAccounts = resp.data.steam_accounts || [];
  logger.info(`Flask returned ${steamAccounts.length} steam accounts.`);

  // Rest of the function remains the same...
  const existingAccounts = await loadAccountsJSON();
  const updatedAccounts = [...existingAccounts];

  for (const flaskAccount of steamAccounts) {
    const steamId = flaskAccount.steam_id;
    const displayName = flaskAccount.persona_name || steamId;
    const avatarUrl = flaskAccount.avatar_url || "static/images/default-avatar.png";

    const existingIdx = existingAccounts.findIndex(a => a.steamId === steamId);

    if (existingIdx >= 0) {
      updatedAccounts[existingIdx].displayName = displayName;
      updatedAccounts[existingIdx].avatarUrl = avatarUrl;
      updatedAccounts[existingIdx].isRegistered = true;
    } else {
      updatedAccounts.push({
        steamId,
        displayName,
        avatarUrl,
        refreshToken: "",
        isRegistered: true,
        lastUsed: Date.now(),
      });
    }
  }

  await saveAccountsJSON(updatedAccounts);
  return updatedAccounts;
}

/**
 * Handle IPC request to get saved accounts
 */
ipcMain.handle("get-saved-accounts", async () => {
  // Fetch all accounts from Keytar
  const allAccounts = await getAllAccounts();
  return allAccounts;
});

/**
 * Load accounts from secure storage
 * @returns {Array} List of stored accounts
 */
async function loadAccountsJSON() {
  try {
    const existing = await keytar.getPassword(SERVICE_NAME, ACCOUNTS_KEY);
    if (!existing) {
      // No data stored yet
      return [];
    }
    return JSON.parse(existing);
  } catch (err) {
    logger.error("Error parsing stored accounts JSON", err);
    return [];
  }
}

/**
 * Save accounts to secure storage
 * @param {Array} accounts - List of accounts to save
 */
async function saveAccountsJSON(accounts) {
  try {
    const json = JSON.stringify(accounts);
    await keytar.setPassword(SERVICE_NAME, ACCOUNTS_KEY, json);
  } catch (err) {
    logger.error("Error saving accounts to storage", err);
    throw err;
  }
}

/**
 * Get all stored accounts
 * @returns {Array} List of all accounts
 */
async function getAllAccounts() {
  return await loadAccountsJSON();
}

/**
 * Save account data to storage
 * @param {Object} accountData - Account data to save
 */
async function saveAccountData({
  steamId,
  displayName,
  refreshToken,
  isRegistered,
  avatarUrl
}) {
  try {
    const accounts = await loadAccountsJSON();

    // If we're saving a non-empty refresh token, verify it's unique
    if (refreshToken && refreshToken.trim() !== "") {
      // First verify the token belongs to this account
      const tokenSteamId = extractSteamIdFromToken(refreshToken);

      if (tokenSteamId && tokenSteamId !== steamId) {
        logger.warn(
          `WARNING: Attempted to save a token for ${steamId} that belongs to ${tokenSteamId}`
        );
        // Token belongs to a different account - don't save it
        return;
      }

      // Check if this token is already saved to a different account
      const existingWithToken = accounts.find(
        (a) => a.steamId !== steamId && a.refreshToken === refreshToken
      );

      if (existingWithToken) {
        logger.warn(
          `Token uniqueness violation detected. Token already exists for account ${
            existingWithToken.displayName || existingWithToken.steamId
          }`
        );

        // Remove the token from the other account
        logger.info(
          `Removing duplicate token from account ${
            existingWithToken.displayName || existingWithToken.steamId
          }`
        );

        const otherIdx = accounts.findIndex(
          (a) => a.steamId === existingWithToken.steamId
        );
        if (otherIdx >= 0) {
          accounts[otherIdx].refreshToken = "";
        }
      }
    }

    // Now save/update the current account
    const idx = accounts.findIndex((a) => a.steamId === steamId);
    if (idx >= 0) {
      // Update existing account
      if (displayName) accounts[idx].displayName = displayName;
      if (refreshToken !== undefined) accounts[idx].refreshToken = refreshToken;
      if (avatarUrl) accounts[idx].avatarUrl = avatarUrl;
      accounts[idx].lastUsed = Date.now();
      
      // Only update isRegistered if provided
      if (typeof isRegistered !== "undefined") {
        accounts[idx].isRegistered = isRegistered;
      }
    } else {
      // Add new account
      accounts.push({
        steamId,
        displayName: displayName || steamId,
        refreshToken: refreshToken || "",
        avatarUrl: avatarUrl || "static/images/default-avatar.png",
        lastUsed: Date.now(),
        isRegistered: typeof isRegistered !== "undefined" ? isRegistered : false,
      });
    }

    await saveAccountsJSON(accounts);

    // If this was a token update, send notification to the user
    
  } catch (err) {
    logger.error("Error saving account data", err);
  }
}

/**
 * Handle login with refresh token
 */
ipcMain.handle('login-with-refresh-token', async (event, steamId) => {
  try {
    const accounts = await getAllAccounts();
    const found = accounts.find(a => a.steamId === steamId);
    
    if (!found || !found.refreshToken || found.refreshToken.trim() === '') {
      throw new Error('No valid refresh token for this account');
    }
    
    // Terminate any existing session
    await terminateSteamSession();
    
    // Log in with the token
    await initCSGO({ refreshToken: found.refreshToken });
    
    // Update account's last used timestamp
    await saveAccountData({
      steamId,
      displayName: found.displayName,
      lastUsed: Date.now()
    });
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-success');
    }
  } catch (error) {
    logger.error('Login with refresh token failed', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-failed', "Login failed. Please try again.");
    }
  }
});

/**
 * Handle moving items from storage
 */
ipcMain.handle('move-items-from-storage', async (_event, payload) => {
  const apiCall = async () => {
    await performMoves(payload);
    return { success: true };
  };

  try {
    return await withDeviceTokenRetry(apiCall);
  } catch (err) {
    logger.error("Move items operation failed", err);
    return { success: false, error: "Failed to move items. Please try again." };
  }
});

/**
 * Handle login credentials from renderer
 */
ipcMain.on('login-credentials', async (event, credentials) => {
  try {
    await terminateSteamSession();
    await initCSGO(credentials);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-success');
    }
  } catch (error) {
    logger.error('Login failed', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-failed', "Login failed. Please check your credentials and try again.");
    }
  }
});

/**
 * Handle fetch storage request
 */
ipcMain.on("fetch-storage", async () => {
  try {
    if (!user || !csgo || !csgo.haveGCSession) {
      throw new Error("Not connected to Steam. Please log in first.");
    }
    
    const caskets = await fetchAllCaskets();
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("storage-items", caskets);
    }
    
    // Get the current Steam account id from the logged-in user
    const steamAccountId = user.steamID.getSteamID64();
    
    // Send the caskets to the Flask endpoint
    try {
      const serverResponse = await sendStorageUnitsToServer(caskets, steamAccountId);
      logger.info(`Storage units sent to server: ${JSON.stringify(serverResponse)}`);
    } catch (serverErr) {
      logger.error("Error sending storage units to server", serverErr);
      // We don't need to notify the user about this server-side issue
    }
  } catch (error) {
    logger.error("Error fetching storage units", error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("storage-error", "Failed to fetch storage units. Please try again.");
    }
  }
});

/**
 * Handle casket deep check request
 */
// Replace the entire casket-deep-check handler (lines ~500-850) with:
ipcMain.on("casket-deep-check", async (event, casketId) => {
  try {
    logger.info(`Starting scan of storage unit ${casketId}...`);

    if (!user || !csgo || !csgo.haveGCSession) {
      throw new Error("Not connected to Steam. Please log in first.");
    }

    // Get the casket contents
    logger.info(`Fetching contents of storage unit ${casketId}...`);
    const casketItems = await fetchCasketContents(casketId);
    logger.info(`Storage unit ${casketId} contains ${casketItems.length} items`);
    
    // DEBUG: Log first item to see structure
    if (casketItems.length > 0) {
      logger.info(`Sample raw item: ${JSON.stringify(casketItems[0])}`);
    }

    // Initialize enricher if needed
    if (!itemEnricher) {
      const ItemEnricher = require('./src/enrichment/itemEnricher');
      itemEnricher = new ItemEnricher(logger);
      await itemEnricher.initialize();
    }

    // Enrich the items
    logger.info(`Enriching ${casketItems.length} items with game data...`);
    const enrichedItems = [];
    
    for (const item of casketItems) {
      try {
        const enriched = await itemEnricher.enrichItem(item);
        enrichedItems.push(enriched);
        
        // Log first enriched item as sample
        if (enrichedItems.length === 1) {
          logger.info(`Sample enriched item: ${JSON.stringify(enriched)}`);
        }
      } catch (err) {
        logger.error(`Failed to enrich item ${item.id}`, err);
        // Add fallback for failed enrichment
        enrichedItems.push({
          assetid: item.id,
          market_hash_name: "Unknown Item",
          icon_url: "",
          tradable: true,
          appid: 730
        });
      }
    }

    // Log summary of enrichment
    const itemCounts = {};
    enrichedItems.forEach(item => {
      const name = item.item_name || item.market_hash_name || 'Unknown';
      itemCounts[name] = (itemCounts[name] || 0) + 1;
    });
    
    // Log top 5 items
    Object.entries(itemCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([name, count]) => {
        logger.info(`[DEBUG] Sending ${count}x ${name}`);
      });

    // Send to server
    const steamAccountId = user.steamID.getSteamID64();
    try {
      const serverResponse = await sendNewItemsToServer(
        casketId,
        enrichedItems,
        steamAccountId
      );
      logger.info(`Server response: ${JSON.stringify(serverResponse)}`);
    } catch (serverErr) {
      logger.error("Error sending items to server", serverErr);
    }

    // Send result to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("deep-check-result", {
        success: true,
        newlyAddedItems: enrichedItems,
        totalTimeMs: 0,
        estimatedSeconds: 0,
      });
    }

  } catch (error) {
    logger.error("Error in storage unit scan", error);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("deep-check-result", {
        success: false,
        error: error.message || "Unknown error during scan",
      });
    }
  }
});

/**
 * Send newly discovered items to server
 * @param {string} casketId - Storage unit ID
 * @param {Array} newlyAddedItems - Items to send
 * @param {string} steamAccountId - Steam account ID
 * @returns {Object} Server response
 */
// Update sendNewItemsToServer function
async function sendNewItemsToServer(casketId, newlyAddedItems, steamAccountId) {
  if (!newlyAddedItems || newlyAddedItems.length === 0) {
    logger.info('[DEBUG] No items to send, skipping server request');
    return { success: true, message: 'No items to register' };
  }

  const apiCall = async () => {
    const deviceToken = await getDeviceToken();
    if (!deviceToken) {
      throw new Error("Device token required");
    }

    const serverUrl = `${API_BASE_URL}/register_storage_items`;
    
    // Transform enriched items to what server expects
    const itemsForServer = newlyAddedItems.map(item => ({
      assetid: item.assetid || item.id,
      market_hash_name: item.market_hash_name || item.item_name,
      // Don't send classid/instanceid since we don't have them
      // classid and instanceid will be empty strings on server
      icon_url: item.icon_url || '',
      tradable: item.tradable !== undefined ? item.tradable : true,
      category: item.item_type || item.category
    }));
    
    const payload = {
      device_token: deviceToken,
      steam_account_id: steamAccountId,
      storage_unit_id: casketId,
      items: itemsForServer,
    };

    logger.info(`[DEBUG] Preparing to send ${itemsForServer.length} items`);

    const counts = {};
    itemsForServer.forEach(item => {
      const name = item.market_hash_name || 'Unknown';
      counts[name] = (counts[name] || 0) + 1;
    });

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    sorted.slice(0, 5).forEach(([name, count]) => {
      logger.info(`[DEBUG] Sending ${count}x ${name}`);
    });

    const resp = await axios.post(serverUrl, payload, {
      withCredentials: true,
    });
    
    if (!resp.data.success) {
      throw new Error(resp.data.error || "Unknown error from server");
    }
    
    return resp.data;
  };

  return await withDeviceTokenRetry(apiCall);
}




/**
 * Send storage units to server
 * @param {Array} caskets - Storage units to send
 * @param {string} steamAccountId - Steam account ID
 * @returns {Object} Server response
 */
// Update sendStorageUnitsToServer function
async function sendStorageUnitsToServer(caskets, steamAccountId) {
  const apiCall = async () => {
    const deviceToken = await getDeviceToken();
    if (!deviceToken) {
      throw new Error("Device token required");
    }

    const serverUrl = `${API_BASE_URL}/register_storage_units`;
    const payload = {
      device_token: deviceToken,
      steam_account_id: steamAccountId,
      storage_units: caskets.map((casket) => ({
        storage_unit_id: casket.casketId,
        name: casket.casketName,
      })),
    };
    
    const resp = await axios.post(serverUrl, payload, {
      withCredentials: true,
    });
    
    if (!resp.data.success) {
      throw new Error(resp.data.error || "Unknown error from server");
    }
    
    return resp.data;
  };

  return await withDeviceTokenRetry(apiCall);
}
/**
 * Initialize CS:GO connection
 * @param {Object} credentials - Login credentials
 * @returns {Promise} Resolves when connected
 */
async function initCSGO(credentials) {
  return new Promise((resolve, reject) => {
    if (user && csgo && csgo.haveGCSession) {
      logger.info('Already logged in with an active GC session.');
      return resolve();
    }

    // Reset the lastReceivedToken for this login session
    lastReceivedToken = null;

    // Create new user and csgo instances
    user = new SteamUser();
    csgo = new GlobalOffensive(user);

    // Simple token capture without immediate saving
    user.on("refreshToken", (token) => {
      if (!token) {
        logger.warn("Got an empty refresh token from steam-user");
        return;
      }
      
      logger.info(`Received new refresh token from Steam`);
      lastReceivedToken = token; // Store it for later use
    });

    // On successful login, handle token saving
    user.on("loggedOn", async () => {
      const steamId = user.steamID.getSteamID64();
      logger.info(`Logged in as ${steamId}`);
      
      user.setPersona(SteamUser.EPersonaState.Online);
      user.gamesPlayed([730]);

      // Determine which token to use - either the one we just received or the one from credentials
      let finalToken = lastReceivedToken;
      if (!finalToken && credentials.refreshToken) {
        finalToken = credentials.refreshToken;
        logger.info(`Using token from credentials`);
      }

      // Handle device token
      let dt = await keytar.getPassword(SERVICE_NAME, DEVICE_TOKEN_KEY);
      if (!dt) {
        try {
          dt = await ensureDeviceToken(steamId);
          logger.info(`Device token is confirmed`);
        } catch (err) {
          logger.error('Error ensuring device token', err);
          return;
        }
      }

      // Get accounts from Flask API
      try {
        const accounts = await fetchAndUpdateAccountsFromFlaskEnhanced(dt);
        const loggedInAccount = accounts.find(a => a.steamId === steamId);

        if (loggedInAccount) {
        
          if (finalToken) {
            
            await saveAccountData({
              steamId,
              displayName: loggedInAccount.displayName,
              refreshToken: finalToken,
              isRegistered: true,
              avatarUrl: loggedInAccount.avatarUrl
            });
            
            // Also check if this token is duplicated in other accounts and remove it
            await removeTokenFromOtherAccounts(finalToken, steamId);
          }

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('account-details', {
              steamId,
              displayName: loggedInAccount.displayName,
              avatarUrl: loggedInAccount.avatarUrl || 'static/images/default-avatar.png'
            });
          }

          // Ask Flask what we still need in live inventory
          try {
            await checkInventoryNeeds(steamId);
          } catch (err) {
            logger.error(`Inventory-needs check failed`, err);
          }
        } else {
          // Not a registered account
          logger.warn(`Account ${steamId} not found in Flask accounts list`);
          
          if (finalToken) {
            await saveAccountData({
              steamId,
              displayName: credentials.username || steamId,
              refreshToken: finalToken,
              isRegistered: false
            });
            
            // Also remove this token from other accounts
            await removeTokenFromOtherAccounts(finalToken, steamId);
          }

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('account-details', {
              steamId,
              displayName: credentials.username || steamId,
              avatarUrl: 'static/images/default-avatar.png'
            });
            
            mainWindow.webContents.send('account-not-registered', {
              steamId,
              displayName: credentials.username || steamId
            });
          }
        }
      } catch (err) {
        logger.error(`Error during account processing`, err);
        
        // Even if Flask fails, save the token
        if (finalToken) {
          await saveAccountData({
            steamId,
            displayName: credentials.username || steamId,
            refreshToken: finalToken
          });
          
          await removeTokenFromOtherAccounts(finalToken, steamId);
        }
      }
    });

    // Web session handling
    user.on("webSession", (sessionID, cookies) => {
      logger.info(`Obtained web session: ${sessionID}`);
      community.setCookies(cookies);
    });

    // Steam Guard handling
    user.on("steamGuard", (domain, callback) => {
      logger.info(`SteamGuard code required for domain: ${domain}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("steamGuard-required", domain);
        ipcMain.once("steamGuard-code", (_event, code) => {
          logger.info(`Received SteamGuard code from renderer`);
          callback(code);
        });
      } else {
        reject(new Error("Main window not available for SteamGuard prompt."));
      }
    });

    // Error handling
    user.on("error", (err) => {
      logger.error(`Steam user error`, err);
      reject(err);
    });

    // CS:GO connection events
    csgo.on("connectedToGC", () => {
      logger.info("Connected to GC.");
      resolve();
    });

    csgo.on("disconnectedFromGC", (reason) => {
      logger.warn(`Disconnected from GC: ${reason}`);
    });

    // Login with credentials
    if (credentials.refreshToken) {
      user.logOn({
        refreshToken: credentials.refreshToken,
      });
    } else {
      user.logOn({
        accountName: credentials.username,
        password: credentials.password,
      });
    }
  });
}

/**
 * Remove token from other accounts
 * @param {string} token - Token to remove
 * @param {string} exceptSteamId - Steam ID to exclude
 */
async function removeTokenFromOtherAccounts(token, exceptSteamId) {
  if (!token) return;
  
  try {
    const accounts = await getAllAccounts();
    let hasChanges = false;
    
    for (const account of accounts) {
      if (account.steamId !== exceptSteamId && account.refreshToken === token) {
        logger.info(`Removing duplicate token from account ${account.displayName || account.steamId}`);
        account.refreshToken = '';
        hasChanges = true;
      }
    }
    
    if (hasChanges) {
      await saveAccountsJSON(accounts);
    }
  } catch (err) {
    logger.error(`Error removing duplicate tokens`, err);
  }
}

/**
 * Get web inventory
 * @returns {Promise<Array>} Inventory items
 */
async function getWebInventory() {
  return retryWithBackoff(() => {
    return new Promise((resolve, reject) => {
      community.getUserInventoryContents(
        user.steamID,
        730,
        2,
        false,
        (err, inventory) => {
          if (err) {
            logger.error(`Error fetching inventory`, err);
            return reject(err);
          }
          logger.info(`Inventory fetched. Count = ${inventory.length}`);
          resolve(inventory);
        }
      );
    });
  });
}





async function retryWithBackoff(fn, maxRetries = 5, initialDelay = 1000) {
  let lastError;
  let delay = initialDelay;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Check if it's a rate limit error
      if (error.message && error.message.includes('duplicate') && attempt < maxRetries - 1) {
        logger.warn(`Rate limit hit, waiting ${delay}ms before retry (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Exponential backoff with jitter
        delay = Math.min(delay * 2 + Math.random() * 1000, 30000);
      } else {
        throw error;
      }
    }
  }
  
  throw lastError;
}



/**
 * Fetch all storage units (caskets)
 * @returns {Promise<Array>} List of storage units
 */
async function fetchAllCaskets() {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (!csgo || !csgo.inventory || csgo.inventory.length === 0) {
        return reject(new Error("No items found in inventory."));
      }
      
      const storageUnits = csgo.inventory.filter(
        (item) => typeof item.casket_contained_item_count !== "undefined"
      );
      
      if (storageUnits.length === 0) {
        return reject(new Error("No storage units found."));
      }
      
      const casketArray = storageUnits.map((unit) => ({
        casketId: unit.id,
        casketName: unit.custom_name || "Unnamed Storage",
        itemCount: unit.casket_contained_item_count || 0,
      }));
      
      resolve(casketArray);
    }, 2000);
  });
}

/**
 * Fetch storage unit contents
 * @param {string} casketId - Storage unit ID
 * @returns {Promise<Array>} List of items in storage unit
 */
async function fetchCasketContents(casketId, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Loading casket contents timed out (attempt ${attempt})`));
        }, 5000);  // 5 second timeout
        
        csgo.getCasketContents(casketId, (err, items) => {
          clearTimeout(timeout);
          if (err) return reject(err);
          resolve(items);
        });
      });
    } catch (err) {
      if (attempt === retries) {
        logger.error(`Failed to fetch contents of casket ${casketId} after ${retries} attempts:`, err);
        return [];  // Return empty array instead of throwing
      }
      logger.warn(`Attempt ${attempt} failed for casket ${casketId}, retrying...`);
      await delay(1000);  // Wait 1 second before retry
    }
  }
}

/**
 * Delay execution
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise} Resolves after delay
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract Steam ID from token
 * @param {string} token - Refresh token
 * @returns {string|null} Steam ID or null
 */
function extractSteamIdFromToken(token) {
  if (!token) return null;
  
  try {
    const decoded = jwt_decode(token);
    return decoded.sub || null;
  } catch (err) {
    logger.error("Error decoding token", err);
    return null;
  }
}

/**
 * Terminate Steam session
 */
async function terminateSteamSession() {
  if (!user) return;
  
  logger.info('Terminating existing Steam session...');
  
  try {
    // ✅ Remove all event listeners BEFORE creating new instances
    if (user) {
      user.removeAllListeners();
    }
    if (csgo) {
      csgo.removeAllListeners();
    }
    
    // Stop playing games
    if (user.steamID) {
      user.gamesPlayed([]);
      user.logOff();
      
      // Wait for logoff
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Create new instances
    user = new SteamUser();
    csgo = new GlobalOffensive(user);
    
    // Increase max listeners if needed
    csgo.setMaxListeners(20);  // Increase from default 10
    
    lastReceivedToken = null;
    
    logger.info('Session terminated successfully');
  } catch (err) {
    logger.error(`Error in session termination`, err);
    
    // Force new instances
    user = new SteamUser();
    csgo = new GlobalOffensive(user);
    csgo.setMaxListeners(20);
  }
}

/**
 * Validate all stored tokens
 */
async function validateAllStoredTokens() {
  logger.info("Validating all stored refresh tokens...");

  try {
    const accounts = await getAllAccounts();
    let hasChanges = false;

    // Track tokens we've seen to detect duplicates
    const seenTokens = new Map(); // token -> steamId

    // First pass - detect and resolve duplicates
    for (const account of accounts) {
      const token = account.refreshToken;

      if (!token || token.trim() === "") {
        continue; // Skip accounts without tokens
      }

      // Check if we've seen this token already
      if (seenTokens.has(token)) {
        const firstAccountId = seenTokens.get(token);
        logger.warn(
          `Duplicate token detected: accounts ${firstAccountId} and ${account.steamId} have the same token`
        );

        // Decode token to see which account it really belongs to
        const tokenSteamId = extractSteamIdFromToken(token);

        if (tokenSteamId) {
          // We know which account this token belongs to
          if (tokenSteamId === account.steamId) {
            // Clear token from the first account
            const firstAccount = accounts.find(
              (a) => a.steamId === firstAccountId
            );
            logger.info(
              `Token belongs to ${account.steamId}, clearing from ${firstAccountId}`
            );
            firstAccount.refreshToken = "";
            hasChanges = true;
          } else if (tokenSteamId === firstAccountId) {
            // Clear token from current account
            logger.info(
              `Token belongs to ${firstAccountId}, clearing from ${account.steamId}`
            );
            account.refreshToken = "";
            hasChanges = true;
          } else {
            // Token doesn't belong to either account
            logger.warn(
              `Token doesn't belong to either account (${firstAccountId} or ${account.steamId}), belongs to ${tokenSteamId}`
            );
            // Clear from both
            account.refreshToken = "";
            const firstAccount = accounts.find(
              (a) => a.steamId === firstAccountId
            );
            firstAccount.refreshToken = "";
            hasChanges = true;
          }
        } else {
          // Can't decode - clear from the second account as a precaution
          logger.warn(
            `Can't decode token, clearing from second account ${account.steamId}`
          );
          account.refreshToken = "";
          hasChanges = true;
        }
      } else {
        // First time seeing this token
        seenTokens.set(token, account.steamId);

        // While we're at it, validate the token belongs to this account
        const tokenSteamId = extractSteamIdFromToken(token);
        if (tokenSteamId && tokenSteamId !== account.steamId) {
          logger.warn(
            `Token for account ${account.steamId} actually belongs to ${tokenSteamId}, clearing`
          );
          account.refreshToken = "";
          hasChanges = true;
        }
      }
    }

    // Save changes if needed
    if (hasChanges) {
      logger.info("Token validation found and fixed issues, saving updated accounts");
      await saveAccountsJSON(accounts);
    } else {
      logger.info("Token validation complete, no issues found");
    }
  } catch (err) {
    logger.error(`Error validating tokens`, err);
  }
}

/**
 * Ensure device token exists
 * @param {string} steamId - Steam ID
 * @returns {Promise<string>} Device token
 */
async function ensureDeviceToken(steamId) {
  // Check if Keytar already has a device token
  const existingToken = await keytar.getPassword(SERVICE_NAME, DEVICE_TOKEN_KEY);
  
  if (existingToken) {
    logger.info("Device token found in Keytar. No 2FA needed.");
    return existingToken;
  }

  logger.info("No device token in Keytar. Initiating 2FA flow via Flask...");


  if (deviceTokenRequestInProgress) {
    logger.warn("Device token request already in progress, skipping duplicate");
    return;
  }

  try {
    // Make initial device_token_request
    let response = await axios.post(
      `${API_BASE_URL}/device_token_request`,
      { steam_id: steamId }
    );

    // Check if email is required
    if (response.data.status === 'email_required') {
      logger.info("User has no email on file, requesting email from user...");
      
      // Prompt user for email
      const userEmail = await promptUserForEmail();
      
      if (!userEmail) {
        throw new Error("Email is required for 2FA verification");
      }
      
      // Retry with email
      response = await axios.post(
        `${API_BASE_URL}/device_token_request`,
        { 
          steam_id: steamId,
          email: userEmail 
        }
      );
      
      if (response.data.status !== '2fa_sent') {
        throw new Error("Failed to send 2FA after providing email");
      }
    }
    
    // At this point, 2FA has been sent
    if (response.data.status === '2fa_sent') {
      logger.info(`2FA sent to ${response.data.email_masked || 'email'}`);
      
      // Prompt for 2FA code
      const twoFaCode = await promptUserFor2FACodeInRenderer();
      
      // Confirm with the code
      const confirmResp = await axios.post(
        `${API_BASE_URL}/device_token_confirm`,
        {
          steam_id: steamId,
          code: twoFaCode
        }
      );
      
      if (!confirmResp.data || !confirmResp.data.device_token) {
        throw new Error("Flask returned no device_token");
      }
      
      const newToken = confirmResp.data.device_token;
      logger.info("Device token obtained from Flask");
      
      // Store in Keytar
      await keytar.setPassword(SERVICE_NAME, DEVICE_TOKEN_KEY, newToken);
      return newToken;
    }
    
    throw new Error("Unexpected response from server");
    
  } catch (err) {
    if (err.response) {
      logger.error(
        `Error in ensureDeviceToken flow: Status ${err.response.status}`,
        err.response.data
      );
    } else {
      logger.error("Error in ensureDeviceToken flow", err);
    }
    throw err;
  }
}

// Add new function to prompt for email
async function promptUserForEmail() {
  return new Promise((resolve, reject) => {
    // Set up timeout
    const timeout = setTimeout(() => {
      reject(new Error("Email prompt timeout"));
    }, 300000); // 5 minute timeout
    
    ipcMain.once("email-submitted", (event, email) => {
      clearTimeout(timeout);
      resolve(email);
    });
    
    ipcMain.once("email-cancelled", () => {
      clearTimeout(timeout);
      resolve(null);
    });
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("please-enter-email");
      logger.info("Email prompt sent to renderer");
    } else {
      clearTimeout(timeout);
      reject(new Error("Main window not available"));
    }
  });
}

/**
 * Prompt user for 2FA code
 * @returns {Promise<string>} 2FA code
 */
async function promptUserFor2FACodeInRenderer() {
  return new Promise((resolve) => {
    // Listen once for the code
    ipcMain.once("2fa-code-submitted", (event, code) => {
      resolve(code);
    });
    
    // Ask renderer to open a modal or prompt
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("please-enter-2fa");
      logger.info("2FA prompt sent to renderer");
    }
  });
}

/**
 * Check inventory needs from Flask
 * @param {string} steamId - Steam ID
 */
// In main.js
async function checkInventoryNeeds(steamId) {
  const apiCall = async () => {
    logger.info("Fetching inventory-needs from API");
    const url = `${API_BASE_URL}/inventory_needs/${steamId}`;
    
    const deviceToken = await getDeviceToken();
    if (!deviceToken) {
      throw new Error("Device token required");
    }

    const { data } = await axios.post(url, { 
      device_token: deviceToken
    }, {
      withCredentials: true
    });

    if (!data.success) {
      throw new Error(data.error || "Unknown error");
    }

    return data;
  };

  const data = await withDeviceTokenRetry(apiCall);

  // Check if we need to move items
  const needsSomething = Array.isArray(data.needed) && 
    data.needed.some(n => n.missing > 0 && n.storage_assetids.length > 0);

  if (needsSomething && mainWindow && !mainWindow.isDestroyed()) {
    // Log what needs to be moved
    logger.info('Inventory needs detected:');
    data.needed.forEach(need => {
      if (need.missing > 0) {
        logger.info(`  - ${need.market_hash_name}: need ${need.missing}, have ${need.have_in_inv}, can move ${need.storage_assetids.length} from storage`);
      }
    });
    
    mainWindow.webContents.send("inventory-needs", data);
  }
}







/**
 * Perform item moves from storage to inventory
 * @param {Object} payload - Move payload
 */
// In main.js - Complete performMoves function
async function performMoves({ locked_assetids, needed }) {
  const start = Date.now();
  logger.info('Starting automatic inventory-balancing…');

  // ✅ FIX: Convert locked_assetids array to Set
  const lockedSet = new Set(locked_assetids || []);

  if (!needed || needed.length === 0) {
    logger.info('No items need to be moved');
    return { success: true, moved: 0, failed: 0, verified: true };
  }

  // Track what we need for verification
  const requirements = {};
  let totalItemsNeeded = 0;
  
  for (const need of needed) {
    requirements[need.market_hash_name] = {
      required: need.required,
      had_before: need.have_in_inv,
      flask_assetids: need.storage_assetids
    };
    totalItemsNeeded += need.storage_assetids.length;
  }

  // ===========================================================================
  // PHASE 1: Use Flask's suggested assetids (primary method)
  // ===========================================================================
  logger.info('===== PHASE 1: Moving items using Flask-provided assetids =====');
  
  // 1.1 Fetch current inventory to check space
  const webInvBefore = await getWebInventory();
  logger.info(`Current inventory: ${webInvBefore.length} items`);

  // 1.2 Fetch all caskets and build asset location map
  const caskets = await fetchAllCaskets();
  const assetToCasket = {};
  
  for (const casket of caskets) {
    try {
      const contents = await fetchCasketContentsWithRetry(casket.casketId);
      casket.itemCount = contents.length;
      
      for (const item of contents) {
        assetToCasket[item.id] = casket.casketId;
      }
    } catch (err) {
      logger.error(`Failed to fetch casket ${casket.casketId}:`, err);
      casket.itemCount = 0;
    }
  }
  
  logger.info(`Mapped ${Object.keys(assetToCasket).length} items across ${caskets.length} storage units`);

  // 1.3 Check if we need to park items to make room
  const freeSlots = SAFE_INVENTORY_SIZE - webInvBefore.length;
  if (totalItemsNeeded > freeSlots) {
    const overflow = totalItemsNeeded - freeSlots;
    logger.info(`Need to park ${overflow} items to make room`);
    
    // Build list of items we must NOT park
    const flaskAssetIds = [];
    for (const need of needed) {
      flaskAssetIds.push(...need.storage_assetids);
    }
    
    const doNotParkSet = new Set([
      ...lockedSet,  // ✅ Use lockedSet
      ...flaskAssetIds
    ]);

    // Select victims to park
    const victims = webInvBefore
      .filter(item => !doNotParkSet.has(item.assetid))
      .slice(0, overflow);
    
    if (victims.length < overflow) {
      logger.warn(`Only found ${victims.length} items to park (needed ${overflow})`);
    }

    // Park the victims
    let casketIndex = 0;
    for (const victim of victims) {
      let attempts = 0;
      let parked = false;
      
      while (attempts < caskets.length && !parked) {
        const casket = caskets[casketIndex % caskets.length];
        
        if (casket.itemCount < MAX_CASKET_SIZE) {
          try {
            csgo.addToCasket(casket.casketId, victim.assetid);
            await delay(DELAY_MS);
            
            assetToCasket[victim.assetid] = casket.casketId;
            casket.itemCount++;
            
            logger.info(`Parked ${victim.assetid} (${victim.market_hash_name || 'unknown'}) → ${casket.casketName}`);
            parked = true;
          } catch (err) {
            logger.error(`Failed to park ${victim.assetid}:`, err);
          }
        }
        
        casketIndex++;
        attempts++;
      }
      
      if (!parked) {
        logger.warn(`Could not find space to park ${victim.assetid}`);
      }
    }
  }

  // 1.4 Move items using Flask's assetids
  const moveResults = { 
    successful: [], 
    failed: [],
    notFound: []
  };
  
  for (const need of needed) {
    logger.info(`Moving ${need.storage_assetids.length} items for ${need.market_hash_name}`);
    
    for (const assetId of need.storage_assetids) {
      const casketId = assetToCasket[assetId];
      
      if (!casketId) {
        logger.warn(`Asset ${assetId} not found in any casket`);
        moveResults.notFound.push(assetId);
        continue;
      }
      
      try {
        csgo.removeFromCasket(casketId, assetId);
        await delay(DELAY_MS);
        
        moveResults.successful.push({
          assetId,
          market_hash_name: need.market_hash_name,
          from_casket: casketId
        });
        
        logger.info(`✅ Moved ${assetId} from storage`);
      } catch (err) {
        logger.error(`❌ Failed to move ${assetId}:`, err);
        moveResults.failed.push(assetId);
      }
    }
  }

  logger.info(`Phase 1 complete: ${moveResults.successful.length} moved, ${moveResults.failed.length} failed, ${moveResults.notFound.length} not found`);

  // ===========================================================================
  // PHASE 2: Verify we have the right amounts by market_hash_name
  // ===========================================================================
  
  let verificationResults = {
    success: true,
    verified: [],
    failed: [],
    error: null
  };
  
  try {
    logger.info('===== PHASE 2: Verifying inventory by market_hash_name =====');
    await delay(3000); // Give Steam time to update
    
    const webInvAfter = await getWebInventory();
    logger.info(`Inventory after moves: ${webInvAfter.length} items`);
    
    // Count items by market_hash_name (from Steam API - always correct)
    const inventoryCounts = {};
    
    for (const item of webInvAfter) {
      if (!lockedSet.has(item.assetid) && item.tradable) {  // ✅ Use lockedSet
        const name = item.market_hash_name;
        inventoryCounts[name] = (inventoryCounts[name] || 0) + 1;
      }
    }

    // Check what's still missing
    const stillMissing = [];
    
    for (const [market_hash_name, requirement] of Object.entries(requirements)) {
      const have = inventoryCounts[market_hash_name] || 0;
      const required = requirement.required;
      
      if (have >= required) {
        logger.info(`✅ VERIFIED: ${market_hash_name} - have ${have}/${required}`);
      } else {
        const deficit = required - have;
        logger.warn(`❌ MISSING: ${market_hash_name} - have ${have}/${required} (need ${deficit} more)`);
        
        stillMissing.push({
          market_hash_name,
          required,
          have,
          deficit
        });
      }
    }

    // ===========================================================================
    // PHASE 3: If still missing, search storage by market_hash_name (fallback)
    // ===========================================================================
    if (stillMissing.length > 0) {
      logger.info('===== PHASE 3: Searching storage by market_hash_name =====');
      logger.info(`Still missing items for ${stillMissing.length} item types, scanning all storage...`);
      
      // Build complete storage inventory by name
      const storageByName = {};
      const alreadyMoved = new Set(moveResults.successful.map(m => m.assetId));
      
      for (const casket of caskets) {
        try {
          const contents = await fetchCasketContentsWithRetry(casket.casketId);
          
          for (const rawItem of contents) {
            // Skip if already moved
            if (alreadyMoved.has(rawItem.id)) continue;
            
            // Enrich to get market_hash_name
            const enriched = await itemEnricher.enrichItem(rawItem);
            const name = enriched.market_hash_name;
            
            if (!storageByName[name]) {
              storageByName[name] = [];
            }
            
            storageByName[name].push({
              assetId: rawItem.id,
              casketId: casket.casketId,
              casketName: casket.casketName
            });
          }
        } catch (err) {
          logger.error(`Failed to scan casket ${casket.casketId}:`, err);
        }
      }
      
      // Log what we found
      for (const missing of stillMissing) {
        const available = storageByName[missing.market_hash_name] || [];
        logger.info(`Found ${available.length} "${missing.market_hash_name}" in storage (need ${missing.deficit})`);
      }
      
      // Move the missing items
      for (const missing of stillMissing) {
        const available = storageByName[missing.market_hash_name] || [];
        const toMove = available.slice(0, missing.deficit);
        
        if (toMove.length === 0) {
          logger.error(`❌ No items found in storage for ${missing.market_hash_name}`);
          continue;
        }
        
        logger.info(`Moving ${toMove.length} additional ${missing.market_hash_name} from storage`);
        
        for (const item of toMove) {
          try {
            csgo.removeFromCasket(item.casketId, item.assetId);
            await delay(DELAY_MS);
            
            moveResults.successful.push({
              assetId: item.assetId,
              market_hash_name: missing.market_hash_name,
              from_casket: item.casketId,
              phase: 3  // Mark as phase 3 move
            });
            
            logger.info(`✅ Moved ${item.assetId} from ${item.casketName} (Phase 3)`);
          } catch (err) {
            logger.error(`❌ Failed to move ${item.assetId} (Phase 3):`, err);
            moveResults.failed.push(item.assetId);
          }
        }
      }
    }

    // ===========================================================================
    // FINAL VERIFICATION
    // ===========================================================================
    logger.info('===== FINAL VERIFICATION =====');
    await delay(3000);
    
    const webInvFinal = await getWebInventory();
    const finalCounts = {};
    
    for (const item of webInvFinal) {
      if (!lockedSet.has(item.assetid) && item.tradable) {  // ✅ Use lockedSet
        const name = item.market_hash_name;
        finalCounts[name] = (finalCounts[name] || 0) + 1;
      }
    }

    // Final check
    verificationResults = {
      success: true,
      verified: [],
      failed: [],
      error: null
    };
    
    for (const [market_hash_name, requirement] of Object.entries(requirements)) {
      const have = finalCounts[market_hash_name] || 0;
      const required = requirement.required;
      
      if (have >= required) {
        logger.info(`✅ FINAL: ${market_hash_name} - ${have}/${required} ✓`);
        verificationResults.verified.push({
          market_hash_name,
          required,
          have
        });
      } else {
        logger.error(`❌ FINAL: ${market_hash_name} - ${have}/${required} FAILED`);
        verificationResults.failed.push({
          market_hash_name,
          required,
          have,
          deficit: required - have
        });
        verificationResults.success = false;
      }
    }
    
  } catch (verifyError) {
    // ✅ If verification process fails, don't throw - just log and continue
    logger.error('Verification process encountered an error', verifyError);
    verificationResults = {
      success: moveResults.successful.length > 0,  // Consider success if we moved items
      verified: [],
      failed: [],
      error: verifyError.message || 'Verification failed'
    };
    
    // If moves were successful, we still return success
    if (moveResults.successful.length > 0) {
      logger.info('⚠️ Verification failed but items were moved successfully');
    }
  }

  // ===========================================================================
  // SUMMARY
  // ===========================================================================
  const elapsed = Date.now() - start;
  const phase3Moves = moveResults.successful.filter(m => m.phase === 3).length;
  
  logger.info('===== OPERATION COMPLETE =====');
  logger.info(`Total time: ${elapsed}ms`);
  logger.info(`Total items moved: ${moveResults.successful.length}`);
  logger.info(`  - Phase 1 (Flask assetids): ${moveResults.successful.length - phase3Moves}`);
  logger.info(`  - Phase 3 (name search): ${phase3Moves}`);
  logger.info(`Failed moves: ${moveResults.failed.length}`);
  logger.info(`Not found: ${moveResults.notFound.length}`);
  
  // Determine overall success
  const overallSuccess = moveResults.successful.length > 0 && 
                         (verificationResults.success || verificationResults.error);
  
  logger.info(`Final result: ${overallSuccess ? '✅ SUCCESS' : '❌ FAILED'}`);
  
  // Only alert renderer if actual verification failed (not just process error)
  if (!verificationResults.success && !verificationResults.error && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('move-verification-failed', {
      failed: verificationResults.failed,
      summary: `Failed to get ${verificationResults.failed.length} item types`
    });
  }

  return {
    success: overallSuccess,
    moved: moveResults.successful.length,
    failed: moveResults.failed.length,
    notFound: moveResults.notFound.length,
    phase3Moves,
    totalTime: elapsed,
    verification: verificationResults,
    verificationError: verificationResults.error
  };
}

// Helper function with retry logic
async function fetchCasketContentsWithRetry(casketId, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timeout (attempt ${attempt}/${retries})`));
        }, 5000);
        
        csgo.getCasketContents(casketId, (err, items) => {
          clearTimeout(timeout);
          if (err) return reject(err);
          resolve(items);
        });
      });
    } catch (err) {
      if (attempt === retries) {
        logger.error(`Failed to fetch casket ${casketId} after ${retries} attempts`);
        return [];
      }
      await delay(1000);
    }
  }
}



// Update syncInventoryWithServer function
async function syncInventoryWithServer(steamId64) {
  const apiCall = async () => {
    const deviceToken = await getDeviceToken();
    if (!deviceToken) {
      throw new Error("Device token required");
    }

    // 1) live inventory
    const webInv = await getWebInventory();
    const payload = {
      device_token: deviceToken,
      inventory: webInv.map((i) => ({
        assetid: String(i.assetid),
        market_hash_name: i.market_hash_name || "",
        tradable: i.tradable ? 1 : 0,
      })),
    };

    // 2) storage units
    try {
      const caskets = await fetchAllCaskets();
      for (const ck of caskets) {
        try {
          const items = await fetchCasketContents(ck.casketId);
          payload[ck.casketId] = items.map((it) => String(it.id));
        } catch (e) {
          logger.warn(`Skipping casket ${ck.casketId}: ${e.message}`);
        }
      }
    } catch (_) {
      /* no caskets → fine */
    }

    // 3) POST to Flask
    const url = `${API_BASE_URL}/inventory-sync/${steamId64}`;
    logger.info(`POST → ${url}`);

    const res = await axios.post(url, payload, {
      withCredentials: true,
      timeout: 15_000,
    });

    logger.info("inventory-sync ok", res.data);
    return res.data;
  };

  return await withDeviceTokenRetry(apiCall);
}


module.exports = syncInventoryWithServer;











// Handle app quit
app.on('quit', () => {
  if (logStream) {
    logStream.end();
  }
});