// renderer.js - Main UI logic for CS-Assets Storage Scanner

// DOM Elements



const elements = {
  // Views
  loginView: document.getElementById('login-view'),
  dashboardView: document.getElementById('dashboard-view'),
  
  // Forms
  loginForm: document.getElementById('login-form'),
  usernameInput: document.getElementById('username'),
  passwordInput: document.getElementById('password'),
  
  // Account elements
  savedAccountsList: document.getElementById('saved-accounts-list'),
  savedAccountsSection: document.getElementById('saved-accounts-section'),
  savedAccountsDivider: document.getElementById('saved-accounts-divider'),
  displayUsername: document.getElementById('display-username'),
  userAvatar: document.getElementById('user-avatar'),
  
  // Storage elements
  storageGrid: document.getElementById('storage-grid'),
  
  // Loading indicator
  loadingIndicator: document.getElementById('loading-indicator'),
  loadingSpinner: document.getElementById('loading-spinner'),
  loadingUnitIcon: document.getElementById('loading-unit-icon'),
  loadingUnitName: document.getElementById('loading-unit-name'),
  progressBar: document.getElementById('progress-bar'),
  progressText: document.getElementById('progress-text'),
  
  // Modals
  steamGuardModal: document.getElementById('steam-guard-modal'),
  steamGuardInput: document.getElementById('steam-guard-input'),
  device2faModal: document.getElementById('device-2fa-modal'),
  device2faInput: document.getElementById('device-2fa-input'),
  accountNotRegisteredModal: document.getElementById('account-not-registered-modal'),
  notRegisteredAccountName: document.getElementById('not-registered-account-name'),
  warningModal: document.getElementById('warning-modal'),
  warningMessage: document.getElementById('warning-message'),
  scanResultModal: document.getElementById('scan-result-modal'),
  scanResultTitle: document.getElementById('scan-result-title'),
  scanResultSummary: document.getElementById('scan-result-summary'),
  scanResultList: document.getElementById('scan-result-list'),
  inventoryFullModal: document.getElementById('inventory-full-modal'),
  moveItemsModal: document.getElementById('move-items-modal'),
  moveItemsText: document.getElementById('move-items-text')


};

// Global state
const appState = {
  currentUser: null,
  currentCasketName: '',
  currentCasketIcon: '',
  inventoryNeedsPayload: null,
  isLoading: false
};






// Update-related state
const updateState = {
  updateAvailable: false,
  downloading: false,
  downloaded: false,
  currentVersion: null
};






// Add this to renderer.js - Global state for scan all functionality
// Add this to the scanAllState object
const scanAllState = {
  isScanning: false,
  isBatchMode: false,  // Add this line
  cancelled: false,
  currentIndex: 0,
  totalUnits: 0,
  caskets: [],
  results: [],
  startTime: null
};

// Function to scan all storage units
async function scanAllStorageUnits() {
  // Prevent multiple scans
  if (scanAllState.isScanning) {
    toast.warning('A scan is already in progress');
    return;
  }
  
  // Get all storage units
  const storageUnits = document.querySelectorAll('.storage-unit');
  if (storageUnits.length === 0) {
    toast.warning('No storage units found');
    return;
  }
  
  // Initialize scan state
  scanAllState.isScanning = true;
  scanAllState.isBatchMode = true;  // Add this line
  scanAllState.cancelled = false;
  scanAllState.currentIndex = 0;
  scanAllState.totalUnits = scanAllState.caskets.length;
  scanAllState.results = [];
  scanAllState.startTime = Date.now();
  
  // Show modal
  showModal('scan-all-modal');
  updateScanAllProgress();
  
  // Create individual unit progress display
  createUnitProgressDisplay();
  
  // Hide complete button, show cancel button
  document.getElementById('scan-all-complete').style.display = 'none';
  document.getElementById('cancel-scan-all').style.display = 'inline-block';
  
  // Start scanning
  await processScanQueue();
}

// Process the scan queue
// Process the scan queue
async function processScanQueue() {
  while (scanAllState.currentIndex < scanAllState.totalUnits && !scanAllState.cancelled) {
    const casket = scanAllState.caskets[scanAllState.currentIndex];
    
    logger.log(`Starting scan ${scanAllState.currentIndex + 1} of ${scanAllState.totalUnits}: ${casket.casketName}`);
    
    // Update UI
    document.getElementById('scan-progress-current').textContent = `Currently scanning: ${casket.casketName}`;
    updateScanAllProgress();
    highlightCurrentUnit(casket.casketId);
    
    try {
      // Start the deep check with suppressModal = true
      logger.log(`Calling performDeepCheck for ${casket.casketName}`);
      const result = await performDeepCheck(casket.casketId, casket.casketName, true);
      logger.log(`Deep check completed for ${casket.casketName}:`, result.success ? 'Success' : 'Failed');
      
      // Store result with items detail
      scanAllState.results.push({
        casketId: casket.casketId,
        casketName: casket.casketName,
        success: result.success,
        itemsFound: result.newlyAddedItems ? result.newlyAddedItems.length : 0,
        items: result.newlyAddedItems || [],
        error: result.error,
        timeMs: result.totalTimeMs
      });
      
      // Mark unit as complete
      markUnitComplete(casket.casketId);
      
    } catch (error) {
      logger.error(`Error scanning ${casket.casketName}:`, error);
      scanAllState.results.push({
        casketId: casket.casketId,
        casketName: casket.casketName,
        success: false,
        itemsFound: 0,
        items: [],
        error: error.message,
        timeMs: 0
      });
      
      // Mark unit as failed
      markUnitFailed(casket.casketId);
    }
    
    scanAllState.currentIndex++;
    updateScanAllProgress();
    logger.log(`Progress: ${scanAllState.currentIndex} of ${scanAllState.totalUnits} completed`);
    
    // Small delay between scans to prevent overwhelming the system
    if (scanAllState.currentIndex < scanAllState.totalUnits && !scanAllState.cancelled) {
      logger.log('Waiting 1 second before next scan...');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  logger.log('All scans completed, finishing scan all process');
  // Scan complete
  finishScanAll();
}

// Modified deep check function that returns a promise



// In performDeepCheck function, remove progress handling
function performDeepCheck(casketId, casketName, suppressModal = false) {
  return new Promise((resolve) => {
    let resolved = false;
    
    const tempResultHandler = (data) => {
      if (!resolved) {
        resolved = true;
        resolve(data);
        
        if (!suppressModal && !scanAllState.isBatchMode) {
          handleDeepCheckResult(data);
        }
      }
    };
    
    // No more progress updates needed - it's instant!
    window.electronAPI.onDeepCheckResult(tempResultHandler);
    window.electronAPI.deepCheckCasket(casketId);
    
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ success: false, error: 'Operation timed out' });
      }
    }, 30000); // 30 second timeout instead of 5 minutes
  });
}







// Update progress UI
function updateScanAllProgress() {
  const progress = (scanAllState.currentIndex / scanAllState.totalUnits) * 100;
  document.getElementById('scan-all-progress-bar').style.width = `${progress}%`;
  document.getElementById('scan-progress-count').textContent = 
    `${scanAllState.currentIndex} of ${scanAllState.totalUnits} units scanned`;
  
  if (scanAllState.currentIndex === scanAllState.totalUnits) {
    document.getElementById('scan-all-status').textContent = 'Scan complete!';
    document.getElementById('scan-progress-current').textContent = 'All units scanned';
  }
}





function createUnitProgressDisplay() {
  const container = document.getElementById('unit-progress-container');
  
  if (!container) {
    logger.error('Unit progress container not found');
    return;
  }
  
  // Clear and populate with storage units
  container.innerHTML = '';
  container.className = 'unit-progress-container';
  
  const header = document.createElement('h4');
  header.textContent = 'Storage Units:';
  container.appendChild(header);
  
  scanAllState.caskets.forEach((casket, index) => {
    const unitProgress = document.createElement('div');
    unitProgress.className = 'unit-progress-item';
    unitProgress.id = `unit-progress-${casket.casketId}`;
    
    unitProgress.innerHTML = `
      <div class="unit-progress-header">
        <span class="unit-name">${casket.casketName}</span>
        <span class="unit-status" id="unit-status-${casket.casketId}">Waiting...</span>
      </div>
      <div class="unit-progress-bar-container">
        <div class="unit-progress-bar" id="unit-bar-${casket.casketId}"></div>
      </div>
    `;
    
    container.appendChild(unitProgress);
  });
}



function updateIndividualUnitProgress(casketId, progress) {
  const unit = document.getElementById(`unit-progress-${casketId}`);
  
  // Only update if this unit is currently scanning
  if (unit && unit.classList.contains('scanning')) {
    const progressBar = document.getElementById(`unit-bar-${casketId}`);
    if (progressBar) {
      progressBar.style.width = `${progress}%`;
    }
  }
}

// Mark unit as complete
// Mark unit as complete
function markUnitComplete(casketId) {
  const unit = document.getElementById(`unit-progress-${casketId}`);
  if (unit) {
    unit.classList.remove('scanning');
    unit.classList.add('complete');
  }
  
  const status = document.getElementById(`unit-status-${casketId}`);
  if (status) status.textContent = 'Complete';
  
  const progressBar = document.getElementById(`unit-bar-${casketId}`);
  if (progressBar) {
    progressBar.style.width = '100%';
    // Ensure it stays at 100% by setting a more specific style
    progressBar.style.cssText = 'width: 100% !important;';
  }
}

// Mark unit as failed
function markUnitFailed(casketId) {
  const unit = document.getElementById(`unit-progress-${casketId}`);
  if (unit) {
    unit.classList.remove('scanning');
    unit.classList.add('failed');
  }
  
  const status = document.getElementById(`unit-status-${casketId}`);
  if (status) status.textContent = 'Failed';
}

// In renderer.js, in the finishScanAll function, update the items display part:

function finishScanAll() {
  scanAllState.isScanning = false;
  scanAllState.isBatchMode = false;
  const totalTime = Date.now() - scanAllState.startTime;
  
  // Calculate totals
  const successfulScans = scanAllState.results.filter(r => r.success).length;
  const totalItemsFound = scanAllState.results.reduce((sum, r) => sum + r.itemsFound, 0);
  const failedScans = scanAllState.results.filter(r => !r.success);
  
  // Base URL for Steam CDN
  const baseIconUrl = "https://steamcommunity-a.akamaihd.net/economy/image/";
  
  // Combine all items from all storage units
  const allItems = [];
  scanAllState.results.forEach(result => {
    if (result.items && result.items.length > 0) {
      result.items.forEach(item => {
        allItems.push({
          ...item,
          storageUnit: result.casketName
        });
      });
    }
  });
  
  // Group combined items by name
  const groupedItems = {};
  allItems.forEach((item) => {
    const name = item.item_name || item.market_hash_name || `Item ID: ${item.assetid}`;
    if (!groupedItems[name]) {
      // Get the icon URL
      let iconUrl = item.icon_url || item.item_url || '';
      
      // Process the icon URL
      if (iconUrl.startsWith('http://') || iconUrl.startsWith('https://')) {
        groupedItems[name] = { count: 0, icon: iconUrl, units: new Set() };
      } else if (iconUrl.startsWith('-9a81')) {
        groupedItems[name] = { count: 0, icon: baseIconUrl + iconUrl, units: new Set() };
      } else if (iconUrl.startsWith('econ/')) {
        groupedItems[name] = { count: 0, icon: baseIconUrl + iconUrl, units: new Set() };
      } else if (!iconUrl) {
        groupedItems[name] = { count: 0, icon: 'static/images/default-item.png', units: new Set() };
      } else {
        groupedItems[name] = { count: 0, icon: baseIconUrl + iconUrl, units: new Set() };
      }
    }
    groupedItems[name].count++;
    groupedItems[name].units.add(item.storageUnit);
  });
  
  const sortedItems = Object.entries(groupedItems).sort((a, b) => b[1].count - a[1].count);
  
  // Update modal with final results
  document.getElementById('scan-all-status').innerHTML = `
    <div class="scan-summary">
      <h3>Scan Complete!</h3>
      <div class="scan-stats">
        <div class="scan-stat">
          <span class="scan-stat-label">Total Units Scanned:</span>
          <span class="scan-stat-value">${scanAllState.totalUnits}</span>
        </div>
        <div class="scan-stat">
          <span class="scan-stat-label">Successful Scans:</span>
          <span class="scan-stat-value">${successfulScans}</span>
        </div>
        <div class="scan-stat">
          <span class="scan-stat-label">Total Items Found:</span>
          <span class="scan-stat-value">${totalItemsFound}</span>
        </div>
        <div class="scan-stat">
          <span class="scan-stat-label">Total Time:</span>
          <span class="scan-stat-value">${Math.round(totalTime / 1000)} seconds</span>
        </div>
      </div>
      ${failedScans.length > 0 ? `
        <div class="scan-failures">
          <h4>Failed Scans:</h4>
          <ul>
            ${failedScans.map(f => `<li>${f.casketName}: ${f.error}</li>`).join('')}
          </ul>
        </div>
      ` : ''}
      ${totalItemsFound > 0 ? `
        <div class="scan-items-summary">
          <h4>Items Found:</h4>
          <ul class="scan-result-list compact">
            ${sortedItems.slice(0, 10).map(([name, info]) => `
              <li class="scan-result-item compact">
                <img src="${info.icon}" 
                     alt="${name}"
                     onerror="this.onerror=null; this.src='static/images/default-item.png';">
                <div class="scan-result-item-info">
                  <div class="scan-result-item-name">${name}</div>
                  <div class="scan-result-item-count">Quantity: ${info.count} (found in ${info.units.size} unit${info.units.size > 1 ? 's' : ''})</div>
                </div>
              </li>
            `).join('')}
          </ul>
          ${sortedItems.length > 10 ? `<p class="more-items">...and ${sortedItems.length - 10} more item types</p>` : ''}
        </div>
      ` : ''}
    </div>
  `;
  
  // Show complete button, hide cancel button
  document.getElementById('scan-all-complete').style.display = 'inline-block';
  document.getElementById('cancel-scan-all').style.display = 'none';
  
  // Show toast notification
  if (scanAllState.cancelled) {
    toast.warning(`Scan cancelled. Completed ${scanAllState.currentIndex} of ${scanAllState.totalUnits} units`);
  } else if (totalItemsFound > 0) {
    toast.success(`All storage units scanned successfully! Found ${totalItemsFound} items`);
  } else {
    toast.warning(`Scan complete. No new items found in storage units.`);
  }
}

// Cancel scan all
function cancelScanAll() {
  if (scanAllState.isScanning) {
    scanAllState.cancelled = true;
    toast.warning('Cancelling scan...');
  } else {
    // If not scanning, just close the modal
    hideModal('scan-all-modal');
  }
}




function highlightCurrentUnit(casketId) {
  // Remove highlight and reset all progress bars
  document.querySelectorAll('.unit-progress-item').forEach(item => {
    item.classList.remove('scanning');
    
    // If it's marked as complete, ensure the bar stays at 100%
    if (item.classList.contains('complete')) {
      const progressBar = item.querySelector('.unit-progress-bar');
      if (progressBar) {
        progressBar.style.cssText = 'width: 100% !important;';
      }
    }
  });
  
  // Add highlight to current unit
  const currentUnit = document.getElementById(`unit-progress-${casketId}`);
  if (currentUnit) {
    currentUnit.classList.add('scanning');
    const status = document.getElementById(`unit-status-${casketId}`);
    if (status) status.textContent = 'Scanning...';
    
    // Reset the current unit's progress bar to 0
    const progressBar = document.getElementById(`unit-bar-${casketId}`);
    if (progressBar) {
      progressBar.style.width = '0%';
    }
  }
}

function addScanAllEventListeners() {
  // Scan all button
  const scanAllButton = document.getElementById('scan-all-button');
  if (scanAllButton) {
    scanAllButton.addEventListener('click', scanAllStorageUnits);
  }
  
  // Cancel button
  document.getElementById('cancel-scan-all').addEventListener('click', cancelScanAll);
  
  // Complete button (close modal)
  document.getElementById('scan-all-complete').addEventListener('click', () => {
    hideModal('scan-all-modal');
  });
  
  // Prevent modal dismissal during scanning
  const scanAllModal = document.getElementById('scan-all-modal');
  if (scanAllModal) {
    scanAllModal.addEventListener('click', (e) => {
      if (e.target === scanAllModal && scanAllState.isScanning) {
        e.stopPropagation();
        toast.warning('Please wait for the scan to complete or click Cancel');
      }
    });
  }
}

// Call this in your main setupEventListeners function
// addScanAllEventListeners();





// Toast notification system
const toast = {
  container: document.getElementById('toast-container'),
  
  show(message, type = 'info', duration = 3000) {
    const toastEl = document.createElement('div');
    toastEl.className = `toast toast-${type}`;
    
    let iconClass = 'info-circle';
    if (type === 'success') iconClass = 'check-circle';
    if (type === 'error') iconClass = 'exclamation-circle';
    if (type === 'warning') iconClass = 'exclamation-triangle';
    
    toastEl.innerHTML = `
      <div class="toast-content">
        <div class="toast-title">${type.charAt(0).toUpperCase() + type.slice(1)}</div>
        <div class="toast-message">${message}</div>
      </div>
      <button class="toast-close">&times;</button>
    `;
    
    this.container.appendChild(toastEl);
    
    // Handle close button
    const closeBtn = toastEl.querySelector('.toast-close');
    closeBtn.addEventListener('click', () => {
      toastEl.classList.add('toast-hiding');
      setTimeout(() => {
        this.container.removeChild(toastEl);
      }, 300);
    });
    
    // Auto remove after duration
    setTimeout(() => {
      if (toastEl.parentNode === this.container) {
        toastEl.classList.add('toast-hiding');
        setTimeout(() => {
          if (toastEl.parentNode === this.container) {
            this.container.removeChild(toastEl);
          }
        }, 300);
      }
    }, duration);
  },
  
  success(message, duration) {
    this.show(message, 'success', duration);
  },
  
  error(message, duration) {
    this.show(message, 'error', duration);
  },
  
  warning(message, duration) {
    this.show(message, 'warning', duration);
  }
};

// Logger - Log to console but not to UI
const logger = {
  log(message) {
    console.log(`[LOG] ${message}`);
  },
  
  error(message, error) {
    console.error(`[ERROR] ${message}`, error);
  },
  
  warn(message) {
    console.warn(`[WARN] ${message}`);
  }
};

// UI state management
function showView(viewName) {
  // Hide all views
  elements.loginView.style.display = 'none';
  elements.dashboardView.style.display = 'none';
  
  // Show the requested view
  if (viewName === 'login') {
    elements.loginView.style.display = 'block';
    loadSavedAccounts(); // Refresh the accounts list
  } else if (viewName === 'dashboard') {
    elements.dashboardView.style.display = 'block';
    window.electronAPI.fetchStorage();
  }
}







// Create update notification UI
function createUpdateNotification() {
  const updateNotification = document.createElement('div');
  updateNotification.id = 'update-notification';
  updateNotification.className = 'update-notification';
  updateNotification.innerHTML = `
    <div class="update-content">
      <div class="update-icon">🔄</div>
      <div class="update-text">
        <div class="update-title">Update Available</div>
        <div class="update-message">A new version is available</div>
      </div>
      <div class="update-actions">
        <button id="download-update-btn" class="btn btn-primary btn-sm">Download</button>
        <button id="dismiss-update-btn" class="btn btn-secondary btn-sm">Later</button>
      </div>
    </div>
    <div class="update-progress" id="update-progress" style="display: none;">
      <div class="progress-bar" id="update-progress-bar"></div>
      <div class="progress-text" id="update-progress-text">Downloading...</div>
    </div>
  `;
  
  document.body.appendChild(updateNotification);
  
  // Event listeners
  document.getElementById('download-update-btn').addEventListener('click', downloadUpdate);
  document.getElementById('dismiss-update-btn').addEventListener('click', dismissUpdate);
  
  return updateNotification;
}

// Show update available notification
function showUpdateNotification(info) {
  let notification = document.getElementById('update-notification');
  if (!notification) {
    notification = createUpdateNotification();
  }
  
  const messageEl = notification.querySelector('.update-message');
  messageEl.textContent = `Version ${info.version} is available`;
  
  notification.style.display = 'block';
  setTimeout(() => notification.classList.add('show'), 100);
}

// Download update
async function downloadUpdate() {
  const btn = document.getElementById('download-update-btn');
  const progressEl = document.getElementById('update-progress');
  
  btn.disabled = true;
  btn.textContent = 'Downloading...';
  progressEl.style.display = 'block';
  
  updateState.downloading = true;
  
  try {
    const result = await window.electronAPI.downloadUpdate();
    if (!result.success) {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error('Failed to download update:', error);
    toast.error('Failed to download update: ' + error.message);
    
    btn.disabled = false;
    btn.textContent = 'Download';
    progressEl.style.display = 'none';
    updateState.downloading = false;
  }
}

// Dismiss update notification
function dismissUpdate() {
  const notification = document.getElementById('update-notification');
  if (notification) {
    notification.classList.remove('show');
    setTimeout(() => {
      notification.style.display = 'none';
    }, 300);
  }
}

// Install update
async function installUpdate() {
  try {
    await window.electronAPI.installUpdate();
  } catch (error) {
    logger.error('Failed to install update:', error);
    toast.error('Failed to install update: ' + error.message);
  }
}

// Handle download progress
function handleDownloadProgress(progress) {
  const progressBar = document.getElementById('update-progress-bar');
  const progressText = document.getElementById('update-progress-text');
  
  if (progressBar && progressText) {
    progressBar.style.width = `${progress.percent}%`;
    progressText.textContent = `Downloading... ${Math.round(progress.percent)}%`;
  }
}

// Handle update downloaded
function handleUpdateDownloaded(info) {
  const notification = document.getElementById('update-notification');
  if (notification) {
    notification.innerHTML = `
      <div class="update-content">
        <div class="update-icon">✅</div>
        <div class="update-text">
          <div class="update-title">Update Ready</div>
          <div class="update-message">Version ${info.version} has been downloaded</div>
        </div>
        <div class="update-actions">
          <button id="install-update-btn" class="btn btn-success btn-sm">Restart & Install</button>
          <button id="install-later-btn" class="btn btn-secondary btn-sm">Install Later</button>
        </div>
      </div>
    `;
    
    document.getElementById('install-update-btn').addEventListener('click', installUpdate);
    document.getElementById('install-later-btn').addEventListener('click', dismissUpdate);
  }
  
  updateState.downloaded = true;
  updateState.downloading = false;
}















// Loading indicator functions
function showLoading(withProgress = false) {
  appState.isLoading = true;
  elements.loadingIndicator.style.display = 'flex';

  if (withProgress) {
    elements.progressBar.style.width = '0%';
    elements.progressText.textContent = 'Scanning... 0%';
    elements.progressBar.parentElement.style.display = 'block';
    elements.loadingSpinner.style.display = 'none';
    elements.loadingUnitIcon.src = appState.currentCasketIcon;
    elements.loadingUnitIcon.style.display = 'block';
    elements.loadingUnitName.textContent = appState.currentCasketName;
    elements.loadingUnitName.style.display = 'block';
  } else {
    elements.progressBar.parentElement.style.display = 'none';
    elements.progressText.textContent = 'Loading...';
    elements.loadingSpinner.style.display = 'block';
    elements.loadingUnitIcon.style.display = 'none';
    elements.loadingUnitName.style.display = 'none';
  }
}

function hideLoading() {
  appState.isLoading = false;
  elements.loadingIndicator.style.display = 'none';
  elements.loadingSpinner.style.display = 'block';
  elements.loadingUnitIcon.style.display = 'none';
  elements.loadingUnitName.style.display = 'none';
}

function updateLoadingProgress(progress, current, total) {
  if (!appState.isLoading) return;

  elements.progressBar.style.width = `${progress}%`;
  elements.progressText.textContent = `Scanning... ${progress}%`;
}

// Modal management
function showModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.style.display = 'flex';
    
    // Focus the first input if there is one
    const firstInput = modal.querySelector('input');
    if (firstInput) {
      setTimeout(() => {
        firstInput.focus();
      }, 100);
    }
  }
}

function hideModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.style.display = 'none';
  }
}

// Account management
async function loadSavedAccounts() {
  try {
    const accounts = await window.electronAPI.getSavedAccounts();
    elements.savedAccountsList.innerHTML = '';
    // Reset visibility each time
    if (elements.savedAccountsSection) {
      elements.savedAccountsSection.style.display = '';
    }
    if (elements.savedAccountsDivider) {
      elements.savedAccountsDivider.style.display = '';
    }

    if (!accounts || accounts.length === 0) {
      if (elements.savedAccountsSection) {
        elements.savedAccountsSection.style.display = 'none';
      }
      if (elements.savedAccountsDivider) {
        elements.savedAccountsDivider.style.display = 'none';
      }
      return;
    }
    
    // Sort accounts: valid refresh tokens first, then by last used date
    const sortedAccounts = accounts.sort((a, b) => {
      const aHasToken = a.refreshToken && a.refreshToken.trim() !== '';
      const bHasToken = b.refreshToken && b.refreshToken.trim() !== '';
      
      if (aHasToken !== bHasToken) {
        return aHasToken ? -1 : 1; // Accounts with tokens come first
      }
      
      // Then sort by last used (most recent first)
      return (b.lastUsed || 0) - (a.lastUsed || 0);
    });
    
    // For each account, create a new account item
    sortedAccounts.forEach((account) => {
      const div = document.createElement('div');
      div.classList.add('account-item');
      
      // Visual indication if account has no valid token
      const hasToken = account.refreshToken && account.refreshToken.trim() !== '';
      if (!hasToken) {
        div.classList.add('no-token');
      }
      
      div.onclick = () => {
        if (hasToken) {
          // If it has a token, try to log in automatically
          loginWithSavedAccount(account.steamId);
        } else {
          // No token - show credential login form with username pre-filled
          elements.usernameInput.value = account.displayName || '';
          elements.passwordInput.focus();
        }
      };
      
      const lastLogin = account.lastUsed 
        ? new Date(account.lastUsed).toLocaleString() 
        : 'Never';
      
      div.innerHTML = `
        <div class="account-avatar">
          <img src="${account.avatarUrl || 'static/images/default-avatar.png'}" alt="Account avatar">
        </div>
        <div class="account-info">
          <div class="account-name">${account.displayName || account.steamId}</div>
          <div class="account-details">
            ${hasToken ? 'Auto login available' : 'Manual login required'}
            ${account.lastUsed ? ` • Last login: ${lastLogin}` : ''}
          </div>
        </div>
      `;
      
      elements.savedAccountsList.appendChild(div);
    });
  } catch (err) {
    logger.error('Failed to load saved accounts', err);
    elements.savedAccountsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-text">Failed to load accounts</div>
      </div>
    `;
  }
}

function loginWithSavedAccount(steamId) {
  logger.log(`Logging in with saved account: ${steamId}`);
  showLoading();
  window.electronAPI.loginWithSavedAccount(steamId);
}

// Login functionality
function handleLogin(event) {
  if (event) event.preventDefault();
  
  const username = elements.usernameInput.value.trim();
  const password = elements.passwordInput.value;
  
  if (!username || !password) {
    toast.warning('Please enter both username and password');
    return;
  }
  
  logger.log(`Logging in with username: ${username}`);
  showLoading();
  window.electronAPI.login({ username, password });
}

// Steam Guard handling
function submitSteamGuardCode() {
  const code = elements.steamGuardInput.value.trim();
  
  if (!code) {
    toast.warning('Please enter the Steam Guard code');
    return;
  }
  
  logger.log('Submitting Steam Guard code');
  window.electronAPI.sendSteamGuardCode(code);
  elements.steamGuardInput.value = '';
  hideModal('steam-guard-modal');
}

// 2FA handling
function submitDevice2FACode() {
  const code = elements.device2faInput.value.trim();
  
  if (!code) {
    toast.warning('Please enter the 2FA code');
    return;
  }
  
  logger.log('Submitting 2FA code');
  window.electronAPI.send2FACode(code);
  elements.device2faInput.value = '';
  hideModal('device-2fa-modal');
}

// Storage units rendering
// Modify renderStorageUnits to store caskets and show scan all button
function renderStorageUnits(caskets) {
  // Store caskets in scan state
  scanAllState.caskets = caskets || [];
  
  elements.storageGrid.innerHTML = '';
  
  // Show/hide scan all button based on caskets availability
  const scanAllButton = document.getElementById('scan-all-button');
  if (scanAllButton) {
    scanAllButton.style.display = caskets && caskets.length > 1 ? 'inline-flex' : 'none';
  }
  
  if (!caskets || caskets.length === 0) {
    elements.storageGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-text">No storage units found</div>
        <p>You don't have any storage units in your inventory.</p>
      </div>
    `;
    return;
  }
  
  caskets.forEach((casket) => {
    const unitDiv = document.createElement('div');
    unitDiv.className = 'storage-unit';
    
    const unitIconUrl = "https://steamcommunity-a.akamaihd.net/economy/image/" +
      "-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXX7gNTPcUxqAhWSVieFOX71szWCgwsdlZRsuz0L1M1iqrOIGUauNiyzdmKxKWsMrnXkjlQsIthhO5eh9dfdg";
    
    unitDiv.onclick = () => {
      if (!scanAllState.isScanning) {
        startDeepCheck(casket.casketId, casket.casketName, unitDiv);
      } else {
        toast.warning('Please wait for the current scan to complete');
      }
    };
    
    unitDiv.innerHTML = `
      <img src="${unitIconUrl}" alt="${casket.casketName}">
      <div class="storage-name">${casket.casketName}</div>
      <div class="storage-items">Contains ${casket.itemCount} item(s)</div>
    `;
    
    elements.storageGrid.appendChild(unitDiv);
  });
}

// Deep check functionality
function startDeepCheck(casketId, casketName, unitElement) {
  appState.currentCasketName = casketName;
  appState.currentCasketIcon = unitElement ? unitElement.querySelector('img').src : '';
  
  // Disable the element to prevent multiple clicks
  if (unitElement) {
    unitElement.style.pointerEvents = 'none';
  }
  
  showLoading(true);
  logger.log(`Starting deep check on storage unit: ${casketName} (${casketId})`);
  window.electronAPI.deepCheckCasket(casketId);
}

// Handle deep check result
// In renderer.js

function handleDeepCheckResult(data) {
  hideLoading();
  
  if (!data.success) {
    if (data.error && data.error.includes('inventory is too full')) {
      showModal('inventory-full-modal');
    } else {
      toast.error(`Deep check failed: ${data.error}`);
    }
    return;
  }
  
  const items = data.newlyAddedItems;
  const grouped = {};
  
  // Base URL for Steam CDN
  const baseIconUrl = "https://steamcommunity-a.akamaihd.net/economy/image/";
  
  // Group items by name
  items.forEach((item) => {
    const name = item.item_name || item.market_hash_name || `Item ID: ${item.assetid}`;
    if (!grouped[name]) {
      // Get the icon URL
      let iconUrl = item.icon_url || item.item_url || '';
      
      // If it's already a full URL, use it
      if (iconUrl.startsWith('http://') || iconUrl.startsWith('https://')) {
        grouped[name] = { count: 0, icon: iconUrl };
      } 
      // If it starts with the Steam CDN hash format
      else if (iconUrl.startsWith('-9a81')) {
        grouped[name] = { count: 0, icon: baseIconUrl + iconUrl };
      }
      // If it's a path like "econ/weapons/..."
      else if (iconUrl.startsWith('econ/')) {
        grouped[name] = { count: 0, icon: baseIconUrl + iconUrl };
      }
      // If empty, use default
      else if (!iconUrl) {
        grouped[name] = { count: 0, icon: 'static/images/default-item.png' };
      }
      // Otherwise prepend base URL
      else {
        grouped[name] = { count: 0, icon: baseIconUrl + iconUrl };
      }
    }
    grouped[name].count++;
  });
  
  const totalItems = items.length;
  const sortedEntries = Object.entries(grouped).sort((a, b) => b[1].count - a[1].count);
  
  // Update scan result modal content
  elements.scanResultTitle.textContent = `Successfully scanned "${appState.currentCasketName}"`;
  elements.scanResultSummary.textContent = `${totalItems} new items detected. You can now sell them on cswhale.com!`;
  elements.scanResultList.innerHTML = '';
  
  sortedEntries.forEach(([name, info]) => {
    const li = document.createElement('li');
    li.className = 'scan-result-item';
    
    li.innerHTML = `
      <img src="${info.icon}" 
           alt="${name}" 
           onerror="this.onerror=null; this.src='static/images/default-item.png';">
      <div class="scan-result-item-info">
        <div class="scan-result-item-name">${name}</div>
        <div class="scan-result-item-count">Quantity: ${info.count}</div>
      </div>
    `;
    
    elements.scanResultList.appendChild(li);
  });
  
  showModal('scan-result-modal');
  
  // Log success
  logger.log(`Deep check completed successfully: ${totalItems} items found`);
  
  // Re-enable all storage unit elements
  document.querySelectorAll('.storage-unit').forEach(el => {
    el.style.pointerEvents = 'auto';
  });
}

// Inventory needs handling
function handleInventoryNeeds(data) {
  appState.inventoryNeedsPayload = data;
  
  // Update modal text
  const totalMissing = data.needed.reduce((sum, n) => sum + n.missing, 0);
  elements.moveItemsText.textContent = 
    `You are missing ${totalMissing} item(s) for open orders. Move them now?`;
  
  showModal('move-items-modal');
}

async function moveItemsFromStorage() {
  try {
    hideModal('move-items-modal');
    showLoading();
    
    const response = await window.electronAPI.moveItemsFromStorage(appState.inventoryNeedsPayload);
    hideLoading();
    
    if (response.success) {
      // Show the success modal instead of just a toast
      showModal('move-items-success-modal');
    } else {
      toast.error(`Failed to move items: ${response.error}`);
      // Show the move items modal again since it's required
      showModal('move-items-modal');
    }
  } catch (error) {
    hideLoading();
    logger.error('Error moving items from storage', error);
    toast.error('An error occurred while moving items');
    // Show the move items modal again since it's required
    showModal('move-items-modal');
  }
}


// Add this function for email submission
function submitEmail() {
  const emailInput = document.getElementById('email-input');
  const submitButton = document.getElementById('email-submit');
  const email = emailInput.value.trim();
  
  // Prevent double submission
  if (submitButton.disabled) {
    console.log('Submit already in progress');
    return;
  }
  
  if (!email) {
    toast.warning('Please enter your email address');
    return;
  }
  
  // Disable button immediately
  submitButton.disabled = true;
  submitButton.textContent = 'Sending...';
  
  logger.log(`Submitting email address: ${email.substring(0, 3)}***`);
  window.electronAPI.sendEmail(email);
  emailInput.value = '';
  hideModal('email-request-modal');
  showLoading();
  toast.info('Sending 2FA code to your email...');
  
  // Re-enable after a delay (in case of error)
  setTimeout(() => {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = 'Send 2FA Code';
    }
  }, 5000);
}

// Add this in setupEventListeners() function
// Email modal buttons
document.getElementById('email-submit').addEventListener('click', submitEmail);
// Replace the existing email-cancel handler with this:
document.getElementById('email-cancel').addEventListener('click', () => {
  // Show confirmation before allowing cancel
  if (confirm('Without providing an email, you cannot complete authentication. Are you sure you want to cancel? You will need to restart the application to try again.')) {
    hideModal('email-request-modal');
    window.electronAPI.cancelEmail();
    hideLoading();
    
    // Optionally redirect back to login
    showView('login');
    toast.error('Authentication cancelled. Please restart the application to try again.');
  }
});

// Allow Enter key to submit email
document.getElementById('email-input').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    submitEmail();
  }
});



// Event Listeners
function setupEventListeners() {
  // Login form submit
  if (elements.loginForm) {
    elements.loginForm.addEventListener('submit', handleLogin);
  }


  addScanAllEventListeners();
  
  // Login button
  document.getElementById('login-button').addEventListener('click', handleLogin);
  
  // Switch account button
  document.getElementById('switch-account-button').addEventListener('click', () => {
    showView('login');
  });
  
  // Modal close buttons and overlay clicks
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal-overlay');
      if (modal) hideModal(modal.id);
    });
  });


  // Prevent ESC key from closing critical modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const emailModal = document.getElementById('email-request-modal');
      const device2faModal = document.getElementById('device-2fa-modal');
      
      // Check if email modal is visible
      if (emailModal && emailModal.style.display === 'flex') {
        e.preventDefault();
        toast.warning('Please enter your email address to continue');
        return;
      }
      
      // Check if 2FA modal is visible
      if (device2faModal && device2faModal.style.display === 'flex') {
        e.preventDefault();
        toast.warning('Please enter the 2FA code to continue');
        return;
      }
    }
  });
  
  // Replace the existing modal overlay click handler with this:
  document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        // Prevent closing the email-request-modal by clicking outside
        if (modal.id === 'email-request-modal') {
          e.stopPropagation();
          toast.warning('Please enter your email address to continue, or close the application if you wish to cancel.');
          return;
        }
        
        // Prevent closing scan-all modal during scanning
        if (modal.id === 'scan-all-modal' && scanAllState.isScanning) {
          e.stopPropagation();
          toast.warning('Please wait for the scan to complete or click Cancel');
          return;
        }
        
        // Prevent closing device-2fa-modal
        if (modal.id === 'device-2fa-modal') {
          // Don't allow clicking away from 2FA modal either
          return;
        }
        
        hideModal(modal.id);
      }
    });
  });


  // Steam Guard submit button
  document.getElementById('steam-guard-submit').addEventListener('click', submitSteamGuardCode);
  
  // 2FA submit button
  document.getElementById('device-2fa-submit').addEventListener('click', submitDevice2FACode);
  
  // Close scan result modal
  document.getElementById('scan-result-close').addEventListener('click', () => {
    hideModal('scan-result-modal');
  });
  
  // Close inventory full modal
  document.getElementById('inventory-full-close').addEventListener('click', () => {
    hideModal('inventory-full-modal');
  });
  
  // Close not registered modal
  document.getElementById('not-registered-close').addEventListener('click', () => {
    hideModal('account-not-registered-modal');
  });
  
  // Close warning modal
  document.getElementById('warning-close').addEventListener('click', () => {
    hideModal('warning-modal');
  });
  




  // Move items buttons
  document.getElementById('move-items-yes').addEventListener('click', moveItemsFromStorage);


  document.getElementById('move-items-success-close').addEventListener('click', () => {
  hideModal('move-items-success-modal');
});
}

// Set up IPC event handlers
function setupIPCHandlers() {


window.electronAPI.onPleaseEnterEmail(() => {
  hideLoading();
  showModal('email-request-modal');
  // Focus the email input
  setTimeout(() => {
    const emailInput = document.getElementById('email-input');
    if (emailInput) emailInput.focus();
  }, 100);
});




  // Login events
  window.electronAPI.onLoginSuccess(() => {
    hideLoading();
    showView('dashboard');
  });
  
  window.electronAPI.onLoginFailed((error) => {
    hideLoading();
    logger.error('Login failed', error);
    toast.error('Login failed: ' + error);
  });
  
  // Steam Guard
  window.electronAPI.onSteamGuardRequired((domain) => {
    hideLoading();
    const promptEl = document.getElementById('steam-guard-prompt');
    promptEl.textContent = domain
      ? `Enter Steam Guard code for ${domain}:`
      : 'Enter your Steam Guard code:';
      
    showModal('steam-guard-modal');
  });
  
  // 2FA
  window.electronAPI.onPleaseEnter2FA(() => {
    hideLoading();
    showModal('device-2fa-modal');
  });
  
  // Storage items
  window.electronAPI.onStorageItems((_, caskets) => {
    renderStorageUnits(caskets);
  });
  
  // Deep check progress
  window.electronAPI.onDeepCheckProgress((data) => {
    updateLoadingProgress(data.progress, data.currentMovement, data.totalMovements);
  });
  
  // Deep check result
// Deep check result
  window.electronAPI.onDeepCheckResult((data) => {
    handleDeepCheckResult(data);
  });
    
  // Account details
  window.electronAPI.onAccountDetails((_, data) => {
    logger.log(`Received account details: ${JSON.stringify(data)}`);
    
    if (data.displayName) {
      elements.displayUsername.textContent = data.displayName;
    }
    
    if (data.avatarUrl) {
      elements.userAvatar.src = data.avatarUrl;
    }
  });
  
  // Account not registered
  window.electronAPI.onAccountNotRegistered((account) => {
    elements.notRegisteredAccountName.textContent = account.displayName || account.steamId;
    showModal('account-not-registered-modal');
  });
  
  // Login warning
  window.electronAPI.onLoginWarning((message) => {
    elements.warningMessage.textContent = message;
    showModal('warning-modal');
  });
  
  // Storage error
  window.electronAPI.onStorageError((_, error) => {
    hideLoading();
    logger.error('Storage error', error);
    toast.error(`Storage error: ${error}`);
  });
  
  // Log event
  // In renderer.js
  window.electronAPI.onLogEvent((_, message) => {
    // Highlight auto-updater related logs
    if (message && message.includes('update')) {
      console.log('%c[Auto-Updater]', 'color: #10b981; font-weight: bold;', message);
    } else if (message && message.includes('ERROR')) {
      console.error('[Main Process]', message);
    } else {
      console.log('[Main Process]', message);
    }
  });



  // Inventory needs
  window.electronAPI.onInventoryNeeds((data) => {
    handleInventoryNeeds(data);
  });




  window.electronAPI.onDeviceTokenExpired(() => {
    logger.warn('Device token has expired');
    
    // Show a modal or toast notification
    showModal('device-reauth-modal');
  });



}



function setupUpdateHandlers() {
  // Update available
  window.electronAPI.onUpdateAvailable((info) => {
    console.log('%c[UPDATE AVAILABLE]', 'background: #10b981; color: white; padding: 2px 4px; border-radius: 2px;', info);
    logger.log(`Update available: ${info.version}`);
    updateState.updateAvailable = true;
    updateState.currentVersion = info.version;
    showUpdateNotification(info);
  });
  
  // Download progress
  window.electronAPI.onDownloadProgress((progress) => {
    console.log('[UPDATE PROGRESS]', `${Math.round(progress.percent)}%`);
    handleDownloadProgress(progress);
  });
  
  // Update downloaded
  window.electronAPI.onUpdateDownloaded((info) => {
    console.log('%c[UPDATE DOWNLOADED]', 'background: #3b82f6; color: white; padding: 2px 4px; border-radius: 2px;', info);
    logger.log(`Update downloaded: ${info.version}`);
    handleUpdateDownloaded(info);
    toast.success('Update downloaded successfully!');
  });
}


async function handleDeviceReauth() {
  try {
    showLoading();
    const result = await window.electronAPI.refreshDeviceToken();
    
    if (result.success) {
      hideLoading();
      hideModal('device-reauth-modal');
      toast.success('Authentication refreshed successfully');
      
      // Refresh the current view
      if (elements.dashboardView.style.display !== 'none') {
        window.electronAPI.fetchStorage();
      }
    } else {
      hideLoading();
      toast.error('Failed to refresh authentication: ' + result.error);
    }
  } catch (error) {
    hideLoading();
    logger.error('Device re-authentication failed', error);
    toast.error('Authentication failed. Please log in again.');
    showView('login');
  }
}


// Initialize app
function initApp() {
  setupEventListeners();
  setupIPCHandlers();
  showView('login');
  setupUpdateHandlers(); // Add this line
  logger.log('Application initialized');
}

// Run initialization when DOM is loaded
document.addEventListener('DOMContentLoaded', initApp);

// Make functions available globally for HTML onclick attributes
window.login = handleLogin;
window.showDashboard = () => showView('dashboard');
window.showLogin = () => showView('login');
window.submitSteamGuardCode = submitSteamGuardCode;
window.submitDevice2FACode = submitDevice2FACode;
window.closeScanResultModal = () => hideModal('scan-result-modal');
window.closeInventoryFullModal = () => hideModal('inventory-full-modal');
window.closeNotRegisteredModal = () => hideModal('account-not-registered-modal');
window.closeWarningModal = () => hideModal('warning-modal');