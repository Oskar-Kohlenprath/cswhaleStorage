// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Existing functions
  login: (credentials) => ipcRenderer.send('login-credentials', credentials),
  fetchStorage: () => ipcRenderer.send('fetch-storage'),
  sendSteamGuardCode: (code) => ipcRenderer.send('steamGuard-code', code),
  deepCheckCasket: (casketId) => ipcRenderer.send('casket-deep-check', casketId),
  
  onPleaseEnter2FA: (callback) => ipcRenderer.on('please-enter-2fa', callback),
  send2FACode: (code) => ipcRenderer.send('2fa-code-submitted', code),
  
  onLoginSuccess: (callback) => ipcRenderer.on('login-success', callback),
  onLoginFailed: (callback) => ipcRenderer.on('login-failed', (event, error) => callback(error)),
  onStorageItems: (callback) => ipcRenderer.on('storage-items', (event, caskets) => callback(event, caskets)),
  onDeepCheckResult: (callback) => ipcRenderer.on('deep-check-result', (event, data) => callback(data)),
  onDeepCheckProgress: (callback) => ipcRenderer.on('deep-check-progress', (event, data) => callback(data)),
  onStorageError: (callback) => ipcRenderer.on('storage-error', (event, error) => callback(event, error)),
  onLogEvent: (callback) => ipcRenderer.on('log-event', (event, message) => callback(event, message)),
  onSteamGuardRequired: (callback) =>
    ipcRenderer.on('steamGuard-required', (event, domain) => callback(domain)),
  
  // Get all saved accounts
  getSavedAccounts: () => ipcRenderer.invoke('get-saved-accounts'),
  
// ADD THIS LINE in the electronAPI exposure:
  // ADD THIS LINE in the electronAPI exposure:
onSetAutoScanPending: (callback) => ipcRenderer.on('set-auto-scan-pending', callback),
// REMOVE or comment out: onTriggerAutoScan if you added it before

  onForceRefreshAccounts: (callback) => ipcRenderer.on('force-refresh-accounts', callback),


  scanAllStorageUnits: () => ipcRenderer.send('casket-deep-check-all'),
  onScanAllParallelProgress: (callback) => ipcRenderer.on('scan-all-parallel-progress', (event, data) => callback(data)),
  onScanAllStorageProgress: (callback) => ipcRenderer.on('scan-all-storage-progress', (event, data) => callback(data)),
  onScanAllComplete: (callback) => ipcRenderer.on('scan-all-complete', (event, data) => callback(data)),
  // Log in with a stored refresh token
  loginWithSavedAccount: (steamId) => ipcRenderer.invoke('login-with-refresh-token', steamId),
  
  onAccountDetails: (callback) => ipcRenderer.on('account-details', callback),
  
  // New events
  onAccountNotRegistered: (callback) => ipcRenderer.on('account-not-registered', (event, account) => callback(account)),
  onLoginWarning: (callback) => ipcRenderer.on('login-warning', (event, message) => callback(message)),
  
  onInventoryNeeds: (callback) => ipcRenderer.on('inventory-needs', (_e,data) => callback(data)),
  moveItemsFromStorage: (payload) => ipcRenderer.invoke('move-items-from-storage', payload),

  onDeviceTokenExpired: (callback) => ipcRenderer.on('device-token-expired', callback),
  refreshDeviceToken: () => ipcRenderer.invoke('refresh-device-token'),
  
  // Add these to the electronAPI exposure in contextBridge.exposeInMainWorld
  onPleaseEnterEmail: (callback) => ipcRenderer.on('please-enter-email', callback),
  sendEmail: (email) => ipcRenderer.send('email-submitted', email),
  cancelEmail: () => ipcRenderer.send('email-cancelled'),

    // ADD these in the electronAPI exposure:
  onMarkUnitComplete: (callback) => ipcRenderer.on('mark-unit-complete', (event, data) => callback(data)),
  onMarkUnitFailed: (callback) => ipcRenderer.on('mark-unit-failed', (event, data) => callback(data)),


  // Auto-updater functions
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'), 
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),

  // Auto-updater events
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (event, info) => callback(info)),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, progress) => callback(progress)),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (event, info) => callback(info)),
});