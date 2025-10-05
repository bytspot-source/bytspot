import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Search,
  MapPin,
  Users,
  Star,
  Car,
  UtensilsCrossed,
  Shield,
  Sun,
  Cloud,
  CloudRain,
  Navigation
} from 'lucide-react';
import { Mic } from 'lucide-react';

import { Button } from './ui/button';

interface LandingPageProps {
  onGetStarted: () => void;
  onBecomeHost: () => void;
  onSignIn: () => void;
  onAskConcierge: (query: string) => void;
}

interface WeatherData {
  temperature: number;
  feelsLike: number;
  condition: string;
  location: string;
  icon: React.ReactNode;
}

export function LandingPage({ onGetStarted, onBecomeHost, onSignIn, onAskConcierge }: LandingPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [weather, setWeather] = useState<WeatherData>({
    temperature: 72,
    feelsLike: 72,
    condition: 'Clear',
    location: 'Near you',
    icon: <Sun className="w-4 h-4" />
  });
  const [activeUsers, setActiveUsers] = useState(() => 850 + Math.floor(Math.random()*900));
  const [timeOfDay, setTimeOfDay] = useState('afternoon');
  const [currentTheme, setCurrentTheme] = useState('cloudy');
  const [locationTheme] = useState('beach');
  const [conciergePrompt, setConciergePrompt] = useState<{ query: string; count: number } | null>(null);
  const [isNewUser, setIsNewUser] = useState(false);
  useEffect(() => {
    try {
      setIsNewUser(typeof window !== 'undefined' && localStorage.getItem('bytspot_seen_splash') !== 'true');
    } catch { setIsNewUser(true); }
  }, []);

  const [isScrolled, setIsScrolled] = useState(false);
  const prefersReducedMotion = typeof window !== 'undefined' && (window as any).matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const iosSpring = { type: 'spring' as const, stiffness: 320, damping: 30, mass: 0.8 };

  useEffect(() => {
    const onScroll = () => setIsScrolled(window.scrollY > 50);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const [listening, setListening] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const timerRef = useRef<number | null>(null);
  const startAtRef = useRef<number | null>(null);

  const formatElapsed = (s: number) => {
    const mm = Math.floor(s / 60);
    const ss = (s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  };


  // Live time-of-day + geolocated weather and city (with fallbacks)
  useEffect(() => {
    const updateTime = () => {
      const hour = new Date().getHours();
      if (hour >= 5 && hour < 12) setTimeOfDay('morning');
      else if (hour >= 12 && hour < 17) setTimeOfDay('afternoon');
      else if (hour >= 17 && hour < 21) setTimeOfDay('evening');
      else setTimeOfDay('night');
    };
    updateTime();
    const timeIv = setInterval(updateTime, 300000);

    const setIconForCode = (code: number) => {
      if (code === 0) return <Sun className="w-4 h-4" />;
      if ([1,2,3,45,48].includes(code)) return <Cloud className="w-4 h-4" />;
      if ([51,53,55,56,57,61,63,65,80,81,82].includes(code)) return <CloudRain className="w-4 h-4" />;
      if ([71,73,75,85,86].includes(code)) return <CloudRain className="w-4 h-4" />;
      if ([95,96,99].includes(code)) return <CloudRain className="w-4 h-4" />;
      return <Sun className="w-4 h-4" />;
    };
    const conditionLabel = (code: number) => {
      if (code === 0) return 'Clear';
      if ([1,2,3,45,48].includes(code)) return 'Clouds';
      if ([51,53,55,56,57,61,63,65,80,81,82].includes(code)) return 'Rain';
      if ([71,73,75,85,86].includes(code)) return 'Snow';
      if ([95,96,99].includes(code)) return 'Storm';
      return 'Clear';
    };

    const fallback = () => setWeather(prev => ({ ...prev, temperature: 72, condition: 'Clear', icon: <Sun className="w-4 h-4" />, location: 'Near you' }));

    if (!navigator.geolocation) { fallback(); return () => clearInterval(timeIv); }

    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const { latitude: lat, longitude: lon } = pos.coords;
        // Weather
        const wxRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
        if (wxRes.ok) {
          const wx = await wxRes.json();
          const cw = wx.current_weather;
          const tempF = Math.round((cw.temperature * 9/5) + 32);
          setWeather(prev => ({ ...prev, temperature: tempF, condition: conditionLabel(cw.weathercode), icon: setIconForCode(cw.weathercode) }));
        } else {
          fallback();
        }
        // Reverse geocode
        try {
          const locRes = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
          if (locRes.ok) {
            const loc = await locRes.json();
            const city = loc.city || loc.locality || loc.principalSubdivision || 'Near you';
            setWeather(prev => ({ ...prev, location: city }));
          }
        } catch {}
      } catch {
        fallback();
      }
    }, () => fallback(), { enableHighAccuracy: true, timeout: 5000 });

    return () => clearInterval(timeIv);
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      onGetStarted();
    }
  };

  const curateCount = (q: string) => {
    const catalog = [
      'parking','valet','restaurant','bar','cafe','coffee','event',
      'museum','theater','club','ev','charging','gas','hotel'
    ];
    const text = q.toLowerCase();
    return catalog.filter((c) => text.includes(c)).length;
  };

  const handleVoiceSearch = async () => {
    try {
      if ('vibrate' in navigator) { navigator.vibrate(10); }
      const doCurate = (q: string) => {
        const count = curateCount(q);
        setConciergePrompt({ query: q, count });
        if (!q) setConciergePrompt(null);
      };

      const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SR) {
        const rec = new SR();
        rec.lang = 'en-US';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        rec.onstart = () => {
          setListening(true);
          startAtRef.current = Date.now();
          setElapsedSec(0);
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = window.setInterval(() => {
            if (startAtRef.current) {
              setElapsedSec(Math.max(0, Math.floor((Date.now() - startAtRef.current) / 1000)));
            }
          }, 200);
        };
        rec.onend = () => {
          setListening(false);
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        };
        rec.onresult = (e: any) => {
          const text = e.results?.[0]?.[0]?.transcript || '';
          setSearchQuery(text);
          doCurate(text.toLowerCase());
        };
        rec.onerror = () => {
          const fallback = prompt('Speak not supported. Type your request:') || '';
          setSearchQuery(fallback);
          doCurate(fallback.toLowerCase());
        };
        rec.start();
      } else {
        const fallback = prompt('Voice not supported. Type your request:') || '';
        setSearchQuery(fallback);
        doCurate(fallback.toLowerCase());
      }
    } catch (e) {
      const fallback = prompt('Voice failed. Type your request:') || '';
      setSearchQuery(fallback);
      const count = curateCount(fallback);
      setConciergePrompt({ query: fallback.toLowerCase(), count });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] text-white">
      {/* Status Header: Live Weather • Active Users • Location */}
      <motion.div
        initial={{ y: -50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="bg-black/40 backdrop-blur-sm border-b border-white/10 px-4 py-3"
      >
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between text-xs text-white/80 bg-white/5 border border-white/15 backdrop-blur-md rounded-2xl px-4 py-2 shadow-[0_10px_30px_rgba(0,0,0,0.25)]">
            <div className="inline-flex items-center gap-1">{weather.icon}<span>{weather.temperature}°F</span><span className="text-white/40 ml-2">•</span><span>{weather.condition}</span></div>
            <div className="text-white/40">•</div>
            <div className="inline-flex items-center gap-1"><Users className="w-4 h-4 opacity-70" /><span>{activeUsers.toLocaleString()} nearby</span></div>
            <div className="text-white/40">•</div>
            <div className="inline-flex items-center gap-1"><MapPin className="w-4 h-4 opacity-70" /><span className="text-white/70">{weather.location}</span></div>
          </div>
        </div>
      </motion.div>

      {/* Navigation */}
      <motion.nav
        initial={{ y: -30, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={prefersReducedMotion ? { duration: 0 } : { ...iosSpring, delay: 0.1 }}
        className="px-4 py-4 border-b border-white/10"
      >
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <motion.div
            className="text-2xl font-bold bg-gradient-to-r from-[#00BFFF] via-[#FF00FF] to-[#FF4500] bg-clip-text text-transparent"
            animate={{ opacity: isScrolled ? 1 : 0, y: isScrolled ? 0 : -10 }}
            transition={prefersReducedMotion ? { duration: 0 } : iosSpring}
          >
            Bytspot
          </motion.div>
          <div className="flex items-center space-x-6">
            {!isNewUser && (
              <>
                <Button
                  variant="ghost"
                  onClick={onSignIn}
                  className="min-h-[44px] text-white text-sm px-3 py-2 rounded-lg hover:text-[#A855F7] hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-[#A855F7]/50"
                >
                  Sign In
                </Button>
                <Button
                  variant="ghost"
                  onClick={onBecomeHost}
                  className="min-h-[44px] text-white text-sm px-3 py-2 rounded-lg hover:text-[#A855F7] hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-[#A855F7]/50"
                >
                  Become a Host
                </Button>
              </>
            )}
          </div>
        </div>
      </motion.nav>

      {/* Hero Section */}
      <div className="max-w-3xl mx-auto px-4 py-16">
        <motion.div
          initial={{ y: 50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="text-center mb-12"
        >
          <motion.h1
            className="text-6xl font-bold mb-3 bg-gradient-to-r from-[#A855F7] to-[#D946EF] bg-clip-text text-transparent"
            animate={{ opacity: isScrolled ? 0 : 1, scale: isScrolled ? 0.92 : 1 }}
            transition={prefersReducedMotion ? { duration: 0 } : iosSpring}
          >
            Bytspot
          </motion.h1>
          <p className="text-xl text-white/80 mb-2 max-w-2xl mx-auto">Discover. Park. Experience</p>
          {isNewUser && (
            <div className="mt-1 text-sm text-white/80">
              <div className="flex items-center justify-center gap-6">
                <button onClick={onSignIn} className="hover:text-white">Sign In</button>
                <span className="text-white/40">•</span>
                <button onClick={onBecomeHost} className="hover:text-white">Become a Host</button>
              </div>
            </div>
          )}

          {/* Search Bar */}
          <motion.form
            onSubmit={handleSearch}
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="max-w-2xl mx-auto mb-8"
          >
            <div className="relative p-[1.5px] rounded-[9999px] bg-gradient-to-r from-[#A855F7]/40 to-[#D946EF]/40">
              <div className="relative rounded-[9999px] bg-white/5 backdrop-blur-md border border-white/10 shadow-[inset_0_1px_3px_rgba(0,0,0,0.35)]">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-white/50 w-5 h-5" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search places, parking, valet…"
                  className="w-full pl-12 pr-16 py-4 bg-transparent border-0 rounded-[9999px] text-white placeholder-white/60 focus:outline-none focus:ring-0"
                />
                {/* Voice mic (icon only) with pulse + timer when listening) */}
                <Button
                  type="button"
                  aria-label="Voice search"
                  variant="ghost"
                  onClick={handleVoiceSearch}
                  className={`absolute right-3 top-1/2 -translate-y-1/2 size-11 min-w-[44px] min-h-[44px] rounded-full shadow-lg ${listening ? 'animate-pulse ring-2 ring-fuchsia-400/60 text-white bg-gradient-to-r from-[#A855F7] to-[#D946EF]' : 'text-white bg-gradient-to-r from-[#A855F7] to-[#D946EF] hover:opacity-90'}`}
                >
                  <Mic className="w-5 h-5" />
                </Button>
                {listening && (
                  <span className="absolute right-16 top-1/2 -translate-y-1/2 text-xs text-white/90 bg-black/50 px-2 py-1 rounded-md">
                    {formatElapsed(elapsedSec)}
                  </span>
                )}
              </div>
            </div>
          </motion.form>

          {/* Feature grid (matches attachments) */}
          <div className="grid grid-cols-2 gap-4 max-w-3xl mx-auto mb-10">
            <div className="bg-white/5 border border-white/15 rounded-[20px] p-4 group transition-all transform will-change-transform hover:-translate-y-0.5 hover:scale-[1.01] hover:bg-white/8 hover:shadow-[0_12px_40px_rgba(168,85,247,0.15)]">
              <div className="text-[11px] text-white/50 mb-1">Near destination</div>
              <button
                type="button"
                onClick={() => { if ('vibrate' in navigator) navigator.vibrate(10); setSearchQuery('parking'); onAskConcierge('parking'); }}
                className="text-left w-full"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-lg font-semibold text-cyan-300">Find</div>
                    <div className="text-white/80">Parking</div>
                  </div>
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-r from-[#22d3ee] to-[#0ea5e9] flex items-center justify-center transition-transform group-hover:scale-105">
                    <Car className="w-5 h-5" />
                  </div>
                </div>
              </button>
            </div>
            <div className="bg-white/5 border border-white/15 rounded-[20px] p-4 group transition-all transform will-change-transform hover:-translate-y-0.5 hover:scale-[1.01] hover:bg-white/8 hover:shadow-[0_12px_40px_rgba(168,85,247,0.15)]">
              <div className="text-[11px] text-white/50 mb-1">Premium service</div>
              <button
                type="button"
                onClick={() => { if ('vibrate' in navigator) navigator.vibrate(10); setSearchQuery('valet booking'); onAskConcierge('valet booking'); }}
                className="text-left w-full"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-lg font-semibold text-fuchsia-300">Book</div>
                    <div className="text-white/80">Valet</div>
                  </div>
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-r from-[#A855F7] to-[#D946EF] flex items-center justify-center transition-transform group-hover:scale-105">
                    <Users className="w-5 h-5" />
                  </div>
                </div>
              </button>
            </div>
            <div className="bg-white/5 border border-white/15 rounded-[20px] p-4 group transition-all transform will-change-transform hover:-translate-y-0.5 hover:scale-[1.01] hover:bg-white/8 hover:shadow-[0_12px_40px_rgba(168,85,247,0.15)]">
              <div className="text=[11px] text-white/50 mb-1">Personalized</div>
              <button
                type="button"
                onClick={() => { if ('vibrate' in navigator) navigator.vibrate(10); setSearchQuery('venues'); onAskConcierge('venues'); }}
                className="text-left w-full"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-lg font-semibold text-amber-300">Find</div>
                    <div className="text-white/80">Venues</div>
                  </div>
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-r from-[#f59e0b] to-[#f97316] flex items-center justify-center transition-transform group-hover:scale-105">
                    <Star className="w-5 h-5" />
                  </div>
                </div>
              </button>
            </div>
            <div className="bg-white/5 border border-white/15 rounded-[20px] p-4 group transition-all transform will-change-transform hover:-translate-y-0.5 hover:scale-[1.01] hover:bg-white/8 hover:shadow-[0_12px_40px_rgba(168,85,247,0.15)]">
              <div className="text-[11px] text-white/50 mb-1">Optimized route</div>
              <button
                type="button"
                onClick={() => { if ('vibrate' in navigator) navigator.vibrate(10); setSearchQuery('directions'); onAskConcierge('directions'); }}
                className="text-left w-full"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-lg font-semibold text-emerald-300">Get</div>
                    <div className="text-white/80">Directions</div>
                  </div>
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-r from-[#10b981] to-[#34d399] flex items-center justify-center transition-transform group-hover:scale-105">
                    <Navigation className="w-5 h-5" />
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Featured Locations */}
          <div className="max-w-3xl mx-auto">
            <h3 className="text-sm text-white/70 mb-3">Featured Locations</h3>
            <div className="space-y-3">
              <div className="bg-white/5 border border-white/15 rounded-[20px] p-4 flex items-center justify-between group transition-all transform will-change-transform hover:-translate-y-0.5 hover:scale-[1.01] hover:bg-white/8 hover:shadow-[0_12px_40px_rgba(168,85,247,0.15)]">
                <div>
                  <div className="text-white font-medium">Downtown Plaza</div>
                  <div className="text-white/60 text-sm">0.3 mi away • 24 spots</div>
                </div>
                <div className="w-9 h-9 rounded-xl bg-gradient-to-r from-[#A855F7] to-[#D946EF] flex items-center justify-center transition-transform group-hover:scale-105">
                  <MapPin className="w-5 h-5" />
                </div>
              </div>
              <div className="bg-white/5 border border-white/15 rounded-[20px] p-4 flex items-center justify-between group transition-all transform will-change-transform hover:-translate-y-0.5 hover:scale-[1.01] hover:bg-white/8 hover:shadow-[0_12px_40px_rgba(168,85,247,0.15)]">
                <div>
                  <div className="text-white font-medium">Central Station</div>
                  <div className="text-white/60 text-sm">0.5 mi away • 18 spots</div>
                </div>
                <div className="w-9 h-9 rounded-xl bg-gradient-to-r from-[#22d3ee] to-[#0ea5e9] flex items-center justify-center transition-transform group-hover:scale-105">
                  <MapPin className="w-5 h-5" />
                </div>
              </div>
              <div className="bg-white/5 border border-white/15 rounded-[20px] p-4 flex items-center justify-between group transition-all transform will-change-transform hover:-translate-y-0.5 hover:scale-[1.01] hover:bg-white/8 hover:shadow-[0_12px_40px_rgba(168,85,247,0.15)]">
                <div>
                  <div className="text-white font-medium">Bay Area Mall</div>
                  <div className="text-white/60 text-sm">0.8 mi away • 42 spots</div>
                </div>
                <div className="w-9 h-9 rounded-xl bg-gradient-to-r from-[#10b981] to-[#34d399] flex items-center justify-center transition-transform group-hover:scale-105">
                  <MapPin className="w-5 h-5" />
                </div>
              </div>
            </div>
          </div>


        </motion.div>

        {/* Concierge Prompt after voice input */}
        {conciergePrompt && (
          <div className="max-w-2xl mx-auto mb-10">
            <div className="glass-card rounded-2xl p-4 flex items-center justify-between">
              <div>
                <div className="text-white font-medium">Concierge found {conciergePrompt.count} matches</div>
                <div className="text-white/70 text-sm">“{conciergePrompt.query}” • Ask Concierge to curate</div>
              </div>
              <Button onClick={() => conciergePrompt && onAskConcierge(conciergePrompt.query)} className="bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] hover:opacity-90 rounded-xl">
                Ask Concierge
              </Button>
            </div>
          </div>
        )}

        {/* Stats */}
        <motion.div
          initial={{ y: 30, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-16"
        >
          <div className="text-center">
            <div className="text-4xl font-bold text-[#00BFFF] mb-2">50K+</div>
            <div className="text-white/70">Happy Users</div>
          </div>
          <div className="text-center">
            <div className="text-4xl font-bold text-[#FF00FF] mb-2">1.2M+</div>
            <div className="text-white/70">Spots Found</div>

          </div>
          <div className="text-center">
            <div className="text-4xl font-bold text-[#FF4500] mb-2">4.9★</div>
            <div className="text-white/70">User Rating</div>
          </div>
        </motion.div>

        {/* Features */}
        <motion.div
          initial={{ y: 50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-16"
        >
          <motion.div
            whileHover={{ scale: 1.05, y: -5 }}
            className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-8 text-center"
          >
            <div className="w-16 h-16 bg-gradient-to-r from-[#00BFFF] to-[#008080] rounded-2xl flex items-center justify-center mx-auto mb-6">
              <Car className="w-8 h-8 text-white" />
            </div>
            <h3 className="text-xl font-semibold mb-4">Smart Parking</h3>
            <p className="text-white/70">
              Find and reserve perfect parking spots instantly with real-time availability
            </p>
          </motion.div>

          <motion.div
            whileHover={{ scale: 1.05, y: -5 }}
            className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-8 text-center"
          >
            <div className="w-16 h-16 bg-gradient-to-r from-[#FF00FF] to-[#8B5CF6] rounded-2xl flex items-center justify-center mx-auto mb-6">
              <UtensilsCrossed className="w-8 h-8 text-white" />
            </div>
            <h3 className="text-xl font-semibold mb-4">Venue Discovery</h3>
            <p className="text-white/70">
              Discover amazing restaurants, bars, and entertainment venues near you
            </p>
          </motion.div>

          <motion.div
            whileHover={{ scale: 1.05, y: -5 }}
            className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-8 text-center"
          >
            <div className="w-16 h-16 bg-gradient-to-r from-[#FF4500] to-[#FF6B35] rounded-2xl flex items-center justify-center mx-auto mb-6">
              <Shield className="w-8 h-8 text-white" />
            </div>
            <h3 className="text-xl font-semibold mb-4">Premium Services</h3>
            <p className="text-white/70">
              Access exclusive valet services and premium experiences effortlessly
            </p>
          </motion.div>
        </motion.div>

        {/* CTA */}
        <motion.div
          initial={{ y: 30, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="text-center"
        >
          <Button
            onClick={onGetStarted}
            className="bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] hover:opacity-90 text-white px-12 py-4 text-lg font-semibold rounded-2xl shadow-2xl"
          >
            Start Matching
          </Button>
        </motion.div>
      </div>

      {/* Footer */}
      <motion.footer
        initial={{ y: 50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.7 }}
        className="border-t border-white/10 py-8 mt-16"
      >
        <div className="max-w-7xl mx-auto px-4 text-center">
          <p className="text-white/50 mb-4">
            © 2025 Bytspot
          </p>
          <div className="flex items-center justify-center space-x-6 text-sm text-white/50">
            <a href="#" className="hover:text-white transition-colors">Privacy Policy</a>
            <span>•</span>
            <a href="#" className="hover:text-white transition-colors">Terms of Service</a>
          </div>
        </div>
      </motion.footer>
    </div>
  );
}
