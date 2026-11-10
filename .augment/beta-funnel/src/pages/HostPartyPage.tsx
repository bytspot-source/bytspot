import { Link } from 'react-router-dom';
import { AppStoreButton } from '../components/AppStoreButton';
import { DocumentTitle } from '../components/DocumentTitle';

const HOST_STEPS = [
  {
    title: 'Create the party in Host Studio',
    body: 'Set the name, time, and how people get in — for example a free RSVP, a paid pass, or approval at the door.',
  },
  {
    title: 'Share the pass',
    body: 'Send one link. That link is the invite. You do not need a separate ticketing tool to get the word out.',
  },
  {
    title: 'Guests get in with a pass, or the App Clip',
    body: 'People with iPhone can open a party link in the App Clip and get their pass without downloading the full Bytspot app. They can also download the app if they want the rest of it.',
  },
  {
    title: 'Check people in',
    body: 'At the door, hosts can scan a guest’s pass in the app.',
  },
];

export function HostPartyPage() {
  return (
    <>
      <DocumentTitle
        title="Host a party — Bytspot"
        description="Use Host Studio to publish a party, share a pass, and let guests in with an App Clip — no download required."
      />
      <article className="mx-auto max-w-3xl px-5 py-14 md:px-8 md:py-20">
        <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--cyan)]">
          Host Studio
        </p>
        <h1 className="mt-3 text-[clamp(2rem,5vw,3.5rem)] font-semibold leading-[1.1] tracking-tight">
          Host a party. Share the pass.
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-[var(--bone-muted)]">
          Bytspot is built for gatherings you actually throw — a house party, a
          celebration, a night you want people to walk into without a messy group
          chat. Guests get a pass. You get a door you can run.
        </p>
        <ol className="mt-12 space-y-8">
          {HOST_STEPS.map((step, i) => (
            <li key={step.title} className="border-t border-[var(--line)] pt-8 first:border-t-0 first:pt-0">
              <p className="text-sm font-semibold text-[var(--cyan)]">Step {i + 1}</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight">{step.title}</h2>
              <p className="mt-2 text-[16px] leading-relaxed text-[var(--bone-muted)]">{step.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-12 rounded-3xl border border-[var(--line)] bg-[var(--navy)]/55 p-6 md:p-8">
          <h2 className="text-xl font-semibold tracking-tight">What this page is not</h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-[var(--bone-muted)]">
            <li>It is not a list of Atlanta venue partners. Bytspot does not claim those here.</li>
            <li>
              Paid passes, refunds, and payouts are covered in legal drafts that are still
              pending counsel — see the{' '}
              <Link to="/legal" className="text-[var(--cyan)] underline-offset-2 hover:underline">
                legal drafts
              </Link>
              .
            </li>
          </ul>
        </div>
        <div className="mt-10 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <AppStoreButton size="lg" />
          <Link to="/invite" className="font-semibold text-[var(--cyan)] hover:text-white">
            How invite links and the App Clip work
          </Link>
        </div>
      </article>
    </>
  );
}
