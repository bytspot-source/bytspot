import * as Sentry from '@sentry/node';
import { config } from '../config';

/** Sentry is optional: an unset DSN must leave the API running exactly as it
 *  did before, not crash it at boot. */
export const isErrorTrackingEnabled = (): boolean => config.sentryDsn.length > 0;

/** Header and body values are secrets by default, so nothing but the shape of
 *  a request is allowed to leave the process. */
export function initErrorTracking(): void {
  if (!isErrorTrackingEnabled()) return;
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.nodeEnv,
    release: config.releaseVersion,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event) {
      delete event.request?.headers;
      delete event.request?.cookies;
      delete event.request?.data;
      return event;
    },
  });
}

/** Report a handled failure. Never throws: reporting must not become a second
 *  fault on top of the first. */
export function captureError(error: unknown, context?: Record<string, string>): void {
  if (!isErrorTrackingEnabled()) return;
  try {
    Sentry.captureException(error, context ? { tags: context } : undefined);
  } catch {
    // An unreachable Sentry must never surface to the caller.
  }
}

/** Crashes that would otherwise leave no trace beyond a restarted process. */
export function installProcessGuards(): void {
  process.on('uncaughtException', (error) => {
    console.error('[fatal] uncaughtException', error);
    captureError(error, { kind: 'uncaughtException' });
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandledRejection', reason);
    captureError(reason, { kind: 'unhandledRejection' });
  });
}
