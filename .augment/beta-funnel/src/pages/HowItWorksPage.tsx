import { Link } from 'react-router-dom';
import { AppStoreButton } from '../components/AppStoreButton';
import { DocumentTitle } from '../components/DocumentTitle';
import { FEATURES, HOW_IT_WORKS_STEPS, TAGLINE } from '../lib/site';

export function HowItWorksPage() {
  return (
    <>
      <DocumentTitle
        title="How Bytspot works — Bytspot"
        description="Make a plan, host a party, and find a nearby spot. Bytspot is a free iOS day-and-night-out app for Atlanta, starting in Midtown."
      />
      <article className="mx-auto max-w-3xl px-5 py-14 md:px-8 md:py-20">
        <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--cyan)]">
          How it works
        </p>
        <h1 className="mt-3 text-[clamp(2rem,5vw,3.5rem)] font-semibold leading-[1.1] tracking-tight">
          {TAGLINE}
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-[var(--bone-muted)]">
          Bytspot is a free iOS app for the whole day out, from brunch to after-hours.
          It starts with the people you&apos;re going with, then helps you pick a spot
          and get there.
        </p>
        <ol className="mt-12 space-y-8">
          {HOW_IT_WORKS_STEPS.map((step) => (
            <li key={step.n} className="grid gap-3 sm:grid-cols-[4rem_1fr] sm:gap-6">
              <span className="font-semibold tabular-nums text-[var(--cyan)]">{step.n}</span>
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">{step.title}</h2>
                <p className="mt-2 text-[16px] leading-relaxed text-[var(--bone-muted)]">
                  {step.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-16">
          <h2 className="text-2xl font-semibold tracking-tight">What you can do in the app</h2>
          <ul className="mt-6 space-y-5">
            {FEATURES.map((feature) => (
              <li key={feature.id}>
                <h3 className="font-semibold">{feature.title}</h3>
                <p className="mt-1 text-[15px] leading-relaxed text-[var(--bone-muted)]">
                  {feature.body}
                </p>
              </li>
            ))}
          </ul>
        </div>
        <p className="mt-10 text-sm leading-relaxed text-[var(--bone-muted)]">
          Launch market: Atlanta, starting in Midtown. Bytspot does not claim venue
          partnerships on this site.
        </p>
        <div className="mt-10 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <AppStoreButton size="lg" />
          <Link to="/host" className="font-semibold text-[var(--cyan)] hover:text-white">
            Host a party
          </Link>
        </div>
      </article>
    </>
  );
}
