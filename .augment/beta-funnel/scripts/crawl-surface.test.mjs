import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

const POSITIONING = 'Bytspot is an intent app for people to find spots and plan outings.'
const INTENT =
  'Tell Bytspot what you want to do, like a chill date night under $50 near Midtown, and it finds spots that fit and builds a plan you can share with friends.'
const TAGLINE = 'Find the spot. Make the plan. Send the link.'

test('www.bytspot.com crawl files use this domain and do not invent ratings or live busyness', () => {
  const robots = read('public/robots.txt')
  const llms = read('public/llms.txt')
  const sitemap = read('public/sitemap.xml')
  const support = read('public/support.html')
  const home = read('index.html')

  assert.match(robots, /User-agent: OAI-SearchBot\nAllow: \//)
  assert.match(robots, /User-agent: Googlebot\nAllow: \//)
  assert.match(robots, /Sitemap: https:\/\/www\.bytspot\.com\/sitemap\.xml/)

  assert.match(llms, new RegExp(POSITIONING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(llms, /typical busyness by hour/i)
  assert.match(llms, /https:\/\/www\.bytspot\.com\//)
  assert.match(llms, /https:\/\/www\.bytspot\.com\/support/)
  assert.doesNotMatch(llms, /live updates/i)
  assert.doesNotMatch(llms, /aggregateRating|ratingValue|\d\.\d\s*stars/i)

  assert.match(sitemap, /<loc>https:\/\/www\.bytspot\.com\/<\/loc>/)
  assert.match(sitemap, /<loc>https:\/\/www\.bytspot\.com\/support<\/loc>/)
  assert.doesNotMatch(sitemap, /<loc>https:\/\/bytspot\.app\//)
  assert.doesNotMatch(sitemap, /<loc>https:\/\/bytspot\.com\//)

  for (const page of [support, home]) {
    assert.match(page, new RegExp(POSITIONING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(page, new RegExp(INTENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(page, new RegExp(TAGLINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(page, /aggregateRating|ratingValue|TODO/)
  }

  assert.match(home, /rel="canonical" href="https:\/\/www\.bytspot\.com\/"/)
  assert.match(home, /property="og:url" content="https:\/\/www\.bytspot\.com\/"/)
  assert.match(home, /SoftwareApplication/)
  assert.match(home, /6761876421/)
  assert.match(home, /"price": "0"/)
  assert.doesNotMatch(home, /aggregateRating|reviewCount|ratingValue/)

  const blocks = [...home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  assert.equal(blocks.length, 1)
  const graph = JSON.parse(blocks[0][1])['@graph']
  assert.equal(graph[0]['@type'], 'Organization')
  assert.equal(graph[1]['@type'], 'WebSite')
  assert.deepEqual(graph[2]['@type'], ['SoftwareApplication', 'MobileApplication'])
  assert.equal(graph[2].downloadUrl, 'https://apps.apple.com/us/app/bytspot/id6761876421')
  assert.doesNotMatch(blocks[0][1], /\blive\b/i)

  assert.match(support, /mailto:update@bytspot.com/)
  assert.match(support, /href="https:\/\/bytspot\.app\/terms"/)
  assert.match(support, /href="https:\/\/bytspot\.app\/privacy"/)
  assert.match(support, /href="https:\/\/bytspot\.app\/refunds"/)
  assert.match(support, /canonical" href="https:\/\/www\.bytspot\.com\/support"/)
  assert.match(support, /Delete Account/)
  assert.match(support, /30 days/)
  assert.match(support, /URGENT/)
  assert.match(support, /not a live crowd count/)
})
