import React, { useState } from 'react';
import { motion } from 'motion/react';
import { MapPin, Search, Heart, Zap, Users, Car, UtensilsCrossed, Camera, Star, Clock, Shield } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ImageWithFallback } from './figma/ImageWithFallback';
import { BytspotColors } from './BytspotColors';

interface HomePageProps {
  onGetStarted: () => void;
  onAddressSubmit: (address: string) => void;
  onHostOnboarding: () => void;
  currentTheme?: string;
  weatherTheme?: string;
  locationTheme?: string;
  themeColors?: {
    primary: string;
    secondary: string;
    accent: string;
    bg: string;
    particles: string;
  };
  isLoading?: boolean;
  connectivity?: { isOnline: boolean; isSlowConnection: boolean };
}

export function HomePage({ 
  onGetStarted, 
  onAddressSubmit, 
  onHostOnboarding, 
  currentTheme, 
  weatherTheme, 
  locationTheme, 
  themeColors,
  isLoading = false,
  connectivity = { isOnline: true, isSlowConnection: false }
}: HomePageProps) {
  const [address, setAddress] = useState('');
  const [selectedSuggestion, setSelectedSuggestion] = useState<string | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isSearchFocused, setIsSearchFocused] = useState(false);

  const handleAddressSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (address.trim()) {
      onAddressSubmit(address.trim());
    }
  };

  const features = [
    {
      icon: <Car className="w-8 h-8" />,
      title: "Smart Parking",
      description: "Find and reserve perfect parking spots instantly with real-time availability",
      color: "from-[#00BFFF] to-[#008080]",
      gradient: BytspotColors.getServiceGradient('parking')
    },
    {
      icon: <UtensilsCrossed className="w-8 h-8" />,
      title: "Venue Discovery",
      description: "Discover amazing restaurants, bars, and entertainment venues near you",
      color: "from-[#FF00FF] to-[#00BFFF]",
      gradient: BytspotColors.getServiceGradient('venue')
    },
    {
      icon: <Users className="w-8 h-8" />,
      title: "Premium Services",
      description: "Access exclusive valet services and premium experiences effortlessly",
      color: "from-[#008080] to-[#FF00FF]",
      gradient: BytspotColors.getServiceGradient('valet')
    }
  ];

  const stats = [
    { value: "50K+", label: "Happy Users" },
    { value: "1.2M+", label: "Spots Found" },
    { value: "4.9★", label: "User Rating" }
  ];

  const contextualSuggestions = [
    {
      id: 'parking-downtown',
      title: 'Downtown parking spots',
      subtitle: 'Smart Parking',
      type: 'parking',
      icon: <Car className="w-4 h-4" />,
      color: 'from-[#00BFFF] to-[#008080]'
    },
    {
      id: 'parking-airport',
      title: 'Airport parking deals',
      subtitle: 'Smart Parking',
      type: 'parking',
      icon: <Car className="w-4 h-4" />,
      color: 'from-[#00BFFF] to-[#008080]'
    },
    {
      id: 'dining-romantic',
      title: 'Romantic dinner spots',
      subtitle: 'Venue Discovery',
      type: 'dining',
      icon: <UtensilsCrossed className="w-4 h-4" />,
      color: 'from-[#FF00FF] to-[#00BFFF]'
    },
    {
      id: 'dining-trendy',
      title: 'Trending restaurants',
      subtitle: 'Venue Discovery',
      type: 'dining',
      icon: <UtensilsCrossed className="w-4 h-4" />,
      color: 'from-[#FF00FF] to-[#00BFFF]'
    },
    {
      id: 'valet-luxury',
      title: 'Luxury valet service',
      subtitle: 'Premium Services',
      type: 'valet',
      icon: <Users className="w-4 h-4" />,
      color: 'from-[#008080] to-[#FF00FF]'
    },
    {
      id: 'valet-events',
      title: 'Event valet booking',
      subtitle: 'Premium Services',
      type: 'valet',
      icon: <Users className="w-4 h-4" />,
      color: 'from-[#008080] to-[#FF00FF]'
    }
  ];

  const getFilteredSuggestions = () => {
    if (!address.trim()) return contextualSuggestions.slice(0, 4);
    
    const query = address.toLowerCase();
    return contextualSuggestions.filter(suggestion => 
      suggestion.title.toLowerCase().includes(query) ||
      suggestion.subtitle.toLowerCase().includes(query) ||
      suggestion.type.toLowerCase().includes(query)
    ).slice(0, 4);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="min-h-screen flex flex-col relative z-10"
    >
      {/* Header - Enhanced */}
      <motion.header
        initial={{ y: -50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2, type: "spring", stiffness: 400, damping: 25 }}
        className="flex justify-between items-center p-4 sm:p-6 border-b border-white/10 safe-area-top"
        style={{
          backdropFilter: 'blur(20px) saturate(180%)',
          background: 'linear-gradient(135deg, rgba(18, 18, 18, 0.8) 0%, rgba(0, 191, 255, 0.05) 50%, rgba(255, 0, 255, 0.05) 100%)',
          borderColor: 'rgba(0, 191, 255, 0.2)',
          boxShadow: '0 8px 32px rgba(0, 191, 255, 0.1)',
        }}
      >
        <div className="flex items-center space-x-3">
          <motion.div
            animate={{ 
              rotate: 360,
              scale: [1, 1.1, 1]
            }}
            transition={{ 
              rotate: { duration: 8, repeat: Infinity, ease: "linear" },
              scale: { duration: 2, repeat: Infinity, ease: "easeInOut" }
            }}
            className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, #00BFFF, #FF00FF)',
              boxShadow: '0 0 30px rgba(0, 191, 255, 0.4), 0 0 60px rgba(255, 0, 255, 0.2)',
            }}
          >
            <MapPin className="w-5 h-5 sm:w-6 sm:h-6 text-white" />
          </motion.div>
          <motion.span 
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3, type: "spring" }}
            className="text-xl sm:text-2xl text-white tracking-tight font-semibold"
          >
            Bytspot
          </motion.span>
        </div>
        <div className="flex space-x-3">
          <motion.div
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <Button
              onClick={onHostOnboarding}
              variant="ghost"
              className="text-white hover:bg-white/15 min-h-[44px] px-4 touch-feedback text-sm font-medium rounded-2xl"
              style={{
                backdropFilter: 'blur(20px) saturate(180%)',
                background: 'rgba(18, 18, 18, 0.6)',
                border: '1px solid rgba(0, 191, 255, 0.2)',
              }}
            >
              Become a Host
            </Button>
          </motion.div>
          <motion.div
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <Button
              onClick={onGetStarted}
              className="min-h-[44px] px-6 touch-feedback text-sm font-medium rounded-2xl border-0 text-white"
              style={{
                background: 'linear-gradient(135deg, #00BFFF, #FF00FF)',
                boxShadow: '0 4px 20px rgba(0, 191, 255, 0.4), 0 2px 10px rgba(255, 0, 255, 0.3)',
              }}
            >
              Sign In
            </Button>
          </motion.div>
        </div>
      </motion.header>

      {/* Hero Section - Mobile Optimized */}
      <div className="flex-1 flex flex-col justify-center items-center px-4 sm:px-6 text-center">
        <motion.div
          initial={{ y: 50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="max-w-4xl"
        >
          <motion.h1
            className="text-4xl sm:text-6xl md:text-8xl text-white mb-8 tracking-tight leading-tight"
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.6, type: "spring", stiffness: 300, damping: 20 }}
          >
            <motion.span 
              initial={{ y: 30, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.7, duration: 0.8, ease: "easeOut" }}
              className="block text-gradient-rainbow font-bold"
            >
              Bytspot
            </motion.span>
          </motion.h1>

          {/* Address Search with Contextual Suggestions - Enhanced */}
          <motion.div
            initial={{ y: 30, opacity: 0, scale: 0.95 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            transition={{ delay: 1.3, duration: 0.8, type: "spring", stiffness: 300 }}
            className="w-full max-w-lg mx-auto mb-10 sm:mb-14 px-2 relative"
          >
            <form onSubmit={handleAddressSubmit}>
              <div className="relative hover-lift">
                <div className="absolute inset-0 bg-gradient-to-r from-[#00BFFF]/60 via-[#FF00FF]/50 to-[#008080]/40 rounded-3xl blur-md opacity-60" />
                <div className="relative rounded-3xl p-3 flex flex-col sm:flex-row items-stretch sm:items-center space-y-3 sm:space-y-0 sm:space-x-4"
                style={{
                  backdropFilter: 'blur(16px) saturate(150%)',
                  background: 'linear-gradient(135deg, rgba(18, 18, 18, 0.9) 0%, rgba(0, 191, 255, 0.1) 50%, rgba(255, 0, 255, 0.1) 100%)',
                  border: '1px solid rgba(0, 191, 255, 0.3)',
                  boxShadow: '0 12px 40px rgba(0, 191, 255, 0.2), 0 6px 20px rgba(255, 0, 255, 0.1)',
                }}>
                  <div className="flex items-center flex-1 group">
                    <motion.div
                      animate={{ scale: isSearchFocused ? 1.1 : 1 }}
                      transition={{ duration: 0.2 }}
                      className="text-white/60 ml-3 mr-3"
                    >
                      <Search className="w-5 h-5 sm:w-6 sm:h-6" />
                    </motion.div>
                    <Input
                      type="text"
                      placeholder="Search parking, restaurants, events..."
                      value={address}
                      onChange={(e) => {
                        setAddress(e.target.value);
                        setShowSuggestions(true);
                      }}
                      onFocus={() => {
                        setIsSearchFocused(true);
                        setShowSuggestions(true);
                      }}
                      onBlur={() => {
                        setIsSearchFocused(false);
                        setTimeout(() => setShowSuggestions(false), 200);
                      }}
                      className="flex-1 bg-transparent border-none text-white placeholder-white/70 focus:ring-0 text-base h-14 font-medium transition-all duration-300"
                    />
                  </div>
                  <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                    <Button
                      type="submit"
                      size="lg"
                      className="rounded-2xl px-6 sm:px-8 min-h-[52px] touch-feedback border-0 font-semibold text-white"
                      style={{
                        background: 'linear-gradient(135deg, #00BFFF, #FF00FF)',
                        boxShadow: '0 4px 20px rgba(0, 191, 255, 0.4), 0 2px 10px rgba(255, 0, 255, 0.3)',
                      }}
                    >
                      <motion.div
                        animate={{ rotate: [0, 360] }}
                        transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                        className="mr-2"
                      >
                        <MapPin className="w-4 h-4 sm:w-5 sm:h-5" />
                      </motion.div>
                      <span className="text-sm sm:text-base">Find</span>
                    </Button>
                  </motion.div>
                </div>
              </div>
            </form>

            {/* Contextual Suggestions Dropdown - Enhanced */}
            {showSuggestions && (
              <motion.div
                initial={{ opacity: 0, y: -10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.95 }}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
                className="absolute top-full left-0 right-0 mt-3 z-50"
              >
                <div className="rounded-2xl p-3 shadow-2xl"
                style={{
                  backdropFilter: 'blur(16px) saturate(150%)',
                  background: 'linear-gradient(135deg, rgba(18, 18, 18, 0.9) 0%, rgba(0, 191, 255, 0.1) 100%)',
                  border: '1px solid rgba(0, 191, 255, 0.3)',
                  boxShadow: '0 12px 40px rgba(0, 191, 255, 0.2)',
                }}>
                  {getFilteredSuggestions().map((suggestion, index) => (
                    <motion.div
                      key={suggestion.id}
                      initial={{ opacity: 0, x: -20, scale: 0.95 }}
                      animate={{ opacity: 1, x: 0, scale: 1 }}
                      exit={{ opacity: 0, x: 20, scale: 0.95 }}
                      transition={{ 
                        delay: index * 0.03, 
                        type: "spring", 
                        stiffness: 500, 
                        damping: 30 
                      }}
                      whileHover={{ scale: 1.02, x: 4 }}
                      whileTap={{ scale: 0.98 }}
                      className="flex items-center p-4 rounded-xl hover:bg-white/15 cursor-pointer transition-all duration-300 group touch-feedback backdrop-blur-sm"
                      onClick={() => {
                        setAddress(suggestion.title);
                        setShowSuggestions(false);
                        onAddressSubmit(suggestion.title);
                      }}
                    >
                      <motion.div 
                        whileHover={{ scale: 1.1, rotate: 5 }}
                        className={`flex items-center justify-center w-10 h-10 bg-gradient-to-r ${suggestion.color} rounded-xl mr-4 text-white flex-shrink-0 shadow-lg`}
                      >
                        {suggestion.icon}
                      </motion.div>
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-sm font-medium group-hover:text-white/95 truncate transition-colors">
                          {suggestion.title}
                        </p>
                        <p className="text-white/70 text-xs group-hover:text-white/80 truncate transition-colors">
                          {suggestion.subtitle}
                        </p>
                      </div>
                      <motion.div 
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="text-white/40 group-hover:text-white/70 transition-all duration-300"
                      >
                        <Search className="w-4 h-4" />
                      </motion.div>
                    </motion.div>
                  ))}
                  
                  {getFilteredSuggestions().length === 0 && address.trim() && (
                    <div className="p-3 text-center">
                      <p className="text-white/60 text-sm">No suggestions found</p>
                      <p className="text-white/40 text-xs mt-1">Try "parking", "dining", or "valet"</p>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </motion.div>

          {/* Stats - Mobile Optimized */}
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 1.2 }}
            className="flex justify-center space-x-6 sm:space-x-12 mb-12 sm:mb-16"
          >
            {stats.map((stat, index) => (
              <motion.div
                key={stat.label}
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 1.4 + index * 0.1 }}
                className="text-center"
              >
                <div className="text-2xl sm:text-3xl text-white mb-1">{stat.value}</div>
                <div className="text-white/60 text-xs sm:text-sm">{stat.label}</div>
              </motion.div>
            ))}
          </motion.div>
        </motion.div>



        {/* Features Grid - Mobile Optimized */}
        <motion.div
          initial={{ y: 50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 1.4 }}
          className="w-full max-w-6xl grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6 sm:gap-8 mb-12 sm:mb-16 px-2"
        >
          {features.map((feature, index) => (
            <motion.div
              key={feature.title}
              initial={{ y: 30, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 1.6 + index * 0.2 }}
              whileHover={{ y: -10, scale: 1.02 }}
              className="group"
            >
              <div className="relative">
                <div className={`absolute inset-0 bg-gradient-to-r ${feature.color} rounded-2xl blur opacity-25 group-hover:opacity-40 transition-opacity`} />
                <div className="relative backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl p-6 sm:p-8 text-center">
                  <motion.div
                    whileHover={{ rotate: 360 }}
                    transition={{ duration: 0.5 }}
                    className={`inline-flex items-center justify-center w-14 h-14 sm:w-16 sm:h-16 bg-gradient-to-r ${feature.color} rounded-xl mb-4 sm:mb-6 text-white`}
                  >
                    <div className="w-6 h-6 sm:w-8 sm:h-8">
                      {feature.icon}
                    </div>
                  </motion.div>
                  <h3 className="text-lg sm:text-xl text-white mb-3">{feature.title}</h3>
                  <p className="text-sm sm:text-base text-white/70 leading-relaxed">{feature.description}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>

        {/* CTA Button - Mobile Optimized */}
        <motion.div
          initial={{ y: 30, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 2.0 }}
          className="px-4"
        >
          <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              onClick={onGetStarted}
              size="lg"
              className="text-white text-base sm:text-lg px-8 sm:px-12 py-4 sm:py-6 rounded-2xl shadow-2xl min-h-[56px] border-0 interactive-hover"
              style={{
                background: 'linear-gradient(135deg, #00BFFF 0%, #FF00FF 50%, #FF4500 100%)',
                boxShadow: '0 8px 25px rgba(0, 191, 255, 0.4), 0 4px 15px rgba(255, 0, 255, 0.3), 0 2px 10px rgba(255, 69, 0, 0.2)',
              }}
            >
              <motion.div
                animate={{ 
                  scale: [1, 1.2, 1],
                  rotate: [0, 5, -5, 0]
                }}
                transition={{ 
                  duration: 2, 
                  repeat: Infinity, 
                  ease: "easeInOut" 
                }}
                className="mr-2 sm:mr-3"
              >
                <Heart className="w-5 h-5 sm:w-6 sm:h-6" />
              </motion.div>
              Start Matching
            </Button>
          </motion.div>
        </motion.div>
      </div>

      {/* Footer - Mobile Optimized */}
      <motion.footer
        initial={{ y: 50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 2.2 }}
        className="p-4 sm:p-6 text-center safe-area-bottom"
        style={{
          backdropFilter: 'blur(20px) saturate(180%)',
          background: 'linear-gradient(135deg, rgba(18, 18, 18, 0.8) 0%, rgba(0, 191, 255, 0.05) 100%)',
          borderTop: '1px solid rgba(0, 191, 255, 0.2)',
        }}
      >
        <div className="flex flex-col sm:flex-row justify-center items-center space-y-2 sm:space-y-0 sm:space-x-8 text-white/60 text-xs sm:text-sm">
          <span>© 2025 Bytspot</span>
          <div className="flex items-center space-x-4 sm:space-x-8">
            <span>Privacy Policy</span>
            <span>•</span>
            <span>Terms of Service</span>
          </div>
        </div>
      </motion.footer>

      {/* Enhanced Theme-Aware Floating Elements */}
      <motion.div
        className="absolute top-1/4 right-8 w-4 h-4 bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] rounded-full opacity-70"
        animate={{
          y: [0, -25, 0],
          x: [0, 10, 0],
          opacity: [0.7, 1, 0.7],
          scale: [1, 1.3, 1],
        }}
        transition={{
          duration: 3,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />
      <motion.div
        className="absolute bottom-1/3 left-8 w-3 h-3 bg-gradient-to-r from-[#008080] to-[#00BFFF] rounded-full opacity-60"
        animate={{
          y: [0, 20, 0],
          x: [0, -8, 0],
          opacity: [0.6, 0.9, 0.6],
          scale: [1, 1.4, 1],
        }}
        transition={{
          duration: 4,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />
      <motion.div
        className={`absolute top-2/3 right-1/4 w-2 h-2 bg-gradient-to-r ${themeColors?.accent || 'from-emerald-400 to-teal-500'} rounded-full opacity-50`}
        animate={{
          y: [0, -15, 0],
          x: [0, 12, 0],
          opacity: [0.5, 0.8, 0.5],
          rotate: [0, 180, 360],
        }}
        transition={{
          duration: 5,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />
      <motion.div
        className={`absolute top-1/2 left-1/5 w-3 h-3 bg-gradient-to-r ${themeColors?.primary || 'from-orange-400 to-red-500'} rounded-full opacity-65`}
        animate={{
          y: [0, 18, 0],
          x: [0, -15, 0],
          opacity: [0.65, 1, 0.65],
          scale: [1, 1.2, 1],
        }}
        transition={{
          duration: 3.5,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />
      
      {/* Enhanced Context Indicator */}
      <motion.div
        className={`absolute top-6 left-1/2 transform -translate-x-1/2 flex items-center space-x-2 glass-effect px-4 py-2 rounded-full live-indicator ${
          locationTheme === 'beach' ? 'location-beach' : 
          locationTheme === 'forest' ? 'location-forest' : 
          locationTheme === 'mountain' ? 'location-mountain' : ''
        }`}
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 2.5 }}
      >
        <motion.div
          className={`w-2 h-2 bg-gradient-to-r ${themeColors?.primary || 'from-green-400 to-emerald-400'} rounded-full`}
          animate={{
            scale: [1, 1.5, 1],
            opacity: [1, 0.5, 1],
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
        <span className="text-white text-xs font-medium capitalize">{currentTheme}</span>
        <span className="text-white/60 text-xs">•</span>
        <span className="text-white/60 text-xs capitalize">{weatherTheme}</span>
        <span className="text-white/60 text-xs">•</span>
        <span className="text-white/60 text-xs capitalize">{locationTheme}</span>
      </motion.div>
    </motion.div>
  );
}