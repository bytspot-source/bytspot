#!/usr/bin/env node
/**
 * Fails CI on any high or critical advisory in the runtime dependency tree,
 * except the ones named below.
 *
 * An exception is a dated promise, not a mute button: past its `until` date
 * the gate fails on the exception itself, so a deferral cannot quietly become
 * permanent. Anything not listed here fails immediately.
 */
import { execFileSync } from 'node:child_process';

const ACCEPTED = [
  // deepmerge-ts and effect (via prisma -> @prisma/config) were accepted here
  // until 2026-12-01. package.json `overrides` now pins them to fixed
  // versions, so nothing is accepted.
];

const BLOCKING = new Set(['high', 'critical']);

function runAudit() {
  try {
    return execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // npm audit exits non-zero when it finds anything; the report is still on stdout.
    if (err.stdout) return err.stdout;
    throw err;
  }
}

const report = JSON.parse(runAudit());
const accepted = new Map(ACCEPTED.map((entry) => [entry.source, entry]));
const today = new Date().toISOString().slice(0, 10);

const expired = ACCEPTED.filter((entry) => entry.until < today);
const unexpected = [];
const waived = [];

for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    if (typeof via !== 'object' || !BLOCKING.has(via.severity)) continue;
    const entry = accepted.get(via.source);
    if (entry) waived.push(`${via.severity} ${via.name} (${entry.advisory}) — accepted until ${entry.until}`);
    else unexpected.push(`${via.severity} ${via.name} — ${via.url ?? via.source}\n    ${via.title ?? ''}`);
  }
}

const unique = (lines) => [...new Set(lines)];

for (const line of unique(waived)) console.log(`accepted: ${line}`);

if (expired.length) {
  console.error('\nAccepted exceptions have expired and must be fixed or explicitly re-dated:');
  for (const entry of expired) console.error(`  ${entry.name} (${entry.advisory}) expired ${entry.until} — ${entry.reason}`);
}

if (unexpected.length) {
  console.error('\nUnaccepted high/critical advisories in runtime dependencies:');
  for (const line of unique(unexpected)) console.error(`  ${line}`);
}

if (expired.length || unexpected.length) process.exit(1);

console.log(`\nNo unaccepted high/critical runtime advisories (${unique(waived).length} accepted).`);
