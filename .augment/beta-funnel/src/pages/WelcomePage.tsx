import { Link } from 'react-router-dom';
import { AppStoreButton } from '../components/AppStoreButton';
import { DocumentTitle } from '../components/DocumentTitle';
import { EmailUpdatesForm } from '../components/EmailUpdatesForm';

export function WelcomePage() {
  return (
    <>
      <DocumentTitle
        title="Welcome — Bytspot"
        description="Thanks for signing up for Bytspot updates. The free iOS app is on the App Store."
      />
      <article className="mx-auto max-w-xl px-5 py-16 md:px-8 md:py-24">
        <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--cyan)]">
          Atlanta, starting in Midtown
        </p>
        <h1 className="mt-3 text-[clamp(2rem,5vw,3.25rem)] font-semibold leading-[1.1] tracking-tight">
          You&apos;re in.
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-[var(--bone-muted)]">
          If you just joined the email list, we&apos;ll send Bytspot updates for Atlanta.
          The free iOS app is already on the App Store — you don&apos;t need a waitlist
          to download it.
        </p>
        <div className="mt-8">
          <AppStoreButton size="lg" />
        </div>
        <p className="mt-8 text-sm">
          <Link to="/how-it-works" className="font-semibold text-[var(--cyan)] hover:text-white">
            See how Bytspot works
          </Link>
        </p>
        <div className="mt-14 border-t border-[var(--line)] pt-10">
          <h2 className="text-xl font-semibold tracking-tight">Want updates by email?</h2>
          <div className="mt-4">
            <EmailUpdatesForm />
          </div>
        </div>
      </article>
    </>
  );
}
