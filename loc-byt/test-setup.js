#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log('🔍 Bytspot Landing Page Setup Verification');
console.log('==========================================\n');

const checks = [
  {
    name: 'Landing Page Component',
    path: 'src/components/LandingPage.tsx',
    required: true
  },
  {
    name: 'App.tsx Integration',
    path: 'src/App.tsx',
    required: true
  },
  {
    name: 'Playwright Config',
    path: 'playwright.config.js',
    required: true
  },
  {
    name: 'Landing Page Tests',
    path: 'tests/landing-page.spec.js',
    required: true
  },
  {
    name: 'Screenshots Directory',
    path: 'screenshots',
    required: false
  },
  {
    name: 'Package.json',
    path: 'package.json',
    required: true
  },
  {
    name: 'Vite Config',
    path: 'vite.config.ts',
    required: true
  },
  {
    name: 'Index HTML',
    path: 'index.html',
    required: true
  }
];

let allGood = true;

console.log('📋 Checking required files...\n');

checks.forEach(check => {
  const fullPath = path.join(__dirname, check.path);
  const exists = fs.existsSync(fullPath);
  
  if (exists) {
    console.log(`✅ ${check.name}: Found`);
    
    // Additional checks for specific files
    if (check.path === 'src/components/LandingPage.tsx') {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('export function LandingPage')) {
        console.log('   ✅ LandingPage component properly exported');
      } else {
        console.log('   ⚠️  LandingPage export might be missing');
      }
      
      if (content.includes('Weather Bar') || content.includes('LIVE')) {
        console.log('   ✅ Weather bar implementation found');
      } else {
        console.log('   ⚠️  Weather bar implementation might be missing');
      }
    }
    
    if (check.path === 'src/App.tsx') {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('import { LandingPage }')) {
        console.log('   ✅ LandingPage imported in App.tsx');
      } else {
        console.log('   ⚠️  LandingPage import might be missing');
      }
      
      if (content.includes('<LandingPage')) {
        console.log('   ✅ LandingPage component used in App.tsx');
      } else {
        console.log('   ⚠️  LandingPage component usage might be missing');
      }
    }
    
    if (check.path === 'package.json') {
      const content = fs.readFileSync(fullPath, 'utf8');
      const packageJson = JSON.parse(content);
      
      if (packageJson.devDependencies && packageJson.devDependencies['@playwright/test']) {
        console.log('   ✅ Playwright dependency found');
      } else {
        console.log('   ⚠️  Playwright dependency missing');
        allGood = false;
      }
      
      if (packageJson.scripts && packageJson.scripts['test:screenshots']) {
        console.log('   ✅ Screenshot test script found');
      } else {
        console.log('   ⚠️  Screenshot test script missing');
      }
    }
    
  } else {
    const status = check.required ? '❌' : '⚠️ ';
    console.log(`${status} ${check.name}: Missing`);
    if (check.required) {
      allGood = false;
    }
  }
  console.log('');
});

console.log('🎯 Setup Summary');
console.log('================\n');

if (allGood) {
  console.log('✅ All required files are present!');
  console.log('🚀 You can now run the screenshot capture:');
  console.log('');
  console.log('   Windows: capture-landing-page.bat');
  console.log('   Or: npm run test:screenshots');
  console.log('   Or: node scripts/capture-landing-page.js');
  console.log('');
  console.log('📸 Screenshots will be saved to ./screenshots/');
  console.log('');
  console.log('🎉 Ready to capture your Bytspot landing page!');
} else {
  console.log('❌ Some required files are missing.');
  console.log('📋 Please ensure all files are created before running tests.');
  console.log('');
  console.log('🔧 Next steps:');
  console.log('1. Install dependencies: npm install');
  console.log('2. Install Playwright: npx playwright install');
  console.log('3. Run setup verification again: node test-setup.js');
}

console.log('\n' + '='.repeat(50));
