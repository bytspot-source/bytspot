import { useId } from 'react';

interface BrandLogoProps {
  size?: number;
  title?: string;
  className?: string;
}

/**
 * Official Bytspot mark: rings, pointy-top hex, and the cyan "spot" dot.
 * Geometry matches contracts/brand-mark-geometry.json (120-unit viewBox).
 */
export function BrandLogo({ size = 40, title = 'Bytspot', className }: BrandLogoProps) {
  const uid = useId();
  const outer = `${uid}-outer`;
  const mid = `${uid}-mid`;
  const hex = `${uid}-hex`;
  const border = `${uid}-border`;
  const dot = `${uid}-dot`;
  const glow = `${uid}-glow`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      role="img"
      aria-label={title}
      className={className}
    >
      <defs>
        <linearGradient id={outer} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#00BFFF" />
          <stop offset="100%" stopColor="#00BFFF" />
        </linearGradient>
        <linearGradient id={mid} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#A855F7" />
          <stop offset="100%" stopColor="#A855F7" />
        </linearGradient>
        <linearGradient id={hex} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#A855F7" />
          <stop offset="100%" stopColor="#A855F7" />
        </linearGradient>
        <linearGradient id={border} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#20A9FB" />
          <stop offset="100%" stopColor="#20A9FB" />
        </linearGradient>
        <radialGradient id={dot} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#00BFFF" />
          <stop offset="100%" stopColor="#0099CC" />
        </radialGradient>
        <radialGradient id={glow} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#00BFFF" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#00BFFF" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="60" cy="60" r="48" fill="none" stroke={`url(#${outer})`} strokeWidth="3" />
      <circle cx="60" cy="60" r="38" fill="none" stroke={`url(#${mid})`} strokeWidth="2" opacity="0.4" />
      <path d="M60 32 L74 41 L74 59 L60 68 L46 59 L46 41 Z" fill={`url(#${hex})`} />
      <path
        d="M60 32 L74 41 L74 59 L60 68 L46 59 L46 41 Z"
        fill="none"
        stroke={`url(#${border})`}
        strokeWidth="1.5"
      />
      <circle cx="60" cy="50" r="12" fill={`url(#${glow})`} />
      <circle cx="60" cy="50" r="8" fill={`url(#${dot})`} />
    </svg>
  );
}

export function Wordmark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <BrandLogo size={size} />
      <span className="font-semibold tracking-tight text-[var(--bone)]" style={{ fontSize: size * 0.72 }}>
        Bytspot
      </span>
    </span>
  );
}
