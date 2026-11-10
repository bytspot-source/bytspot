import type { ReactNode } from 'react';
import { Starfield } from './Starfield';
import { SiteHeader } from './SiteHeader';
import { SiteFooter } from './SiteFooter';

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-screen text-[var(--bone)]">
      <Starfield />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="relative z-10 flex min-h-screen flex-col">
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </div>
    </div>
  );
}
