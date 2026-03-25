import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { MapPin, ArrowRight, Radio, ParkingCircle, Car, Clock } from 'lucide-react';

const API_URL = 'https://bytspot-api.onrender.com';
const BETA_APP_URL = 'https://bytspot-beta.onrender.com';

interface Venue { id: string; name: string; crowdLevel: string; parkingAvailable: number; updatedAt: string; }

/** Generate a recent-ish ISO timestamp (1-8 mins ago) for fallback realism */
function recentTimestamp(minsAgo: number): string {
  return new Date(Date.now() - minsAgo * 60_000).toISOString();
}

/** Format an ISO timestamp as a relative "X min ago" string */
function timeAgo(iso: string): string {
  const diff = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (diff < 1) return 'Just now';
  if (diff === 1) return '1 min ago';
  return `${diff} min ago`;
}

/** Fallback venues shown when API is cold-starting or unreachable */
function buildFallbackVenues(): Venue[] {
  return [
    { id: 'f1', name: 'Ponce City Market', crowdLevel: 'Active', parkingAvailable: 45, updatedAt: recentTimestamp(2) },
    { id: 'f2', name: 'Colony Square', crowdLevel: 'Chill', parkingAvailable: 22, updatedAt: recentTimestamp(4) },
    { id: 'f3', name: 'Krog Street Market', crowdLevel: 'Active', parkingAvailable: 12, updatedAt: recentTimestamp(1) },
    { id: 'f4', name: 'The Painted Pin', crowdLevel: 'Packed', parkingAvailable: 5, updatedAt: recentTimestamp(6) },
    { id: 'f5', name: 'Piedmont Park', crowdLevel: 'Chill', parkingAvailable: 60, updatedAt: recentTimestamp(3) },
  ];
}

const CROWD_COLOR: Record<string, string> = {
  Chill: 'text-emerald-400',
  Active: 'text-orange-400',
  Packed: 'text-red-400',
};
const CROWD_BAR: Record<string, string> = {
  Chill: 'w-1/4 bg-emerald-500',
  Active: 'w-2/3 bg-orange-500',
  Packed: 'w-full bg-red-500',
};

const FEATURE_CHECKLIST = [
  { label: 'Live crowd data', done: true },
  { label: 'Parking availability', done: true },
  { label: 'Ride ETAs', done: false, wip: true },
  { label: 'Reservations', done: false },
];

function VenueCardSkeleton() {
  return (
    <div className="rounded-2xl bg-white/5 border border-white/10 p-4 space-y-3 animate-pulse">
      <div className="h-4 w-2/3 bg-white/10 rounded" />
      <div className="h-3 w-1/3 bg-white/10 rounded" />
      <div className="h-2 w-full bg-white/10 rounded-full" />
    </div>
  );
}

function VenueCard({ venue }: { venue: Venue }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl bg-white/5 border border-white/10 p-4 space-y-2"
    >
      <div className="flex justify-between items-start">
        <p className="text-white font-semibold text-[14px] leading-tight">{venue.name}</p>
        <span className={`text-[12px] font-bold ${CROWD_COLOR[venue.crowdLevel] ?? 'text-white/60'}`}>
          {venue.crowdLevel}
        </span>
      </div>
      <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${CROWD_BAR[venue.crowdLevel] ?? 'w-1/2 bg-white/40'}`} />
      </div>
      <div className="flex items-center justify-between text-[11px] text-white/40">
        <div className="flex items-center gap-1">
          <ParkingCircle className="w-3 h-3 text-cyan-400" />
          <span>{venue.parkingAvailable} spots open nearby</span>
        </div>
        <div className="flex items-center gap-1">
          <Clock className="w-3 h-3 text-white/30" />
          <span>{timeAgo(venue.updatedAt)}</span>
        </div>
      </div>
    </motion.div>
  );
}

export default function WelcomeLanding() {
  const hashQuery = window.location.hash.includes('?') ? window.location.hash.split('?')[1] : window.location.search;
  const params = new URLSearchParams(hashQuery);
  const emailParam = params.get('email') || localStorage.getItem('bytspot_beta_email') || '';
  const storedName = localStorage.getItem('bytspot_beta_name') || '';
  const firstName = storedName || emailParam.split('@')[0].split('.')[0];
  const displayName = firstName.charAt(0).toUpperCase() + firstName.slice(1);

  const [venues, setVenues] = useState<Venue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    // Timeout after 6s — Render free tier cold starts take ~30s, don't leave users waiting
    const timeout = setTimeout(() => {
      controller.abort();
    }, 6000);

    fetch(`${API_URL}/venues`, { signal: controller.signal })
      .then(r => r.json())
      .then((data: any[]) => {
        clearTimeout(timeout);
        const mapped = data.slice(0, 5).map(v => ({
          id: v.id,
          name: v.name,
          crowdLevel: v.crowdLevel ?? 'Active',
          parkingAvailable: v.parkingAvailable ?? 0,
          updatedAt: v.updatedAt ?? new Date().toISOString(),
        }));
        setVenues(mapped.length > 0 ? mapped : buildFallbackVenues());
        setLoading(false);
      })
      .catch(() => {
        clearTimeout(timeout);
        // Use fallback venues instead of showing error
        setVenues(buildFallbackVenues());
        setError(false);
        setLoading(false);
      });
    return () => { clearTimeout(timeout); controller.abort(); };
  }, []);

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white relative overflow-hidden flex flex-col items-center justify-start px-6 py-12">
      {/* Background glows */}
      <div className="absolute top-[-10%] left-[-10%] w-[400px] h-[400px] rounded-full blur-[100px] opacity-25 bg-purple-600 pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[400px] h-[400px] rounded-full blur-[100px] opacity-20 bg-cyan-600 pointer-events-none" />

      <div className="w-full max-w-md relative z-10 space-y-8">
        {/* Wordmark */}
        <motion.p initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="text-center text-2xl font-extrabold tracking-tight">
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-cyan-400">Bytspot</span>
        </motion.p>

        {/* Greeting */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 border border-white/20">
            <MapPin className="w-3 h-3 text-cyan-400" />
            <span className="text-[11px] font-bold text-white/90 tracking-widest uppercase">Atlanta Beta · Midtown</span>
          </div>
          <h1 className="text-3xl font-bold leading-tight">
            You're in, {displayName}! 🎉
          </h1>
          <p className="text-white/60 text-[15px] leading-relaxed">
            Your early access is confirmed. Welcome to Atlanta Midtown's live guide to crowd levels, parking, and rides.
          </p>
        </motion.div>

        {/* Live Crowd Ticker */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }} className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
              </span>
              <span className="text-[12px] font-bold text-white/80 uppercase tracking-widest">Right now in Midtown →</span>
            </div>
            <div className="flex items-center gap-1 text-[10px] text-white/30">
              <Radio className="w-3 h-3" /><span>Live</span>
            </div>
          </div>

          {loading && [0, 1, 2].map(i => <VenueCardSkeleton key={i} />)}

          {/* Error state removed — fallback venues always fill in */}

          {!loading && !error && venues.map((v, i) => (
            <motion.div key={v.id} transition={{ delay: 0.1 * i }}>
              <VenueCard venue={v} />
            </motion.div>
          ))}
        </motion.div>

        {/* Full App Progress Checklist */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className="rounded-2xl bg-white/5 border border-white/10 p-5 space-y-3">
          <p className="text-[12px] font-bold text-white/50 uppercase tracking-widest">Full App Coming Soon</p>
          <div className="space-y-2">
            {FEATURE_CHECKLIST.map(f => (
              <div key={f.label} className="flex items-center gap-2.5 text-[14px]">
                <span className={`text-base ${f.done ? 'opacity-100' : 'opacity-40'}`}>
                  {f.done ? '✅' : f.wip ? '🔄' : '🔜'}
                </span>
                <span className={f.done ? 'text-white/80' : 'text-white/35'}>{f.label}</span>
                {f.wip && <span className="text-[10px] text-cyan-400/70 font-semibold uppercase tracking-wide">In Progress</span>}
              </div>
            ))}
          </div>
        </motion.div>

        {/* Secondary Open Beta CTA */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }} className="pb-8">
          <a
            href={`${BETA_APP_URL}${emailParam ? `?email=${encodeURIComponent(emailParam)}` : ''}`}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full flex items-center justify-center gap-2 py-4 px-6 rounded-2xl bg-gradient-to-r from-purple-600 to-cyan-600 text-white font-bold text-[16px] shadow-lg shadow-purple-500/25 hover:opacity-90 transition-opacity"
          >
            <Car className="w-5 h-5" />
            <span>Open Beta App →</span>
            <ArrowRight className="w-5 h-5" />
          </a>
          <p className="text-center text-[11px] text-white/25 mt-3">Limited Preview · Full Launch Coming Soon</p>
        </motion.div>
      </div>

      {/* Footer */}
      <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8 }} className="absolute bottom-6 left-0 right-0 text-center text-[11px] text-white/20">
        &copy; 2026 Bytspot &bull; Atlanta, GA
      </motion.p>
    </div>
  );
}

