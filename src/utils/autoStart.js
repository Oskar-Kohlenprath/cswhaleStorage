// src/utils/autoStart.js
const { app } = require('electron');
const path = require('path');

function setupAutoStart() {
  if (process.platform === 'win32') {
    // Windows: Use registry
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
      path: app.getPath('exe'),
      args: ['--background', '--hidden']
    });
  } else if (process.platform === 'darwin') {
    // macOS: Use Login Items
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true
    });
  } else {
    // Linux: Create .desktop file
    const desktopEntry = `[Desktop Entry]
Type=Application
Name=CSWhale Trade Monitor
Exec="${app.getPath('exe')}" --background
Hidden=true
NoDisplay=true
X-GNOME-Autostart-enabled=true`;
    
    const fs = require('fs');
    const autostartPath = path.join(
      app.getPath('home'),
      '.config/autostart/cswhale.desktop'
    );
    
    fs.writeFileSync(autostartPath, desktopEntry);
  }
}

module.exports = { setupAutoStart };