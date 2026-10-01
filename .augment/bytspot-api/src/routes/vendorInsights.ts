import { Router, type NextFunction, type Request, type Response } from 'express';
import { captureError } from '../lib/observability';
import { requireVendorSeat } from '../middleware/vendorAuth';
import { analyticsRange, loadAnalytics, payoutDashboardLink, payoutLines, payoutTotals } from '../vendor/insights';
import { refreshPayout } from '../vendor/payout';

const router = Router();

/**
 * Analytics and Payouts. Money is the owner's and manager's to read, and only
 * the owner's to manage, matching `requiresFinancials` and `requiresPayouts`
 * in the console's navigation.
 */

function requireRoles(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.vendor || !roles.includes(req.vendor.seat.role)) {
      res.status(403).json({ error: 'Not permitted', blockers: ['Your role cannot see this'] });
      return;
    }
    next();
  };
}

router.get('/vendor/analytics', requireVendorSeat, requireRoles('owner', 'manager'), async (req, res) => {
  try {
    res.status(200).json(await loadAnalytics(req.vendor!.seller.id, analyticsRange(req.query.days)));
  } catch (err) {
    captureError(err, { route: 'vendor/analytics' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/vendor/payouts', requireVendorSeat, requireRoles('owner'), async (req, res) => {
  const { seller } = req.vendor!;
  try {
    const [payout, lines] = await Promise.all([refreshPayout(seller), payoutLines(seller.id)]);
    res.status(200).json({ payout, totals: payoutTotals(lines), lines });
  } catch (err) {
    captureError(err, { route: 'vendor/payouts' });
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/vendor/payouts/dashboard', requireVendorSeat, requireRoles('owner'), async (req, res) => {
  try {
    const url = await payoutDashboardLink(req.vendor!.seller);
    if (!url) {
      res.status(409).json({ error: 'No dashboard yet', blockers: ['Finish payout setup first'] });
      return;
    }
    res.status(200).json({ url });
  } catch (err) {
    captureError(err, { route: 'vendor/payouts/dashboard' });
    res.status(502).json({ error: 'Payout dashboard failed', blockers: ['The payout dashboard is down. Try again'] });
  }
});

export default router;
