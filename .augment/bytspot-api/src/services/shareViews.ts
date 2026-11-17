import { db } from '../lib/db';
import { captureError } from '../lib/observability';

export type ShareLinkKind = 'plan' | 'party';

/** Apps that fetch a link to draw its preview card. They are not a person opening it. */
const PREVIEW_AGENT = /bot\b|crawler|spider|facebookexternalhit|facebot|whatsapp|telegrambot|slackbot|discordbot|linkedinbot|embedly|skypeuripreview|pinterest|vkshare|redditbot|applebot|googlebot|bingbot|preview/i;

export function isLinkPreviewAgent(userAgent: string | undefined): boolean {
  return !userAgent || PREVIEW_AGENT.test(userAgent);
}

/** Counts a person opening a share page. No visitor detail is stored; failures never affect the page. */
export function noteShareView(kind: ShareLinkKind, targetId: string, userAgent: string | undefined,
  write: (kind: ShareLinkKind, targetId: string) => Promise<unknown> = (k, id) => db.shareLinkView.create({ data: { kind: k, targetId: id } })): void {
  if (isLinkPreviewAgent(userAgent)) return;
  write(kind, targetId).catch((err) => captureError(err, { route: 'share-view' }));
}
