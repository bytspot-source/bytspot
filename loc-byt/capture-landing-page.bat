@echo off
echo.
echo 🎭 Bytspot Landing Page Screenshot Capture
echo ==========================================
echo.

cd /d "%~dp0"

echo 📦 Installing dependencies...
call npm install

echo.
echo 🎭 Installing Playwright browsers...
call npx playwright install chromium

echo.
echo 🚀 Capturing landing page screenshots...
echo This will start the dev server and take screenshots automatically.
echo.

call npx playwright test tests/landing-page.spec.js --project=chromium

echo.
echo ✅ Screenshot capture complete!
echo 📂 Check the 'screenshots' folder to see your landing page images.
echo.

pause
