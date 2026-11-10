import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { AppStoreButton } from '../components/AppStoreButton';
import { DocumentTitle } from '../components/DocumentTitle';
import { EmailUpdatesForm } from '../components/EmailUpdatesForm';
import { ProductIllustration } from '../components/ProductIllustration';
import { FEATURES, SITE_DESCRIPTION, TAGLINE } from '../lib/site';

const DAY_PARTS = ['Brunch', 'Afternoon', 'Dinner', 'After-hours'];

export function HomePage() {
  return (
    <>
      <DocumentTitle title={`Bytspot — ${TAGLINE}`} description={SITE_DESCRIPTION} />
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-8 pt-12 md:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] md:gap-16 md:px-8 md:pt-20">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-white/5 px-3 py-1 text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--bone-soft)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--cyan)]" aria-hidden="true" />
            Atlanta, starting in Midtown
          </p>
          <h1 className="mt-6 max-w-xl text-[clamp(2.25rem,6vw,4.35rem)] font-semibold leading-[1.05] tracking-tight text-[var(--bone)]">
            Plan the night.
            <br />
            Send one link.
            <br />
            Everyone&apos;s in.
          </h1>
          <p className="mt-6 max-w-lg text-[17px] leading-relaxed text-[var(--bone-muted)] md:text-[18px]">
            Bytspot is a free iOS day-and-night-out app. Make a plan with friends, host a
            party with a shareable pass, and find the right spot nearby — from brunch to
            after-hours.
          </p>
          <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <AppStoreButton size="lg" />
            <Link
              to="/how-it-works"
              className="inline-flex min-h-12 items-center gap-2 text-[15px] font-semibold text-[var(--bone)] hover:text-white"
            >
              How it works
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
          <p className="mt-10 text-sm leading-relaxed text-[var(--bone-muted)]">
            {DAY_PARTS.map((part, i) => (
              <span key={part}>
                {i > 0 && <span className="mx-2 text-[var(--cyan)]" aria-hidden="true">·</span>}
                <span>{part}</span>
              </span>
            ))}
          </p>
        </div>
        <ProductIllustration />
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16 md:px-8 md:py-24" aria-labelledby="features-heading">
        <div className="max-w-2xl">
          <h2 id="features-heading" className="text-3xl font-semibold tracking-tight md:text-4xl">
            Parties and plans first. The rest of the day around them.
          </h2>
          <p className="mt-4 text-[16px] leading-relaxed text-[var(--bone-muted)]">
            Bytspot is built for going out with people — a party you host, a plan you
            share — and for finding a spot when you need one.
          </p>
        </div>
        <ul className="mt-10 grid gap-4 md:grid-cols-2">
          {FEATURES.map((feature, i) => (
            <li
              key={feature.id}
              className={`rounded-3xl border border-[var(--line)] bg-[var(--navy)]/55 p-6 ${
                i < 2 ? 'md:p-8' : ''
              }`}
            >
              <h3 className={`font-semibold tracking-tight ${i < 2 ? 'text-2xl' : 'text-xl'}`}>
                {feature.title}
              </h3>
              <p className="mt-3 text-[15px] leading-relaxed text-[var(--bone-muted)]">
                {feature.body}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-16 md:px-8 md:pb-24">
        <div className="grid items-center gap-8 rounded-[2rem] border border-[var(--line)] bg-[var(--navy)]/55 px-6 py-10 md:grid-cols-2 md:px-12">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight">Hosting tonight?</h2>
            <p className="mt-4 text-[16px] leading-relaxed text-[var(--bone-muted)]">
              Host Studio lets you publish a party and share a pass. Guests can get in
              with an App Clip, without downloading the full app.
            </p>
            <Link
              to="/host"
              className="mt-6 inline-flex min-h-12 items-center gap-2 font-semibold text-[var(--cyan)] hover:text-white"
            >
              How hosting works
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Stay in the loop</h2>
            <div className="mt-4">
              <EmailUpdatesForm compact />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
