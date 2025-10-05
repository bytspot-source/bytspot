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
  onStartPremiumPreferences?: () => void;
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

export function SwipeInterfaceFixed({ 
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
  onStartPremiumPreferences = () => {},
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
    },
    {
      id: '3',
      type: 'valet',
      title: 'Elite Valet Service',
      subtitle: 'Entertainment District',
      description: 'White glove valet service with premium car care and concierge assistance',
      image: 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHx2YWxldCUyMHNlcnZpY2V8ZW58MXx8fHwxNzU2MzMwMjY1fDA&ixlib=rb-4.1.0&q=80&w=1080',
      price: '$25/hour',
      rating: 4.7,
      distance: 'On-site',
      availability: '24/7 Service',
      features: ['White Glove', '24/7 Service', 'Car Care', 'Concierge'],
      responseTime: '< 2 minutes',
      serviceLevel: 'White Glove'
    },
    {
      id: '4',
      type: 'venue',
      title: 'Craft Coffee House',
      subtitle: 'Quiet • Work Friendly',
      description: 'Cozy coffee shop perfect for remote work with fast WiFi and quiet atmosphere',
      image: 'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxjb2ZmZWUlMjBzaG9wfGVufDF8fHx8MTc1NjMzMDI2NXww&ixlib=rb-4.1.0&q=80&w=1080',
      price: '$8/drink',
      rating: 4.6,
      distance: '3 min walk',
      availability: 'Open',
      features: ['Fast WiFi', 'Quiet', 'Power Outlets', 'Specialty Coffee'],
      energyLevel: 'Low',
      crowd: 'Quiet',
      liveVibeScore: 45,
      peopleInside: 12
    },
    {
      id: '5',
      type: 'parking',
      title: 'Street Parking Zone',
      subtitle: 'Historic District',
      description: 'Metered street parking in charming historic area with easy walking access',
      image: 'https://images.unsplash.com/photo-1578662996442-48f60103fc96?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxzdHJlZXQlMjBwYXJraW5nfGVufDF8fHx8MTc1NjMzMDI2NHww&ixlib=rb-4.1.0&q=80&w=1080',
      price: '$4/hour',
      rating: 4.3,
      distance: '1 min walk',
      walkTime: '1 min walk',
      availability: 'Limited spots',
      features: ['Affordable', 'Historic Area', 'Walking Distance', 'Meter Payment'],
      spotsAvailable: 3,
      totalSpots: 12,
      securityLevel: 'Basic'
    }
  ];

  // Motion values for current card
  const currentCard = matches[currentCardIndex];
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useTransform(x, [-300, 300], [-20, 20]);
  const opacity = useTransform(x, [-300, -150, 0, 150, 300], [0, 1, 1, 1, 0]);
  const scale = useTransform(y, [0, 150], [1, 0.9]);
  
  // Gesture feedback transforms
  const leftIndicatorOpacity = useTransform(x, [-150, -50, 0], [1, 0.5, 0]);
  const rightIndicatorOpacity = useTransform(x, [0, 50, 150], [0, 0.5, 1]);
  const downIndicatorOpacity = useTransform(y, [0, 50, 100], [0, 0.5, 1]);

  const handleSwipe = useCallback((direction: 'left' | 'right') => {
    if (isAnimating || !currentCard) return;
    
    setIsAnimating(true);
    
    // Enhanced analytics tracking
    trackEvent('card_swiped', {
      direction,
      cardId: currentCard.id,
      cardType: currentCard.type,
      cardTitle: currentCard.title,
      cardIndex: currentCardIndex,
      userId: userData.id
    });
    
    if (direction === 'right') {
      // Swipe right - open details
      x.set(300);
      setTimeout(() => {
        setSelectedCard(currentCard);
        if (currentCard.type === 'venue') {
          setCurrentView('venue-detail');
        } else if (currentCard.type === 'valet') {
          setCurrentView('valet-flow');
        } else if (currentCard.type === 'parking') {
          setCurrentView('parking-detail');
        }
        setIsAnimating(false);
        x.set(0);
        y.set(0);
        onTriggerAchievement?.();
        
        trackEvent('card_explored', {
          cardId: currentCard.id,
          cardType: currentCard.type,
          cardTitle: currentCard.title
        });
      }, 300);
    } else {
      // Swipe left - skip to next card
      x.set(-300);
      setTimeout(() => {
        if (currentCardIndex < matches.length - 1) {
          setCurrentCardIndex(currentCardIndex + 1);
        } else {
          setCurrentCardIndex(0); // Loop back
        }
        setIsAnimating(false);
        x.set(0);
        y.set(0);
        
        trackEvent('card_skipped', {
          cardId: currentCard.id,
          cardType: currentCard.type,
          skippedAt: currentCardIndex
        });
      }, 300);
    }
  }, [currentCard, currentCardIndex, isAnimating, matches.length, onTriggerAchievement, trackEvent, userData.id]);

  const handleRefresh = useCallback(() => {
    if (isAnimating || isRefreshing) return;
    
    setIsAnimating(true);
    setIsRefreshing(true);
    
    // Enhanced analytics tracking
    trackEvent('cards_refreshed', {
      previousCardIndex: currentCardIndex,
      totalCards: matches.length,
      userId: userData.id,
      trigger: 'swipe_down'
    });
    
    // Animate card down
    y.set(200);
    
    setTimeout(() => {
      // Reset to first card and shuffle if needed
      setCurrentCardIndex(0);
      
      // Show refreshing state
      setTimeout(() => {
        setIsAnimating(false);
        setIsRefreshing(false);
        x.set(0);
        y.set(0);
        
        // Trigger achievement for refreshing
        onTriggerAchievement?.();
        
        trackEvent('cards_refresh_completed', {
          newCardIndex: 0,
          userId: userData.id
        });
      }, 800);
    }, 400);
  }, [isAnimating, isRefreshing, onTriggerAchievement, trackEvent, currentCardIndex, matches.length, userData.id]);

  const handleCardTap = useCallback(() => {
    if (!currentCard || isAnimating) return;
    
    // Enhanced analytics tracking
    trackEvent('card_tapped', {
      cardId: currentCard.id,
      cardType: currentCard.type,
      cardTitle: currentCard.title,
      cardIndex: currentCardIndex,
      userId: userData.id,
      interaction: 'tap'
    });
    
    setSelectedCard(currentCard);
    if (currentCard.type === 'venue') {
      setCurrentView('venue-detail');
    } else if (currentCard.type === 'valet') {
      setCurrentView('valet-flow');
    } else if (currentCard.type === 'parking') {
      setCurrentView('parking-detail');
    }
  }, [currentCard, isAnimating, trackEvent, currentCardIndex, userData.id]);

  const handleBackToSwipe = useCallback(() => {
    setCurrentView('swipe');
    setSelectedCard(null);
    setShowFooter(true);
  }, []);

  const handlePremiumUpgrade = useCallback((plan: 'monthly' | 'yearly') => {
    // Analytics tracking
    trackEvent('premium_upgrade_initiated', {
      plan,
      userId: userData.id,
      currentSpots: matches.length,
      userVibeScore: 78
    });

    // Close modal and start preferences flow
    setShowPremiumModal(false);
    
    // Route to vibe preferences
    onStartPremiumPreferences?.();
    
    setTimeout(() => {
      onTriggerAchievement?.();
    }, 500);
  }, [trackEvent, userData.id, matches.length, onTriggerAchievement, onStartPremiumPreferences]);

  const handleDragEnd = useCallback((event: any, info: PanInfo) => {
    if (isAnimating) return;
    
    const horizontalThreshold = 120;
    const verticalThreshold = 100;
    const velocityX = Math.abs(info.velocity.x);
    const velocityY = Math.abs(info.velocity.y);
    
    // Check for vertical swipe down (refresh)
    if (info.offset.y > verticalThreshold || velocityY > 600) {
      handleRefresh();
      return;
    }
    
    // Check for horizontal swipe
    if (Math.abs(info.offset.x) > horizontalThreshold || velocityX > 800) {
      const direction = info.offset.x > 0 ? 'right' : 'left';
      handleSwipe(direction);
      return;
    }
    
    // Snap back to center
    x.set(0);
    y.set(0);
  }, [isAnimating, handleRefresh, handleSwipe, x, y]);

  // Enhanced Keyboard Navigation - After function declarations
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (currentView !== 'swipe' || isAnimating) return;
      
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          handleSwipe('left');
          trackEvent('keyboard_navigation', { action: 'skip', key: 'ArrowLeft' });
          break;
        case 'ArrowRight':
          e.preventDefault();
          handleSwipe('right');
          trackEvent('keyboard_navigation', { action: 'explore', key: 'ArrowRight' });
          break;
        case 'ArrowDown':
          e.preventDefault();
          handleRefresh();
          trackEvent('keyboard_navigation', { action: 'refresh', key: 'ArrowDown' });
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          handleCardTap();
          trackEvent('keyboard_navigation', { action: 'tap', key: e.key });
          break;
        case 'Escape':
          e.preventDefault();
          onBack();
          trackEvent('keyboard_navigation', { action: 'back', key: 'Escape' });
          break;
        default:
          break;
      }
    };

    if (currentView === 'swipe') {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [currentView, isAnimating, handleSwipe, handleRefresh, handleCardTap, onBack, trackEvent]);

  // Enhanced Focus Management
  useEffect(() => {
    if (currentView === 'swipe' && cardRef.current) {
      cardRef.current.focus();
    }
  }, [currentView, currentCardIndex]);

  const renderCard = (card: MatchCard, index: number, isActive = false) => {
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
        {/* Background Image */}
        <div className="absolute inset-0">
          <ImageWithFallback
            src={card.image}
            alt={card.title}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
        </div>

        {/* Glassmorphism overlay */}
        <div 
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(180deg, rgba(18, 18, 18, 0.1) 0%, rgba(18, 18, 18, 0.8) 100%)',
            backdropFilter: 'blur(1px)',
          }}
        />

        {/* Content */}
        <div className="relative z-10 h-full flex flex-col justify-between p-4 sm:p-6">
          {/* Header */}
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

          {/* Main Content */}
          <div className="space-y-3 sm:space-y-4">
            {/* Title and Location */}
            <div className="space-y-1 sm:space-y-2">
              <h2 className="text-white text-xl sm:text-2xl font-semibold line-clamp-2">{card.title}</h2>
              <p className="text-white/80 text-sm sm:text-base line-clamp-1">{card.subtitle}</p>
            </div>

            {/* Distance and Availability */}
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-1.5">
                <MapPin className="w-4 h-4 text-white/70 drop-shadow-sm flex-shrink-0" />
                <span className="text-white/80 text-sm">{card.walkTime || card.distance}</span>
              </div>
              <div className="flex items-center space-x-1.5">
                <Clock className="w-4 h-4 text-white/70 drop-shadow-sm flex-shrink-0" />
                <span className="text-white/80 text-sm line-clamp-1">{card.availability}</span>
              </div>
            </div>

            {/* Type-specific info */}
            {card.type === 'venue' && card.liveVibeScore && (
              <div className="bg-white/12 backdrop-blur-sm rounded-xl p-3 sm:p-4 border border-white/25 shadow-lg">
                <div className="flex items-center justify-between mb-2 sm:mb-3">
                  <span className="text-white/90 text-sm font-medium">Live Vibe</span>
                  <div className="flex items-center space-x-2 bg-white/10 rounded-lg px-2 py-1">
                    <Zap className="w-4 h-4 sm:w-5 sm:h-5 text-yellow-400 drop-shadow-sm" />
                    <span className="text-white font-bold text-base sm:text-lg">{card.liveVibeScore}</span>
                    <span className="text-white/70 text-sm">/100</span>
                  </div>
                </div>
                <div className="text-sm text-white/80">
                  <span className="font-medium">{card.peopleInside}</span> people • {card.energyLevel}
                </div>
              </div>
            )}

            {card.type === 'parking' && card.spotsAvailable && (
              <div className="bg-white/12 backdrop-blur-sm rounded-xl p-3 sm:p-4 border border-white/25 shadow-lg">
                <div className="flex items-center justify-between mb-2 sm:mb-3">
                  <span className="text-white/90 text-sm font-medium">Availability</span>
                  <div className="flex items-center space-x-2 bg-white/10 rounded-lg px-2 py-1">
                    <Car className="w-4 h-4 sm:w-5 sm:h-5 text-green-400 drop-shadow-sm" />
                    <span className="text-white font-bold text-base sm:text-lg">{card.spotsAvailable}</span>
                    <span className="text-white/70 text-sm">/{card.totalSpots}</span>
                  </div>
                </div>
                <div className="text-sm text-white/80">Security: <span className="font-medium">{card.securityLevel}</span></div>
              </div>
            )}

            {card.type === 'valet' && card.responseTime && (
              <div className="bg-white/12 backdrop-blur-sm rounded-xl p-3 sm:p-4 border border-white/25 shadow-lg">
                <div className="flex items-center justify-between mb-2 sm:mb-3">
                  <span className="text-white/90 text-sm font-medium">Service Level</span>
                  <div className="flex items-center space-x-2 bg-white/10 rounded-lg px-2 py-1">
                    <Award className="w-4 h-4 sm:w-5 sm:h-5 text-yellow-400 drop-shadow-sm" />
                    <span className="text-white font-bold text-sm">{card.serviceLevel}</span>
                  </div>
                </div>
                <div className="text-sm text-white/80">Response: <span className="font-medium">{card.responseTime}</span></div>
              </div>
            )}

            {/* Price */}
            <div className="flex items-center justify-between bg-white/12 backdrop-blur-sm rounded-xl p-3 sm:p-4 border border-white/25 shadow-lg">
              <div className="flex items-center space-x-2">
                <DollarSign className="w-5 h-5 sm:w-6 sm:h-6 text-[#00BFFF] drop-shadow-sm" />
                <span className="text-white font-bold text-base sm:text-lg">{card.price}</span>
              </div>
              <span className="text-white/90 text-sm font-medium line-clamp-1">{card.availability}</span>
            </div>

            {/* Features */}
            <div className="flex flex-wrap gap-2">
              {card.features.slice(0, 3).map((feature, featureIndex) => (
                <span
                  key={featureIndex}
                  className="text-xs text-white/80 bg-white/20 backdrop-blur-sm rounded-full px-3 py-1 border border-white/10"
                >
                  {feature}
                </span>
              ))}
              {card.features.length > 3 && (
                <span className="text-xs text-white/60 bg-white/10 backdrop-blur-sm rounded-full px-3 py-1 border border-white/10">
                  +{card.features.length - 3}
                </span>
              )}
            </div>

            {/* Swipe hints - More prominent on mobile */}
            <div className="flex items-center justify-between mt-4 sm:mt-6 px-2 sm:px-4">
              <div className="flex flex-col items-center space-y-1 text-white/40 text-xs">
                <motion.div
                  animate={{ x: [-2, 2, -2] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                  className="text-base sm:text-sm"
                >
                  ←
                </motion.div>
                <span>Skip</span>
              </div>
              
              <div className="flex flex-col items-center space-y-1 text-white/40 text-xs">
                <motion.div
                  animate={{ y: [0, -3, 0] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut", delay: 0.5 }}
                  className="text-base sm:text-sm"
                >
                  ↓
                </motion.div>
                <span>Refresh</span>
              </div>
              
              <div className="flex flex-col items-center space-y-1 text-white/40 text-xs">
                <motion.div
                  animate={{ x: [-2, 2, -2] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut", delay: 1 }}
                  className="text-base sm:text-sm"
                >
                  →
                </motion.div>
                <span>Explore</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderSwipeView = () => {
    if (!matches.length) {
      return (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center text-white">
            <motion.div
              className="w-20 h-20 bg-gradient-to-r from-[#00BFFF]/20 to-[#FF00FF]/20 rounded-full flex items-center justify-center mx-auto mb-4 border border-[#00BFFF]/30"
              animate={{ scale: [1, 1.1, 1], opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            >
              <Search className="w-10 h-10 text-[#00BFFF] drop-shadow-md" />
            </motion.div>
            <h3 className="mb-3">No spots found</h3>
            <p className="text-white/70 text-sm mb-6">Pull down to refresh and find new spots</p>
            <Button
              onClick={handleRefresh}
              className="bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] text-white"
            >
              Refresh Discovery
            </Button>
          </div>
        </div>
      );
    }

    return (
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
              {/* Background cards */}
              {matches.slice(currentCardIndex + 1, currentCardIndex + 3).map((card, index) => (
                <motion.div
                  key={card.id}
                  className="absolute inset-0 w-full h-full"
                  style={{
                    zIndex: -(index + 1),
                    transform: `scale(${0.94 - index * 0.02}) translateY(${(index + 1) * 8}px)`,
                    opacity: 0.6 - index * 0.2,
                  }}
                >
                  <div 
                    className="w-full h-full rounded-2xl"
                    style={{
                      background: 'linear-gradient(135deg, rgba(18, 18, 18, 0.8) 0%, rgba(0, 191, 255, 0.1) 50%, rgba(255, 0, 255, 0.1) 100%)',
                      backdropFilter: 'blur(20px) saturate(180%)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                    }}
                  >
                    {renderCard(card, currentCardIndex + index + 1)}
                  </div>
                </motion.div>
              ))}

              {/* Current card */}
              {currentCard && (
                <motion.div
                  key={currentCard.id}
                  drag
                  dragConstraints={constraintsRef}
                  dragElastic={0.2}
                  onDragEnd={handleDragEnd}
                  onClick={handleCardTap}
                  style={{ x, y, rotate, opacity, scale }}
                  className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing touch-manipulation"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                >
                  <div 
                    className="w-full h-full rounded-2xl"
                    style={{
                      background: 'linear-gradient(135deg, rgba(18, 18, 18, 0.95) 0%, rgba(0, 191, 255, 0.1) 50%, rgba(255, 0, 255, 0.1) 100%)',
                      backdropFilter: 'blur(20px) saturate(180%)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5), 0 8px 32px rgba(0, 191, 255, 0.2)',
                    }}
                  >
                    {renderCard(currentCard, currentCardIndex, true)}
                  </div>

                  {/* Swipe direction indicators */}
                  <motion.div
                    className="absolute top-1/2 left-4 transform -translate-y-1/2 bg-red-500/20 backdrop-blur-sm rounded-full p-2 sm:p-3 pointer-events-none"
                    style={{ 
                      opacity: leftIndicatorOpacity,
                    }}
                  >
                    <div className="text-red-400 text-xs sm:text-sm font-medium">Skip</div>
                  </motion.div>

                  <motion.div
                    className="absolute top-1/2 right-4 transform -translate-y-1/2 bg-green-500/20 backdrop-blur-sm rounded-full p-2 sm:p-3 pointer-events-none"
                    style={{ 
                      opacity: rightIndicatorOpacity,
                    }}
                  >
                    <div className="text-green-400 text-xs sm:text-sm font-medium">Explore</div>
                  </motion.div>

                  <motion.div
                    className="absolute bottom-6 left-1/2 transform -translate-x-1/2 bg-[#00BFFF]/20 backdrop-blur-sm rounded-full px-3 py-2 pointer-events-none"
                    style={{ 
                      opacity: downIndicatorOpacity,
                    }}
                  >
                    <div className="text-[#00BFFF] text-xs sm:text-sm font-medium">Refresh</div>
                  </motion.div>
                </motion.div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex flex-col h-full min-h-screen"
      style={{ 
        minHeight: '100vh',
        minHeight: '100dvh'
      }}
    >
      <AnimatePresence mode="wait">
        {currentView === 'swipe' && (
          <motion.div
            key="swipe-view"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col h-full"
          >
            {renderSwipeView()}
          </motion.div>
        )}

        {currentView === 'venue-detail' && selectedCard && (
          <motion.div
            key="venue-detail"
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -50 }}
            className="flex flex-col h-full overflow-y-auto"
          >
            <VenueDetail
              venue={selectedCard}
              onBack={handleBackToSwipe}
            />
          </motion.div>
        )}

        {currentView === 'parking-detail' && selectedCard && (
          <motion.div
            key="parking-detail"
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -50 }}
            className="flex flex-col h-full overflow-y-auto"
          >
            <SimpleParkingDetail
              parking={selectedCard}
              onBack={handleBackToSwipe}
            />
          </motion.div>
        )}

        {currentView === 'valet-flow' && selectedCard && (
          <motion.div
            key="valet-flow"
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -50 }}
            className="flex flex-col h-full overflow-y-auto"
          >
            <ValetFlow
              valet={selectedCard}
              onBack={handleBackToSwipe}
            />
          </motion.div>
        )}

        {currentView === 'insider' && (
          <motion.div
            key="insider"
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -50 }}
            className="flex flex-col h-full overflow-y-auto"
          >
            <VenueInsider
              onBack={handleBackToSwipe}
              userData={userData}
              currentTheme={currentTheme}
              weatherTheme={weatherTheme}
              locationTheme={locationTheme}
            />
          </motion.div>
        )}

        {currentView === 'concierge' && (
          <motion.div
            key="concierge"
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -50 }}
            className="flex flex-col h-full overflow-y-auto"
          >
            <ConciergeChat
              onBack={handleBackToSwipe}
              userData={userData}
              currentTheme={currentTheme}
              weatherTheme={weatherTheme}
              locationTheme={locationTheme}
            />
          </motion.div>
        )}

        {currentView === 'profile' && (
          <motion.div
            key="profile"
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -50 }}
            className="flex flex-col h-full overflow-y-auto"
          >
            <ProfileSettings
              userData={userData}
              onBack={handleBackToSwipe}
              onLogout={onLogout}
              onWeatherChange={onWeatherChange}
              onLocationChange={onLocationChange}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer Navigation */}
      <AnimatePresence>
        {showFooter && currentView === 'swipe' && (
          <motion.div
            className="absolute bottom-0 left-0 right-0 z-50 safe-area-bottom"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.3 }}
          >
            <div className="backdrop-blur-enhanced bg-black/40 border-t border-white/10 px-2 py-1.5">
              <div className="flex items-center justify-between max-w-lg mx-auto">
                {/* Discover Button */}
                <motion.button
                  onClick={() => setCurrentView('swipe')}
                  className={`flex flex-col items-center space-y-0.5 px-2 py-1.5 rounded-xl touch-target relative overflow-hidden ${
                    currentView === 'swipe' 
                      ? 'bg-[#00BFFF]/20 border border-[#00BFFF]/30' 
                      : 'bg-black/20'
                  }`}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <Search className={`w-5 h-5 ${
                    currentView === 'swipe' ? 'text-[#00BFFF]' : 'text-white/70'
                  }`} />
                  <span className={`text-xs font-medium ${
                    currentView === 'swipe' ? 'text-[#00BFFF]' : 'text-white/70'
                  }`}>Discover</span>
                </motion.button>

                {/* Map Button */}
                <motion.button
                  onClick={onOpenMap}
                  className="flex flex-col items-center space-y-0.5 px-2 py-1.5 rounded-xl touch-target relative overflow-hidden bg-black/20"
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <Map className="w-5 h-5 text-white/70" />
                  <span className="text-white/70 text-xs font-medium">Map</span>
                </motion.button>

                {/* Insider Button */}
                <motion.button
                  onClick={() => setCurrentView('insider')}
                  className={`flex flex-col items-center space-y-0.5 px-2 py-1.5 rounded-xl touch-target relative overflow-hidden ${
                    currentView === 'insider' 
                      ? 'bg-[#FF00FF]/20 border border-[#FF00FF]/30' 
                      : 'bg-black/20'
                  }`}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <BarChart3 className={`w-5 h-5 ${
                    currentView === 'insider' ? 'text-[#FF00FF]' : 'text-white/70'
                  }`} />
                  <span className={`text-xs font-medium ${
                    currentView === 'insider' ? 'text-[#FF00FF]' : 'text-white/70'
                  }`}>Insider</span>
                </motion.button>

                {/* Concierge Button */}
                <motion.button
                  onClick={() => setCurrentView('concierge')}
                  className={`flex flex-col items-center space-y-0.5 px-2 py-1.5 rounded-xl touch-target relative overflow-hidden ${
                    currentView === 'concierge' 
                      ? 'bg-[#008080]/20 border border-[#008080]/30' 
                      : 'bg-black/20'
                  }`}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <MessageCircle className={`w-5 h-5 ${
                    currentView === 'concierge' ? 'text-[#008080]' : 'text-white/70'
                  }`} />
                  <span className={`text-xs font-medium ${
                    currentView === 'concierge' ? 'text-[#008080]' : 'text-white/70'
                  }`}>Concierge</span>
                </motion.button>

                {/* Profile Button */}
                <motion.button
                  onClick={() => setCurrentView('profile')}
                  className={`flex flex-col items-center space-y-0.5 px-2 py-1.5 rounded-xl touch-target relative overflow-hidden ${
                    currentView === 'profile' 
                      ? 'bg-[#FF4500]/20 border border-[#FF4500]/30' 
                      : 'bg-black/20'
                  }`}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <UserCircle className={`w-5 h-5 ${
                    currentView === 'profile' ? 'text-[#FF4500]' : 'text-white/70'
                  }`} />
                  <span className={`text-xs font-medium ${
                    currentView === 'profile' ? 'text-[#FF4500]' : 'text-white/70'
                  }`}>Profile</span>
                </motion.button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};