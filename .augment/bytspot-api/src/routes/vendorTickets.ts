import { Router, type Response } from 'express';
import { captureError } from '../lib/observability';
import { requireCapability, requireVendorSeat } from '../middleware/vendorAuth';
import { createTicket, createTicketInput, editTicket, editTicketInput, listTickets, TicketRefused, withdrawTicket } from '../vendor/tickets';

const router = Router();

/** Putting a date on sale is publishing, like a bookable. */
const canManage = requireCapability('PUBLISH');

function refuse(res: Response, err: unknown, route: string): void {
  if (err instanceof TicketRefused) {
    res.status(err.status).json({ error: 'Ticket refused', blockers: err.blockers });
    return;
  }
  captureError(err, { route });
  res.status(500).json({ error: 'Internal error' });
}

router.get('/vendor/tickets', requireVendorSeat, canManage, async (req, res) => {
  try {
    res.status(200).json({ tickets: await listTickets(req.vendor!.seller.id) });
  } catch (err) {
    refuse(res, err, 'vendor/tickets:get');
  }
});

router.post('/vendor/tickets', requireVendorSeat, canManage, async (req, res) => {
  const parsed = createTicketInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid ticket', blockers: ['Choose a place, a name, a date and times, a price of at least $1 and how many to sell'] });
    return;
  }
  try {
    const { seller, seat } = req.vendor!;
    res.status(200).json({ ticket: await createTicket(seller.id, seat.id, parsed.data) });
  } catch (err) {
    refuse(res, err, 'vendor/tickets:create');
  }
});

router.post('/vendor/tickets/:id', requireVendorSeat, canManage, async (req, res) => {
  const parsed = editTicketInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid ticket', blockers: ['Change the name, the details, the price or how many to sell'] });
    return;
  }
  try {
    res.status(200).json({ ticket: await editTicket(req.vendor!.seller.id, String(req.params.id), parsed.data) });
  } catch (err) {
    refuse(res, err, 'vendor/tickets:edit');
  }
});

router.post('/vendor/tickets/:id/withdraw', requireVendorSeat, canManage, async (req, res) => {
  try {
    res.status(200).json({ ticket: await withdrawTicket(req.vendor!.seller.id, String(req.params.id)) });
  } catch (err) {
    refuse(res, err, 'vendor/tickets:withdraw');
  }
});

export default router;
