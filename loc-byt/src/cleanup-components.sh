#!/bin/bash
# Bytspot Component Cleanup Script
# Run this script to clean up unused SwipeInterface variants and optimize the project

echo "🧹 Bytspot Component Cleanup Script"
echo "==================================="

# Create backup directory
mkdir -p .backup/components
echo "📁 Created backup directory"

# Backup components before cleanup
echo "💾 Backing up components..."
cp components/SwipeInterface.tsx .backup/components/ 2>/dev/null || echo "SwipeInterface.tsx not found"
cp components/SwipeInterfaceEnhanced.tsx .backup/components/ 2>/dev/null || echo "SwipeInterfaceEnhanced.tsx not found"
cp components/SwipeInterfaceTemp.tsx .backup/components/ 2>/dev/null || echo "SwipeInterfaceTemp.tsx not found"
cp components/SwipeInterface_fixed.tsx .backup/components/ 2>/dev/null || echo "SwipeInterface_fixed.tsx not found"
cp components/SwipeInterfaceFixed_backup.tsx .backup/components/ 2>/dev/null || echo "SwipeInterfaceFixed_backup.tsx not found"

echo "🗑️  Cleaning up unused SwipeInterface variants..."

# Remove unused SwipeInterface variants (keep SwipeInterfaceFixed.tsx)
rm -f components/SwipeInterface.tsx
rm -f components/SwipeInterfaceEnhanced.tsx  
rm -f components/SwipeInterfaceTemp.tsx
rm -f components/SwipeInterface_fixed.tsx
rm -f components/SwipeInterfaceFixed_backup.tsx

echo "✅ Cleanup completed!"
echo ""
echo "📊 Summary:"
echo "- Kept: SwipeInterfaceFixed.tsx (main implementation)"
echo "- Removed: 5 unused SwipeInterface variants"
echo "- Backup location: .backup/components/"
echo ""
echo "🎯 Next steps:"
echo "1. Test the app to ensure SwipeInterfaceFixed works correctly"
echo "2. If issues occur, restore from .backup/components/"
echo "3. Consider adding service worker for offline support"
echo "4. Implement lazy loading for better performance"
echo ""
echo "💡 Your Bytspot app is now optimized and ready for production!"