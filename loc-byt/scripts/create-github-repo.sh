#!/bin/bash
set -e

echo "🚀 Creating Bytspot GitHub Repository"

# Check if we're in a git repo
if [ ! -d ".git" ]; then
  echo "📝 Initializing git repository..."
  git init
  git branch -M main
fi

# Create .gitignore if it doesn't exist
if [ ! -f ".gitignore" ]; then
  echo "📄 Creating .gitignore..."
  cat > .gitignore << 'EOF'
# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Build outputs
dist/
build/
*.tsbuildinfo

# Environment variables
.env
.env.local
.env.production
.env.staging

# OS generated files
.DS_Store
.DS_Store?
._*
.Spotlight-V100
.Trashes
ehthumbs.db
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
*.swo

# Logs
logs/
*.log

# Go
*.exe
*.exe~
*.dll
*.so
*.dylib
*.test
*.out
go.work

# Mobile
apps/mobile/.expo/
apps/mobile/dist/
apps/mobile/web-build/

# Temporary files
*.tmp
*.temp
EOF
fi

# Add all files
echo "📦 Adding files to git..."
git add .

# Initial commit
echo "💾 Creating initial commit..."
git commit -m "feat: initial Bytspot project setup

- Add mobile app with Expo/React Native
- Add backend services (auth, venue, gateway)
- Add deployment configuration for Render
- Add development and production environments" || echo "No changes to commit"

# Create GitHub repo (you'll need to install GitHub CLI: brew install gh)
echo "🌐 Creating GitHub repository..."
if command -v gh &> /dev/null; then
  gh repo create bytspot --public --description "Bytspot Location Discovery App - Find amazing venues and experiences" --push
  echo "✅ Repository created: https://github.com/$(gh api user --jq .login)/bytspot"
else
  echo "⚠️  GitHub CLI not found. Manual steps:"
  echo "1. Go to https://github.com/new"
  echo "2. Repository name: bytspot"
  echo "3. Description: Bytspot Location Discovery App"
  echo "4. Make it Public"
  echo "5. Click 'Create repository'"
  echo "6. Run these commands:"
  echo "   git remote add origin https://github.com/YOUR_USERNAME/bytspot.git"
  echo "   git push -u origin main"
fi