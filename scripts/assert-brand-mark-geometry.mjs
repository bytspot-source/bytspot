import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Brand mark drift gate: geometry and colour.
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

const COL = contract.colours;
// Roles are resolved by which element references a gradient, not by its id: the
// funnel banners name theirs a/b/c/d and the print sheet pl-outer/pl-mid/etc.
function gradientRoles(src) {
  const roles = {};
  for (const el of src.match(/<(?:circle|path)\b[^>]*?\/?>/gs) ?? []) {
    const fill = el.match(/fill="url\(#([^)]+)\)"/);
    const stroke = el.match(/stroke="url\(#([^)]+)\)"/);
    const r = el.match(/\br="([\d.]+)"/);
    const d = el.match(/\bd="([^"]+)"/);
    if (r) {
      const radius = Number(r[1]);
      if (stroke && radius === G.outerRingRadius) roles[stroke[1]] = 'outerRing';
      if (stroke && radius === G.middleRingRadius) roles[stroke[1]] = 'middleRing';
    }
    if (d && d[1].trim() === G.hexPath) {
      if (fill) roles[fill[1]] = 'hexFill';
      if (stroke) roles[stroke[1]] = 'hexBorder';
    }
  }
  return roles;
}

function checkColours(surface, src) {
  const roles = gradientRoles(src);
  for (const role of ['outerRing', 'middleRing', 'hexFill', 'hexBorder']) {
    const ids = Object.entries(roles).filter(([, r]) => r === role).map(([id]) => id);
    if (!ids.length) { fail(surface, `no gradient resolves to ${role}`); continue; }
    for (const id of ids) {
      const block = src.match(new RegExp(`<(?:linear|radial)Gradient[^>]*id="${id}"[^>]*>(.*?)</(?:linear|radial)Gradient>`, 's'));
      if (!block) { fail(surface, `gradient "${id}" (${role}) has no definition`); continue; }
      const stops = [...block[1].matchAll(/(?:stop-color|stopColor)="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase());
      const wrong = stops.filter((c) => c !== COL[role].toUpperCase());
      // The icon's rings and gem are flat; a second colour is the gradient drift.
      if (wrong.length) fail(surface, `${role} carries ${[...new Set(wrong)].join(', ')}, canonical is flat ${COL[role]}`);
    }
  }
}

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
  checkColours(surface, src);
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
// Flat gradients in Swift too: one token, repeated.
  for (const [name, token] of Object.entries(COL.swiftTokens)) {
    const block = mark.match(new RegExp(`private var ${name}Gradient[^{]*\\{([^}]*)\\}`, 's'));
    if (!block) { fail(surface, `could not read ${name}Gradient`); continue; }
    const used = [...new Set([...block[1].matchAll(/NativeLaunchTheme\.(\w+)/g)].map((m) => m[1]))];
    if (used.length !== 1 || used[0] !== token) {
      fail(surface, `${name}Gradient uses ${used.join(', ') || 'no theme colour'}, canonical is flat ${token}`);
    }
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

// The app icon is the design of record. Nothing verified it, and the icons
// derived from it had gone stale: icon-192 -- the home-screen and notification
// icon -- was a blank purple square, and icon-512, the schema.org logo, an
// unrelated graphic. Pinned by hash and PNG header, so the gate needs no image
// library; regenerating the app icon fails here until the derived set follows.
function checkIcons(repoLabel, root) {
  const I = contract.icons;
  let n = 0;
  for (const [role, entry] of [['source', I.source], ...I.derived.map((d) => ['derived', d])]) {
    const surface = `${repoLabel}/${entry.path}`;
    const full = path.join(root, entry.path);
    n += 1;
    if (!fs.existsSync(full)) { fail(surface, `${role} icon listed in the contract does not exist`); continue; }
    const buf = fs.readFileSync(full);
    if (buf.length < 24 || buf.subarray(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') {
      fail(surface, 'not a PNG'); continue;
    }
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width !== entry.width || height !== entry.height) {
      fail(surface, `is ${width}x${height}, canonical is ${entry.width}x${entry.height}`);
    }
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== entry.sha256) {
      fail(surface, role === 'source'
        ? `app icon changed (${sha.slice(0, 12)}); it is the design of record, so regenerate the derived icons and re-pin all three: ${I.regenerate}`
        : `does not match the icon of record (${sha.slice(0, 12)}); regenerate from the app icon: ${I.regenerate}`);
    }
  }
  return n;
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
  checked += checkIcons('bytspot-beta', sibling);
} else {
  notes.push(`SKIPPED ${contract.surfaces['bytspot-beta'].length} surfaces in the authoring repo: no checkout at ${sibling} (set BYTSPOT_BETA_REPO). That repo gates them, and the app icon, itself.`);
}

for (const note of notes) console.log(note);
if (failures.length) {
  console.error('Brand mark drift:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`Brand mark consistent across ${checked} surfaces and icons (geometry, colour, icon of record).`);
