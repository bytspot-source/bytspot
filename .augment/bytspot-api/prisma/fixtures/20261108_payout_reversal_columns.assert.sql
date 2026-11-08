-- Disposable migration-fixture database ONLY. These assertions always roll back.
BEGIN;
DO $$
DECLARE u TEXT := 'fixture-payout-reversal';
BEGIN
  IF to_regclass('public.party_payout_transfers_status_paid_at_idx') IS NULL
  THEN RAISE EXCEPTION 'paid_at index missing'; END IF;
  ALTER TABLE party_payout_transfers DROP CONSTRAINT IF EXISTS party_payout_transfers_checkout_id_fkey;
  INSERT INTO party_payout_transfers (id, checkout_id, party_id, recipient, amount_cents, status, updated_at)
    VALUES (u, u, u, 'host', 1000, 'paid', NOW());
  IF (SELECT reversed_cents FROM party_payout_transfers WHERE id = u) <> 0
    OR (SELECT checked_at FROM party_payout_transfers WHERE id = u) IS NOT NULL
  THEN RAISE EXCEPTION 'reversal columns have the wrong defaults'; END IF;
  UPDATE party_payout_transfers SET status = 'reversed', reversed_cents = 1000, checked_at = NOW() WHERE id = u;
  BEGIN
    UPDATE party_payout_transfers SET reversed_cents = 1001 WHERE id = u;
    RAISE EXCEPTION 'reversal above the transfer accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE party_payout_transfers SET status = 'sent' WHERE id = u;
    RAISE EXCEPTION 'unknown status accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
