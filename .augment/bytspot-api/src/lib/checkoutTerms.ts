/**
 * REA X3: refund terms shown on the Stripe Checkout page (custom_text.submit,
 * max 1200 characters). DRAFT copy for attorney review; it must match the
 * Terms of Sale draft in bytspot-beta/docs/legal-drafts/terms-of-sale.md and
 * the page at the URL below must be published before this goes live.
 */
export const TERMS_OF_SALE_URL = 'https://bytspot.app/terms-of-sale';

export const PARTY_CHECKOUT_TERMS =
  'If the host cancels or Bytspot removes the event, you get a full refund to this card. '
  + 'Otherwise passes are non-refundable unless the host offers one. '
  + 'Bottle minimums are settled at the venue. 21+ events need a valid ID at the door. '
  + `Terms of Sale: ${TERMS_OF_SALE_URL}`;

export const VENDOR_TICKET_CHECKOUT_TERMS =
  'This ticket is sold by the business named above; Bytspot processes the payment. '
  + 'If the business cancels, you get a full refund to this card. '
  + `Terms of Sale: ${TERMS_OF_SALE_URL}`;
