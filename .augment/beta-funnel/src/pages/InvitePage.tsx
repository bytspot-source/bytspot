import { Link } from 'react-router-dom';
import { AppStoreButton } from '../components/AppStoreButton';
import { DocumentTitle } from '../components/DocumentTitle';

export function InvitePage() {
  return (
    <>
      <DocumentTitle
        title="Invites — Bytspot"
        description="Open a Bytspot plan or party-pass link. Hosts share a link; guests use that link to get on the plan or get their pass."
      />
      <article className="mx-auto max-w-3xl px-5 py-14 md:px-8 md:py-20">
        <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--cyan)]">
          Invites
        </p>
        <h1 className="mt-3 text-[clamp(2rem,5vw,3.5rem)] font-semibold leading-[1.1] tracking-tight">
          Someone sent you a link?
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-[var(--bone-muted)]">
          Plans and parties on Bytspot travel as a single link. This page explains what
          that link is. A specific invite from a friend or host will show that plan or
          party&apos;s own details — this is the general guide.
        </p>

        <section className="mt-12 space-y-8">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">If it&apos;s a plan</h2>
            <p className="mt-3 text-[16px] leading-relaxed text-[var(--bone-muted)]">
              The link is an invite to a shared plan. Open it to see the same plan
              everyone else was invited to — the stops, the timing, and any updates the
              host or friends add.
            </p>
          </div>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">If it&apos;s a party pass</h2>
            <p className="mt-3 text-[16px] leading-relaxed text-[var(--bone-muted)]">
              The host sends a link to the pass. Use that link to get your pass.
            </p>
          </div>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">If you&apos;re not on iPhone</h2>
            <p className="mt-3 text-[16px] leading-relaxed text-[var(--bone-muted)]">
              Bytspot is a free iOS app. If you don&apos;t have an iPhone, ask the person
              who invited you to share the time and place another way, or check back when
              you can open the link on an iPhone.
            </p>
          </div>
        </section>

        <div className="mt-12 rounded-3xl border border-[var(--line)] bg-[var(--navy)]/55 p-6 md:p-8">
          <h2 className="text-xl font-semibold tracking-tight">Get the app</h2>
          <p className="mt-3 text-[15px] leading-relaxed text-[var(--bone-muted)]">
            Plans, discovery, the concierge, and the rest of Bytspot live in the free
            iOS app.
          </p>
          <div className="mt-6">
            <AppStoreButton size="lg" />
          </div>
        </div>
        <p className="mt-8 text-sm text-[var(--bone-muted)]">
          Hosting instead?{' '}
          <Link to="/host" className="font-semibold text-[var(--cyan)] hover:text-white">
            See how Host Studio works
          </Link>
          .
        </p>
      </article>
    </>
  );
}
