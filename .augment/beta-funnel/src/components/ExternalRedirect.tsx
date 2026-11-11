import { useEffect } from 'react';

/** Sends an old on-site path to the published page on bytspot.app. */
export function ExternalRedirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);

  return (
    <p className="mx-auto max-w-3xl px-5 py-14 text-[var(--bone-muted)] md:px-8">
      Opening <a className="text-[var(--cyan)] underline" href={to}>{to}</a>…
    </p>
  );
}
