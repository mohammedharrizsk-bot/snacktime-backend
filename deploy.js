// =====================================================================
//  SNACK TIME — Instant Deployment & Auto-Update Bumper Script
//  Usage: node deploy.js
// =====================================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = __dirname;
const buildId = Date.now();
const newVersion = `1.0.8.${buildId}`;

console.log(`🚀 Starting SNACK TIME Instant Deployment (Build v${newVersion})...`);

// 1. Update sw-v2.js
const swPath = path.join(rootDir, 'sw-v2.js');
let swCode = fs.readFileSync(swPath, 'utf8');
swCode = swCode.replace(/const APP_VERSION = ['"][^'"]+['"];/, `const APP_VERSION = '${newVersion}';`);
fs.writeFileSync(swPath, swCode);
console.log(` ✅ Updated sw-v2.js → v${newVersion}`);

// 2. Update app.js
const appPath = path.join(rootDir, 'app.js');
let appCode = fs.readFileSync(appPath, 'utf8');
appCode = appCode.replace(/const APP_VERSION = ['"][^'"]+['"];/, `const APP_VERSION = '${newVersion}';`);
fs.writeFileSync(appPath, appCode);
console.log(` ✅ Updated app.js → v${newVersion}`);

// 3. Update index.html
const htmlPath = path.join(rootDir, 'index.html');
let htmlCode = fs.readFileSync(htmlPath, 'utf8');
htmlCode = htmlCode.replace(/window\.SNACKTIME_VERSION = ['"][^'"]+['"];/, `window.SNACKTIME_VERSION = '${newVersion}';`);
htmlCode = htmlCode.replace(/app\.js\?v=\d+/, `app.js?v=${buildId}`);
htmlCode = htmlCode.replace(/styles\.css\?v=\d+/, `styles.css?v=${buildId}`);
htmlCode = htmlCode.replace(/translations\.js\?v=\d+/, `translations.js?v=${buildId}`);
fs.writeFileSync(htmlPath, htmlCode);
console.log(` ✅ Updated index.html → v${newVersion} & asset query params v=${buildId}`);

// 4. Run Firebase Deployment
console.log(`📡 Deploying to Firebase Hosting live CDN...`);
try {
  execSync('npx firebase-tools deploy --only hosting', { stdio: 'inherit', cwd: rootDir });
  console.log(`\n🎉 DEPLOYMENT COMPLETE! All live browsers & installed PWAs will auto-reload to v${newVersion} within 15 seconds!`);
} catch (err) {
  console.error('❌ Firebase deploy error:', err.message);
  process.exit(1);
}
