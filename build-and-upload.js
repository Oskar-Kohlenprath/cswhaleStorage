#!/usr/bin/env node

/**
 * Automated build and upload script for CS-Assets Inventory Verifier
 * Usage: node build-and-upload.js [version]
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

// Configuration
const CONFIG = {
  FLASK_ADMIN_TOKEN: process.env.FLASK_ADMIN_TOKEN || 'YOUR_ADMIN_TOKEN',
  FLASK_URL: process.env.FLASK_URL || 'cswhale-green-dust-4483.fly.dev',
  DIST_DIR: path.join(__dirname, 'dist'),
  PACKAGE_JSON: path.join(__dirname, 'package.json')
};

class Builder {
  constructor() {
    this.version = this.getVersion();
    this.builtFiles = {};
  }


  
  getVersion() {
    // Get version from command line arg or package.json
    const cmdVersion = process.argv[2];
    if (cmdVersion) {
      return cmdVersion;
    }
    
    const packageJson = JSON.parse(fs.readFileSync(CONFIG.PACKAGE_JSON, 'utf8'));
    return packageJson.version;
  }

  log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
  }

  error(message) {
    console.error(`[${new Date().toISOString()}] ERROR: ${message}`);
  }

  async updateVersion() {
    this.log(`Updating version to ${this.version}...`);
    
    // Update package.json version
    const packageJson = JSON.parse(fs.readFileSync(CONFIG.PACKAGE_JSON, 'utf8'));
    packageJson.version = this.version;
    fs.writeFileSync(CONFIG.PACKAGE_JSON, JSON.stringify(packageJson, null, 2));
    
    this.log(`Version updated to ${this.version}`);
  }

  async buildForPlatform(platform) {
    this.log(`Building for ${platform}...`);
    
    try {
      const buildCommand = `npm run build-${platform}`;
      execSync(buildCommand, { stdio: 'inherit' });
      
      // Find the built file
      const builtFile = this.findBuiltFile(platform);
      if (builtFile) {
        this.builtFiles[platform] = builtFile;
        this.log(`✅ Built ${platform}: ${builtFile}`);
      } else {
        throw new Error(`Could not find built file for ${platform}`);
      }
    } catch (error) {
      this.error(`Failed to build ${platform}: ${error.message}`);
      throw error;
    }
  }

  findBuiltFile(platform) {
    const distDir = CONFIG.DIST_DIR;
    
    if (!fs.existsSync(distDir)) {
      return null;
    }
    
    const files = fs.readdirSync(distDir);
    
    // Platform-specific file patterns
    const patterns = {
      win: /.*Setup.*\.exe$/,
      mac: /.*\.dmg$/,
      linux: /.*\.AppImage$/
    };
    
    const pattern = patterns[platform];
    if (!pattern) return null;
    
    const matchingFile = files.find(file => pattern.test(file));
    return matchingFile ? path.join(distDir, matchingFile) : null;
  }

  async uploadToFlask() {
    this.log('Uploading files to Flask server...');
    
    try {
      const formData = new FormData();
      formData.append('version', this.version);
      
      // Upload each built file
      for (const [platform, filePath] of Object.entries(this.builtFiles)) {
        if (fs.existsSync(filePath)) {
          this.log(`Uploading ${platform} file: ${path.basename(filePath)}`);
          formData.append(`${platform}_file`, fs.createReadStream(filePath));
        }
      }
      
      const response = await axios.post(
        `${CONFIG.FLASK_URL}/admin/upload-release`,
        formData,
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.FLASK_ADMIN_TOKEN}`,
            ...formData.getHeaders()
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 300000 // 5 minutes
        }
      );
      
      this.log('✅ Upload successful!');
      this.log(`Server response: ${JSON.stringify(response.data, null, 2)}`);
      
    } catch (error) {
      this.error(`Upload failed: ${error.message}`);
      if (error.response) {
        this.error(`Server response: ${JSON.stringify(error.response.data, null, 2)}`);
      }
      throw error;
    }
  }

  async generateUpdateInfo() {
    this.log('Generating update information...');
    
    const updateInfo = {
      version: this.version,
      releaseDate: new Date().toISOString(),
      files: {},
      releaseNotes: `Version ${this.version} - Latest improvements and bug fixes`
    };
    
    // Add file information
    for (const [platform, filePath] of Object.entries(this.builtFiles)) {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        updateInfo.files[platform] = {
          filename: path.basename(filePath),
          size: stats.size,
          url: `${CONFIG.FLASK_URL}/downloads/${platform}/latest`
        };
      }
    }
    
    // Save update info locally
    const updateInfoPath = path.join(__dirname, 'update-info.json');
    fs.writeFileSync(updateInfoPath, JSON.stringify(updateInfo, null, 2));
    
    this.log(`Update info saved to: ${updateInfoPath}`);
    return updateInfo;
  }

  async build() {
    try {
      this.log(`🚀 Starting build process for version ${this.version}`);
      
      // Clean dist directory
      if (fs.existsSync(CONFIG.DIST_DIR)) {
        this.log('Cleaning dist directory...');
        fs.rmSync(CONFIG.DIST_DIR, { recursive: true, force: true });
      }
      
      // Update version
      await this.updateVersion();
      
      // Install dependencies
      this.log('Installing dependencies...');
      execSync('npm ci', { stdio: 'inherit' });
      
      // Build for all platforms
      const platforms = ['win', 'mac', 'linux'];
      
      for (const platform of platforms) {
        await this.buildForPlatform(platform);
      }
      
      // Generate update information
      const updateInfo = await this.generateUpdateInfo();
      
      // Upload to Flask server
      await this.uploadToFlask();
      
      this.log('🎉 Build and upload completed successfully!');
      this.log(`✅ Version ${this.version} is now available for download`);
      this.log(`📦 Download page: ${CONFIG.FLASK_URL}/downloads`);
      
      return updateInfo;
      
    } catch (error) {
      this.error(`Build failed: ${error.message}`);
      process.exit(1);
    }
  }
}

// Run if called directly
if (require.main === module) {
  const builder = new Builder();
  builder.build();
}

module.exports = Builder;



