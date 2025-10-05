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
  ChevronUp
} from 'lucide-react';
import { Button } from './ui/button';
import { ImageWithFallback } from './figma/ImageWithFallback';
import { VenueDetail } from './VenueDetail';
import { SimpleParkingDetail } from './SimpleParkingDetail';
import { ConciergeChat } from './ConciergeChat';
import { ValetFlow } from './ValetFlow';
import { VenueInsider } from './VenueInsider';
import { ProfileSettings } from './ProfileSettings';

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

type ViewType = 'swipe' | 'map' | 'insider' | 'concierge' | 'venue-detail' | 'parking-detail' | 'valet-flow' | 'profile';

export function SwipeInterface({ 
  userData, 
  onBack, 
  onLogout,
  currentTheme = 'morning',
  weatherTheme = 'sunny',
  locationTheme = 'city',
  onWeatherChange = () => {},
  onLocationChange = () => {},
  onTriggerAchievement = () => {}
}: SwipeInterfaceProps) {
  const [currentCardIndex, setCurrentCardIndex] = useState(0);
  const [currentView, setCurrentView] = useState<ViewType>('swipe');
  const [selectedCard, setSelectedCard] = useState<MatchCard | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const [showFooter, setShowFooter] = useState(true);
  const [scrollPosition, setScrollPosition] = useState(0);
  const constraintsRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
  const leftIndicatorScale = useTransform(x, [-150, -50, 0], [1.2, 1, 0.8]);
  const rightIndicatorOpacity = useTransform(x, [0, 50, 150], [0, 0.5, 1]);
  const rightIndicatorScale = useTransform(x, [0, 50, 150], [0.8, 1, 1.2]);
  const downIndicatorOpacity = useTransform(y, [0, 50, 100], [0, 0.5, 1]);
  const downIndicatorScale = useTransform(y, [0, 50, 100], [0.8, 1, 1.2]);

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
  }, [isAnimating]);

  const handleSwipe = useCallback((direction: 'left' | 'right') => {
    if (isAnimating || !currentCard) return;
    
    setIsAnimating(true);
    
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
      }, 300);
    }
  }, [currentCard, currentCardIndex, isAnimating, matches.length, onTriggerAchievement]);

  const handleRefresh = useCallback(() => {
    if (isAnimating || isRefreshing) return;
    
    setIsAnimating(true);
    setIsRefreshing(true);
    
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
      }, 800);
    }, 400);
  }, [isAnimating, isRefreshing, onTriggerAchievement]);

  const handleCardTap = useCallback(() => {
    if (!currentCard || isAnimating) return;
    
    setSelectedCard(currentCard);
    if (currentCard.type === 'venue') {
      setCurrentView('venue-detail');
    } else if (currentCard.type === 'valet') {
      setCurrentView('valet-flow');
    } else if (currentCard.type === 'parking') {
      setCurrentView('parking-detail');
    }
  }, [currentCard, isAnimating]);

  const handleBackToSwipe = useCallback(() => {
    setCurrentView('swipe');
    setSelectedCard(null);
    setShowFooter(true); // Always show footer when returning to main view
  }, []);

  // Handle scroll events to hide/show footer for better content visibility
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (currentView === 'insider' || currentView === 'venue-detail' || currentView === 'parking-detail') {
      const element = e.currentTarget;
      const { scrollTop, scrollHeight, clientHeight } = element;
      
      // Track scroll position for better back to top button handling
      setScrollPosition(scrollTop);
      
      // More aggressive footer hiding for VenueInsider
      const isNearBottom = scrollTop + clientHeight >= scrollHeight - 200;
      const isAtTop = scrollTop <= 50;
      
      // Immediately show footer if at very top
      if (isAtTop) {
        setShowFooter(true);
        setIsScrolling(false);
        return;
      }
      
      // Hide footer when scrolling or near bottom
      setIsScrolling(true);
      setShowFooter(false);
      
      // Clear existing timeout
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      
      // Show footer after scroll stops
      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false);
        // Show footer if at top of page (generous threshold)
        if (scrollTop < 150) {
          setShowFooter(true);
        }
        // Keep footer hidden if user is near bottom content/buttons
        else if (isNearBottom) {
          setShowFooter(false);
        }
      }, 250);
    }
  }, [currentView]);

  // Reset footer visibility when view changes
  useEffect(() => {
    if (currentView === 'swipe' || currentView === 'map') {
      setShowFooter(true);
    } else if (currentView === 'concierge') {
      setShowFooter(false);
    } else if (currentView === 'insider') {
      // Start with footer visible for VenueInsider (at top), then hide as user scrolls
      setShowFooter(true);
      // Auto-hide after 3 seconds to encourage exploration
      setTimeout(() => {
        setShowFooter(false);
      }, 3000);
    }
  }, [currentView]);

  // Add global touch handler to hide footer when touching bottom content
  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      if (currentView === 'insider' || currentView === 'venue-detail' || currentView === 'parking-detail') {
        const touchY = e.touches[0].clientY;
        const windowHeight = window.innerHeight;
        
        // If touching in bottom 50% of screen, hide footer (more aggressive)
        if (touchY > windowHeight * 0.5) {
          setShowFooter(false);
        }
        // If touching very top area, show footer
        else if (touchY < windowHeight * 0.15) {
          setShowFooter(true);
        }
      }
    };

    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    return () => document.removeEventListener('touchstart', handleTouchStart);
  }, [currentView]);

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
        <div className="relative z-10 h-full flex flex-col justify-between p-6">
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
          <div className="space-y-4">
            {/* Title and Location */}
            <div className="space-y-2">
              <h2 className="text-white text-2xl font-semibold">{card.title}</h2>
              <p className="text-white/80 text-base">{card.subtitle}</p>
            </div>

            {/* Distance and Availability */}
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-1.5">
                <MapPin className="w-4 h-4 text-white/70 drop-shadow-sm" />
                <span className="text-white/80 text-sm">{card.walkTime || card.distance}</span>
              </div>
              <div className="flex items-center space-x-1.5">
                <Clock className="w-4 h-4 text-white/70 drop-shadow-sm" />
                <span className="text-white/80 text-sm">{card.availability}</span>
              </div>
            </div>

            {/* Type-specific info */}
            {card.type === 'venue' && card.liveVibeScore && (
              <div className="bg-white/12 backdrop-blur-sm rounded-xl p-4 border border-white/25 shadow-lg">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-white/90 text-sm font-medium">Live Vibe</span>
                  <div className="flex items-center space-x-2 bg-white/10 rounded-lg px-2 py-1">
                    <Zap className="w-5 h-5 text-yellow-400 drop-shadow-sm" />
                    <span className="text-white font-bold text-lg">{card.liveVibeScore}</span>
                    <span className="text-white/70 text-sm">/100</span>
                  </div>
                </div>
                <div className="text-sm text-white/80">
                  <span className="font-medium">{card.peopleInside}</span> people • {card.energyLevel}
                </div>
              </div>
            )}

            {card.type === 'parking' && card.spotsAvailable && (
              <div className="bg-white/12 backdrop-blur-sm rounded-xl p-4 border border-white/25 shadow-lg">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-white/90 text-sm font-medium">Availability</span>
                  <div className="flex items-center space-x-2 bg-white/10 rounded-lg px-2 py-1">
                    <Car className="w-5 h-5 text-green-400 drop-shadow-sm" />
                    <span className="text-white font-bold text-lg">{card.spotsAvailable}</span>
                    <span className="text-white/70 text-sm">/{card.totalSpots}</span>
                  </div>
                </div>
                <div className="text-sm text-white/80">Security: <span className="font-medium">{card.securityLevel}</span></div>
              </div>
            )}

            {card.type === 'valet' && card.responseTime && (
              <div className="bg-white/12 backdrop-blur-sm rounded-xl p-4 border border-white/25 shadow-lg">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-white/90 text-sm font-medium">Service Level</span>
                  <div className="flex items-center space-x-2 bg-white/10 rounded-lg px-2 py-1">
                    <Award className="w-5 h-5 text-yellow-400 drop-shadow-sm" />
                    <span className="text-white font-bold text-sm">{card.serviceLevel}</span>
                  </div>
                </div>
                <div className="text-sm text-white/80">Response: <span className="font-medium">{card.responseTime}</span></div>
              </div>
            )}

            {/* Price */}
            <div className="flex items-center justify-between bg-white/12 backdrop-blur-sm rounded-xl p-4 border border-white/25 shadow-lg">
              <div className="flex items-center space-x-2">
                <DollarSign className="w-6 h-6 text-[#00BFFF] drop-shadow-sm" />
                <span className="text-white font-bold text-lg">{card.price}</span>
              </div>
              <span className="text-white/90 text-sm font-medium">{card.availability}</span>
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

            {/* Swipe hints */}
            <div className="flex items-center justify-between mt-6 px-4">
              <div className="flex flex-col items-center space-y-1 text-white/40 text-xs">
                <motion.div
                  animate={{ x: [-2, 2, -2] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                >
                  ←
                </motion.div>
                <span>Skip</span>
              </div>
              
              <div className="flex flex-col items-center space-y-1 text-white/40 text-xs">
                <motion.div
                  animate={{ y: [0, -3, 0] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut", delay: 0.5 }}
                >
                  ↓
                </motion.div>
                <span>Refresh</span>
              </div>
              
              <div className="flex flex-col items-center space-y-1 text-white/40 text-xs">
                <motion.div
                  animate={{ x: [-2, 2, -2] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut", delay: 1 }}
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
        
        <div className="flex items-center justify-center px-6 pt-6 pb-32 h-full">
          <div className="relative w-full max-w-sm mx-auto h-[600px]">
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
                  className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing"
                  whileHover={{ scale: 1.02 }}
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
                    className="absolute top-1/2 left-4 transform -translate-y-1/2 bg-red-500/20 backdrop-blur-sm rounded-full p-3 pointer-events-none"
                    style={{ 
                      opacity: leftIndicatorOpacity,
                      scale: leftIndicatorScale
                    }}
                  >
                    <div className="text-red-400 text-sm font-medium">Skip</div>
                  </motion.div>

                  <motion.div
                    className="absolute top-1/2 right-4 transform -translate-y-1/2 bg-green-500/20 backdrop-blur-sm rounded-full p-3 pointer-events-none"
                    style={{ 
                      opacity: rightIndicatorOpacity,
                      scale: rightIndicatorScale
                    }}
                  >
                    <div className="text-green-400 text-sm font-medium">Explore</div>
                  </motion.div>

                  <motion.div
                    className="absolute bottom-6 left-1/2 transform -translate-x-1/2 bg-[#00BFFF]/20 backdrop-blur-sm rounded-full px-3 py-1 pointer-events-none"
                    style={{ 
                      opacity: downIndicatorOpacity,
                      scale: downIndicatorScale
                    }}
                  >
                    <div className="text-[#00BFFF] text-sm font-medium">Refresh</div>
                  </motion.div>
                </motion.div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderMapView = () => {
    return (
      <div className="flex-1 relative">
        <div className="absolute inset-0 bg-gradient-to-br from-[#121212] via-[#1a1a1a] to-[#000000] flex items-center justify-center">
          <div className="text-center text-white">
            <motion.div
              className="w-20 h-20 bg-gradient-to-r from-[#00BFFF]/20 to-[#FF00FF]/20 rounded-full flex items-center justify-center mx-auto mb-4 border border-[#00BFFF]/30"
              animate={{ scale: [1, 1.1, 1], opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            >
              <Map className="w-8 h-8 text-[#00BFFF]" />
            </motion.div>
            <h3 className="mb-3">Interactive Map</h3>
            <p className="text-white/70 text-sm">Coming soon - Real-time spot mapping</p>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] relative overflow-hidden">
      <AnimatePresence mode="wait">
        {currentView === 'swipe' && (
          <motion.div
            key="swipe"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.3 }}
            className="h-screen flex flex-col"
          >
            {renderSwipeView()}
          </motion.div>
        )}

        {currentView === 'map' && (
          <motion.div
            key="map"
            initial={{ opacity: 0, x: 100 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -100 }}
            transition={{ duration: 0.3 }}
            className="h-screen flex flex-col"
          >
            {renderMapView()}
          </motion.div>
        )}

        {currentView === 'insider' && (
          <motion.div
            key="insider"
            initial={{ opacity: 0, y: 100 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 100 }}
            transition={{ duration: 0.3 }}
            className="h-screen"
            onScroll={handleScroll}
          >
            <VenueInsider 
              onBack={handleBackToSwipe}
              currentTheme={currentTheme}
              weatherTheme={weatherTheme}
              locationTheme={locationTheme}
              onTriggerAchievement={onTriggerAchievement}
            />
          </motion.div>
        )}

        {currentView === 'concierge' && (
          <motion.div
            key="concierge"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.3 }}
            className="h-screen"
          >
            <ConciergeChat 
              onBack={handleBackToSwipe}
              userData={userData}
              onTriggerAchievement={onTriggerAchievement}
            />
          </motion.div>
        )}

        {currentView === 'venue-detail' && selectedCard && (
          <motion.div
            key="venue-detail"
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            transition={{ duration: 0.3 }}
            className="h-screen"
            onScroll={handleScroll}
          >
            <VenueDetail
              venue={selectedCard}
              onBack={handleBackToSwipe}
              onTriggerAchievement={onTriggerAchievement}
            />
          </motion.div>
        )}

        {currentView === 'parking-detail' && selectedCard && (
          <motion.div
            key="parking-detail"
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            transition={{ duration: 0.3 }}
            className="h-screen"
            onScroll={handleScroll}
          >
            <SimpleParkingDetail
              parking={selectedCard}
              onBack={handleBackToSwipe}
              onTriggerAchievement={onTriggerAchievement}
            />
          </motion.div>
        )}

        {currentView === 'valet-flow' && selectedCard && (
          <motion.div
            key="valet-flow"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.3 }}
            className="h-screen"
          >
            <ValetFlow
              valet={selectedCard}
              onBack={handleBackToSwipe}
              onTriggerAchievement={onTriggerAchievement}
            />
          </motion.div>
        )}

        {currentView === 'profile' && (
          <motion.div
            key="profile"
            initial={{ opacity: 0, x: 100 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -100 }}
            transition={{ duration: 0.3 }}
            className="h-screen"
          >
            <ProfileSettings
              userData={userData}
              onBack={handleBackToSwipe}
              onLogout={onLogout}
              currentTheme={currentTheme}
              weatherTheme={weatherTheme}
              locationTheme={locationTheme}
              onWeatherChange={onWeatherChange}
              onLocationChange={onLocationChange}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer Navigation */}
      <AnimatePresence>
        {showFooter && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed bottom-0 left-0 right-0 z-[999] footer-navigation safe-area-bottom"
            style={{
              background: 'linear-gradient(135deg, rgba(18, 18, 18, 0.95) 0%, rgba(0, 191, 255, 0.1) 50%, rgba(255, 0, 255, 0.1) 100%)',
              backdropFilter: 'blur(20px) saturate(180%)',
              borderTop: '1px solid rgba(255, 255, 255, 0.1)',
              boxShadow: '0 -8px 32px rgba(0, 0, 0, 0.3)',
            }}
          >
            <div className="px-4 py-3 sm:px-6 sm:py-4">
              <div className="flex items-center justify-between max-w-lg mx-auto">
                {/* Discover Button */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCurrentView('swipe')}
                  className={`flex flex-col items-center space-y-1 px-3 py-2 h-auto min-h-[60px] min-w-[60px] z-[1000] touch-target transition-all duration-200 ${
                    currentView === 'swipe' ? 'text-[#00BFFF] bg-[#00BFFF]/10 rounded-xl' : 'text-white/60 hover:text-white hover:bg-white/5 rounded-xl'
                  }`}
                >
                  <Search className="w-6 h-6 drop-shadow-sm" />
                  <span className="text-xs font-medium">Discover</span>
                </Button>

                {/* Map Button */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCurrentView('map')}
                  className={`flex flex-col items-center space-y-1 px-3 py-2 h-auto min-h-[60px] min-w-[60px] z-[1000] touch-target transition-all duration-200 ${
                    currentView === 'map' ? 'text-[#00BFFF] bg-[#00BFFF]/10 rounded-xl' : 'text-white/60 hover:text-white hover:bg-white/5 rounded-xl'
                  }`}
                >
                  <Map className="w-6 h-6 drop-shadow-sm" />
                  <span className="text-xs font-medium">Map</span>
                </Button>

                {/* Insider Button */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCurrentView('insider')}
                  className={`flex flex-col items-center space-y-1 px-3 py-2 h-auto min-h-[60px] min-w-[60px] z-[1000] touch-target transition-all duration-200 ${
                    currentView === 'insider' ? 'text-[#FF00FF] bg-[#FF00FF]/10 rounded-xl' : 'text-white/60 hover:text-white hover:bg-white/5 rounded-xl'
                  }`}
                >
                  <BarChart3 className="w-6 h-6 drop-shadow-sm" />
                  <span className="text-xs font-medium">Insider</span>
                </Button>

                {/* Concierge Button */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCurrentView('concierge')}
                  className={`flex flex-col items-center space-y-1 px-3 py-2 h-auto min-h-[60px] min-w-[60px] z-[1000] touch-target transition-all duration-200 ${
                    currentView === 'concierge' ? 'text-[#FF00FF] bg-[#FF00FF]/10 rounded-xl' : 'text-white/60 hover:text-white hover:bg-white/5 rounded-xl'
                  }`}
                >
                  <MessageCircle className="w-6 h-6 drop-shadow-sm" />
                  <span className="text-xs font-medium">Concierge</span>
                </Button>

                {/* Profile Button */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCurrentView('profile')}
                  className={`flex flex-col items-center space-y-1 px-3 py-2 h-auto min-h-[60px] min-w-[60px] z-[1000] touch-target transition-all duration-200 ${
                    currentView === 'profile' ? 'text-[#00BFFF] bg-[#00BFFF]/10 rounded-xl' : 'text-white/60 hover:text-white hover:bg-white/5 rounded-xl'
                  }`}
                >
                  <UserCircle className="w-6 h-6 drop-shadow-sm" />
                  <span className="text-xs font-medium">Profile</span>
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Back to Top Button for scrollable views */}
      {(currentView === 'insider' || currentView === 'venue-detail' || currentView === 'parking-detail') && scrollPosition > 300 && (
        <motion.button
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          onClick={() => {
            const element = document.querySelector('.h-screen');
            if (element) {
              element.scrollTo({ top: 0, behavior: 'smooth' });
            }
          }}
          className="fixed bottom-24 right-6 z-[998] w-12 h-12 bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] rounded-full flex items-center justify-center shadow-lg back-to-top-button"
          style={{
            backdropFilter: 'blur(20px) saturate(180%)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
          }}
        >
          <ChevronUp className="w-6 h-6 text-white" />
        </motion.button>
      )}
    </div>
  );
}