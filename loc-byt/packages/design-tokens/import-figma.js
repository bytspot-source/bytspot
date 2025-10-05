#!/usr/bin/env node
/**
 * Minimal importer for Figma variables/tokens export -> tokens.json schema
 * Usage: node packages/design-tokens/import-figma.js path/to/figma-export.json
 */
const fs = require('fs');
const path = require('path');

const input = process.argv[2];
if (!input) {
  console.error('Usage: node packages/design-tokens/import-figma.js path/to/figma-export.json');
  process.exit(1);
}

// Very flexible: accept either Tokens Studio export or a simple key/value map.
function loadFigmaExport(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  // If it's a flat map of { tokenName: value }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !raw.collections) return raw;
  // If it's a Figma Variables export (collections/modes/variables)
  if (raw && raw.collections && raw.variables) {
    const result = {};
    for (const [, v] of Object.entries(raw.variables)) {
      const name = (v.name || '').replace(/\s+/g, '').toLowerCase();
      let value = v.valuesByMode ? Object.values(v.valuesByMode)[0] : v.value;
      result[name] = value;
    }
    return result;
  }
  return raw;
}

function toTokens(fig) {
  // Target schema w/ extended groups
  const tokens = {
    color: {}, radius: {}, space: {},
    shadow: {}, opacity: {}, duration: {}, zIndex: {},
    font: { size: {}, weight: {}, family: {}, lineHeight: {}, letterSpacing: {} },
    components: {}
  };
  const assign = (obj, key, val) => { obj[key] = val; };

  for (const [k, v] of Object.entries(fig)) {
    const val = typeof v === 'string' ? v : v?.value ?? v;
    if (k.startsWith('color.')) assign(tokens.color, k.substring(6), val);
    else if (k.startsWith('radius.')) assign(tokens.radius, k.substring(7), Number(val));
    else if (k.startsWith('space.')) assign(tokens.space, k.substring(6), Number(val));
    else if (k.startsWith('shadow.')) assign(tokens.shadow, k.substring(7), val);
    else if (k.startsWith('opacity.')) assign(tokens.opacity, k.substring(8), Number(val));
    else if (k.startsWith('duration.')) assign(tokens.duration, k.substring(9), String(val));
    else if (k.startsWith('zindex.') || k.startsWith('z-index.')) assign(tokens.zIndex, k.replace(/^zindex\.|z-index\./, ''), Number(val));
    else if (k.startsWith('font.size.')) assign(tokens.font.size, k.substring(10), Number(val));
    else if (k.startsWith('font.weight.')) assign(tokens.font.weight, k.substring(12), Number(val));
    else if (k.startsWith('font.family.')) assign(tokens.font.family, k.substring(12), String(val));
    else if (k.startsWith('font.lineheight.')) assign(tokens.font.lineHeight, k.substring(16), Number(val));
    else if (k.startsWith('font.letterspacing.')) assign(tokens.font.letterSpacing, k.substring(19), Number(val));
    else if (k.startsWith('component.')) {
      const path = k.substring(10).split('.');
      let cur = tokens.components;
      while (path.length > 1) {
        const p = path.shift();
        cur[p] = cur[p] || {};
        cur = cur[p];
      }
      cur[path[0]] = val;
    }
  }
  return tokens;
}

const fig = loadFigmaExport(path.resolve(input));
const tokens = toTokens(fig);
const out = path.join(__dirname, 'tokens.json');
fs.writeFileSync(out, JSON.stringify(tokens, null, 2));
console.log('Updated tokens.json from', input);

