import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { MapPin, Users, Car, Clock, KeyRound, Mail, ArrowRight, Check, Shield, ExternalLink, Lock, Smartphone, Radio, ParkingCircle } from 'lucide-react';
import { toast, Toaster } from 'sonner';

const BACKEND_PROVIDER: 'formspree' | 'custom' | 'mock' = 'formspree';
const FORMSPREE_FORM_ID = 'xqedgrzv';
const CUSTOM_API_URL = 'https://api.example.com/beta-signup';

/** P3: Dynamic spots counter — decrements based on days since launch */
function getSpotsLeft(): number {
  const launchDate = new Date('2026-02-24').getTime();
  const now = Date.now();
  const daysSinceLaunch = Math.floor((now - launchDate) / (1000 * 60 * 60 * 24));
  const base = 47;
  const decrement = daysSinceLaunch * 2 + Math.floor((now / (1000 * 60 * 60 * 6)) % 3);
  return Math.max(3, base - decrement);
}

interface BetaSignupProps { isDarkMode?: boolean; onComplete?: () => void; standalone?: boolean; }

async function submitEmail(email: string): Promise<{ ok: boolean; message?: string }> {
  switch (BACKEND_PROVIDER) {
    case 'formspree': {
      const res = await fetch(`https://formspree.io/f/${FORMSPREE_FORM_ID}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, _subject: 'Bytspot Beta Signup', source: 'beta-funnel' }),
      });
      if (!res.ok) { const data = await res.json().catch(() => ({})); return { ok: false, message: data?.error || 'Signup failed.' }; }
      return { ok: true };
    }
    case 'custom': {
      const res = await fetch(CUSTOM_API_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, timestamp: new Date().toISOString(), source: 'beta-funnel' }),
      });
      if (!res.ok) return { ok: false, message: 'Signup failed.' };
      return { ok: true };
    }
    case 'mock': default: { await new Promise((r) => setTimeout(r, 1500)); return { ok: true }; }
  }
}

export function BetaSignup({ isDarkMode = true, onComplete, standalone = false }: BetaSignupProps) {
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const spotsLeft = useMemo(() => getSpotsLeft(), []);
  const [alreadySignedUp, setAlreadySignedUp] = useState(false);

  useEffect(() => { const s = localStorage.getItem('bytspot_beta_signed_up'); if (s) { setAlreadySignedUp(true); setIsSuccess(true); } }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) { toast.error('Please enter your email'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast.error('Please enter a valid email'); return; }
    setIsSubmitting(true);
    try {
      const result = await submitEmail(email);
      if (result.ok) {
        setIsSuccess(true); localStorage.setItem('bytspot_beta_signed_up', 'true'); localStorage.setItem('bytspot_beta_email', email);
        toast.success('Welcome to the Inner Circle!', { description: "You've secured your spot for the Midtown Beta." });
        if (onComplete) setTimeout(() => onComplete(), 2500);
      } else { toast.error(result.message || 'Something went wrong.'); }
    } catch { toast.error('Network error. Please check your connection.'); }
    finally { setIsSubmitting(false); }
  };

  return (<>
    {standalone && <Toaster />}
    <div className={`min-h-screen relative overflow-hidden flex flex-col items-center justify-center px-6 py-12 ${isDarkMode ? 'bg-[#000000]' : 'bg-[#F5F7FA]'}`}>
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className={`absolute top-[-10%] left-[-10%] w-[500px] h-[500px] rounded-full blur-[100px] opacity-30 ${isDarkMode ? 'bg-purple-600' : 'bg-purple-400'}`} />
        <div className={`absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] rounded-full blur-[100px] opacity-20 ${isDarkMode ? 'bg-cyan-600' : 'bg-cyan-400'}`} />
        {standalone && <div className="absolute top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full blur-[120px] opacity-10 bg-purple-500" />}
      </div>
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md relative z-10 flex flex-col gap-8">
        {!isSuccess ? (<>
          <HeaderSection />
          <ProductMockCard />
          <SignupForm email={email} setEmail={setEmail} isSubmitting={isSubmitting} spotsLeft={spotsLeft} isDarkMode={isDarkMode} onSubmit={handleSubmit} />
        </>) : (
          <SuccessState alreadySignedUp={alreadySignedUp} onComplete={onComplete} standalone={standalone} />
        )}
      </motion.div>
      {standalone && (<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8 }} className="absolute bottom-6 left-0 right-0 text-center"><p className="text-[11px] text-white/20">&copy; 2026 Bytspot &bull; Atlanta, GA</p></motion.div>)}
    </div>
  </>);
}

function HeaderSection() {
  return (
    <div className="text-center space-y-4">
      {/* P1: Bytspot wordmark */}
      <motion.p initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="text-2xl font-extrabold tracking-tight">
        <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-cyan-400">Bytspot</span>
      </motion.p>
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 backdrop-blur-md border border-white/20 shadow-lg">
        <MapPin className="w-3 h-3 text-cyan-400" />
        <span className="text-[11px] font-bold text-white/90 tracking-widest uppercase">Atlanta Beta &bull; Midtown</span>
      </div>
      <h1 className="text-4xl md:text-5xl font-bold text-white tracking-tight leading-[1.1]">Know{' '}<span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-cyan-400">Before</span>{' '}You Go.</h1>
      <p className="text-[17px] text-white/70 max-w-sm mx-auto leading-relaxed">Bytspot shows live crowd levels, parking availability, and ride options — all in one place.</p>
      {/* P2: Feature bullets */}
      <div className="flex items-center justify-center gap-4 pt-1">
        <span className="flex items-center gap-1.5 text-[11px] text-white/50"><Radio className="w-3.5 h-3.5 text-red-400" />Live Crowds</span>
        <span className="text-white/20">·</span>
        <span className="flex items-center gap-1.5 text-[11px] text-white/50"><ParkingCircle className="w-3.5 h-3.5 text-cyan-400" />Open Parking</span>
        <span className="text-white/20">·</span>
        <span className="flex items-center gap-1.5 text-[11px] text-white/50"><Car className="w-3.5 h-3.5 text-purple-400" />Ride ETAs</span>
      </div>
      {/* P2: iOS & Android badge */}
      <div className="flex items-center justify-center gap-1.5 pt-1">
        <Smartphone className="w-3 h-3 text-white/30" />
        <span className="text-[10px] font-medium text-white/30 uppercase tracking-widest">Coming to iOS &amp; Android</span>
      </div>
    </div>
  );
}

function ProductMockCard() {
  return (
    <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.2 }} className="relative mx-4">
      <div className="relative rounded-2xl overflow-hidden backdrop-blur-xl border border-white/15 bg-[#1C1C1E]/60 shadow-2xl">
        <div className="h-24 bg-gradient-to-br from-purple-900/40 to-black/40 flex items-end p-4 relative">
          <div className="absolute inset-0 bg-gradient-to-t from-[#1C1C1E]/90 to-transparent" />
          <div className="relative z-10 w-full flex justify-between items-end">
            <div><h3 className="text-white font-bold text-lg">Ponce City Market</h3><div className="flex items-center gap-1 text-white/60 text-xs"><MapPin className="w-3 h-3" /><span>Midtown, Atlanta</span></div></div>
            <div className="px-2 py-1 rounded-md bg-white/10 backdrop-blur-md border border-white/10"><span className="text-xs font-medium text-emerald-400">Open Now</span></div>
          </div>
        </div>
        <div className="p-4 space-y-4">
          <div className="space-y-2">
            <div className="flex justify-between text-xs font-medium text-white/60 uppercase tracking-wide"><div className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /><span>Crowd Level</span></div><span className="text-orange-400">Active</span></div>
            <div className="flex gap-1 h-2"><div className="flex-1 rounded-full bg-cyan-500/20" /><div className="flex-1 rounded-full bg-orange-500 shadow-[0_0_10px_rgba(249,115,22,0.5)]" /><div className="flex-1 rounded-full bg-red-500/20" /></div>
            <div className="flex justify-between text-[10px] text-white/40"><span>Chill</span><span>Active</span><span>Packed</span></div>
            <div className="text-center pt-1"><span className="text-[10px] text-white/60 font-medium">Busy but moving</span></div>
          </div>
          <div className="h-px bg-white/10" />
          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col items-center justify-center p-2 rounded-xl bg-white/5 border border-white/5 text-center"><div className="bg-cyan-500/20 p-1.5 rounded-full mb-1.5"><Car className="w-4 h-4 text-cyan-400" /></div><span className="text-xs font-bold text-white">42</span><span className="text-[10px] text-white/50">Spots</span></div>
            <div className="flex flex-col items-center justify-center p-2 rounded-xl bg-white/5 border border-white/5 text-center"><div className="bg-white/10 p-1.5 rounded-full mb-1.5"><Clock className="w-4 h-4 text-white" /></div><span className="text-xs font-bold text-white">6 min</span><span className="text-[10px] text-white/50">Uber ETA</span></div>
            <div className="flex flex-col items-center justify-center p-2 rounded-xl bg-white/5 border border-white/5 text-center"><div className="bg-purple-500/20 p-1.5 rounded-full mb-1.5"><KeyRound className="w-4 h-4 text-purple-400" /></div><span className="text-xs font-bold text-purple-400">Yes</span><span className="text-[10px] text-white/50">Valet</span></div>
          </div>
        </div>
      </div>
      <div className="absolute -top-6 -right-6 w-20 h-20 bg-purple-500/30 rounded-full blur-2xl pointer-events-none" />
      <div className="absolute -bottom-6 -left-6 w-20 h-20 bg-cyan-500/30 rounded-full blur-2xl pointer-events-none" />
    </motion.div>
  );
}

function SignupForm({ email, setEmail, isSubmitting, spotsLeft, isDarkMode, onSubmit }: {
  email: string; setEmail: (v: string) => void; isSubmitting: boolean; spotsLeft: number; isDarkMode: boolean; onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {/* P1: Social proof counter */}
      <p className="text-center text-[12px] text-white/50 font-medium">Join <span className="text-white/80">300+</span> Midtown locals on the waitlist</p>
      <div className="space-y-3">
        <div className={`group relative rounded-xl transition-all duration-300 ${isDarkMode ? 'bg-white/5 border border-white/10 focus-within:bg-white/10 focus-within:border-white/20' : 'bg-white/80 border border-black/10'}`}>
          <div className="absolute left-4 top-1/2 -translate-y-1/2"><Mail className="w-5 h-5 text-white/40 group-focus-within:text-purple-400 transition-colors" /></div>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Enter your email" className="w-full bg-transparent p-4 pl-12 text-white placeholder:text-white/30 focus:outline-none text-[16px]" required />
        </div>
        {/* P2: Privacy reassurance */}
        <div className="flex items-center justify-center gap-1.5">
          <Lock className="w-3 h-3 text-white/25" />
          <span className="text-[10px] text-white/30">We'll never spam you. Unsubscribe anytime.</span>
        </div>
        <div className="flex items-center justify-center gap-2">
          <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/20">
            <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span><span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span></span>
            <span className="text-[10px] font-medium text-red-200">Only {spotsLeft} Early Access spots left</span>
          </span>
        </div>
      </div>
      <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} type="submit" disabled={isSubmitting} className="w-full relative overflow-hidden rounded-xl p-4 bg-gradient-to-r from-purple-600 to-cyan-600 text-white font-bold text-lg shadow-lg shadow-purple-500/25 disabled:opacity-70 disabled:cursor-not-allowed group">
        <div className="relative z-10 flex items-center justify-center gap-2">
          {isSubmitting ? (<div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />) : (<><span>Reserve My Spot</span><ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" /></>)}
        </div>
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:animate-[shimmer_1.5s_infinite]" />
      </motion.button>
      <div className="text-center space-y-3 pt-2">
        <p className="text-sm text-white/80 font-medium">First 100 Midtown users get <span className="text-cyan-400">free parking credit</span> during beta.</p>
        <p className="text-[11px] text-white/30">Launching in select Midtown venues.</p>
      </div>
      {BACKEND_PROVIDER === 'mock' && (<div className="flex items-center justify-center gap-1.5 pt-2"><Shield className="w-3 h-3 text-yellow-500/60" /><span className="text-[10px] text-yellow-500/60">Preview mode — emails not saved. Connect Formspree to go live.</span></div>)}
    </form>
  );
}

function SuccessState({ alreadySignedUp, onComplete, standalone }: { alreadySignedUp: boolean; onComplete?: () => void; standalone: boolean }) {
  return (
    <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="text-center space-y-6 bg-white/5 backdrop-blur-xl p-8 rounded-3xl border border-white/10">
      <div className="w-20 h-20 bg-gradient-to-br from-green-400 to-emerald-600 rounded-full mx-auto flex items-center justify-center shadow-lg shadow-green-500/20"><Check className="w-10 h-10 text-white" strokeWidth={3} /></div>
      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-white">{alreadySignedUp ? "You're already on the list!" : "You're on the list."}</h2>
        <p className="text-white/70">Keep an eye on your inbox.<br />We'll notify you when your spot is ready.</p>
      </div>
      <div className="pt-4"><div className="text-sm font-medium text-purple-400 bg-purple-400/10 py-2 px-4 rounded-lg inline-block">{onComplete ? 'Entering Bytspot Preview...' : "We'll be in touch soon."}</div></div>
      {standalone && !onComplete && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }} className="pt-2">
          <p className="text-[12px] text-white/40 mb-3">Share with friends in Midtown</p>
          <div className="flex items-center justify-center gap-3">
            <button onClick={() => { const t = encodeURIComponent("I just got early access to Bytspot — live crowd levels, parking & ride options for Atlanta Midtown venues. Get yours:"); const u = encodeURIComponent(window.location.href); window.open(`https://twitter.com/intent/tweet?text=${t}&url=${u}`, '_blank'); }} className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/70 text-[13px] hover:bg-white/10 transition-colors flex items-center gap-1.5">Share on X<ExternalLink className="w-3 h-3" /></button>
            <button onClick={() => { navigator.clipboard.writeText(window.location.href); toast.success('Link copied!'); }} className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/70 text-[13px] hover:bg-white/10 transition-colors">Copy Link</button>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}

export default function BetaSignupPage() { return <BetaSignup standalone={true} />; }
