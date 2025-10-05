// Sentry initialization (Expo)
// Requires `sentry-expo` dependency. Set EXPO_PUBLIC_SENTRY_DSN in your env to enable.

// Guard dynamic import so local dev without the package doesn't crash bundling
let inited = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Sentry = require('sentry-expo');
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  Sentry.init({
    dsn,
    enableInExpoDevelopment: true,
    debug: false,
  });
  inited = true;
} catch (e) {
  // sentry-expo not installed or not available; skip silently
}

export function captureError(err: unknown) {
  if (!inited) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require('sentry-expo');
    Sentry.Native.captureException(err);
  } catch {}
}

