import React, { useState, useRef, useCallback, useEffect } from 'react';
import { motion, PanInfo, useMotionValue, useTransform, AnimatePresence } from 'motion/react';
import { 
  Star, 
  MapPin, 
  Clock, 
  DollarSign, 
  Map,
  BarChart3,
  MessageCircle,
  Car,
  UtensilsCrossed,
  Users,
  Search,
  TrendingUp,
  Zap,
  Award,
  Activity,
  ArrowLeft,
  UserCircle,
  Info,
  ChevronUp,
  Crown,
  Sparkles
} from 'lucide-react';
import { Button } from './ui/button';
import { ImageWithFallback } from './figma/ImageWithFallback';
import { VenueDetail } from './VenueDetail';
import { SimpleParkingDetail } from './SimpleParkingDetail';
import { ConciergeChat } from './ConciergeChat';
import { ValetFlow } from './ValetFlow';
import { VenueInsider } from './VenueInsider';
import { ProfileSettings } from './ProfileSettings';
import { VibePremiumModal } from './VibePremiumModal';

interface SwipeInterfaceProps {
  userData: any;
  onBack: () => void;
  onLogout: () => void;
  currentTheme?: string;
  weatherTheme?: string;
  locationTheme?: string;
  onWeatherChange?: (weather: string) => void;
  onLocationChange?: (location: string) => void;
  onTriggerAchievement?: () => void;
  onOpenMap?: () => void;
  onTriggerSystemNotification?: () => void;
  onTriggerRecommendation?: () => void;
  onOpenProfile?: () => void;
  onOpenSettings?: () => void;
  onError?: (error: any) => void;
  isLoading?: boolean;
  connectivity?: { isOnline: boolean; isSlowConnection: boolean };
  trackEvent?: (event: string, properties?: Record<string, any>) => void;
}

interface MatchCard {
  id: string;
  type: 'parking' | 'venue' | 'valet';
  title: string;
  subtitle: string;
  description: string;
  image: string;
  price: string;
  rating: number;
  distance: string;
  availability: string;
  features: string[];
  trending?: boolean;
  energyLevel?: 'Low' | 'Medium' | 'High Energy' | 'Electric';
  crowd?: 'Empty' | 'Quiet' | 'Moderate' | 'Busy' | 'Packed' | 'Full';
  liveVibeScore?: number;
  peopleInside?: number;
  spotsAvailable?: number;
  totalSpots?: number;
  securityLevel?: 'Basic' | 'Standard' | 'Premium' | 'Maximum';
  responseTime?: string;
  serviceLevel?: 'Standard' | 'Premium' | 'Luxury' | 'White Glove';
  walkTime?: string;
}

type ViewType = 'swipe' | 'insider' | 'concierge' | 'venue-detail' | 'parking-detail' | 'valet-flow' | 'profile';

export function SwipeInterfaceWithPremium({ 
  userData, 
  onBack, 
  onLogout,
  currentTheme = 'morning',
  weatherTheme = 'sunny',
  locationTheme = 'city',
  onWeatherChange = () => {},
  onLocationChange = () => {},
  onTriggerAchievement = () => {},
  onOpenMap = () => {},
  onTriggerSystemNotification = () => {},
  onTriggerRecommendation = () => {},
  onOpenProfile = () => {},
  onOpenSettings = () => {},
  onError = () => {},
  isLoading = false,
  connectivity = { isOnline: true, isSlowConnection: false },
  trackEvent = () => {}
}: SwipeInterfaceProps) {
  const [currentCardIndex, setCurrentCardIndex] = useState(0);
  const [currentView, setCurrentView] = useState<ViewType>('swipe');
  const [selectedCard, setSelectedCard] = useState<MatchCard | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showFooter, setShowFooter] = useState(true);
  const [showPremiumModal, setShowPremiumModal] = useState(false);
  const constraintsRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Sample data
  const matches: MatchCard[] = [
    {
      id: '1',
      type: 'parking',
      title: 'Premium Garage Spot',
      subtitle: 'Downtown Financial District',
      description: 'Covered parking spot in premium garage with 24/7 security and EV charging',
      image: 'https://images.unsplash.com/photo-1590674899484-d5640e854abe?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxwYXJraW5nJTIwZ2FyYWdlfGVufDF8fHx8MTc1NjMzMDI2NHww&ixlib=rb-4.1.0&q=80&w=1080',
      price: '$12/hour',
      rating: 4.8,
      distance: '2 min walk',
      walkTime: '2 min walk',
      availability: 'Available now',
      features: ['Covered', 'Security', 'EV Charging', 'Mobile Payment'],
      spotsAvailable: 23,
      totalSpots: 100,
      securityLevel: 'Premium'
    },
    {
      id: '2',
      type: 'venue',
      title: 'Skyline Rooftop',
      subtitle: 'Arts District • High Energy',
      description: 'Premium rooftop experience with stunning city views and live entertainment',
      image: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxyb29mdG9wJTIwYmFyJTIwbmlnaHR8ZW58MXx8fHwxNzU2MzMwMjY1fDA&ixlib=rb-4.1.0&q=80&w=1080',
      price: '$45/person',
      rating: 4.9,
      distance: '5 min walk',
      availability: 'Open',
      features: ['City Views', 'Live Music', 'Craft Cocktails', 'VIP Areas'],
      trending: true,
      energyLevel: 'High Energy',
      crowd: 'Packed',
      liveVibeScore: 92,
      peopleInside: 156
    }
  ];

  // Motion values for current card
  const currentCard = matches[currentCardIndex];
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useTransform(x, [-300, 300], [-20, 20]);
  const opacity = useTransform(x, [-300, -150, 0, 150, 300], [0, 1, 1, 1, 0]);
  const scale = useTransform(y, [0, 150], [1, 0.9]);

  const handlePremiumUpgrade = useCallback((plan: 'monthly' | 'yearly') => {
    trackEvent('premium_upgrade_initiated', {
      plan,
      userId: userData.id,
      currentSpots: matches.length,
      userVibeScore: 78
    });

    console.log('Premium upgrade initiated:', plan);
    setShowPremiumModal(false);
    
    setTimeout(() => {
      onTriggerAchievement?.();
    }, 500);
  }, [trackEvent, userData.id, matches.length, onTriggerAchievement]);

  const handleRefresh = useCallback(() => {
    if (isAnimating || isRefreshing) return;
    
    setIsAnimating(true);
    setIsRefreshing(true);
    
    y.set(200);
    
    setTimeout(() => {
      setCurrentCardIndex(0);
      
      setTimeout(() => {
        setIsAnimating(false);
        setIsRefreshing(false);
        x.set(0);
        y.set(0);
        
        onTriggerAchievement?.();
      }, 800);
    }, 400);
  }, [isAnimating, isRefreshing, onTriggerAchievement, x, y]);

  const renderCard = (card: MatchCard) => {
    const getTypeIcon = (type: string) => {
      switch (type) {
        case 'parking': return <Car className="w-6 h-6 text-white drop-shadow-sm" />;
        case 'venue': return <UtensilsCrossed className="w-6 h-6 text-white drop-shadow-sm" />;
        case 'valet': return <Users className="w-6 h-6 text-white drop-shadow-sm" />;
        default: return <MapPin className="w-6 h-6 text-white drop-shadow-sm" />;
      }
    };

    const getTypeGradient = (type: string) => {
      switch (type) {
        case 'parking': return 'from-[#00BFFF] to-[#008080]';
        case 'venue': return 'from-[#FF00FF] to-[#FF4500]';
        case 'valet': return 'from-[#008080] to-[#00BFFF]';
        default: return 'from-[#00BFFF] to-[#FF00FF]';
      }
    };

    return (
      <div className="w-full h-full rounded-2xl overflow-hidden relative">
        <div className="absolute inset-0">
          <ImageWithFallback
            src={card.image}
            alt={card.title}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
        </div>

        <div className="relative z-10 h-full flex flex-col justify-between p-4 sm:p-6">
          <div className="flex justify-between items-start">
            <div className="flex items-center space-x-2">
              <div className={`w-12 h-12 rounded-xl bg-gradient-to-r ${getTypeGradient(card.type)} flex items-center justify-center shadow-lg`}>
                {getTypeIcon(card.type)}
              </div>
              
              {card.trending && (
                <div className="flex items-center space-x-1 bg-red-500/20 backdrop-blur-sm rounded-full px-3 py-1.5 border border-red-400/30">
                  <TrendingUp className="w-4 h-4 text-red-400" />
                  <span className="text-red-300 text-xs font-medium">Trending</span>
                </div>
              )}
            </div>
            
            <div className="flex items-center space-x-1 bg-black/40 backdrop-blur-sm rounded-full px-3 py-1.5 shadow-sm">
              <Star className="w-4 h-4 text-yellow-400 fill-current drop-shadow-sm" />
              <span className="text-white text-sm font-medium">{card.rating}</span>
            </div>
          </div>

          <div className="space-y-3 sm:space-y-4">
            <div className="space-y-1 sm:space-y-2">
              <h2 className="text-white text-xl sm:text-2xl font-semibold line-clamp-2">{card.title}</h2>
              <p className="text-white/80 text-sm sm:text-base line-clamp-1">{card.subtitle}</p>
            </div>

            <div className="flex items-center justify-between bg-white/12 backdrop-blur-sm rounded-xl p-3 sm:p-4 border border-white/25 shadow-lg">
              <div className="flex items-center space-x-2">
                <DollarSign className="w-5 h-5 sm:w-6 sm:h-6 text-[#00BFFF] drop-shadow-sm" />
                <span className="text-white font-bold text-base sm:text-lg">{card.price}</span>
              </div>
              <span className="text-white/90 text-sm font-medium line-clamp-1">{card.availability}</span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderPremiumFooter = () => {
    if (!showFooter || currentView !== 'swipe') return null;

    return (
      <AnimatePresence>
        <motion.div
          className="fixed bottom-0 left-0 right-0 z-50 pointer-events-auto"
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ 
            type: "spring", 
            stiffness: 400, 
            damping: 25,
            delay: 0.3
          }}
        >
          <div className="p-4 pb-8 safe-area-bottom">
            <motion.div
              className="relative rounded-2xl overflow-hidden"
              style={{
                background: 'linear-gradient(135deg, rgba(18, 18, 18, 0.95) 0%, rgba(0, 191, 255, 0.1) 30%, rgba(255, 0, 255, 0.1) 70%, rgba(255, 69, 0, 0.05) 100%)',
                backdropFilter: 'blur(24px) saturate(180%)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                boxShadow: '0 20px 40px rgba(0, 0, 0, 0.3), 0 8px 16px rgba(0, 191, 255, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1)'
              }}
              whileHover={{ scale: 1.02, y: -2 }}
              transition={{ duration: 0.2 }}
            >
              {/* Animated background elements */}
              <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <motion.div
                  className="absolute top-1/4 left-1/4 w-16 h-16 rounded-full opacity-20"
                  style={{
                    background: 'radial-gradient(circle, rgba(0, 191, 255, 0.6), transparent 70%)'
                  }}
                  animate={{
                    x: [0, 20, -10, 0],
                    y: [0, -15, 10, 0],
                    scale: [1, 1.2, 0.8, 1]
                  }}
                  transition={{
                    duration: 6,
                    repeat: Infinity,
                    ease: "easeInOut"
                  }}
                />
                
                <motion.div
                  className="absolute bottom-1/3 right-1/4 w-12 h-12 rounded-full opacity-15"
                  style={{
                    background: 'radial-gradient(circle, rgba(255, 0, 255, 0.8), transparent 70%)'
                  }}
                  animate={{
                    x: [0, -15, 15, 0],
                    y: [0, 20, -10, 0],
                    scale: [0.8, 1.3, 1, 0.8]
                  }}
                  transition={{
                    duration: 8,
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: 2
                  }}
                />

                {[...Array(4)].map((_, i) => (
                  <motion.div
                    key={i}
                    className="absolute w-0.5 h-0.5 bg-white/60 rounded-full"
                    style={{
                      left: `${25 + i * 20}%`,
                      top: `${30 + i * 15}%`,
                    }}
                    animate={{
                      opacity: [0, 1, 0],
                      scale: [0, 1.5, 0],
                    }}
                    transition={{
                      duration: 2,
                      repeat: Infinity,
                      delay: i * 0.5,
                      ease: "easeInOut"
                    }}
                  />
                ))}
              </div>

              <div className="relative z-10 p-6">
                {/* Header */}
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center space-x-3">
                    <motion.div
                      className="w-10 h-10 rounded-xl bg-gradient-to-r from-[#FFD700] to-[#FFA500] flex items-center justify-center"
                      animate={{ 
                        rotate: [0, 5, -5, 0],
                        scale: [1, 1.05, 1]
                      }}
                      transition={{ 
                        duration: 4, 
                        repeat: Infinity,
                        ease: "easeInOut"
                      }}
                    >
                      <Crown className="w-5 h-5 text-black" />
                    </motion.div>
                    
                    <div>
                      <motion.h3 
                        className="text-white font-semibold text-lg"
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.2 }}
                      >
                        Vibe Premium
                      </motion.h3>
                      <motion.p 
                        className="text-white/80 text-sm"
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.3 }}
                      >
                        Unlock AI-powered discovery
                      </motion.p>
                    </div>
                  </div>

                  <motion.div
                    className="text-right"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.4 }}
                  >
                    <div className="text-white font-bold text-xl">$4.99</div>
                    <div className="text-white/60 text-xs">per month</div>
                  </motion.div>
                </div>

                {/* Premium Features Grid */}
                <div className="grid grid-cols-5 gap-3 mb-6">
                  {[
                    { icon: Activity, label: 'Live 24/7', color: 'from-[#00BFFF] to-[#008080]' },
                    { icon: Sparkles, label: 'Smart Matching', color: 'from-[#FF00FF] to-[#FF4500]' },
                    { icon: Zap, label: 'Instant Discovery', color: 'from-[#008080] to-[#00BFFF]' },
                    { icon: Search, label: 'Vibe Learning', color: 'from-[#FF4500] to-[#FF00FF]' },
                    { icon: Crown, label: 'Exclusive Venues', color: 'from-[#FFD700] to-[#FFA500]' }
                  ].map((feature, index) => {
                    const IconComponent = feature.icon;
                    return (
                      <motion.div
                        key={index}
                        className="flex flex-col items-center space-y-2"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.5 + index * 0.1 }}
                      >
                        <motion.div
                          className={`w-10 h-10 rounded-xl bg-gradient-to-r ${feature.color} flex items-center justify-center`}
                          whileHover={{ 
                            scale: 1.1,
                            rotate: 5,
                            y: -2
                          }}
                          transition={{ duration: 0.2 }}
                        >
                          <IconComponent className="w-4 h-4 text-white" />
                        </motion.div>
                        <span className="text-white/80 text-xs text-center font-medium leading-tight">
                          {feature.label}
                        </span>
                      </motion.div>
                    );
                  })}
                </div>

                {/* CTA Button */}
                <motion.div
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ duration: 0.1 }}
                >
                  <Button
                    onClick={() => setShowPremiumModal(true)}
                    className="w-full h-14 bg-gradient-to-r from-[#00BFFF] via-[#FF00FF] to-[#FF4500] hover:opacity-90 text-white font-semibold text-base rounded-xl shadow-lg relative overflow-hidden border-0"
                  >
                    {/* Button shimmer effect */}
                    <motion.div
                      className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent"
                      animate={{
                        x: [-100, 300]
                      }}
                      transition={{
                        duration: 2,
                        repeat: Infinity,
                        repeatDelay: 1,
                        ease: "easeInOut"
                      }}
                    />
                    
                    <div className="relative z-10 flex items-center justify-center space-x-2">
                      <Zap className="w-5 h-5" />
                      <span>Start Premium Discovery</span>
                      <span className="text-white/90">• $4.99/month</span>
                    </div>
                  </Button>
                </motion.div>

                {/* Footer text */}
                <motion.div
                  className="text-center mt-3 text-white/50 text-xs"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.8 }}
                >
                  Cancel anytime • Premium features activate instantly
                </motion.div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      </AnimatePresence>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] relative">
      {/* Main Content */}
      <div className="flex-1 relative">
        {/* Refresh Loading State */}
        {isRefreshing && (
          <motion.div
            className="absolute inset-0 flex items-center justify-center z-20 bg-black/20 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] p-4 rounded-2xl"
              animate={{ scale: [1, 1.1, 1], rotate: [0, 180, 360] }}
              transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
            >
              <Search className="w-10 h-10 text-white drop-shadow-md" />
            </motion.div>
          </motion.div>
        )}
        
        <div className="flex items-center justify-center px-4 sm:px-6 pt-6 pb-32 h-full min-h-[600px]">
          <div className="relative w-full max-w-sm mx-auto" style={{ height: 'min(600px, 70vh)' }}>
            <div ref={constraintsRef} className="relative w-full h-full">
              {/* Current card */}
              {currentCard && (
                <motion.div
                  key={currentCard.id}
                  style={{ x, y, rotate, opacity, scale }}
                  className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing touch-manipulation"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                >
                  <div 
                    className="w-full h-full rounded-2xl"
                    style={{
                      background: 'linear-gradient(135deg, rgba(18, 18, 18, 0.9) 0%, rgba(0, 191, 255, 0.1) 50%, rgba(255, 0, 255, 0.1) 100%)',
                      backdropFilter: 'blur(20px) saturate(180%)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4), 0 8px 16px rgba(0, 191, 255, 0.1)',
                    }}
                  >
                    {renderCard(currentCard)}
                  </div>
                </motion.div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Premium Footer */}
      {renderPremiumFooter()}

      {/* Premium Modal */}
      <VibePremiumModal
        isOpen={showPremiumModal}
        onClose={() => setShowPremiumModal(false)}
        onUpgrade={handlePremiumUpgrade}
        userVibeScore={78}
        currentSpots={matches.length}
        userData={userData}
      />
    </div>
  );
}