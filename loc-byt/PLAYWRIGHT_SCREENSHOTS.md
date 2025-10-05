# 🎭 Bytspot Landing Page Screenshot Capture

This guide will help you capture screenshots of your Bytspot landing page using Playwright automation.

## 🚀 Quick Start

### Option 1: Windows Batch Script (Easiest)
```bash
# Double-click or run from command prompt
capture-landing-page.bat
```

### Option 2: Manual Commands
```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Run screenshot tests
npm run test:screenshots
```

### Option 3: Node.js Script
```bash
# Run the capture script
node scripts/capture-landing-page.js
```

## 📸 What Gets Captured

The Playwright tests will automatically capture:

1. **Full Landing Page** - Complete page screenshot
2. **Weather Bar** - Live weather information bar
3. **Navigation** - Header with Bytspot logo and buttons
4. **Hero Section** - Main title and search bar
5. **Statistics** - 50K+ users, 1.2M+ spots, 4.9★ rating
6. **Features** - Smart Parking, Venue Discovery, Premium Services cards
7. **Call-to-Action** - "Start Matching" button
8. **Footer** - Copyright and legal links
9. **Mobile View** - Responsive mobile layout
10. **Tablet View** - Responsive tablet layout
11. **Interactive States** - Hover effects and interactions

## 📂 Screenshot Locations

All screenshots are saved to: `./screenshots/`

### Generated Files:
- `landing-page-full.png` - Complete landing page
- `weather-bar.png` - Weather information bar
- `navigation.png` - Header navigation
- `hero-section.png` - Main hero content
- `statistics.png` - User statistics section
- `features.png` - Feature cards
- `cta-section.png` - Call-to-action button
- `footer.png` - Footer section
- `landing-page-mobile.png` - Mobile responsive view
- `landing-page-tablet.png` - Tablet responsive view
- `*-hover.png` - Various hover state screenshots

## 🔧 How It Works

1. **Starts Dev Server**: Automatically launches Vite dev server on port 5173
2. **Waits for Ready**: Ensures the server is fully loaded
3. **Navigates to Page**: Opens the landing page in a headless browser
4. **Captures Screenshots**: Takes screenshots of different sections
5. **Tests Interactions**: Captures hover states and interactions
6. **Saves Results**: All images saved to screenshots folder

## 🎯 Test Coverage

The Playwright tests verify:
- ✅ All landing page elements are visible
- ✅ Weather bar displays correctly
- ✅ Navigation works properly
- ✅ Search functionality is present
- ✅ Statistics are displayed
- ✅ Feature cards are rendered
- ✅ CTA button is functional
- ✅ Footer is complete
- ✅ Responsive design works
- ✅ Interactive elements respond to hover
- ✅ Dark theme is consistent

## 🐛 Troubleshooting

### Common Issues:

**Port 5173 already in use:**
```bash
# Kill any existing Vite processes
taskkill /f /im node.exe
# Or use a different port in vite.config.ts
```

**Playwright not installed:**
```bash
npm install @playwright/test
npx playwright install
```

**Screenshots folder not created:**
- The script automatically creates the folder
- Check file permissions in your project directory

**Tests failing:**
- Ensure your landing page component has no syntax errors
- Check that all imports are correct
- Verify the LandingPage component is properly exported

## 🎨 Viewing Results

After running the tests:

1. Open the `screenshots` folder
2. View the PNG files to see your landing page
3. Check different viewport sizes (desktop, tablet, mobile)
4. Review interactive states (hover effects)

## 🔄 Re-running Tests

To capture fresh screenshots:
```bash
# Delete old screenshots
rm -rf screenshots/

# Run tests again
npm run test:screenshots
```

## 📊 Advanced Usage

### Run specific tests:
```bash
# Only capture full page
npx playwright test -g "should display the complete landing page"

# Only capture mobile view
npx playwright test -g "should test responsive design on mobile"

# Run with UI (visual test runner)
npm run test:e2e:ui
```

### Different browsers:
```bash
# Firefox
npx playwright test --project=firefox

# Safari (WebKit)
npx playwright test --project=webkit

# All browsers
npx playwright test
```

## 🎉 Success!

Once complete, you'll have professional screenshots of your Bytspot landing page showing:
- Beautiful dark theme design
- Responsive layouts
- Interactive elements
- Complete user interface
- Professional presentation ready for demos or documentation

Your landing page screenshots are now ready to showcase the amazing Bytspot experience! 🚀
