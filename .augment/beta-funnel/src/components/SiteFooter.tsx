import { Link } from 'react-router-dom';
import { Wordmark } from './BrandLogo';
import { LEGAL_LINKS } from '../lib/site';

export function SiteFooter() {
  return (
    <footer className="relative z-10 border-t border-[var(--line)] bg-[rgba(11,16,40,0.72)]">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-10 md:flex-row md:items-start md:justify-between md:px-8">
        <div className="space-y-3">
          <Wordmark size={26} />
          <p className="max-w-sm text-sm leading-relaxed text-[var(--bone-muted)]">
            A free iOS day-and-night-out app. Atlanta, starting in Midtown.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-x-10 gap-y-3 text-sm sm:flex sm:flex-wrap sm:gap-x-6">
          <Link className="text-[var(--bone-muted)] hover:text-[var(--bone)]" to="/how-it-works">
            How it works
          </Link>
          <Link className="text-[var(--bone-muted)] hover:text-[var(--bone)]" to="/host">
            Host a party
          </Link>
          <Link className="text-[var(--bone-muted)] hover:text-[var(--bone)]" to="/invite">
            Invites
          </Link>
          <Link className="text-[var(--bone-muted)] hover:text-[var(--bone)]" to="/legal">
            Legal drafts
          </Link>
        </div>
      </div>
      <div className="mx-auto flex max-w-6xl flex-col gap-3 border-t border-[var(--line)] px-5 py-6 text-xs text-[var(--bone-muted)] md:flex-row md:items-center md:justify-between md:px-8">
        <p>© 2026 Bytspot · Atlanta, GA</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-2">
          {LEGAL_LINKS.map((link) => (
            <li key={link.to}>
              <Link className="hover:text-[var(--bone)]" to={link.to}>
                {link.label}
                <span className="ml-1 text-[10px] uppercase tracking-wider text-[var(--danger)]">
                  draft
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <p className="mx-auto max-w-6xl px-5 pb-8 text-[11px] leading-relaxed text-[var(--bone-muted)] md:px-8">
        Legal pages are draft shells pending counsel review. They are not published terms and are
        not in force.
      </p>
    </footer>
  );
}
