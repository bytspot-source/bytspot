// Search for trackEvent in App.tsx
const fs = require('fs');
const content = fs.readFileSync('./App.tsx', 'utf8');
const lines = content.split('\n');

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('trackEvent')) {
    console.log(`Line ${i + 1}: ${lines[i]}`);
  }
}