import { Smartphone } from 'lucide-react';
import { APP_STORE_URL } from '../lib/site';

interface AppStoreButtonProps {
  className?: string;
  size?: 'md' | 'lg' | 'compact';
}

export function AppStoreButton({ className = '', size = 'md' }: AppStoreButtonProps) {
  const pad =
    size === 'lg'
      ? 'min-h-14 px-6 py-3 text-[16px]'
      : size === 'compact'
        ? 'min-h-11 px-4 py-2 text-[14px]'
        : 'min-h-12 px-5 py-2.5 text-[15px]';

  const label =
    size === 'compact' ? (
      <span className="font-semibold tracking-tight">App Store</span>
    ) : (
      <span className="leading-tight text-left">
        <span className="block text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--navy)]/70">
          Download on the
        </span>
        <span className="block text-[16px] font-semibold tracking-tight">App Store</span>
      </span>
    );

  return (
    <a
      href={APP_STORE_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Download Bytspot on the App Store"
      className={`inline-flex items-center justify-center gap-2.5 rounded-full bg-[var(--bone)] font-semibold text-[var(--navy-deep)] shadow-[0_0_0_1px_rgba(244,239,230,0.08),0_10px_30px_rgba(0,0,0,0.35)] transition-colors hover:bg-white ${pad} ${className}`}
    >
      <Smartphone className="h-5 w-5 shrink-0" aria-hidden="true" strokeWidth={1.75} />
      {label}
    </a>
  );
}
