import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

interface SplashScreenProps {
  onDone?: () => void;
  totalMs?: number; // Optional override for total splash duration
}

// Brand colors
const COLORS = {
  blue: '#00BFFF',
  magenta: '#FF00FF',
  teal: '#008080',
  orange: '#FF4500',
  charcoal: '#121212',
};

// Compute stage durations from optional total duration for easy tuning
const getDurations = (total?: number) => {
  if (!total) return { logo: 1200, tag: 1200, load: 2800 };
  const logo = Math.max(600, Math.round(total * 0.28));
  const tag = Math.max(600, Math.round(total * 0.22));
  const load = Math.max(1200, total - logo - tag);
  return { logo, tag, load };
};

type Stage = 'logo' | 'tag' | 'load';

const SplashScreen: React.FC<SplashScreenProps> = ({ onDone, totalMs }) => {
  const [stage, setStage] = useState<Stage>('logo');
  const [progress, setProgress] = useState(0);
  const [featureIndex, setFeatureIndex] = useState(0);
  const D = getDurations(totalMs);
  const features = ['securing session', 'tuning interface', 'loading maps', 'prepping concierge'];

  useEffect(() => {
    // stage timeline
    const t1 = setTimeout(() => setStage('tag'), D.logo);
    const t2 = setTimeout(() => setStage('load'), D.logo + D.tag);
    const t3 = setTimeout(() => onDone?.(), D.logo + D.tag + D.load);

    // progress animation during load with ease-out curve
    const start = Date.now() + D.logo + D.tag;
    const intv = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.max(0, now - start);
      const ratio = Math.min(1, elapsed / D.load);
      const eased = 1 - Math.pow(1 - ratio, 3); // cubic ease-out
      setProgress(Math.round(eased * 100));
      if (ratio >= 1) clearInterval(intv);
    }, 50);

    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearInterval(intv); };
  }, [onDone, D.logo, D.tag, D.load]);

  // Rotate feature captions during load stage
  useEffect(() => {
    if (stage !== 'load') return;
    const iv = setInterval(() => setFeatureIndex((i) => (i + 1) % features.length), 800);
    return () => clearInterval(iv);
  }, [stage]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] text-white">
      <div className="relative w-[340px] h-[340px]">
        {/* Ambient brand glows */}
        <motion.div className="absolute -z-10 -top-12 -left-20 w-[360px] h-[360px] rounded-full" style={{background:COLORS.blue, filter:'blur(80px)', opacity:.15}} initial={{scale:.8, opacity:.1}} animate={{scale:1, opacity:.15}} transition={{duration:1.2}} />
        <motion.div className="absolute -z-10 -bottom-10 -right-16 w-[320px] h-[320px] rounded-full" style={{background:COLORS.magenta, filter:'blur(90px)', opacity:.12}} initial={{scale:.8, opacity:.08}} animate={{scale:1, opacity:.12}} transition={{duration:1.2, delay:.2}} />
        {/* Floating particles */}
        <span className="absolute w-2 h-2 rounded-full opacity-30" style={{left:'12%',top:'18%',background:COLORS.blue}} />
        <span className="absolute w-2 h-2 rounded-full opacity-30" style={{left:'82%',top:'30%',background:COLORS.magenta}} />
        <span className="absolute w-2 h-2 rounded-full opacity-30" style={{left:'20%',top:'78%',background:COLORS.teal}} />
        <span className="absolute w-2 h-2 rounded-full opacity-30" style={{left:'70%',top:'86%',background:COLORS.orange}} />

        {/* Stage: Logo */}
        <AnimatePresence>
          {stage === 'logo' && (
            <motion.div className="absolute inset-0 flex flex-col items-center justify-center"
              initial={{opacity:0, scale:.95}} animate={{opacity:1, scale:1}} exit={{opacity:0, scale:1.02}}
            >
              <div className="relative w-40 h-40">
                <motion.div className="absolute inset-0 rounded-full" style={{backdropFilter:'blur(18px)'}}
                  initial={{opacity:.6}} animate={{opacity:.9}} />
                <motion.div className="absolute inset-0 rounded-full border border-white/10"
                  animate={{ rotate: 360 }} transition={{ duration: 12, repeat: Infinity, ease: 'linear' }} />
                {/* Orbiting feature dots */}
                <motion.div className="absolute -top-1 left-1/2 -translate-x-1/2" animate={{rotate: -360}} transition={{duration: 12, repeat: Infinity, ease:'linear'}}>📍</motion.div>
                <motion.div className="absolute top-1/2 -left-1 -translate-y-1/2" animate={{rotate: -360}} transition={{duration: 12, repeat: Infinity, ease:'linear'}}>🔎</motion.div>
                <motion.div className="absolute -bottom-1 left-1/2 -translate-x-1/2" animate={{rotate: -360}} transition={{duration: 12, repeat: Infinity, ease:'linear'}}>👥</motion.div>
                <motion.div className="absolute top-1/2 -right-1 -translate-y-1/2" animate={{rotate: -360}} transition={{duration: 12, repeat: Infinity, ease:'linear'}}>🧭</motion.div>
              </div>
              <motion.div className="mt-4 text-4xl font-extrabold"
                style={{background:'linear-gradient(90deg,#00BFFF,#FF00FF,#FF4500,#008080)',WebkitBackgroundClip:'text',backgroundClip:'text',color:'transparent'}}
                initial={{opacity:0,y:6}} animate={{opacity:1,y:0}}
              >Bytspot</motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Stage: Tagline */}
        <AnimatePresence>
          {stage === 'tag' && (
            <motion.div className="absolute inset-0 flex items-center justify-center"
              initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
            >
              <div className="text-center">
                <div className="text-2xl font-semibold">Urban Discovery Reimagined</div>
                <div className="text-white/70 mt-1">Powered by AI</div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Stage: Loading */}
        <AnimatePresence>
          {stage === 'load' && (
            <motion.div className="absolute inset-0 flex items-center justify-center"
              initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
            >
              <div className="w-full px-4 text-center">
                <div className="grid grid-cols-4 gap-3 mb-4 text-sm text-white/80">
                  <div className="px-3 py-2 rounded-lg bg-white/5">📍 Map</div>
                  <div className="px-3 py-2 rounded-lg bg-white/5">🔎 Search</div>
                  <div className="px-3 py-2 rounded-lg bg-white/5">🏬 Venues</div>
                  <div className="px-3 py-2 rounded-lg bg-white/5">🧭 Directions</div>
                </div>
                <div className="h-2 w-56 mx-auto bg-white/15 rounded-full overflow-hidden">
                  <motion.div className="h-2 bg-gradient-to-r from-[#00BFFF] to-[#FF00FF]"
                    initial={{width:0}} animate={{width: `${progress}%`}} transition={{type:'tween', duration:.06}}
                  />
                </div>
                <div className="text-xs text-white/70 mt-2">Preparing {features[featureIndex]}…</div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="absolute bottom-3 inset-x-0 text-center text-[11px] text-white/50">v0.1 • © Bytspot</div>
      </div>
    </div>
  );
};

export default SplashScreen;

