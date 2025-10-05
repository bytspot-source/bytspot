#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'tokens.json');
const outWebCss = path.join(__dirname, 'dist', 'tokens.css');
const outWebTs = path.join(__dirname, 'dist', 'tokens.ts');
const outMobile = path.join(__dirname, 'dist', 'tokens.native.json');

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const tokens = JSON.parse(fs.readFileSync(src, 'utf-8'));

function cssVars(tokens) {
  const lines = [':root {'];
  for (const [k, v] of Object.entries(tokens.color || {})) lines.push(`  --color-${k}: ${v};`);
  for (const [k, v] of Object.entries(tokens.radius || {})) lines.push(`  --radius-${k}: ${v}px;`);
  for (const [k, v] of Object.entries(tokens.space || {})) lines.push(`  --space-${k}: ${v}px;`);
  for (const [k, v] of Object.entries((tokens.font||{}).size || {})) lines.push(`  --font-size-${k}: ${v}px;`);
  // Component tokens → CSS variables
  if (tokens.components) {
    const b = tokens.components.button || {};
    if (b.primary) {
      lines.push(`  --button-primary-bg: ${b.primary.bg};`);
      lines.push(`  --button-primary-fg: ${b.primary.fg};`);
      lines.push(`  --button-primary-border: ${b.primary.border};`);
    }
    if (b.ghost) {
      lines.push(`  --button-ghost-bg: ${b.ghost.bg};`);
      lines.push(`  --button-ghost-fg: ${b.ghost.fg};`);
      lines.push(`  --button-ghost-border: ${b.ghost.border};`);
    }
    const i = tokens.components.input || {};
    if (Object.keys(i).length) {
      lines.push(`  --input-bg: ${i.bg};`);
      lines.push(`  --input-fg: ${i.fg};`);
      lines.push(`  --input-border: ${i.border};`);
      lines.push(`  --input-placeholder: ${i.placeholder};`);
    }
  }
  lines.push('}');
  return lines.join('\n');
}

function tsExport(tokens) {
  return `export const tokens = ${JSON.stringify(tokens, null, 2)} as const;`;
}

fs.writeFileSync(outWebCss, cssVars(tokens));
fs.writeFileSync(outWebTs, tsExport(tokens));
fs.writeFileSync(outMobile, JSON.stringify(tokens, null, 2));
console.log('design tokens built');

