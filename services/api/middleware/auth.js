// Lightweight auth middleware: parses Authorization header if present.
// TODO: Replace with real JWT verification once Auth is wired.

export function parseAuth(req, _res, next) {
  const h = req.headers?.authorization || req.headers?.Authorization;
  if (typeof h === 'string') {
    const [scheme, token] = h.split(' ');
    if (scheme && token) {
      req.auth = { scheme, token };
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.auth?.token) return res.status(401).json({ error: 'unauthorized' });
  return next();
}

