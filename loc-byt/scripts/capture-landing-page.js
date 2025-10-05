#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🎭 Bytspot Landing Page Screenshot Capture');
console.log('==========================================\n');

// Create screenshots directory if it doesn't exist
const screenshotsDir = path.join(__dirname, '..', 'screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  console.log('📁 Created screenshots directory');
}

try {
  console.log('🔧 Installing Playwright browsers...');
  execSync('npx playwright install chromium', { 
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });

  console.log('\n🚀 Starting development server and running tests...');
  console.log('This will:');
  console.log('  1. Start the Vite dev server');
  console.log('  2. Wait for the server to be ready');
  console.log('  3. Run Playwright tests to capture screenshots');
  console.log('  4. Save screenshots to ./screenshots/ directory\n');

  // Run the Playwright tests
  execSync('npx playwright test tests/landing-page.spec.js --project=chromium', { 
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });

  console.log('\n✅ Screenshots captured successfully!');
  console.log('\n📸 Generated screenshots:');
  
  // List all generated screenshots
  const screenshots = fs.readdirSync(screenshotsDir)
    .filter(file => file.endsWith('.png'))
    .sort();

  screenshots.forEach(screenshot => {
    console.log(`   📷 ${screenshot}`);
  });

  console.log(`\n🎯 Total screenshots: ${screenshots.length}`);
  console.log(`📂 Location: ${screenshotsDir}`);
  
  console.log('\n🌟 Landing page capture complete!');
  console.log('You can now view the screenshots to see how your Bytspot landing page looks.');

} catch (error) {
  console.error('\n❌ Error during screenshot capture:');
  console.error(error.message);
  
  console.log('\n🔧 Troubleshooting tips:');
  console.log('1. Make sure you have Node.js installed');
  console.log('2. Run "npm install" to install dependencies');
  console.log('3. Check that port 5173 is available');
  console.log('4. Ensure your landing page component has no syntax errors');
  
  process.exit(1);
}
