import type { CSSProperties } from 'react';

/**
 * Deterministic starfield on the night-navy ground.
 * A handful of stars are the cyan "spot" dots. Animation is CSS-only and
 * disabled when the user prefers reduced motion.
 */
const STARS = buildStars(160);

interface Star {
  x: number;
  y: number;
  r: number;
  o: number;
  dur: number;
  delay: number;
  cyan: boolean;
}

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function buildStars(count: number): Star[] {
  const rand = mulberry32(72);
  const stars: Star[] = [];
  for (let i = 0; i < count; i += 1) {
    const cyan = i % 17 === 0;
    stars.push({
      x: rand() * 100,
      y: rand() * 100,
      r: cyan ? 1.15 + rand() * 1.15 : 0.45 + rand() * 1,
      o: cyan ? 0.55 + rand() * 0.35 : 0.22 + rand() * 0.5,
      dur: 3.2 + rand() * 5,
      delay: rand() * 6,
      cyan,
    });
  }
  return stars;
}

export function Starfield() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% -10%, rgba(0, 191, 255, 0.16) 0%, transparent 55%), #0B1028',
        }}
      />
      {STARS.map((star, i) => (
        <span
          key={i}
          className="star-twinkle absolute rounded-full"
          style={
            {
              left: `${star.x}%`,
              top: `${star.y}%`,
              width: star.r * 2,
              height: star.r * 2,
              background: star.cyan ? '#00BFFF' : '#F4EFE6',
              ['--star-o' as string]: String(star.o),
              ['--star-dur' as string]: `${star.dur}s`,
              ['--star-delay' as string]: `${star.delay}s`,
              opacity: star.o,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
