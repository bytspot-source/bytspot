import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Brand mark drift gate.
//
// The mark is drawn independently on nine surfaces across two repos because iOS
// cannot read the SVG -- asset-catalog rendering drops gradient fills in Release
// builds -- so a native reproduction is unavoidable and drift is structural. The
// four surfaces in this repo had already fallen a revision behind the favicon.
//
//   node scripts/assert-brand-mark-geometry.mjs
//   BYTSPOT_BETA_REPO=../bytspot-beta node scripts/assert-brand-mark-geometry.mjs
//
// Geometry is read from contracts/brand-mark-geometry.json, vendored
// byte-identically from bytspot-beta, where the mark is authored. When that repo
// is checked out alongside this one, its four surfaces and its copy of the
// contract are checked too; when it is not, they are reported as SKIPPED rather
// than silently passing.

const CONTRACT = 'contracts/brand-mark-geometry.json';
const contract = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'));
const G = contract.geometry;
const CENTRE = contract.viewBox / 2;
// The gem, its dot and its glow ride above the rings' centre; the rings do not.
const GEM_CENTRE_Y = G.concentric ? CENTRE : G.gemCentreY;
const GEM_OFFSET = CENTRE - GEM_CENTRE_Y;

const failures = [];
const notes = [];
const fail = (surface, detail) => failures.push(`${surface}: ${detail}`);

function hexBounds(hexPath) {
  const points = [...hexPath.matchAll(/([ML])(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)/g)].map((m) => [Number(m[2]), Number(m[3])]);
  if (points.length !== 6) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    centreX: (Math.max(...xs) + Math.min(...xs)) / 2,
    centreY: (Math.max(...ys) + Math.min(...ys)) / 2,
  };
}

function checkSvg(surface, file) {
  const src = fs.readFileSync(file, 'utf8');
  const paths = [...src.matchAll(/d="(M60[^"]+Z)"/g)].map((m) => m[1]);
  if (paths.length !== 2) {
    fail(surface, `expected 2 hexagon paths (fill + border), found ${paths.length}`);
    return;
  }
  for (const hexPath of paths) {
    if (hexPath !== G.hexPath) fail(surface, `hexagon path is "${hexPath}", canonical is "${G.hexPath}"`);
    const bounds = hexBounds(hexPath);
    if (!bounds) {
      fail(surface, `hexagon path is not six points: "${hexPath}"`);
      continue;
    }
    if (bounds.width !== G.hexWidth || bounds.height !== G.hexHeight) {
      fail(surface, `hexagon is ${bounds.width}x${bounds.height}, canonical is ${G.hexWidth}x${G.hexHeight}`);
    }
    if (bounds.centreX !== CENTRE || bounds.centreY !== GEM_CENTRE_Y) {
      fail(surface, `hexagon centre is (${bounds.centreX}, ${bounds.centreY}), canonical is (${CENTRE}, ${GEM_CENTRE_Y})`);
    }
  }
  // The dot and its glow ride with the gem, so they must be concentric too.
  for (const [name, radius] of [['dot', G.dotRadius], ['glow', G.glowRadius]]) {
    const match = src.match(new RegExp(`cx="60"\\s+cy="(\\d+)"\\s+r="${radius}"`));
    if (!match) fail(surface, `no r="${radius}" ${name} circle at cx="60"`);
    else if (Number(match[1]) !== GEM_CENTRE_Y) fail(surface, `${name} is at cy="${match[1]}", canonical is cy="${GEM_CENTRE_Y}" with the gem`);
  }
  for (const [name, radius] of [['outer ring', G.outerRingRadius], ['middle ring', G.middleRingRadius]]) {
    if (!new RegExp(`r="${radius}"`).test(src)) fail(surface, `no ${name} at r="${radius}"`);
  }
}

function checkSwift(surface, file) {
  const src = fs.readFileSync(file, 'utf8');
  const mark = src.split('private struct NativeBytspotMark: View {')[1]?.split('\nprivate struct')[0];
  if (!mark) {
    fail(surface, 'NativeBytspotMark not found');
    return;
  }
  const read = (re) => {
    const m = mark.match(re);
    return m ? Number(m[1]) : null;
  };
  const expectations = [
    ['outer ring diameter', /outerRingGradient, lineWidth: size \* \(3\.0 \/ 120\.0\)\)\s*\n\s*\.frame\(width: size \* \(([\d.]+) \/ 120\.0\)/, G.outerRingRadius * 2],
    ['outer ring stroke', /outerRingGradient, lineWidth: size \* \(([\d.]+) \/ 120\.0\)/, G.outerRingStroke],
    ['middle ring diameter', /middleRingGradient, lineWidth: size \* \(2\.0 \/ 120\.0\)\)\s*\n\s*\.frame\(width: size \* \(([\d.]+) \/ 120\.0\)/, G.middleRingRadius * 2],
    ['middle ring stroke', /middleRingGradient, lineWidth: size \* \(([\d.]+) \/ 120\.0\)/, G.middleRingStroke],
    ['hexagon width', /Hexagon\(\)\.fill\(hexFillGradient\)\s*\n\s*\.frame\(width: size \* \(([\d.]+) \/ 120\.0\)/, G.hexWidth],
    ['hexagon height', /Hexagon\(\)\.fill\(hexFillGradient\)\s*\n\s*\.frame\(width: size \* \([\d.]+ \/ 120\.0\), height: size \* \(([\d.]+) \/ 120\.0\)/, G.hexHeight],
    ['hexagon border stroke', /hexBorderGradient, lineWidth: size \* \(([\d.]+) \/ 120\.0\)/, G.hexBorderStroke],
    ['dot diameter', /centerDotGradient\)\s*\n\s*\.frame\(width: size \* \(([\d.]+) \/ 120\.0\)/, G.dotRadius * 2],
    ['glow diameter', /centerGlowGradient\)\s*\n\s*\.frame\(width: size \* \(([\d.]+) \/ 120\.0\)/, G.glowRadius * 2],
  ];
  for (const [name, re, expected] of expectations) {
    const actual = read(re);
    if (actual === null) fail(surface, `could not read ${name}`);
    else if (actual !== expected) fail(surface, `${name} is ${actual}/120, canonical is ${expected}/120`);
  }
  const offsets = [...mark.matchAll(/\.offset\(y: (-?)size \* \(([\d.]+) \/ 120\.0\)\)/g)]
    .map((m) => (m[1] === '-' ? -Number(m[2]) : Number(m[2])));
  if (GEM_OFFSET === 0) {
    if (offsets.length) fail(surface, 'a mark layer carries a vertical offset; canonical geometry is concentric');
  } else {
    // Gem, glow and dot each carry it; a layer left behind is the drift to catch.
    if (offsets.length !== 3) fail(surface, `expected 3 offset gem layers (hexagon, glow, dot), found ${offsets.length}`);
    for (const actual of offsets) {
      if (actual !== -GEM_OFFSET) fail(surface, `gem layer offset is ${actual}/120, canonical is ${-GEM_OFFSET}/120`);
    }
  }
}

function checkSurfaces(repoLabel, root, surfaces) {
  for (const { file, kind } of surfaces) {
    const full = path.join(root, file);
    const surface = `${repoLabel}/${file}`;
    if (!fs.existsSync(full)) {
      fail(surface, 'surface listed in the contract does not exist');
      continue;
    }
    if (kind === 'swift') checkSwift(surface, full);
    else checkSvg(surface, full);
  }
  return surfaces.length;
}

let checked = checkSurfaces('bytspot', '.', contract.surfaces.bytspot);

// The authoring repo carries four more surfaces. Check them when co-checked-out.
const sibling = process.env.BYTSPOT_BETA_REPO ?? '../bytspot-beta';
if (fs.existsSync(path.join(sibling, CONTRACT))) {
  const local = crypto.createHash('sha256').update(fs.readFileSync(CONTRACT)).digest('hex');
  const remote = crypto.createHash('sha256').update(fs.readFileSync(path.join(sibling, CONTRACT))).digest('hex');
  if (local !== remote) {
    fail(`bytspot-beta/${CONTRACT}`, 'vendored contract differs from this repo\'s copy; the two gates would disagree about canonical geometry');
  }
  checked += checkSurfaces('bytspot-beta', sibling, contract.surfaces['bytspot-beta']);
} else {
  notes.push(`SKIPPED ${contract.surfaces['bytspot-beta'].length} surfaces in the authoring repo: no checkout at ${sibling} (set BYTSPOT_BETA_REPO). That repo gates them itself.`);
}

for (const note of notes) console.log(note);
if (failures.length) {
  console.error('Brand mark geometry drift:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`Brand mark geometry consistent across ${checked} surfaces.`);
