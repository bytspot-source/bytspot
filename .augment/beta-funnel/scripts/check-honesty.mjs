#!/usr/bin/env node
/**
 * Guardrail: the marketing site must not ship fake scarcity, invented
 * live venue stats, or outdated "coming soon to iOS & Android" claims.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const TARGETS = ['src', 'index.html', 'public'];

const FORBIDDEN = [
  { re: /getSpotsLeft/i, why: 'fake shrinking early-access counter' },
  { re: /only\s+\d+\s+early access spots left/i, why: 'fake scarcity' },
  { re: /300\+/, why: 'invented waitlist count' },
  { re: /parking credit/i, why: 'unverified promotional claim' },
  { re: /first 100 midtown/i, why: 'unverified promotional claim' },
  { re: /coming to ios\s*&\s*android/i, why: 'app is already on the iOS App Store; Android is not claimed' },
  { re: /\b42\s+spots\b/i, why: 'invented parking count on the old mock card' },
  { re: /6\s*min\s+uber/i, why: 'invented ride ETA on the old mock card' },
  { re: /inner circle/i, why: 'old hype copy' },
  { re: /know before you go/i, why: 'retired headline' },
  { re: /live crowds\b/i, why: 'do not claim live crowds on the marketing site' },
  { re: /live crowd levels/i, why: 'do not claim live crowd levels on the marketing site' },
  { re: /bytspot-beta\.onrender\.com/i, why: 'old web-app CTA; product is the iOS app' },
];

const IGNORE_DIR = new Set(['node_modules', 'dist', '.git']);
const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.html', '.css', '.svg', '.md', '.json']);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIR.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (EXT.has(extname(name)) || name === 'index.html') acc.push(p);
  }
  return acc;
}

let files = [];
for (const t of TARGETS) {
  const p = join(ROOT, t);
  try {
    if (statSync(p).isDirectory()) walk(p, files);
    else files.push(p);
  } catch {
    // missing optional path
  }
}

let failed = false;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const { re, why } of FORBIDDEN) {
    if (re.test(text)) {
      failed = true;
      console.error(`Honesty check failed in ${file.replace(ROOT, '')}: ${why}  (${re})`);
    }
  }
}

if (failed) {
  process.exit(1);
}
console.log(`Honesty check passed (${files.length} files).`);
