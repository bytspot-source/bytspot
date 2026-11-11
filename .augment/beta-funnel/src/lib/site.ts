export const APP_STORE_URL = 'https://apps.apple.com/us/app/bytspot/id6761876421';
export const APP_STORE_ID = '6761876421';
export const SITE_URL = 'https://bytspot.com';
export const SIGNUP_API_URL = 'https://bytspot-api.onrender.com/beta-signup';

export const TAGLINE = "Plan the night. Send one link. Everyone's in.";
export const SITE_DESCRIPTION =
  'Bytspot is a free iOS day-and-night-out app. Make a plan with friends, host a party with a shareable pass, and find the right spot nearby — Atlanta, starting in Midtown.';

export const NAV_LINKS = [
  { to: '/how-it-works', label: 'How it works' },
  { to: '/host', label: 'Host a party' },
  { to: '/invite', label: 'Invites' },
] as const;

/** The published policies, the same pages the App Store listing and the app link to. */
export const TERMS_URL = 'https://bytspot.app/terms';
export const PRIVACY_URL = 'https://bytspot.app/privacy';

export const LEGAL_LINKS = [
  { href: TERMS_URL, label: 'Terms of Service' },
  { href: PRIVACY_URL, label: 'Privacy Policy' },
] as const;

/** Featured first: parties and plans lead the product story. */
export const FEATURES = [
  {
    id: 'plans',
    title: 'Plans, shared with one link',
    body: 'Build the outing with friends and send a single link. Everyone sees the same plan.',
  },
  {
    id: 'parties',
    title: 'Host Studio party passes',
    body: 'Publish a party and share a pass. Guests get a link to the pass from the host.',
  },
  {
    id: 'discover',
    title: 'Swipe to discover nearby spots',
    body: 'Browse places around you with typical busyness by hour — the usual pattern for that time of day, not a live crowd count.',
  },
  {
    id: 'map',
    title: 'A real map, with routes and drive times',
    body: 'See how to get there, with routes and drive times in the app.',
  },
  {
    id: 'concierge',
    title: 'AI concierge for local ideas',
    body: 'Ask for ideas that fit the day or night, then add a place to a plan.',
  },
  {
    id: 'dishes',
    title: 'Dish photo finder',
    body: 'Snap a dish and find spots nearby that serve it.',
  },
  {
    id: 'sales',
    title: 'Private sales',
    body: 'List or browse personal items in the app. Payments are arranged directly between people, not through Bytspot.',
  },
  {
    id: 'ratings',
    title: 'Ratings after events',
    body: 'After a night out, rate what it was actually like.',
  },
] as const;

export const HOW_IT_WORKS_STEPS = [
  {
    n: '01',
    title: 'Download Bytspot',
    body: 'Bytspot is a free app for iPhone, on the App Store.',
  },
  {
    n: '02',
    title: 'Make a plan, or host a party',
    body: 'Put the day or night together, then send one link. Hosts can publish a party with a shareable pass from Host Studio.',
  },
  {
    n: '03',
    title: 'Invite everyone',
    body: 'Friends open the plan link in the app. Party guests get a link to the pass from the host.',
  },
  {
    n: '04',
    title: 'Find the right spot',
    body: 'Swipe nearby places, check typical busyness by hour, and use the map for routes and drive times. The concierge and dish photo finder can help you choose.',
  },
  {
    n: '05',
    title: 'Head out, then rate it',
    body: 'From brunch to after-hours, keep everyone on the same plan. After the event, leave a rating.',
  },
] as const;
