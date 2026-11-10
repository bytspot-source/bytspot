import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { DocumentTitle } from '../components/DocumentTitle';
import { LEGAL_LINKS } from '../lib/site';

const DRAFT_NOTICE =
  'This is a draft shell. These terms are pending counsel review. They are not published, and they are not in force.';

function DraftBanner() {
  return (
    <div className="draft-banner rounded-2xl px-4 py-3 text-sm font-medium leading-relaxed" role="status">
      {DRAFT_NOTICE}
    </div>
  );
}

function LegalLayout({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <>
      <DocumentTitle title={`${title} — Bytspot`} description={description} />
      <article className="mx-auto max-w-3xl px-5 py-14 md:px-8 md:py-20">
        <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--danger)]">
          Draft · pending counsel
        </p>
        <h1 className="mt-3 text-[clamp(2rem,5vw,3.25rem)] font-semibold leading-[1.1] tracking-tight">
          {title}
        </h1>
        <div className="mt-6">
          <DraftBanner />
        </div>
        <div className="mt-8 space-y-4 text-[16px] leading-relaxed text-[var(--bone-muted)]">
          {children}
        </div>
        <p className="mt-10 text-sm">
          <Link to="/legal" className="font-semibold text-[var(--cyan)] hover:text-white">
            All legal draft shells
          </Link>
        </p>
      </article>
    </>
  );
}

export function LegalIndexPage() {
  return (
    <>
      <DocumentTitle
        title="Legal drafts — Bytspot"
        description="Draft legal page shells for Bytspot, pending counsel review. These pages are not published terms and are not in force."
      />
      <article className="mx-auto max-w-3xl px-5 py-14 md:px-8 md:py-20">
        <h1 className="text-[clamp(2rem,5vw,3.25rem)] font-semibold leading-[1.1] tracking-tight">
          Legal drafts
        </h1>
        <div className="mt-6">
          <DraftBanner />
        </div>
        <p className="mt-6 text-[16px] leading-relaxed text-[var(--bone-muted)]">
          These routes exist so the site can point to a terms, privacy, sale, and host
          page. The wording that will live here still needs counsel review. Until then,
          treat every page in this list as a placeholder — not a contract.
        </p>
        <ul className="mt-8 divide-y divide-[var(--line)] border-y border-[var(--line)]">
          {LEGAL_LINKS.map((link) => (
            <li key={link.to}>
              <Link
                to={link.to}
                className="flex items-center justify-between gap-4 py-4 text-[var(--bone)] hover:text-white"
              >
                <span className="font-semibold">{link.label}</span>
                <span className="text-[11px] uppercase tracking-wider text-[var(--danger)]">
                  draft
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </article>
    </>
  );
}

export function TermsPage() {
  return (
    <LegalLayout
      title="Terms of Service"
      description="Draft Terms of Service shell for Bytspot. Pending counsel review; not published and not in force."
    >
      <p>
        This page will hold the Terms of Service for the Bytspot app, website,
        and API — including accounts, acceptable use, and how hosted events and plans
        work.
      </p>
      <p>No terms are stated here yet. Do not rely on this page as a legal agreement.</p>
    </LegalLayout>
  );
}

export function PrivacyPage() {
  return (
    <LegalLayout
      title="Privacy Policy"
      description="Draft Privacy Policy shell for Bytspot. Pending counsel review; not published and not in force."
    >
      <p>
        This page will hold the Privacy Policy: what Bytspot collects, why, and the
        choices you have. It will need to match the iOS privacy labels before it is
        published.
      </p>
      <p>No privacy terms are stated here yet. Do not rely on this page as a policy.</p>
    </LegalLayout>
  );
}

export function TermsOfSalePage() {
  return (
    <LegalLayout
      title="Terms of Sale"
      description="Draft Terms of Sale shell for Bytspot. Pending counsel review; not published and not in force."
    >
      <p>
        This page will hold the Terms of Sale for passes and tickets bought through
        Bytspot, including refunds and cancellations.
      </p>
      <p>
        Checkout must not treat this URL as published terms until counsel has signed off
        and the page is actually in force.
      </p>
    </LegalLayout>
  );
}

export function HostTermsPage() {
  return (
    <LegalLayout
      title="Host Terms"
      description="Draft Host Terms shell for Bytspot. Pending counsel review; not published and not in force."
    >
      <p>
        This page will hold the terms for people who host parties and receive payouts for
        paid passes.
      </p>
      <p>No host terms are stated here yet. Do not rely on this page as a legal agreement.</p>
    </LegalLayout>
  );
}
