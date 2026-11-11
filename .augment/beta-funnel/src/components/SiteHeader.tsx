import { useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { Wordmark } from './BrandLogo';
import { AppStoreButton } from './AppStoreButton';
import { NAV_LINKS } from '../lib/site';

export function SiteHeader() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-2 py-1 text-[15px] transition-colors ${
      isActive ? 'text-[var(--bone)]' : 'text-[var(--bone-muted)] hover:text-[var(--bone)]'
    }`;

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[rgba(11,16,40,0.78)] backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3 md:px-8">
        <Link to="/" className="relative z-40 rounded-md" onClick={() => setOpen(false)}>
          <Wordmark size={28} />
          <span className="sr-only">Bytspot home</span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <NavLink key={link.to} to={link.to} className={linkClass}>
              {link.label}
            </NavLink>
          ))}
        </nav>

        <div className="hidden md:block">
          <AppStoreButton size="compact" />
        </div>

        <button
          type="button"
          className="relative z-40 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--bone)] md:hidden"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </div>

      {open && (
        <div
          id="mobile-nav"
          className="border-t border-[var(--line)] bg-[var(--navy-deep)] px-5 py-6 md:hidden"
        >
          <nav className="flex flex-col gap-4" aria-label="Mobile">
            {NAV_LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={linkClass}
                onClick={() => setOpen(false)}
              >
                {link.label}
              </NavLink>
            ))}
            <div className="pt-2">
              <AppStoreButton className="w-full" />
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
