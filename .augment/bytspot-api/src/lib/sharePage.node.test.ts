import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  APP_STORE_ID,
  APP_STORE_URL,
  appStoreCta,
  escapeHtml,
  isInAppBrowserUA,
  openInBytspotCta,
  renderSharePage,
  renderShareShell,
  shareClient,
  shareFootnote,
} from './sharePage';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0.0.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36';

test('escapeHtml encodes the characters that could break out of HTML or attributes', () => {
  assert.equal(escapeHtml(`<script>alert("1")</script> & 'x'`), '&lt;script&gt;alert(&quot;1&quot;)&lt;/script&gt; &amp; &#39;x&#39;');
});

test('shareClient classifies in-app browsers, iOS, Android and desktop, and treats a missing UA as iOS', () => {
  assert.equal(shareClient('Mozilla/5.0 Instagram 300.0'), 'in-app-browser');
  assert.equal(shareClient('Mozilla/5.0 (iPhone) Snapchat/12.0.0.0'), 'in-app-browser');
  assert.equal(isInAppBrowserUA('Mozilla/5.0 (iPhone) Snapchat/12.0.0.0'), true);
  assert.equal(shareClient(IPHONE), 'ios');
  assert.equal(shareClient(ANDROID), 'android');
  assert.equal(shareClient(DESKTOP), 'other');
  assert.equal(shareClient(undefined), 'ios');
  assert.equal(shareClient(''), 'ios');
});

test('Footnotes are honest: in-app browsers get a Safari hint, Android and desktop hear that Bytspot is on iPhone', () => {
  assert.match(shareFootnote('in-app-browser', 'party'), /Open in Safari/);
  assert.equal(shareFootnote('android', 'plan'), 'Bytspot is on iPhone for now. The details on this page are still right.');
  assert.equal(shareFootnote('other', 'sale'), 'Bytspot is on iPhone for now. The details on this page are still right.');
  assert.doesNotMatch(shareFootnote('android', 'plan'), /coming soon|Android date/i);
  assert.match(shareFootnote('ios', 'plan-token'), /reopen this invite to take your seat/);
});

test('renderSharePage escapes a hostile title, keeps the page script-free, and never mentions a second-domain hand-off', () => {
  const html = renderSharePage({
    documentTitle: '</title><script>alert(1)</script>',
    description: 'hello "world"',
    shareUrl: 'https://bytspot.app/plan/p-1?t=abc',
    heading: '<img src=x onerror=alert(1)>',
    kicker: '<b>kicker</b>',
    bodyHtml: '<p class="note">Safe body</p>',
    ctas: [openInBytspotCta('https://bytspot.app/plan/p-1?t=abc'), appStoreCta()],
    footnote: 'Get Bytspot, then reopen this invite to take your seat.',
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;b&gt;kicker&lt;\/b&gt;/);
  assert.match(html, /content="hello &quot;world&quot;"/);
  assert.match(html, /apple-itunes-app" content="app-id=6761876421, app-argument=https:\/\/bytspot\.app\/plan\/p-1\?t=abc"/);
  assert.equal(APP_STORE_ID, '6761876421');
  assert.match(APP_STORE_URL, /id6761876421/);
  assert.doesNotMatch(html, /app-clip-bundle-id|appclip\.apple\.com|App Clip/i);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /Open in Bytspot/);
  assert.match(html, /Get Bytspot on the App Store/);
});

test('A closed-link shell is noindex, has a way forward, and does not carry a share URL into the banner', () => {
  const html = renderShareShell(
    "This plan invite isn't available",
    'The link may have expired, been cancelled, or the plan may have ended.',
    { ctas: [appStoreCta()] },
  );
  assert.match(html, /name="robots" content="noindex"/);
  assert.match(html, /isn&#39;t available/);
  assert.match(html, /Get Bytspot on the App Store/);
  assert.doesNotMatch(html, /apple-itunes-app/);
  assert.doesNotMatch(html, /Open in Bytspot/);
});

test('Share landing sources do not mention App Clips or invent Android availability', () => {
  const files = [
    path.join(__dirname, 'sharePage.ts'),
    path.join(__dirname, '../routes/planLanding.ts'),
    path.join(__dirname, '../routes/partyLanding.ts'),
    path.join(__dirname, '../routes/saleLanding.ts'),
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /App Clip|appclip|app-clip-bundle|CLIP_BUNDLE/i, file);
    assert.doesNotMatch(src, /coming to Android|Android is coming|Android soon/i, file);
  }
});
