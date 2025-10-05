#!/usr/bin/env node
/**
 * Fetch Figma variables via API.
 * Env: FIGMA_TOKEN, FIGMA_FILE_KEY (from your Figma URL)
 * Writes packages/design-tokens/figma-export.json
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = process.env.FIGMA_TOKEN;
const FILE_KEY = process.env.FIGMA_FILE_KEY;
if (!TOKEN || !FILE_KEY) {
  console.error('Set FIGMA_TOKEN and FIGMA_FILE_KEY env vars');
  process.exit(1);
}

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const url = `https://api.figma.com/v1/files/${FILE_KEY}/variables`;
  const headers = { 'X-Figma-Token': TOKEN };
  const json = await fetchJson(url, headers);
  const out = path.join(__dirname, 'figma-export.json');
  fs.writeFileSync(out, JSON.stringify(json, null, 2));
  console.log('Saved', out);
})();

