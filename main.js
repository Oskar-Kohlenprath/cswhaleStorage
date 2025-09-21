// main.js
// main.js
require("dotenv").config();
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, Notification,  powerMonitor } = require("electron");
const path = require("path");
const fs = require('fs');
const os = require('os');






const SteamUser = require("steam-user");
const GlobalOffensive = require("globaloffensive");
const SteamCommunity = require("steamcommunity");
const axios = require("axios");
const keytar = require("keytar");
const jwt_decode = require("jwt-decode");
const TradeOfferManager = require('steam-tradeoffer-manager');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');

const ItemEnricher = require('./src/enrichment/itemEnricher');
const BackgroundTradeMonitor = require('./src/services/backgroundTradeMonitor');

const Mover = require('./src/mover');

let itemEnricher;


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
const API_BASE_URL = "https://cswhale-dev-env.fly.dev/api";

// Global variables
let mainWindow = null;  // Start as null, create only when needed
let user; // SteamUser instance
let csgo; // GlobalOffensive instance
let community; // SteamCommunity instance
let lastReceivedToken = null;
let logStream; // For file logging
let deviceTokenRequestInProgress = false;
let manager; // Add this to your global variables
let tray = null;
let backgroundMonitor = null;
let isQuitting = false;
let windowCreated = false;
let mover = null;




// After your constant definitions in main.js, add:
global.API_BASE_URL = API_BASE_URL;
global.SERVICE_NAME = SERVICE_NAME;
global.DEVICE_TOKEN_KEY = DEVICE_TOKEN_KEY;
global.keytar = keytar;


// IMPORTANT: Hide dock icon on macOS immediately
if (process.platform === 'darwin') {
  app.dock.hide();
}









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






// ============= AUTO-UPDATER CONFIGURATION =============
const { autoUpdater } = require("electron-updater");

// Configure auto-updater for fully automatic updates
autoUpdater.logger = logger;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.autoRunAppAfterInstall = true;

// Force check even in development (for testing)
if (!app.isPackaged) {
  autoUpdater.forceDevUpdateConfig = true;
}

// Check for updates immediately when app starts
function checkForUpdates() {
  logger.info('=== Checking for updates ===');
  autoUpdater.checkForUpdatesAndNotify().catch(err => {
    logger.error('Update check failed:', err);
  });
}

// Set up auto-updater events
autoUpdater.on('checking-for-update', () => {
  logger.info('Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
  logger.info(`Update available: version ${info.version}`);
  logger.info('Update will be downloaded automatically in background');
  
  // Inject notification into Flask UI
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(`
      (function() {
        // Remove any existing update banner
        const existingBanner = document.getElementById('cswhale-update-banner');
        if (existingBanner) existingBanner.remove();
        
        // Create update banner
        const banner = document.createElement('div');
        banner.id = 'cswhale-update-banner';
        banner.style.cssText = \`
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          background: linear-gradient(90deg, #3b82f6, #8b5cf6);
          color: white;
          padding: 12px;
          text-align: center;
          z-index: 999999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 14px;
          font-weight: 600;
          box-shadow: 0 -2px 10px rgba(0,0,0,0.3);
        \`;
        banner.textContent = 'New version ${info.version} is downloading...';
        document.body.appendChild(banner);
      })();
    `).catch(err => logger.error('Failed to show update banner:', err));
  }
});

autoUpdater.on('update-not-available', () => {
  logger.info('App is up to date');
});

autoUpdater.on('download-progress', (progressObj) => {
  const percent = Math.round(progressObj.percent);
  const downloaded = Math.round(progressObj.transferred / 1048576); // Convert to MB
  const total = Math.round(progressObj.total / 1048576); // Convert to MB
  
  logger.info(`Download progress: ${percent}% (${downloaded}MB / ${total}MB)`);
  
  // Update progress in Flask UI
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(`
      (function() {
        const banner = document.getElementById('cswhale-update-banner');
        if (banner) {
          banner.textContent = 'Downloading update: ${percent}% (${downloaded}MB / ${total}MB)';
        }
      })();
    `).catch(err => logger.error('Failed to update progress:', err));
  }
});

autoUpdater.on('update-downloaded', (info) => {
  logger.info(`Update downloaded: version ${info.version}`);
  logger.info('Update will be installed automatically in 5 seconds...');
  
  // Show countdown in Flask UI
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(`
      (function() {
        const banner = document.getElementById('cswhale-update-banner');
        if (banner) {
          banner.style.background = 'linear-gradient(90deg, #10b981, #059669)';
          let countdown = 5;
          const updateCountdown = () => {
            banner.textContent = \`Update ready! Restarting in \${countdown} seconds...\`;
            countdown--;
            if (countdown >= 0) {
              setTimeout(updateCountdown, 1000);
            }
          };
          updateCountdown();
        }
      })();
    `).catch(err => logger.error('Failed to show countdown:', err));
  }
  
  // System notification
  const { Notification } = require('electron');
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: 'CSWhale Update Ready',
      body: `Version ${info.version} will be installed in 5 seconds`,
      icon: path.join(__dirname, 'static/images/icons/icon.png')
    });
    notification.show();
  }
  
  // Force quit and install after 5 seconds
  setTimeout(() => {
    logger.info('Installing update now...');
    setImmediate(() => {
      app.removeAllListeners("before-quit");
      autoUpdater.quitAndInstall(false, true);
    });
  }, 5000);
});

autoUpdater.on('error', (err) => {
  logger.error('Auto-updater error:', err);
  logger.error('Error details:', err.stack || err.toString());
  
  // Remove update banner on error
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(`
      (function() {
        const banner = document.getElementById('cswhale-update-banner');
        if (banner) banner.remove();
      })();
    `).catch(() => {});
  }
});

// ============= END AUTO-UPDATER CONFIGURATION =============




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
  // ALWAYS ensure we have a device token before making any API calls
  let deviceToken = await getDeviceToken();
  
  if (!deviceToken) {
    logger.info('No device token found, obtaining one before API call...');
    
    // Try multiple sources for Steam ID
    let steamId = null;
    
    // 1. Current Steam session in Electron
    if (user && user.steamID) {
      steamId = user.steamID.getSteamID64();
      logger.info(`Using current Steam session: ${steamId}`);
    }
    
    // 2. Stored accounts with refresh tokens
    if (!steamId) {
      const accounts = await getAllAccounts();
      const accountWithToken = accounts.find(a => a.refreshToken && a.refreshToken.trim() !== '');
      if (accountWithToken) {
        steamId = accountWithToken.steamId;
        logger.info(`Using stored account: ${steamId}`);
      }
    }
    
    // 3. Get from Flask session (NEW)
    if (!steamId) {
      logger.info('No local Steam accounts, checking Flask session...');
      steamId = await getFlaskSessionSteamId();
      
      if (steamId) {
        logger.info(`Using Steam ID from Flask session: ${steamId}`);
        
        // Save this as a local account for future use
        await saveAccountData({
          steamId: steamId,
          displayName: steamId,
          refreshToken: "", // No token yet
          isRegistered: true
        });
      }
    }
    
    if (!steamId) {
      logger.error('No Steam account available from any source');
      
      // Show a more helpful error message
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(`
          alert('No Steam account found. Please make sure you are logged into CSWhale and have a Steam account linked.');
        `);
      }
      
      throw new Error('No Steam account available. Please ensure you are logged into CSWhale with a linked Steam account.');
    }
    
    // Get device token (will show 2FA modals if needed)
    try {
      deviceToken = await ensureDeviceToken(steamId);
      if (!deviceToken) {
        throw new Error('Failed to obtain device token');
      }
      logger.info('✅ Device token obtained successfully');
    } catch (tokenError) {
      logger.error('Failed to obtain device token:', tokenError);
      throw new Error(`Authentication failed: ${tokenError.message}`);
    }
  }
  
  // Now we definitely have a token, make the API call
  try {
    return await apiCall(...args);
  } catch (error) {
    // Handle token expiry/invalidation
    if (error.response && (error.response.status === 401 || error.response.status === 403)) {
      const errorData = error.response.data;
      
      if (errorData && (
        errorData.error === 'Invalid device token' || 
        errorData.error === 'Device token required' ||
        errorData.error === 'Device token revoked' ||
        errorData.error === 'Invalid request source'
      )) {
        logger.info('Device token rejected by server, clearing and getting new one...');
        
        // Clear the invalid token
        await keytar.deletePassword(SERVICE_NAME, DEVICE_TOKEN_KEY);
        
        // Get Steam ID (try all sources again)
        let steamId = null;
        
        if (user && user.steamID) {
          steamId = user.steamID.getSteamID64();
        } else {
          steamId = await getFlaskSessionSteamId();
        }
        
        if (!steamId) {
          const accounts = await getAllAccounts();
          if (accounts.length > 0) {
            steamId = accounts[0].steamId;
          }
        }
        
        if (!steamId) {
          throw new Error('No Steam account available for re-authentication');
        }
        
        // Get new token (will show 2FA modals)
        const newToken = await ensureDeviceToken(steamId);
        if (!newToken) {
          throw new Error('Failed to obtain new device token');
        }
        
        logger.info('New device token obtained, retrying API call...');
        
        // Retry the API call once
        return await apiCall(...args);
      }
    }
    
    // Not a token issue, re-throw
    throw error;
  }
}

const flaskSessionScript = `
<script>
// Add to the desktop detection section in base.html
(function() {
    // Expose current user info for desktop app
    if (window.IS_DESKTOP_APP) {
        // Get current user's Steam accounts from Flask
        window.getCurrentUserSteamAccounts = async function() {
            try {
                const response = await fetch('/api/current-user-steam-accounts', {
                    method: 'GET',
                    credentials: 'include',
                    headers: {
                        'X-CSRFToken': CSRF_TOKEN
                    }
                });
                
                if (response.ok) {
                    const data = await response.json();
                    return data.steam_accounts || [];
                }
            } catch (error) {
                console.error('Failed to get Steam accounts:', error);
            }
            return [];
        };
        
        // Store primary Steam account if available
        window.currentUserSteamId = null;
        
        // Auto-fetch on page load
        document.addEventListener('DOMContentLoaded', async function() {
            if (window.IS_DESKTOP_APP) {
                const accounts = await window.getCurrentUserSteamAccounts();
                if (accounts.length > 0) {
                    // Prefer primary account, otherwise first account
                    const primary = accounts.find(a => a.is_primary);
                    window.currentUserSteamId = primary ? primary.steam_id : accounts[0].steam_id;
                    console.log('Current user Steam ID:', window.currentUserSteamId);
                }
            }
        });
    }
})();
</script>
`;

async function getFlaskSessionSteamId() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }
  
  try {
    // Execute JavaScript in the Flask UI to get the current user's Steam ID
    const steamId = await mainWindow.webContents.executeJavaScript(`
      (async function() {
        // First try the cached value
        if (window.currentUserSteamId) {
          return window.currentUserSteamId;
        }
        
        // Otherwise fetch from Flask
        if (window.getCurrentUserSteamAccounts) {
          const accounts = await window.getCurrentUserSteamAccounts();
          if (accounts && accounts.length > 0) {
            const primary = accounts.find(a => a.is_primary);
            return primary ? primary.steam_id : accounts[0].steam_id;
          }
        }
        
        return null;
      })();
    `);
    
    if (steamId) {
      logger.info(`Got Steam ID from Flask session: ${steamId}`);
    }
    
    return steamId;
  } catch (error) {
    logger.error('Failed to get Steam ID from Flask:', error);
    return null;
  }
}









/**
 * Create the main application window (Flask wrapper mode)
 */
function createWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  logger.info('Creating main window...');
  
  let iconPath;
  if (process.platform === 'win32') {
    iconPath = app.isPackaged 
      ? path.join(process.resourcesPath, 'static/images/icons/icon.ico')
      : path.join(__dirname, 'static/images/icons/icon.ico');
  } else if (process.platform === 'darwin') {
    iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'static/images/icons/icon.icns')
      : path.join(__dirname, 'static/images/icons/icon.icns');
  } else {
    iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'static/images/icons/icon.png')
      : path.join(__dirname, 'static/images/icons/icon.png');
  }

  mainWindow = new BrowserWindow({
    width: 1400,  // Slightly wider for web app
    height: 900,   // Slightly taller for web app
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      nodeIntegration: false,
      // Allow the Flask app to access Steam API through preload
      partition: 'persist:cswhale'  // Persist session between app restarts
    },
    show: false,
    skipTaskbar: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f172a',
  });

  // Load Flask app with custom headers to identify Electron
  const flaskUrl = process.env.FLASK_URL || 'https://cswhale-dev-env.fly.dev';
  
  mainWindow.loadURL(flaskUrl, {
    userAgent: mainWindow.webContents.getUserAgent() + ' CSWhaleDesktop/1.0',
    extraHeaders: 'X-CSWhale-Desktop: true\n'
  });
  
  windowCreated = true;

  // Inject custom CSS/JS after page loads to enable desktop features
  mainWindow.webContents.on('did-finish-load', () => {
  logger.info('Flask app loaded in Electron wrapper');
  
  // Inject desktop app information AND Steam Guard modal
  mainWindow.webContents.executeJavaScript(`
    // Check if already injected
    if (window.__STEAM_GUARD_INJECTED__) {
      console.log('Steam Guard modal already injected, skipping');
    } else {
      window.__STEAM_GUARD_INJECTED__ = true;
      
      // Set global flags before any scripts run
      window.__CSWHALE_DESKTOP__ = true;
      window.__CSWHALE_VERSION__ = '${app.getVersion()}';
      window.__CSWHALE_PLATFORM__ = '${process.platform}';
      
      // Update the global variables if they exist
      if (typeof window.IS_DESKTOP_APP !== 'undefined') {
        window.IS_DESKTOP_APP = true;
        window.DESKTOP_VERSION = '${app.getVersion()}';
        window.DESKTOP_PLATFORM = '${process.platform}';
        
        // Add desktop class to body
        if (document.body) {
          document.body.classList.add('desktop-app');
          document.body.classList.remove('web-app');
        }
        
        console.log('✅ Desktop mode activated via Electron wrapper');
      }
      
      // Verify the API is available
      if (window.electronAPI && window.electronAPI.isElectron) {
        console.log('✅ Electron API is available');
      } else {
        console.error('❌ Electron API not found - check preload script');
      }
      
      // INJECT STEAM GUARD MODAL HTML
      const modalHTML = \`
        <div id="steam-guard-modal-injected" style="
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.75);
          backdrop-filter: blur(5px);
          display: none;
          justify-content: center;
          align-items: center;
          z-index: 10000;
        ">
          <div style="
            background: #1e293b;
            border: 1px solid rgba(255, 255, 255, 0.1);
            padding: 32px;
            border-radius: 12px;
            width: 450px;
            max-width: 90%;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
          ">
            <h2 style="
              font-size: 1.5rem;
              margin-bottom: 16px;
              color: #f1f5f9;
              font-weight: 700;
            ">Steam Guard Required</h2>
            <div style="margin-bottom: 24px;">
              <p id="steam-guard-prompt-injected" style="
                color: #94a3b8;
                margin-bottom: 16px;
              ">Enter your Steam Guard code:</p>
              <input type="text" id="steam-guard-input-injected" 
                placeholder="Steam Guard code"
                style="
                  width: 100%;
                  padding: 12px 16px;
                  font-size: 1rem;
                  border-radius: 8px;
                  background-color: #334155;
                  border: 1px solid #475569;
                  color: #f1f5f9;
                  outline: none;
                  box-sizing: border-box;
                "
                onkeypress="if(event.key === 'Enter') document.getElementById('steam-guard-submit-injected').click()">
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 12px;">
              <button id="steam-guard-cancel-injected" style="
                padding: 10px 24px;
                background: #334155;
                color: #f1f5f9;
                border: 1px solid #475569;
                border-radius: 8px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
              ">Cancel</button>
              <button id="steam-guard-submit-injected" style="
                padding: 10px 24px;
                background: #3b82f6;
                color: white;
                border: none;
                border-radius: 8px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
              ">Submit</button>
            </div>
          </div>
        </div>
      \`;
      
      // Only inject if modal doesn't exist
      if (!document.getElementById('steam-guard-modal-injected')) {
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        console.log('✅ Steam Guard modal HTML injected');
      }
      
      // Add event listeners - but check if not already added
      const submitBtn = document.getElementById('steam-guard-submit-injected');
      if (submitBtn && !submitBtn.__listenerAdded) {
        submitBtn.__listenerAdded = true;
        submitBtn.addEventListener('click', () => {
          const code = document.getElementById('steam-guard-input-injected').value.trim();
          if (code) {
            console.log('Sending Steam Guard code to Electron:', code.substring(0, 2) + '****');
            window.electronAPI.sendSteamGuardCode(code);
            
            // Hide modal and clear input
            document.getElementById('steam-guard-modal-injected').style.display = 'none';
            document.getElementById('steam-guard-input-injected').value = '';
          } else {
            alert('Please enter a Steam Guard code');
          }
        });
        console.log('✅ Submit button listener added');
      }
      
      const cancelBtn = document.getElementById('steam-guard-cancel-injected');
      if (cancelBtn && !cancelBtn.__listenerAdded) {
        cancelBtn.__listenerAdded = true;
        cancelBtn.addEventListener('click', () => {
          console.log('Steam Guard cancelled');
          document.getElementById('steam-guard-modal-injected').style.display = 'none';
          document.getElementById('steam-guard-input-injected').value = '';
        });
        console.log('✅ Cancel button listener added');
      }
      
      // Listen for Steam Guard required event - remove old listener first
      if (window.__steamGuardListener) {
        console.log('Clearing old Steam Guard listener');
        // Clear any existing listener
        window.__steamGuardHandler = null;
      }
      
      window.__steamGuardListener = true;
      
      // Store the handler function so we can reference it
      window.__steamGuardHandler = (domain) => {
        console.log('Steam Guard required for domain:', domain);
        const modal = document.getElementById('steam-guard-modal-injected');
        const prompt = document.getElementById('steam-guard-prompt-injected');
        const input = document.getElementById('steam-guard-input-injected');
        
        if (modal) {
          // Check if modal is already visible
          if (modal.style.display === 'flex') {
            console.log('Steam Guard modal already visible, not showing again');
            return;
          }
          
          // Update prompt text
          if (prompt) {
            prompt.textContent = domain 
              ? \`Enter Steam Guard code for \${domain}:\`
              : 'Enter your Steam Guard code:';
          }
          
          // Clear any previous input
          if (input) {
            input.value = '';
            input.disabled = false;
          }
          
          // Show modal
          modal.style.display = 'flex';
          
          // Focus the input after a short delay
          setTimeout(() => {
            if (input) {
              input.focus();
              input.select();
            }
          }, 100);
        } else {
          console.error('Steam Guard modal not found!');
        }
      };
      
      // Register the handler
      if (window.electronAPI && window.electronAPI.onSteamGuardRequired) {
        window.electronAPI.onSteamGuardRequired(window.__steamGuardHandler);
        console.log('✅ Steam Guard event listener registered');
      } else {
        console.error('❌ electronAPI.onSteamGuardRequired not available');
      }
      
      // Also handle 2FA modal if needed
      if (!document.getElementById('device-2fa-modal-injected')) {
        const device2FAModalHTML = \`
          <div id="device-2fa-modal-injected" style="
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.75);
            backdrop-filter: blur(5px);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 10000;
          ">
            <div style="
              background: #1e293b;
              border: 1px solid rgba(255, 255, 255, 0.1);
              padding: 32px;
              border-radius: 12px;
              width: 450px;
              max-width: 90%;
              box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
            ">
              <h2 style="
                font-size: 1.5rem;
                margin-bottom: 16px;
                color: #f1f5f9;
                font-weight: 700;
              ">Email Verification</h2>
              <div style="margin-bottom: 24px;">
                <p style="
                  color: #94a3b8;
                  margin-bottom: 16px;
                ">Please enter the verification code sent to your email:</p>
                <input type="text" id="device-2fa-input-injected" 
                  placeholder="Enter 6-digit code"
                  maxlength="6"
                  style="
                    width: 100%;
                    padding: 12px 16px;
                    font-size: 1rem;
                    border-radius: 8px;
                    background-color: #334155;
                    border: 1px solid #475569;
                    color: #f1f5f9;
                    outline: none;
                    box-sizing: border-box;
                  "
                  onkeypress="if(event.key === 'Enter') document.getElementById('device-2fa-submit-injected').click()">
              </div>
              <div style="display: flex; justify-content: flex-end;">
                <button id="device-2fa-submit-injected" style="
                  padding: 10px 24px;
                  background: #3b82f6;
                  color: white;
                  border: none;
                  border-radius: 8px;
                  font-weight: 600;
                  cursor: pointer;
                  transition: all 0.2s;
                ">Submit</button>
              </div>
            </div>
          </div>
        \`;
        
        document.body.insertAdjacentHTML('beforeend', device2FAModalHTML);
        
        // Add 2FA event listeners
        const device2FASubmit = document.getElementById('device-2fa-submit-injected');
        if (device2FASubmit) {
          device2FASubmit.addEventListener('click', () => {
            const code = document.getElementById('device-2fa-input-injected').value.trim();
            if (code) {
              console.log('Sending 2FA code to Electron');
              window.electronAPI.send2FACode(code);
              document.getElementById('device-2fa-modal-injected').style.display = 'none';
              document.getElementById('device-2fa-input-injected').value = '';
            }
          });
        }
      
        // Listen for 2FA required event
        if (window.electronAPI && window.electronAPI.onPleaseEnter2FA) {
          window.electronAPI.onPleaseEnter2FA(() => {
            console.log('2FA verification required');
            const modal = document.getElementById('device-2fa-modal-injected');
            if (modal) {
              modal.style.display = 'flex';
              setTimeout(() => {
                const input = document.getElementById('device-2fa-input-injected');
                if (input) {
                  input.value = '';
                  input.focus();
                }
              }, 100);
            }
          });
        }
        
        console.log('✅ 2FA modal injected');
      }
      
      console.log('✅ All injection complete');
    }
  `);
});

  // Handle navigation to stay within the app
  mainWindow.webContents.on('new-window', (event, url) => {
    event.preventDefault();
    // Open external links in system browser
    if (!url.startsWith(flaskUrl)) {
      require('electron').shell.openExternal(url);
    } else {
      mainWindow.loadURL(url);
    }
  });

  // Handle connection errors gracefully
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    logger.error(`Failed to load Flask app: ${errorDescription}`);
    
    // Load a local fallback page if Flask is unreachable
    if (errorCode === -106 || errorCode === -105) { // ERR_INTERNET_DISCONNECTED or ERR_NAME_NOT_RESOLVED
      mainWindow.loadFile(path.join(__dirname, 'offline.html'));
    }
  });

  // Window event handlers (keep existing)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      
      if (process.platform === 'win32') {
        mainWindow.setSkipTaskbar(true);
      }
      
      return false;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    windowCreated = false;
  });

  mainWindow.on('show', () => {
    if (process.platform === 'win32') {
      mainWindow.setSkipTaskbar(false);
    }
    if (process.platform === 'darwin') {
      app.dock.show();
    }
  });

  mainWindow.on('hide', () => {
    if (process.platform === 'win32') {
      mainWindow.setSkipTaskbar(true);
    }
    if (process.platform === 'darwin') {
      app.dock.hide();
    }
  });

  // Open DevTools only in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

// Mover IPC Handlers
ipcMain.handle('get-mover-inventory', async () => {
  try {
    if (!user || !csgo || !csgo.haveGCSession) {
      return { success: false, error: 'Not connected to Steam' };
    }
    
    const inventory = await getWebInventory();
    
    // Enrich items if enricher is available
    const enrichedItems = [];
    for (const item of inventory) {
      if (itemEnricher) {
        const enriched = await itemEnricher.enrichItem(item);
        enrichedItems.push({
          assetid: item.assetid,
          market_hash_name: enriched.market_hash_name || item.market_hash_name,
          icon_url: enriched.icon_url || item.icon_url,
          tradable: item.tradable,
          category: enriched.item_type || 'weapon',
          wear: enriched.item_wear_name
        });
      } else {
        enrichedItems.push(item);
      }
    }
    
    return {
      success: true,
      items: enrichedItems
    };
  } catch (error) {
    logger.error('Failed to get mover inventory:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-mover-storage', async () => {
  try {
    if (!user || !csgo || !csgo.haveGCSession) {
      return { success: false, error: 'Not connected to Steam' };
    }
    
    const caskets = await fetchAllCaskets();
    
    return {
      success: true,
      units: caskets.map(c => ({
        id: c.casketId,
        name: c.casketName,
        item_count: c.itemCount
      }))
    };
  } catch (error) {
    logger.error('Failed to get storage units:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-storage-contents', async (event, storageId) => {
  try {
    if (!user || !csgo || !csgo.haveGCSession) {
      return { success: false, error: 'Not connected to Steam' };
    }
    
    const contents = await fetchCasketContents(storageId);
    
    // Enrich items
    const enrichedItems = [];
    for (const item of contents) {
      if (itemEnricher) {
        const enriched = await itemEnricher.enrichItem(item);
        enrichedItems.push({
          assetid: item.id,
          market_hash_name: enriched.market_hash_name,
          icon_url: enriched.icon_url,
          category: enriched.item_type || 'weapon',
          wear: enriched.item_wear_name
        });
      } else {
        enrichedItems.push({
          assetid: item.id,
          market_hash_name: 'Unknown Item',
          icon_url: ''
        });
      }
    }
    
    return {
      success: true,
      items: enrichedItems
    };
  } catch (error) {
    logger.error('Failed to get storage contents:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('move-mover-items', async (event, moveData) => {
  try {
    if (!user || !csgo || !csgo.haveGCSession) {
      return { success: false, error: 'Not connected to Steam' };
    }
    
    const { action, items, target_storage, source_storage } = moveData;
    
    logger.info(`Moving ${items.length} items: ${action}`);
    
    if (action === 'to_storage') {
      // Move items from inventory to storage
      for (const assetId of items) {
        csgo.addToCasket(target_storage, assetId);
        await delay(DELAY_MS);
      }
    } else if (action === 'to_inventory') {
      // Move items from storage to inventory
      for (const assetId of items) {
        csgo.removeFromCasket(source_storage, assetId);
        await delay(DELAY_MS);
      }
    }
    
    logger.info(`Successfully moved ${items.length} items`);
    
    return { success: true };
    
  } catch (error) {
    logger.error('Failed to move items:', error);
    return { success: false, error: error.message };
  }
});


// In main.js - fetch-asset-ids handler
ipcMain.handle('fetch-asset-ids', async (event, orderId, batchIndex, itemsInBatch) => {
  const apiCall = async () => {
    const deviceToken = await getDeviceToken();
    
    const params = new URLSearchParams();
    if (batchIndex !== undefined) params.append('batch_index', batchIndex);
    if (itemsInBatch !== undefined) params.append('items_in_batch', itemsInBatch);
    
    const url = `${API_BASE_URL.replace('/api', '')}/getAssetIDS/${orderId}?${params}`;
    
    try {
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${deviceToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.data.success) {
        throw new Error(response.data.error || 'Failed to fetch asset IDs');
      }

      return response.data;
    } catch (error) {
      // Handle 409 status specifically - it contains useful error info
      if (error.response && error.response.status === 409) {
        logger.info(`Insufficient items: ${JSON.stringify(error.response.data)}`);
        return {
          success: false,
          error: error.response.data.error || 'Insufficient items in inventory',
          needsStorage: true,  // Flag to indicate storage move needed
          status: 409
        };
      }
      
      // Re-throw other errors
      throw error;
    }
  };

  try {
    return await withDeviceTokenRetry(apiCall);
  } catch (error) {
    logger.error('Failed to fetch asset IDs:', error);
    
    // If it's an axios error with response, extract the data
    if (error.response) {
      return {
        success: false,
        error: error.response.data?.error || error.message,
        status: error.response.status
      };
    }
    
    throw error;
  }
});


// Add this handler to check trade offer status
ipcMain.handle('check-trade-offer-status', async (event, offerId) => {
  try {
    if (!manager) {
      throw new Error('Trade manager not initialized');
    }

    return new Promise((resolve, reject) => {
      manager.getOffer(offerId, (err, offer) => {
        if (err) {
          logger.error(`Failed to get trade offer ${offerId}:`, err);
          reject(err);
        } else {
          logger.info(`Trade offer ${offerId} status: ${offer.state} (${TradeOfferManager.ETradeOfferState[offer.state]})`);
          resolve({
            success: true,
            offerId: offer.id,
            state: offer.state,
            stateName: TradeOfferManager.ETradeOfferState[offer.state],
            isOurOffer: offer.isOurOffer,
            confirmationMethod: offer.confirmationMethod
          });
        }
      });
    });
  } catch (error) {
    logger.error('Failed to check trade offer status:', error);
    return {
      success: false,
      error: error.message
    };
  }
});



ipcMain.handle('ensure-correct-steam-session', async (event, requiredSteamId) => {
  try {
    const currentSteamId = user && user.steamID ? user.steamID.getSteamID64() : null;
    
    // Already on correct account
    if (currentSteamId === requiredSteamId) {
      logger.info(`Already logged in as ${requiredSteamId}`);
      return { success: true };
    }
    
    // Need to switch or login
    logger.info(`Need to switch from ${currentSteamId} to ${requiredSteamId}`);
    
    const accounts = await getAllAccounts();
    const targetAccount = accounts.find(a => a.steamId === requiredSteamId);
    
    if (!targetAccount || !targetAccount.refreshToken || targetAccount.refreshToken.trim() === '') {
      logger.info(`No refresh token for ${requiredSteamId}, login required`);
      return { 
        success: false, 
        needsLogin: true,
        error: 'Login required for seller account'
      };
    }
    
    // Switch to the target account
    await terminateSteamSession();
    await initCSGO({ refreshToken: targetAccount.refreshToken });
    
    // Wait for connection
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 30000);
      
      const checkInterval = setInterval(() => {
        if (user && user.steamID && user.steamID.getSteamID64() === requiredSteamId && csgo && csgo.haveGCSession) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve();
        }
      }, 500);
    });
    
    logger.info(`Successfully switched to ${requiredSteamId}`);
    return { success: true };
    
  } catch (error) {
    logger.error('Failed to ensure correct Steam session:', error);
    return { success: false, error: error.message };
  }
});





ipcMain.handle('send-trade-offer', async (event, orderId, assetIds, tradeUrl, sellerSteamId) => {
  try {
    if (!sellerSteamId) {
      throw new Error('Seller Steam ID is required');
    }

    logger.info(`Preparing to send trade for order ${orderId}, seller Steam ID: ${sellerSteamId}`);

    
    const currentSteamId = user && user.steamID ? user.steamID.getSteamID64() : null;
    
    if (currentSteamId !== sellerSteamId) {
      logger.info(`Need to switch from ${currentSteamId} to seller account ${sellerSteamId}`);
      
     
      const accounts = await getAllAccounts();
      const sellerAccount = accounts.find(a => a.steamId === sellerSteamId);
      
      if (!sellerAccount || !sellerAccount.refreshToken || sellerAccount.refreshToken.trim() === '') {
       
        logger.info(`No refresh token for ${sellerSteamId}, login required`);
        
        return {
          success: false,
          needsLogin: true,
          sellerSteamId: sellerSteamId,
          error: 'Login required for seller Steam account'
        };
      }
      
      // We have a token, proceed with login
      logger.info(`Found refresh token for ${sellerSteamId}, logging in...`);
      await terminateSteamSession();
      await initCSGO({ refreshToken: sellerAccount.refreshToken });
      
      // Wait for trade manager to be ready
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          logger.error('Login timeout - trade manager not ready');
          reject(new Error('Login timeout'));
        }, 30000);
        
        const checkInterval = setInterval(() => {
          if (manager && user && user.steamID && user.steamID.getSteamID64() === sellerSteamId) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            logger.info('Trade manager ready, proceeding with trade offer');
            resolve();
          }
        }, 500);
      });
    }
    
    // Now we should be logged in as the correct account
    if (!manager) {
      throw new Error('Trade manager not initialized after login');
    }

    logger.info(`Creating trade offer for order ${orderId} with ${assetIds.length} items`);
    logger.info(`Trade URL: ${tradeUrl}`);

    // Parse the trade URL to extract partner and token
    let partnerSteamID;
    let token;
    
    try {
      const url = new URL(tradeUrl);
      const params = url.searchParams;
      
      const partner = params.get('partner');
      token = params.get('token');
      
      if (!partner || !token) {
        throw new Error('Invalid trade URL - missing partner or token');
      }
      
      // Convert partner ID to Steam ID 64
      const accountId = parseInt(partner);
      const steamId64 = '76561197960265728';
      const base = BigInt(steamId64);
      const partnerSteamId64 = (base + BigInt(accountId)).toString();
      
      logger.info(`Partner account ID: ${partner}, Steam ID 64: ${partnerSteamId64}, Token: ${token}`);
      
      // Create SteamID object for the partner
      const SteamID = require('steamid');
      partnerSteamID = new SteamID(partnerSteamId64);
      
    } catch (parseError) {
      logger.error('Failed to parse trade URL:', parseError);
      throw new Error('Invalid trade URL format');
    }

    // Create the trade offer with SteamID object and token
    const offer = manager.createOffer(partnerSteamID, token);

    // Add items to give
    for (const assetId of assetIds) {
      offer.addMyItem({
        assetid: assetId,
        appid: 730,
        contextid: 2,
        amount: 1
      });
    }

    // Set message
    offer.setMessage(`${orderId} - CSWhale Order`);

    // Send the offer
    return new Promise((resolve, reject) => {
      offer.send(async (err, status) => {
        if (err) {
          logger.error(`Failed to send trade offer for order ${orderId}:`, err);
          reject(err);
        } else {
          logger.info(`Trade offer sent successfully! Order: ${orderId}, Offer ID: ${offer.id}`);
          
          try {
            // After successfully sending, fetch all trade offers and send to Flask
            await sendTradeOffersToFlask(sellerSteamId, offer.id, orderId);
          } catch (flaskError) {
            // Don't fail the whole operation if Flask sync fails
            logger.error('Failed to sync trade offers with Flask:', flaskError);
          }
          
          resolve({
            success: true,
            offerId: offer.id,
            status: status,
            orderId: orderId
          });
        }
      });
    });
    
  } catch (error) {
    logger.error('Failed to send trade offer:', error);
    throw error;
  }
});


async function sendTradeOffersToFlask(steamId, newOfferId, orderId) {

  const hasAccess = await validateDeviceTokenForSteamAccount(steamId);
  
  if (!hasAccess) {
    logger.info(`Need new device token for Steam account ${steamId}`);
    await keytar.deletePassword(SERVICE_NAME, DEVICE_TOKEN_KEY);
    
    // Get new token (will trigger 2FA)
    const newToken = await ensureDeviceToken(steamId);
    if (!newToken) {
      throw new Error("Failed to get device token for this Steam account");
    }
  }



  try {
    logger.info(`Fetching all trade offers to send to Flask...`);
    
    // Fetch all trade offers using the manager
    const offers = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout fetching trade offers'));
      }, 15000);
      
      manager.getOffers(
        TradeOfferManager.EOfferFilter.All,
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
    
    // Format the trade offers like Steam API response
    const formattedSent = offers.sent.map(offer => formatTradeOfferForFlask(offer));
    const formattedReceived = offers.received.map(offer => formatTradeOfferForFlask(offer));
    
    // Build the response structure like Steam's GetTradeOffers API
    const tradeOffersResponse = {
      response: {
        trade_offers_sent: formattedSent,
        trade_offers_received: formattedReceived,
        descriptions: extractDescriptions([...formattedSent, ...formattedReceived])
      }
    };
    
    // Get device token
    const deviceToken = await getDeviceToken();
    if (!deviceToken) {
      throw new Error("Device token required for Flask sync");
    }



    
    // Send to Flask's process-trade-offers endpoint
    const url = `${API_BASE_URL}/steam/process-trade-offers`;
    
    const payload = {
      trade_offers_response: tradeOffersResponse,
      steam_id: steamId,
      // Optional: include order context
      context: {
        new_offer_id: newOfferId,
        order_id: orderId,
        source: 'desktop_after_send'
      }
    };
    





    console.log('=== SENDING TO FLASK ===');
    //console.log(JSON.stringify(payload, null, 2));
    
    // Save to file for inspection
    const fs = require('fs');
    const path = require('path');
    const debugDir = path.join(app.getPath('userData'), 'debug');
    
    // Create debug directory if it doesn't exist
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }
    
    // Save with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(debugDir, `flask_payload_${timestamp}.json`);
    fs.writeFileSync(filename, JSON.stringify(payload, null, 2));
    
    logger.info(`📝 Payload saved to: ${filename}`);
    logger.info(`📊 Payload size: ${JSON.stringify(payload).length} bytes`);
    logger.info(`📦 Contains ${formattedSent.length} sent and ${formattedReceived.length} received offers`);
    // ========== END OF ADDED SECTION ==========



    logger.info(`Sending trade offers to Flask: ${url}`);
    logger.info(`Payload includes ${formattedSent.length} sent and ${formattedReceived.length} received offers`);
    
    // FIXED: Proper headers for desktop app authentication
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${deviceToken}`,  // Flask checks for this
        'X-Device-Token': deviceToken,            // Backup header
        'Content-Type': 'application/json',
        'User-Agent': 'CSWhale-Desktop/1.0'       // Identify as desktop
      },
      timeout: 30000,
      withCredentials: true  // Include cookies if needed
    });
    
    if (response.data.status === 'success') {
      logger.info(`✅ Flask successfully processed trade offers`);
      logger.info(`Stats: ${JSON.stringify(response.data.stats)}`);
      
      // Schedule verification task was triggered
      if (response.data.message && response.data.message.includes('verification')) {
        logger.info('Trade offer verification task scheduled on server');
      }
    } else {
      logger.warn(`Flask processing returned non-success status: ${JSON.stringify(response.data)}`);
    }
    
    return response.data;
    
  } catch (error) {
    logger.error('Failed to send trade offers to Flask:', error);
    if (error.response) {
      logger.error(`Flask response: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      
      // Special handling for authentication errors
      if (error.response.status === 401 || error.response.status === 403) {
        logger.error('Authentication failed - device token may be invalid or expired');
        
        // Try to refresh device token if needed
        try {
          logger.info('Attempting to refresh device token...');
          const newToken = await ensureValidDeviceTokenEnhanced();
          if (newToken) {
            logger.info('Device token refreshed, retrying...');
            // Retry once with new token
            return await sendTradeOffersToFlask(steamId, newOfferId, orderId);
          }
        } catch (tokenError) {
          logger.error('Failed to refresh device token:', tokenError);
        }
      }
    }
    throw error;
  }
}




// Helper function to format trade offer for Flask (Steam API format)
function formatTradeOfferForFlask(offer) {
  return {
    tradeofferid: offer.id,
    accountid_other: offer.partner.accountid || extractAccountId(offer.partner.getSteamID64()),
    message: offer.message || '',
    expiration_time: Math.floor(offer.expires / 1000), // Convert to Unix timestamp
    trade_offer_state: offer.state,
    items_to_give: (offer.itemsToGive || []).map(item => ({
      appid: String(item.appid || 730),
      contextid: String(item.contextid || 2),
      assetid: String(item.assetid),
      classid: String(item.classid || ''),
      instanceid: String(item.instanceid || '0'),
      amount: String(item.amount || 1),
      missing: false,
      est_usd: '0'
    })),
    items_to_receive: (offer.itemsToReceive || []).map(item => ({
      appid: String(item.appid || 730),
      contextid: String(item.contextid || 2),
      assetid: String(item.assetid),
      classid: String(item.classid || ''),
      instanceid: String(item.instanceid || '0'),
      amount: String(item.amount || 1),
      missing: false,
      est_usd: '0'
    })),
    is_our_offer: offer.isOurOffer,
    time_created: Math.floor(offer.created / 1000),
    time_updated: Math.floor(offer.updated / 1000),
    from_real_time_trade: false,
    escrow_end_date: offer.escrow_end_date ? Math.floor(offer.escrow_end_date / 1000) : 0,
    confirmation_method: offer.confirmationMethod || 0,
    eresult: 1
  };
}

// Helper function to extract account ID from Steam ID 64
function extractAccountId(steamId64) {
  const base = BigInt('76561197960265728');
  const id64 = BigInt(steamId64);
  return Number(id64 - base);
}

// Helper function to extract item descriptions (for Flask's descriptions field)
function extractDescriptions(offers) {
  const descriptions = [];
  const seen = new Set();
  
  for (const offer of offers) {
    const allItems = [
      ...(offer.items_to_give || []),
      ...(offer.items_to_receive || [])
    ];
    
    for (const item of allItems) {
      const key = `${item.classid}_${item.instanceid}`;
      if (!seen.has(key) && item.classid) {
        seen.add(key);
        descriptions.push({
          appid: item.appid,
          classid: item.classid,
          instanceid: item.instanceid || '0',
          currency: false,
          background_color: '',
          icon_url: item.icon_url || '',
          icon_url_large: item.icon_url_large || '',
          descriptions: [],
          tradable: 1,
          name: item.name || '',
          name_color: '7D6D00',
          type: item.type || '',
          market_name: item.market_name || item.name || '',
          market_hash_name: item.market_hash_name || item.market_name || item.name || '',
          market_fee_app: 730,
          commodity: 0,
          market_tradable_restriction: 7,
          market_marketable_restriction: 0,
          marketable: 1
        });
      }
    }
  }
  
  return descriptions;
}

// Also add a periodic sync function that can be called independently
async function syncTradeOffersWithFlask(steamId) {
  try {
    if (!manager) {
      logger.warn('Trade manager not initialized, skipping sync');
      return;
    }
    
    logger.info(`Syncing trade offers for ${steamId} with Flask...`);
    await sendTradeOffersToFlask(steamId, null, null);
    logger.info('Trade offers sync completed');
  } catch (error) {
    logger.error('Trade offers sync failed:', error);
  }
}

// Export the sync function for use elsewhere
module.exports.syncTradeOffersWithFlask = syncTradeOffersWithFlask;

// Add new handler to get seller Steam ID for an order
ipcMain.handle('get-order-seller-steamid', async (event, orderId) => {
  const apiCall = async () => {
    const deviceToken = await getDeviceToken();
    const url = `${API_BASE_URL.replace('/api', '')}/api/order/${orderId}/seller`;
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${deviceToken}`
      },
      withCredentials: true
    });

    return {
      success: true,
      sellerSteamId: response.data.seller_steam_id
    };
  };

  try {
    return await withDeviceTokenRetry(apiCall);
  } catch (error) {
    logger.error('Failed to get seller Steam ID:', error);
    return {
      success: false,
      error: error.message
    };
  }
});

// Helper function to notify Flask about sent trade offer
async function notifyFlaskTradeOfferSent(orderId, tradeOfferId) {
  try {
    const deviceToken = await getDeviceToken();
    const url = `${API_BASE_URL}/trade_offer_sent`;
    
    await axios.post(url, {
      device_token: deviceToken,
      order_id: orderId,
      trade_offer_id: tradeOfferId,
      timestamp: new Date().toISOString()
    });
    
    logger.info(`Flask notified about trade offer ${tradeOfferId} for order ${orderId}`);
  } catch (error) {
    logger.error('Failed to notify Flask:', error);
  }
}

// Check if we're connected and ready to send trades
ipcMain.handle('check-trade-readiness', async () => {
  return {
    connected: !!(user && user.steamID),
    hasManager: !!manager,
    hasCommunity: !!community,
    steamId: user ? user.steamID.getSteamID64() : null
  };
});


ipcMain.handle('login-with-qr', async () => {
  try {
    logger.info('QR login requested from Flask UI');
    
    // Terminate any existing session
    await terminateSteamSession();
    
    return new Promise((resolve, reject) => {
      // Reset token tracking
      lastReceivedToken = null;
      
      // Use steam-session instead of steam-user for QR
      const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
      
      let qrResolved = false;
      
      // Handle successful authentication
      session.on('authenticated', async () => {
        const steamId = session.steamID;
        const refreshToken = session.refreshToken;
        const accountName = session.accountName;
        
        logger.info(`QR auth successful: ${accountName} (${steamId})`);
        logger.info(`Got refresh token: ${refreshToken ? 'Yes' : 'No'}`);
        
        // Now create regular steam-user session with the refresh token
        user = new SteamUser();
        csgo = new GlobalOffensive(user);
        community = new SteamCommunity();
        
        // Initialize trade manager
        manager = new TradeOfferManager({
          steam: user,
          community: community,
          language: 'en',
          pollInterval: 10000,
          cancelTime: 0,
          pendingCancelTime: 0
        });
        
        // Store the token
        lastReceivedToken = refreshToken;
        
        // Login with refresh token
        user.logOn({
          refreshToken: refreshToken
        });
        
        user.once('loggedOn', async () => {
          const steamId64 = user.steamID.getSteamID64();
          logger.info(`Main session established for ${steamId64}`);
          
          user.setPersona(SteamUser.EPersonaState.Online);
          user.gamesPlayed([730]);
          
          // Track if we need to handle 2FA
          let had2FA = false;
          

          let dt = await getDeviceToken();
          if (!dt) {
            try {
              logger.info('No device token, starting 2FA flow...');
              had2FA = true;
              
              // IMPORTANT: Hide the Steam credentials modal BEFORE showing 2FA
              if (mainWindow && !mainWindow.isDestroyed()) {
                await mainWindow.webContents.executeJavaScript(`
                  console.log('Entering 2FA flow after QR login, hiding credentials modal...');
                  
                  // Hide the Steam credentials modal immediately
                  const steamModal = document.getElementById('steam-credentials-modal');
                  if (steamModal) {
                    steamModal.style.display = 'none';
                    console.log('Steam credentials modal hidden before 2FA');
                  }
                  
                  // Update QR display to show 2FA pending
                  const qrDisplay = document.getElementById('qr-display');
                  if (qrDisplay) {
                    qrDisplay.innerHTML = '<div class="qr-status"><div class="status-spinner"></div><span>Completing 2FA verification...</span></div>';
                  }
                  
                  // Show a temporary success message
                  if (window.showFlashMessage) {
                    window.showFlashMessage('info', 'QR login successful! Please complete email verification...');
                  }
                `);
              }
              
              dt = await ensureDeviceToken(steamId64);
              logger.info('Device token obtained after 2FA');
            } catch (err) {
              logger.error('Error ensuring device token', err);
              
              // If 2FA fails, hide everything and show error
              if (mainWindow && !mainWindow.isDestroyed()) {
                await mainWindow.webContents.executeJavaScript(`
                  // Hide all modals
                  const steamModal = document.getElementById('steam-credentials-modal');
                  if (steamModal) {
                    steamModal.remove();
                  }
                  
                  // Hide 2FA modals
                  const twoFAModal = document.getElementById('device-2fa-modal-injected');
                  if (twoFAModal) {
                    twoFAModal.style.display = 'none';
                  }
                  
                  // Show error
                  if (window.showFlashMessage) {
                    window.showFlashMessage('error', 'Authentication failed during 2FA verification');
                  }
                `);
              }
              return;
            }
          }
          
          // Fetch and update accounts
          try {
            const accounts = await fetchAndUpdateAccountsFromFlaskEnhanced(dt);
            const loggedInAccount = accounts.find(a => a.steamId === steamId64);
            
            if (loggedInAccount && refreshToken) {
              await saveAccountData({
                steamId: steamId64,
                displayName: loggedInAccount.displayName || accountName,
                refreshToken: refreshToken,
                isRegistered: true,
                avatarUrl: loggedInAccount.avatarUrl
              });
              
              await removeTokenFromOtherAccounts(refreshToken, steamId64);
            }
          } catch (err) {
            logger.error('Error updating accounts after QR login', err);
          }
          
          // NOW send success to Flask UI (after everything is complete)
          if (mainWindow && !mainWindow.isDestroyed()) {
            logger.info('Sending QR login success notification to Flask');
            
            await mainWindow.webContents.executeJavaScript(`
              console.log('QR login fully complete, calling success handler');
              
              // First hide any 2FA modals
              const twoFAModal = document.getElementById('device-2fa-modal-injected');
              if (twoFAModal) {
                twoFAModal.style.display = 'none';
              }
              
              const emailModal = document.getElementById('email-modal-injected');
              if (emailModal) {
                emailModal.style.display = 'none';
              }
              
              // Now call the success handler
              if (window.handleQRLoginSuccess) {
                window.handleQRLoginSuccess({
                  steamId: '${steamId64}',
                  accountName: '${accountName}'
                });
              } else {
                // Fallback: manually hide the modal if handler doesn't exist
                console.log('No handleQRLoginSuccess found, manually hiding modal');
                const steamModal = document.getElementById('steam-credentials-modal');
                if (steamModal) {
                  steamModal.remove();
                }
                
                if (window.showFlashMessage) {
                  window.showFlashMessage('success', 'Successfully logged in as ${accountName}!');
                }
                
                // Trigger storage scan
                setTimeout(() => {
                  if (window.performStorageScan) {
                    window.performStorageScan('${steamId64}');
                  }
                }, 2000);
              }
            `).catch(err => logger.error('Failed to notify Flask of success:', err));
          }
        });
        
        // Set up web session
        user.on('webSession', (sessionID, cookies) => {
          logger.info('Web session obtained from QR login');
          community.setCookies(cookies);
          manager.setCookies(cookies, (err) => {
            if (err) {
              logger.error('Failed to set trade manager cookies', err);
            } else {
              logger.info('Trade manager ready');
              setupTradeOfferListeners();
            }
          });
        });
        
        // Handle errors
        user.on('error', (err) => {
          logger.error('Steam user error after QR login:', err);
        });
        
        if (!qrResolved) {
          qrResolved = true;
          resolve({
            success: true,
            message: 'Authentication successful'
          });
        }
      });
      
      // Handle timeout
      session.on('timeout', () => {
        logger.warn('QR login timeout');
        if (!qrResolved) {
          qrResolved = true;
          reject(new Error('QR code expired'));
        }
      });
      
      // Handle errors
      session.on('error', (err) => {
        logger.error('QR session error:', err);
        if (!qrResolved) {
          qrResolved = true;
          reject(err);
        }
      });
      
      // Start QR session and get challenge URL
      logger.info('Starting QR session...');
      session.startWithQR()
        .then(result => {
          const qrUrl = result.qrChallengeUrl;
          logger.info(`QR URL generated: ${qrUrl.substring(0, 50)}...`);
          
          // Send QR URL to Flask UI
          if (mainWindow && !mainWindow.isDestroyed()) {
            // Use a simpler approach - store in window object
            mainWindow.webContents.executeJavaScript(`
              console.log('Received QR URL from Electron');
              if (window.handleQRCode) {
                window.handleQRCode('${qrUrl}');
              } else {
                // Fallback: store for later
                window.pendingQRUrl = '${qrUrl}';
                console.log('Stored QR URL for later use');
              }
            `).catch(err => logger.error('Failed to send QR to Flask:', err));
          }
          
          // Don't resolve here - wait for authentication
        })
        .catch(err => {
          logger.error('Failed to start QR session:', err);
          if (!qrResolved) {
            qrResolved = true;
            reject(err);
          }
        });
      
      // Overall timeout
      setTimeout(() => {
        if (!qrResolved) {
          qrResolved = true;
          session.cancelLoginAttempt();
          reject(new Error('QR login timeout (3 minutes)'));
        }
      }, 180000);
    });
    
  } catch (error) {
    logger.error('QR login failed:', error);
    throw error;
  }
});




ipcMain.handle('check-account-token', async (event, steamId) => {
  try {
    const accounts = await getAllAccounts();
    const account = accounts.find(a => a.steamId === steamId);
    
    return {
      hasToken: account && account.refreshToken && account.refreshToken.trim() !== '',
      steamId: steamId,
      displayName: account ? account.displayName : null
    };
  } catch (error) {
    logger.error('Error checking account token:', error);
    return { hasToken: false, steamId: steamId };
  }
});

// Login with credentials from Flask UI
ipcMain.handle('login-with-credentials', async (event, credentials) => {
  try {
    logger.info(`Login attempt for account: ${credentials.username}`);
    
    // Terminate any existing session
    await terminateSteamSession();
    
    // Login with credentials
    await initCSGO({
      username: credentials.username,
      password: credentials.password,
      steamId: credentials.steamId // Pass along the steamId for tracking
    });
    
    return { success: true, steamId: credentials.steamId };
  } catch (error) {
    logger.error('Login failed:', error);
    return { success: false, error: error.message };
  }
});

// Get current Steam session info
ipcMain.handle('get-current-steam-session', async () => {
  if (user && user.steamID) {
    return {
      connected: true,
      steamId: user.steamID.getSteamID64(),
      hasGCSession: csgo && csgo.haveGCSession
    };
  }
  return { connected: false };
});


ipcMain.handle('scan-storage-for-account', async (event, steamId) => {
  try {
    logger.info(`Storage scan requested for account: ${steamId}`);
    
    // Check current session
    const currentSession = user && user.steamID ? user.steamID.getSteamID64() : null;
    
    // If different account or no session, need to login
    if (currentSession !== steamId) {
      logger.info(`Need to switch from ${currentSession} to ${steamId}`);
      
      // Check if we have a token for this account
      const accounts = await getAllAccounts();
      const account = accounts.find(a => a.steamId === steamId);
      
      if (account && account.refreshToken && account.refreshToken.trim() !== '') {
        // Login with refresh token
        logger.info(`Logging in with refresh token for ${steamId}`);
        await terminateSteamSession();
        await initCSGO({ refreshToken: account.refreshToken });
        
        // Wait for connection
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Connection timeout')), 30000);
          
          const checkConnection = setInterval(() => {
            if (csgo && csgo.haveGCSession) {
              clearInterval(checkConnection);
              clearTimeout(timeout);
              resolve();
            }
          }, 500);
        });
      } else {
        // No token, request credentials
        logger.info(`No refresh token for ${steamId}, requesting credentials`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('credentials-required', { steamId });
        }
        return { success: false, needsAuth: true };
      }
    }
    
    // Now we should have the right session, start scanning
    logger.info('Starting storage scan...');
    
    // Trigger the existing scan-all logic
    return new Promise((resolve) => {
      ipcMain.once('scan-all-complete', (_, data) => {
        resolve(data);
      });
      
      // Trigger scan
      ipcMain.emit('casket-deep-check-all', { sender: mainWindow?.webContents });
    });
    
  } catch (error) {
    logger.error('Storage scan failed:', error);
    return { success: false, error: error.message };
  }
});


function createTray() {
  const iconPath = app.isPackaged 
    ? path.join(process.resourcesPath, 'static/images/icons/icon.png')
    : path.join(__dirname, 'static/images/icons/icon.png');
  
  const trayIcon = nativeImage.createFromPath(iconPath);
  
  // Resize for Windows (16x16 for tray)
  if (process.platform === 'win32') {
    tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));
  } else {
    tray = new Tray(trayIcon);
  }
  
  updateTrayMenu();
  
  tray.setToolTip('CSWhale Trade Monitor - Running');
  
  // Click events to show window
  tray.on('double-click', () => {
    showMainWindow();
  });
  
  if (process.platform !== 'win32') {
    tray.on('click', () => {
      showMainWindow();
    });
  }
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
  }
  
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    
    // Make sure window is in taskbar when shown
    if (process.platform === 'win32') {
      mainWindow.setSkipTaskbar(false);
    }
  }
}

function updateTrayMenu() {
  if (!tray) return;
  
  const status = backgroundMonitor?.getStatus() || {};
  
  const menuTemplate = [
    {
      label: '🖥️ Open CSWhale',
      font: 'bold',
      click: () => {
        showMainWindow();
      }
    },
    { type: 'separator' },
    {
      label: `Monitor: ${status.isRunning ? '✅ Active' : '❌ Inactive'}`,
      enabled: false
    }
  ];
  
  if (status.isRunning && status.lastCheckTime) {
    menuTemplate.push({
      label: `Last Check: ${status.lastCheckTime.toLocaleTimeString()}`,
      enabled: false
    });
    
    if (status.accountsChecked > 0) {
      menuTemplate.push({
        label: `${status.accountsChecked} accounts | ${status.totalReceived} received, ${status.totalSent} sent`,
        enabled: false
      });
    }
  }
  
  menuTemplate.push(
    { type: 'separator' },
    {
      label: '🔄 Check All Accounts Now',
      click: async () => {
        
        
        const results = await backgroundMonitor.checkAllAccounts();
        updateTrayMenu();
        
        
      }
    },
    {
      label: `Next Check: in ${getTimeUntilNextCheck()} minutes`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: '⚙️ Settings',
      submenu: [
        {
          label: 'Run at Startup',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => {
            app.setLoginItemSettings({
              openAtLogin: item.checked,
              openAsHidden: true,
              args: ['--background']
            });
            logger.info(`Run at startup: ${item.checked ? 'enabled' : 'disabled'}`);
          }
        },
        {
          label: 'Check Interval',
          submenu: [
            {
              label: '15 minutes',
              type: 'radio',
              checked: (status.checkInterval === 15),
              click: () => updateCheckInterval(15)
            },
            {
              label: '30 minutes',
              type: 'radio',
              checked: (status.checkInterval === 30),
              click: () => updateCheckInterval(30)
            },
            {
              label: '1 hour',
              type: 'radio',
              checked: (status.checkInterval === 60),
              click: () => updateCheckInterval(60)
            }
          ]
        }
      ]
    },
    { type: 'separator' },
    {
      label: '❌ Quit (Stop Monitoring)',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  );
  
  const contextMenu = Menu.buildFromTemplate(menuTemplate);
  tray.setContextMenu(contextMenu);
}

function getTimeUntilNextCheck() {
  const status = backgroundMonitor?.getStatus();
  if (!status || !status.lastCheckTime) return 'unknown';
  
  const nextCheckTime = new Date(status.lastCheckTime.getTime() + (status.checkInterval * 60 * 1000));
  const now = new Date();
  const minutesUntilNext = Math.max(0, Math.round((nextCheckTime - now) / 60000));
  
  return minutesUntilNext;
}

function updateCheckInterval(minutes) {
  if (backgroundMonitor) {
    backgroundMonitor.CHECK_INTERVAL_MINUTES = minutes;
    backgroundMonitor.stop();
    backgroundMonitor.start();
    saveSettings({ checkInterval: minutes });
    updateTrayMenu();
  }
}


const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function getSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (error) {
    logger.error('Failed to load settings:', error);
  }
  return {
    checkInterval: 30,
    notificationsEnabled: true
  };
}

function saveSettings(updates) {
  try {
    const current = getSettings();
    const updated = { ...current, ...updates };
    fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2));
  } catch (error) {
    logger.error('Failed to save settings:', error);
  }
}




 

/**
 * Initialize application
 */
app.whenReady().then(async () => {




  logger.info("=== CSWhale Background Service Starting ===");


    // AUTO-START: Enable by default on first run (Windows only)
  if (process.platform === 'win32') {
    const settings = getSettings();
    
    // If we haven't set the default yet, enable auto-start
    if (settings.autoStartDefault === undefined) {
      app.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: true,
        args: ['--background']
      });
      
      saveSettings({ autoStartDefault: true });
      logger.info("Auto-start enabled by default");
    }
  }


  // CHECK FOR UPDATES FIRST
  setTimeout(() => {
    checkForUpdates();
  }, 2000); // Check 2 seconds after startup
  
  // Set up periodic update checks (every 30 minutes)
  setInterval(() => {
    checkForUpdates();
  }, 30 * 60 * 1000);
 





  createTray();
  logger.info("System tray created");
  

  community = new SteamCommunity();
  

  backgroundMonitor = new BackgroundTradeMonitor(logger, keytar, SERVICE_NAME);

try {
  await backgroundMonitor.start();
  logger.info("✅ Background trade monitor started successfully");
  updateTrayMenu();
  

  powerMonitor.on('resume', () => {
    logger.info('System resumed from standby/sleep');
    
    if (backgroundMonitor && backgroundMonitor.isRunning) {
      const status = backgroundMonitor.getStatus();
      const now = new Date();
      
      if (status.lastCheckTime) {
        const minutesSinceLastCheck = Math.floor((now - status.lastCheckTime) / 60000);
        const checkInterval = status.checkInterval || 30;
        
        logger.info(`Last check was ${minutesSinceLastCheck} minutes ago (interval: ${checkInterval} min)`);
        
        // If it's been longer than the interval, check immediately
        if (minutesSinceLastCheck >= checkInterval) {
          logger.info('Triggering immediate trade check after wake');
          backgroundMonitor.checkAllAccounts();
        } else {
          logger.info(`Only ${minutesSinceLastCheck} minutes passed, waiting for scheduled check`);
        }
      } else {
        // No last check time, do check now
        logger.info('No previous check found, checking now');
        backgroundMonitor.checkAllAccounts();
      }
    }
  });
  
  logger.info('Power monitor registered - will check trades on system wake');
  
} catch (err) {
  logger.error("❌ Failed to start background monitor:", err);
    
    new Notification({
      title: 'CSWhale Error',
      body: 'Failed to start trade monitoring.',
      icon: path.join(__dirname, 'static/images/icons/icon.png')
    }).show();
  }
  
  // Update tray menu every minute to show countdown
  setInterval(() => {
    updateTrayMenu();
  }, 60000);
  
  // Initialize item enricher in background (non-blocking)
  itemEnricher = new ItemEnricher(logger);
  itemEnricher.initialize().catch(err => {
    logger.error('Failed to initialize item enricher', err);
  });
  

  try {
    mover = new Mover(logger, itemEnricher);
    logger.info("✅ Mover module initialized");
  } catch (err) {
    logger.error('Failed to initialize mover:', err);
  }

  // ============= ADD THIS SECTION =============
  // Check if we should show the window
  const shouldShowWindow = process.argv.includes('--show') || 
                          process.argv.includes('--ui') ||
                          process.env.NODE_ENV === 'development';
  
  if (shouldShowWindow) {
    logger.info("Starting with UI visible");
    createWindow();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  } else {
    logger.info("Running in system tray. No window created.");
  }
  // ============= END OF ADDED SECTION =============
  
  logger.info("=== Background Service Ready ===");
});








// Ensure single instance
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    // If user tries to open app again, show the window
    if (commandLine.includes('--show') || !commandLine.includes('--background')) {
      showMainWindow();
    }
  });
}



app.on('before-quit', () => {
  logger.info('=== CSWhale Background Service Shutting Down ===');
  isQuitting = true;
  
  if (backgroundMonitor) {
    backgroundMonitor.stop();
    logger.info('Background monitor stopped');
  }
  
  if (tray) {
    tray.destroy();
  }
  
  if (logStream) {
    logStream.end();
  }
});

app.on('window-all-closed', (event) => {
  // On macOS and Windows, keep app running in background
  if (process.platform !== 'linux') {
    event.preventDefault();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});




const createWindowIfNeeded = () => {
  if (!mainWindow) {
    createWindow();
  }
};


const originalLoginHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function(channel, handler) {
  if (['login-credentials', 'fetch-storage', 'casket-deep-check'].includes(channel)) {
    return originalLoginHandler(channel, async (...args) => {
      createWindowIfNeeded();
      return handler(...args);
    });
  }
  return originalLoginHandler(channel, handler);
};


// Fetch all trade offers
ipcMain.handle('fetch-trade-offers', async () => {
  try {
    if (!manager) {
      throw new Error('Trade manager not initialized');
    }

    return new Promise((resolve, reject) => {
      manager.getOffers(
        TradeOfferManager.EOfferFilter.All,
        (err, sent, received) => {
          if (err) {
            logger.error('Error fetching trade offers', err);
            reject(err);
            return;
          }

          try {
            const offers = {
              sent: sent.map(offer => formatTradeOffer(offer)),
              received: received.map(offer => formatTradeOffer(offer))
            };

            logger.info(`Fetched ${sent.length} sent and ${received.length} received trade offers`);
            resolve(offers);
          } catch (formatError) {
            logger.error('Error formatting trade offers:', formatError);
            reject(formatError);
          }
        }
      );
    });
  } catch (error) {
    logger.error('Failed to fetch trade offers:', error);
    logger.error('Error stack:', error.stack);
    throw error;
  }
});




ipcMain.handle('scan-all-storage', async () => {
  return new Promise((resolve) => {
    // Reuse your existing casket-deep-check-all logic
    const event = { sender: mainWindow?.webContents };
    
    // Listen for the completion event
    ipcMain.once('scan-all-complete', (_, data) => {
      resolve(data);
    });
    
    // Trigger the existing scan logic
    ipcMain.emit('casket-deep-check-all', event);
  });
});

// Check if Steam is connected (this is new)
ipcMain.handle('get-storage-status', async () => {
  return {
    connected: !!(user && csgo && csgo.haveGCSession),
    steamId: user ? user.steamID.getSteamID64() : null,
    hasSession: !!csgo
  };
});



// Accept a trade offer
ipcMain.handle('accept-trade-offer', async (event, offerId) => {
  try {
    if (!manager) {
      throw new Error('Trade manager not initialized');
    }

    return new Promise((resolve, reject) => {
      manager.getOffer(offerId, (err, offer) => {
        if (err) {
          reject(err);
          return;
        }

        offer.accept((err, status) => {
          if (err) {
            logger.error(`Failed to accept trade offer ${offerId}`, err);
            reject(err);
          } else {
            logger.info(`Trade offer ${offerId} accepted with status: ${status}`);
            resolve({ success: true, status });
          }
        });
      });
    });
  } catch (error) {
    logger.error('Failed to accept trade offer', error);
    throw error;
  }
});

// Decline a trade offer
ipcMain.handle('decline-trade-offer', async (event, offerId) => {
  try {
    if (!manager) {
      throw new Error('Trade manager not initialized');
    }

    return new Promise((resolve, reject) => {
      manager.getOffer(offerId, (err, offer) => {
        if (err) {
          reject(err);
          return;
        }

        offer.decline((err) => {
          if (err) {
            logger.error(`Failed to decline trade offer ${offerId}`, err);
            reject(err);
          } else {
            logger.info(`Trade offer ${offerId} declined`);
            resolve({ success: true });
          }
        });
      });
    });
  } catch (error) {
    logger.error('Failed to decline trade offer', error);
    throw error;
  }
});



// Add this IPC handler for manual trade sync
ipcMain.handle('sync-all-trade-offers', async () => {
  try {
    if (!backgroundMonitor) {
      return { 
        success: false, 
        error: 'Background monitor not initialized' 
      };
    }
    
    logger.info('Manual trade sync requested from UI');
    
    // Show loading state
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(`
        if (window.updateSyncButton) {
          window.updateSyncButton('syncing');
        }
      `);
    }
    
    const results = await backgroundMonitor.checkAllAccounts();
    
    const successCount = results.filter(r => r.success).length;
    const totalOffers = results.reduce((sum, r) => 
      sum + (r.received_offers?.length || 0) + (r.sent_offers?.length || 0), 0
    );
    
    logger.info(`Manual sync complete: ${successCount}/${results.length} accounts, ${totalOffers} total offers`);
    
    return {
      success: true,
      accountsChecked: results.length,
      accountsSuccessful: successCount,
      totalOffers: totalOffers
    };
    
  } catch (error) {
    logger.error('Manual trade sync failed:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
});


// Listen for new trade offers
function setupTradeOfferListeners() {
  if (!manager) return;

  manager.on('newOffer', (offer) => {
    logger.info(`New trade offer received from ${offer.partner.getSteamID64()}`);
    
    // Notify renderer about new offer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('new-trade-offer', formatTradeOffer(offer));
    }
  });

  manager.on('sentOfferChanged', (offer, oldState) => {
    logger.info(`Sent offer ${offer.id} changed state from ${oldState} to ${offer.state}`);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('trade-offer-updated', {
        offer: formatTradeOffer(offer),
        oldState
      });
    }
  });

  manager.on('receivedOfferChanged', (offer, oldState) => {
    logger.info(`Received offer ${offer.id} changed state from ${oldState} to ${offer.state}`);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('trade-offer-updated', {
        offer: formatTradeOffer(offer),
        oldState
      });
    }
  });

  manager.on('pollFailure', (err) => {
    logger.error('Trade offer polling failed', err);
  });

  manager.on('pollSuccess', () => {
    logger.info('Trade offer poll successful');
  });
}






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















/**
 * Fetch and update accounts from Flask API
 * @param {string} deviceToken - The device token for authentication
 * @returns {Array} Updated accounts list
 */
// Updated fetchAndUpdateAccountsFromFlask with token retry
async function fetchAndUpdateAccountsFromFlaskEnhanced(deviceToken) {
  const apiCall = async () => {
    const token = deviceToken || await getDeviceToken();
    const serverUrl = `${API_BASE_URL}/desktop_steam_accounts`;
    const resp = await axios.post(serverUrl, { 
      device_token: token 
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    return resp;
  };
  
  try {
    const resp = await withDeviceTokenRetry(apiCall);
    const steamAccounts = resp.data.steam_accounts || [];
    logger.info(`Flask returned ${steamAccounts.length} steam accounts.`);

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
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('accounts-updated');
    }
    
    return updatedAccounts;
  } catch (error) {
    logger.error('Failed to fetch accounts from Flask:', error);
    // Return existing accounts on failure
    return await loadAccountsJSON();
  }
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
  try {
    // Check if we have an active Steam session
    if (!user || !user.steamID) {
      logger.info('No active Steam session for move-items-from-storage');
      
      // We need to get the Steam ID from the payload or context
      // The payload should contain information about which account's items we're moving
      // For now, get the first account with a token
      const accounts = await getAllAccounts();
      const accountWithToken = accounts.find(a => a.refreshToken && a.refreshToken.trim() !== '');
      
      if (!accountWithToken) {
        logger.error('No account with refresh token available for login');
        return { success: false, error: 'No Steam account available. Please login first.' };
      }
      
      logger.info(`Logging in as ${accountWithToken.steamId} to move items`);
      
      // Terminate any existing session and login
      await terminateSteamSession();
      await initCSGO({ refreshToken: accountWithToken.refreshToken });
      
      // Wait for connection
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Steam connection timeout'));
        }, 15000);
        
        const checkInterval = setInterval(() => {
          if (user && user.steamID && csgo && csgo.haveGCSession) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 500);
      });
      
      logger.info('Steam session established, proceeding with move');
    }
    
    // Now we should have a valid session
    const apiCall = async () => {
      await performMoves(payload);
      return { success: true };
    };

    return await withDeviceTokenRetry(apiCall);
  } catch (err) {
    logger.error("Move items operation failed", err);
    return { success: false, error: err.message || "Failed to move items. Please try again." };
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
    
    // REMOVED: sendStorageUnitsToServer call - not needed since register_storage_items handles it
    
  } catch (error) {
    logger.error("Error fetching storage units", error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("storage-error", "Failed to fetch storage units. Please try again.");
    }
  }
});

// Replace the existing casket-deep-check-all handler with this new fast version
ipcMain.on("casket-deep-check-all", async (event) => {
  try {
    logger.info("Starting fast parallel scan of all storage units...");
    
    if (!user || !csgo || !csgo.haveGCSession) {
      throw new Error("Not connected to Steam. Please log in first.");
    }
    
    // Get all caskets
    const caskets = await fetchAllCaskets();
    logger.info(`Found ${caskets.length} storage units to scan`);
    
    if (caskets.length === 0) {
      mainWindow.webContents.send("scan-all-complete", {
        success: true,
        results: [],
        totalTime: 0
      });
      return;
    }
    
    const startTime = Date.now();
    
    // Determine optimal concurrency based on number of storage units
    let concurrency = 4; // Default
    if (caskets.length <= 5) concurrency = caskets.length;
    else if (caskets.length <= 10) concurrency = 3;
    else if (caskets.length > 50) concurrency = 5;
    
    logger.info(`Using concurrency level: ${concurrency}`);
    
    // Fetch all casket contents in parallel
    const casketIds = caskets.map(c => c.casketId);
    const { results: casketContents, errors } = await fetchCasketContentsParallel(casketIds, concurrency);
    
    // Initialize enricher if needed
    if (!itemEnricher) {
      const ItemEnricher = require('./src/enrichment/itemEnricher');
      itemEnricher = new ItemEnricher(logger);
      await itemEnricher.initialize();
    }
    
    // Process each storage unit and send to server
    const steamAccountId = user.steamID.getSteamID64();
    const allResults = [];
    let totalItemsProcessed = 0;
    
    for (const casket of caskets) {
      const items = casketContents[casket.casketId] || [];
      
      if (items.length === 0) {
        allResults.push({
          casketId: casket.casketId,
          casketName: casket.casketName,
          success: !errors[casket.casketId],
          itemsFound: 0,
          items: [],
          error: errors[casket.casketId]
        });
        continue;
      }
      
      // Enrich items
      const enrichedItems = [];
      for (const item of items) {
        try {
          const enriched = await itemEnricher.enrichItem(item);
          enrichedItems.push(enriched);
        } catch (err) {
          logger.error(`Failed to enrich item ${item.id}`, err);
          enrichedItems.push({
            assetid: item.id,
            market_hash_name: "Unknown Item",
            icon_url: "",
            tradable: true,
            appid: 730
          });
        }
      }
      
      // Send to server (non-blocking)
      try {
        await sendNewItemsToServerThrottled(casket.casketId, enrichedItems, steamAccountId);
        
        // Only mark as complete after successful server sync
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('mark-unit-complete', {
            casketId: casket.casketId
          });
        }
      } catch (err) {
        logger.error(`Failed to send items for ${casket.casketId} to server`, err);
        // Mark as failed if server sync fails
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('mark-unit-failed', {
            casketId: casket.casketId
          });
        }
      }
      
      totalItemsProcessed += enrichedItems.length;
      
      allResults.push({
        casketId: casket.casketId,
        casketName: casket.casketName,
        success: true,
        itemsFound: enrichedItems.length,
        items: enrichedItems,
        error: null
      });
      
      // Update progress
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scan-all-storage-progress', {
          current: allResults.length,
          total: caskets.length,
          casketName: casket.casketName,
          itemsProcessed: totalItemsProcessed
        });
      }
    }
    
    const totalTime = Date.now() - startTime;
    
    logger.info(`=== FAST SCAN COMPLETE ===`);
    logger.info(`Total time: ${totalTime}ms (${Math.round(totalTime/1000)}s)`);
    logger.info(`Storage units scanned: ${caskets.length}`);
    logger.info(`Total items processed: ${totalItemsProcessed}`);
    logger.info(`Average time per unit: ${Math.round(totalTime/caskets.length)}ms`);
    logger.info(`Errors: ${Object.keys(errors).length}`);
    
    // Send completion
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("scan-all-complete", {
        success: true,
        results: allResults,
        totalTime,
        errors
      });
    }
    
  } catch (error) {
    logger.error("Error in fast parallel scan", error);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("scan-all-complete", {
        success: false,
        error: error.message || "Unknown error during scan",
        results: []
      });
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
 * Fetch multiple storage unit contents in parallel with controlled concurrency
 * @param {Array} casketIds - Array of storage unit IDs to fetch
 * @param {number} concurrency - Max parallel requests (default 4)
 * @returns {Promise<Object>} Map of casketId -> items array
 */
async function fetchCasketContentsParallel(casketIds, concurrency = 4) {
  const results = {};
  const errors = {};
  let completed = 0;
  
  // Create a queue of work
  const queue = [...casketIds];
  const inProgress = new Set();
  
  logger.info(`Starting parallel fetch of ${casketIds.length} storage units with concurrency ${concurrency}`);
  
  // Worker function
  async function processNext() {
    if (queue.length === 0) return;
    
    const casketId = queue.shift();
    inProgress.add(casketId);
    
    try {
      const startTime = Date.now();
      const items = await fetchCasketContents(casketId, 2); // 2 retries max
      const elapsed = Date.now() - startTime;
      
      results[casketId] = items;
      completed++;
      
      logger.info(`Fetched storage ${casketId}: ${items.length} items in ${elapsed}ms (${completed}/${casketIds.length})`);
      
      // Send progress update to renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scan-all-parallel-progress', {
          completed,
          total: casketIds.length,
          casketId,
          itemCount: items.length
        });
      }
      
    } catch (error) {
      logger.error(`Failed to fetch storage ${casketId}:`, error);
      errors[casketId] = error.message;
      results[casketId] = []; // Empty array for failed fetches
      completed++;
    } finally {
      inProgress.delete(casketId);
    }
    
    // Process next item if queue has more
    if (queue.length > 0) {
      await processNext();
    }
  }
  
  // Start concurrent workers
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, casketIds.length); i++) {
    workers.push(processNext());
  }
  
  // Wait for all workers to complete
  await Promise.all(workers);
  
  logger.info(`Parallel fetch complete: ${Object.keys(results).length} successful, ${Object.keys(errors).length} failed`);
  
  return { results, errors };
}








const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 550; // 550ms = ~1.8 requests/second (under your 2/sec limit)

async function sendNewItemsToServerThrottled(casketId, items, steamAccountId) {
  // Ensure minimum time between requests
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await sleep(MIN_REQUEST_INTERVAL - timeSinceLastRequest);
  }
  lastRequestTime = Date.now();
  
  // Now make the actual request
  return sendNewItemsToServer(casketId, items, steamAccountId);
}

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
 * Format trade offer data for renderer
 * @param {Object} offer - Raw trade offer from manager
 * @returns {Object} Formatted trade offer
 */
function formatTradeOffer(offer) {
  return {
    id: offer.id,
    partner: offer.partner.getSteamID64(),
    message: offer.message,
    state: offer.state,
    stateName: TradeOfferManager.ETradeOfferState[offer.state],
    itemsToGive: (offer.itemsToGive || []).map(item => ({
      assetid: item.assetid,
      appid: item.appid,
      contextid: item.contextid,
      amount: item.amount || 1,
      name: item.name,
      market_name: item.market_name,
      market_hash_name: item.market_hash_name,
      icon_url: item.icon_url,
      type: item.type
    })),
    itemsToReceive: (offer.itemsToReceive || []).map(item => ({
      assetid: item.assetid,
      appid: item.appid,
      contextid: item.contextid,
      amount: item.amount || 1,
      name: item.name,
      market_name: item.market_name,
      market_hash_name: item.market_hash_name,
      icon_url: item.icon_url,
      type: item.type
    })),
    isOurOffer: offer.isOurOffer,
    createdAt: offer.created,
    updatedAt: offer.updated,
    expiresAt: offer.expires,
    tradeID: offer.tradeID,
    confirmationMethod: offer.confirmationMethod,
    escrowEnds: offer.escrow_end_date
  };
}


// Add this as a separate handler outside of initCSGO function
ipcMain.on("steamGuard-code", (_event, code) => {
  logger.info(`Received SteamGuard code from renderer`);
  
  if (steamGuardCallback && steamGuardPending) {
    steamGuardPending = false;
    const callback = steamGuardCallback;
    steamGuardCallback = null;
    callback(code);
  } else {
    logger.warn('Received Steam Guard code but no callback pending');
  }
});

// Add these with your other global variables at the top of main.js
let steamGuardCallback = null;
let steamGuardPending = false;


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
    
    // Clear any pending Steam Guard state
    steamGuardCallback = null;
    steamGuardPending = false;

    // Create new user and csgo instances
    user = new SteamUser();
    csgo = new GlobalOffensive(user);

    // Initialize trade manager
    manager = new TradeOfferManager({
      steam: user,
      community: community,
      language: 'en',
      pollInterval: 10000, // Check for trade updates every 10 seconds
      cancelTime: 0,  // Cancel outgoing offers after 5 minutes
      pendingCancelTime: 0 // Cancel offers pending confirmation after 30 seconds
    });

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

          try {
            await checkInventoryNeeds(steamId);
          } catch (err) {
            logger.error(`Inventory-needs check failed`, err);
          }

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('account-details', {
              steamId,
              displayName: loggedInAccount.displayName,
              avatarUrl: loggedInAccount.avatarUrl || 'static/images/default-avatar.png'
            });
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

        // Set up trade offer listeners after successful login
        setTimeout(() => {
          setupTradeOfferListeners();
        }, 2000);

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

      setTimeout(() => {
        setupTradeOfferListeners();
      }, 2000);


      global.user = user;
      global.csgo = csgo;
      global.community = community;
      logger.info("Globals set for mover access");

    });

    // Web session handling - CRITICAL: Set cookies for both community and trade manager
    user.on("webSession", (sessionID, cookies) => {
      logger.info(`Obtained web session: ${sessionID}`);
      
      // Set cookies for community
      community.setCookies(cookies);


      global.user = user;
      global.csgo = csgo;
      global.community = community;
      
      // Set cookies for trade manager
      manager.setCookies(cookies, (err) => {
        if (err) {
          logger.error('Failed to set trade manager cookies', err);
        } else {
          logger.info('Trade manager cookies set successfully')
          
          // Get API key for trade confirmations (optional but recommended)
          manager.setCookies(cookies, (err) => {
            if (err) {
              logger.error('Failed to set trade manager cookies', err);
            } else {
              logger.info('Trade manager cookies set successfully');
              // No need for getAPIKey - the manager handles it internally
            }
          });
        }
      });
    });

    // Steam Guard handling - FIXED VERSION
    user.on("steamGuard", (domain, callback) => {
      logger.info(`SteamGuard code required for domain: ${domain}`);
      
      // Prevent multiple Steam Guard prompts
      if (steamGuardPending) {
        logger.warn('Steam Guard already pending, ignoring duplicate request');
        return;
      }
      
      steamGuardPending = true;
      steamGuardCallback = callback;
      
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("steamGuard-required", domain);
      } else {
        steamGuardPending = false;
        steamGuardCallback = null;
        reject(new Error("Main window not available for SteamGuard prompt."));
      }
    });

    // Error handling
    user.on("error", (err) => {
      logger.error(`Steam user error`, err);
      // Clear Steam Guard state on error
      steamGuardPending = false;
      steamGuardCallback = null;
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

    // Trade offer manager events
    manager.on('sessionExpired', (err) => {
      logger.error('Trade manager session expired', err);
      // The web session event will fire again and reset cookies
    });

    manager.on('debug', (message) => {
      logger.info(`Trade manager debug: ${message}`);
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
 * Set up trade offer event listeners
 */
function setupTradeOfferListeners() {
  if (!manager) {
    logger.warn('Trade manager not initialized, skipping listener setup');
    return;
  }

  logger.info('Setting up trade offer listeners...');

  // New offer received
  manager.on('newOffer', (offer) => {
    logger.info(`New trade offer received from ${offer.partner.getSteamID64()}`);
    
    // Get more details about the offer
    offer.getUserDetails((err, me, them) => {
      if (!err) {
        logger.info(`Trade offer from ${them.personaName}`);
      }
    });
    
    // Notify renderer about new offer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('new-trade-offer', formatTradeOffer(offer));
    }
  });

  // Sent offer state changed
  manager.on('sentOfferChanged', (offer, oldState) => {
    logger.info(`Sent offer ${offer.id} changed state from ${TradeOfferManager.ETradeOfferState[oldState]} to ${TradeOfferManager.ETradeOfferState[offer.state]}`);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('trade-offer-updated', {
        offer: formatTradeOffer(offer),
        oldState,
        type: 'sent'
      });
    }
  });

  // Received offer state changed
  manager.on('receivedOfferChanged', (offer, oldState) => {
    logger.info(`Received offer ${offer.id} changed state from ${TradeOfferManager.ETradeOfferState[oldState]} to ${TradeOfferManager.ETradeOfferState[offer.state]}`);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('trade-offer-updated', {
        offer: formatTradeOffer(offer),
        oldState,
        type: 'received'
      });
    }
  });

  // Offer needs confirmation (mobile authenticator)
  manager.on('sentOfferNeedsConfirmation', (offer) => {
    logger.info(`Offer ${offer.id} needs mobile confirmation`);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('offer-needs-confirmation', {
        offerId: offer.id,
        partner: offer.partner.getSteamID64()
      });
    }
  });

  // Real-time trade notifications
  manager.on('sentPendingOfferCanceled', (offer) => {
    logger.info(`Pending offer ${offer.id} was canceled`);
  });

  // Poll events
  manager.on('pollStarted', () => {
    logger.info('Trade offer poll started');
  });

  manager.on('pollFailure', (err) => {
    logger.error('Trade offer polling failed', err);
    
    // Attempt to recover
    if (err.message && err.message.includes('Not Logged In')) {
      logger.warn('Session expired, web session should refresh automatically');
    }
  });

  manager.on('pollSuccess', () => {
    logger.info('Trade offer poll successful');
  });

  manager.on('pollData', (pollData) => {
    logger.info(`Poll data received: ${JSON.stringify(pollData)}`);
  });

  logger.info('Trade offer listeners setup complete');
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
        }, 10000);  // 5 second timeout
        
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
/**
 * Terminate Steam session
 */
async function terminateSteamSession() {

  steamGuardCallback = null;
  steamGuardPending = false;

  if (!user) {
    user = new SteamUser();
    csgo = new GlobalOffensive(user);
    return;
  }
  
  logger.info('Terminating existing Steam session...');
  
  try {
    // Remove all event listeners
    if (user) {
      user.removeAllListeners();
      
      if (user.steamID) {
        user.gamesPlayed([]);
        user.logOff();
      }
    }
    
    if (csgo) {
      csgo.removeAllListeners();
    }
    
    if (manager) {
      manager.removeAllListeners();
      manager.shutdown();
      manager = null;
    }
    
    // Wait for logoff
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Create new instances with normal configuration
    user = new SteamUser({
      autoRelogin: false,
      promptSteamGuardCode: false
      // Don't set dataDirectory to null
    });
    csgo = new GlobalOffensive(user);
    csgo.setMaxListeners(20);
    
    lastReceivedToken = null;
    
    logger.info('Session terminated successfully');
  } catch (err) {
    logger.error(`Error in session termination`, err);
    
    // Force new instances
    user = new SteamUser();
    csgo = new GlobalOffensive(user);


    csgo.setMaxListeners(20);
  }


    // ADD THIS AT THE VERY END (right here, before the closing brace):
  global.user = null;
  global.csgo = null;
  global.community = null;


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


async function validateDeviceTokenForSteamAccount(steamId) {
  const deviceToken = await getDeviceToken();
  if (!deviceToken) return false;
  
  try {
    // Ask Flask which Steam accounts this token can access
    const response = await axios.post(`${API_BASE_URL}/desktop_steam_accounts`, {
      device_token: deviceToken
    }, {
      headers: { 'Authorization': `Bearer ${deviceToken}` }
    });
    
    const steamAccounts = response.data.steam_accounts || [];
    const canAccess = steamAccounts.some(acc => acc.steam_id === steamId);
    
    if (!canAccess) {
      logger.info(`Current device token doesn't have access to Steam account ${steamId}`);
      logger.info(`Token has access to: ${steamAccounts.map(a => a.steam_id).join(', ')}`);
    }
    
    return canAccess;
  } catch (error) {
    return false;
  }
}


/**
 * Ensure device token exists
 * @param {string} steamId - Steam ID
 * @returns {Promise<string>} Device token
 */
async function ensureDeviceToken(steamId) {
  logger.info(`Ensuring device token for Steam ID: ${steamId}`);
  
  // Check if we already have a valid token
  const existingToken = await keytar.getPassword(SERVICE_NAME, DEVICE_TOKEN_KEY);
  
  if (existingToken) {
    // Validate the token
    try {
      const testUrl = `${API_BASE_URL}/desktop_steam_accounts`;
      const response = await axios.post(testUrl, { device_token: existingToken }, { 
        timeout: 5000,
        headers: {
          'Authorization': `Bearer ${existingToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      logger.info("Existing device token is valid");
      return existingToken;
    } catch (error) {
      logger.warn("Existing token is invalid, will get new one");
      await keytar.deletePassword(SERVICE_NAME, DEVICE_TOKEN_KEY);
    }
  }

  logger.info("No valid device token found. Initiating 2FA flow...");
  
  // Ensure main window exists and is ready
  if (!mainWindow || mainWindow.isDestroyed()) {
    logger.error("Main window not available for 2FA flow");
    throw new Error("Main window required for 2FA authentication");
  }

  // Make sure the window is visible for user interaction
  if (!mainWindow.isVisible()) {
    mainWindow.show();
    mainWindow.focus();
  }

  if (deviceTokenRequestInProgress) {
    logger.warn("Device token request already in progress");
    return null;
  }

  deviceTokenRequestInProgress = true;

  try {
    // Make initial device_token_request
    logger.info("Requesting device token from Flask...");
    let response = await axios.post(
      `${API_BASE_URL}/device_token_request`,
      { steam_id: steamId }
    );

    // Check if email is required
    if (response.data.status === 'email_required') {
      logger.info("Email required - triggering email modal in Flask UI");
      
      // Trigger email modal in Flask UI
      mainWindow.webContents.send("please-enter-email");
      
      // Wait for email from user
      const userEmail = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          ipcMain.removeAllListeners("email-submitted");
          ipcMain.removeAllListeners("email-cancelled");
          reject(new Error("Email prompt timeout"));
        }, 300000); // 5 minute timeout
        
        ipcMain.once("email-submitted", (event, email) => {
          clearTimeout(timeout);
          logger.info("Email received from user");
          resolve(email);
        });
        
        ipcMain.once("email-cancelled", () => {
          clearTimeout(timeout);
          logger.info("Email prompt cancelled by user");
          resolve(null);
        });
      });
      
      if (!userEmail) {
        throw new Error("Email is required for 2FA verification");
      }
      
      // Retry with email
      logger.info("Sending device token request with email...");
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
      
      // Trigger 2FA modal in Flask UI
      mainWindow.webContents.send("please-enter-2fa");
      
      // Wait for 2FA code from user
      const twoFaCode = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          ipcMain.removeAllListeners("2fa-code-submitted");
          reject(new Error("2FA prompt timeout"));
        }, 300000); // 5 minute timeout
        
        ipcMain.once("2fa-code-submitted", (event, code) => {
          clearTimeout(timeout);
          logger.info("2FA code received from user");
          resolve(code);
        });
      });
      
      if (!twoFaCode) {
        throw new Error("2FA code is required");
      }
      
      
      logger.info("Confirming 2FA code with Flask...");
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
      logger.info("✅ Device token obtained successfully from Flask");

      // Store in Keytar
      await keytar.setPassword(SERVICE_NAME, DEVICE_TOKEN_KEY, newToken);
      logger.info("Device token stored securely");

      // IMPORTANT: Hide all modals after 2FA completes successfully
      if (mainWindow && !mainWindow.isDestroyed()) {
        logger.info("Hiding modals after 2FA completion...");
        await mainWindow.webContents.executeJavaScript(`
          console.log('2FA completed, hiding all modals...');
          
          // Hide 2FA modal
          const twoFAModal = document.getElementById('device-2fa-modal-injected');
          if (twoFAModal) {
            twoFAModal.style.display = 'none';
            console.log('2FA modal hidden');
          }
          
          // Hide email modal
          const emailModal = document.getElementById('email-modal-injected');
          if (emailModal) {
            emailModal.style.display = 'none';
            console.log('Email modal hidden');
          }
          
          // Hide Steam credentials modal
          const steamModal = document.getElementById('steam-credentials-modal');
          if (steamModal) {
            steamModal.style.display = 'none';
            // Also try to remove it if it exists
            setTimeout(() => {
              if (steamModal.parentNode) {
                steamModal.remove();
                console.log('Steam credentials modal removed');
              }
            }, 300);
          }
          
          // If we're in a QR login flow, call the success handler
          if (window.qrLoginInProgress && window.handleQRLoginSuccess) {
            console.log('Calling QR login success handler after 2FA');
            window.handleQRLoginSuccess({
              steamId: '${steamId}',
              accountName: window.qrLoginAccountName || 'Steam User'
            });
            window.qrLoginInProgress = false;
          }
        `).catch(err => logger.error('Failed to hide modals after 2FA:', err));
      }

      return newToken;
    }
    
    throw new Error("Unexpected response from server");
    
  } catch (err) {
    if (err.response) {
      logger.error(`Error in device token flow: Status ${err.response.status}`, err.response.data);
    } else {
      logger.error("Error in device token flow", err);
    }
    throw err;
  } finally {
    deviceTokenRequestInProgress = false;
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



// Add this handler in main.js
// Add this IPC handler in main.js
ipcMain.handle('check-inventory-needs', async (event, steamId) => {
  const apiCall = async () => {
    const deviceToken = await getDeviceToken();
    const url = `${API_BASE_URL}/inventory_needs/${steamId}`;
    
    const { data } = await axios.post(url, { 
      device_token: deviceToken
    }, {
      headers: {
        'Authorization': `Bearer ${deviceToken}`,
        'Content-Type': 'application/json'
      },
      withCredentials: true
    });

    if (!data.success) {
      throw new Error(data.error || "Unknown error");
    }

    return data;
  };

  try {
    return await withDeviceTokenRetry(apiCall);
  } catch (error) {
    logger.error('Failed to check inventory needs:', error);
    return { success: false, error: error.message };
  }
});


/**
 * Check inventory needs from Flask
 * @param {string} steamId - Steam ID
 */
async function checkInventoryNeeds(steamId) {
  const apiCall = async () => {
    const deviceToken = await getDeviceToken();
    const url = `${API_BASE_URL}/inventory_needs/${steamId}`;
    
    const { data } = await axios.post(url, { 
      device_token: deviceToken
    }, {
      headers: {
        'Authorization': `Bearer ${deviceToken}`,
        'Content-Type': 'application/json'
      },
      withCredentials: true
    });

    if (!data.success) {
      throw new Error(data.error || "Unknown error");
    }

    return data;
  };

  try {
    const data = await withDeviceTokenRetry(apiCall);
    
    // Check if we need to move items
    const needsSomething = Array.isArray(data.needed) && 
      data.needed.some(n => n.missing > 0 && n.storage_assetids.length > 0);

    if (needsSomething && mainWindow && !mainWindow.isDestroyed()) {
      logger.info('Inventory needs detected:');
      data.needed.forEach(need => {
        if (need.missing > 0) {
          logger.info(`  - ${need.market_hash_name}: need ${need.missing}, have ${need.have_in_inv}, can move ${need.storage_assetids.length} from storage`);
        }
      });
      
      mainWindow.webContents.send("inventory-needs", data);
    } else {
      logger.info('No inventory needs detected');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("set-auto-scan-pending");
      }
    }
  } catch (error) {
    logger.error('Failed to check inventory needs:', error);
    // Don't throw - this is a non-critical check
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
        }, 10000);
        
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