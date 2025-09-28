// This enhanced file has been removed - functionality restored to main SwipeInterface
import { 
  Heart, 
  X, 
  Star, 
  MapPin, 
  Clock, 
  DollarSign, 
  User,
  Settings,
  LogOut,
  Map,
  BarChart3,
  MessageCircle,
  Car,
  UtensilsCrossed,
  Users,
  Search,
  Compass,
  Sparkles,
  TrendingUp,
  Zap,
  Music,
  Calendar,
  Shield,
  Coffee,
  Eye,
  Timer,
  Award,
  ThumbsUp,
  Sliders
} from 'lucide-react';
import { Button } from './ui/button';
import { ImageWithFallback } from './figma/ImageWithFallback';
import { VenueDetail } from './VenueDetail';
import { ParkingDetail } from './ParkingDetail';
import { ConciergeChat } from './ConciergeChat';
import { ValetFlow } from './ValetFlow';
import { VenueInsider } from './VenueInsider';
import { ProfileSettings } from './ProfileSettings';
import { VibePreferences } from './VibePreferences';

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
  color: string;
  trending?: boolean;
  energyLevel?: 'Low' | 'Medium' | 'High Energy' | 'Electric';
  crowd?: 'Empty' | 'Quiet' | 'Moderate' | 'Busy' | 'Packed' | 'Full';
  liveVibeScore?: number;
  peopleInside?: number;
  vibeDescription?: string;
  tonightsEvents?: Array<{
    time: string;
    type: 'Music' | 'Special' | 'Access' | 'Food' | 'Drink';
    title: string;
    description?: string;
  }>;
  amenities?: string[];
  recentReviews?: Array<{
    name: string;
    initial: string;
    review: string;
    rating: number;
    timeAgo: string;
  }>;
  spotsAvailable?: number;
  totalSpots?: number;
  securityLevel?: 'Basic' | 'Standard' | 'Premium' | 'Maximum';
  accessMethod?: string[];
  restrictions?: string[];
  responseTime?: string;
  serviceLevel?: 'Standard' | 'Premium' | 'Luxury' | 'White Glove';
  additionalServices?: string[];
}

interface ActivityNotification {
  id: string;
  type: 'match' | 'booking' | 'user_join' | 'trending';
  message: string;
  timestamp: Date;
  color: string;
}

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
  const [showMenu, setShowMenu] = useState(false);
  const [currentView, setCurrentView] = useState<'swipe' | 'map' | 'insider' | 'concierge' | 'venue-detail' | 'parking-detail' | 'valet-flow' | 'profile' | 'vibe-preferences'>('swipe');
  const [selectedCard, setSelectedCard] = useState<MatchCard | null>(null);
  const [activities, setActivities] = useState<ActivityNotification[]>([]);
  const [swipeDirection, setSwipeDirection] = useState<'left' | 'right' | null>(null);
  const [userPreferences, setUserPreferences] = useState<any>(null);
  const constraintsRef = useRef(null);

  const matches: MatchCard[] = [
    {
      id: '1',
      type: 'venue',
      title: 'Rooftop Lounge',
      subtitle: 'Trending Now • High Energy',
      description: 'Premium rooftop experience with stunning city views and vibrant nightlife atmosphere.',
      image: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxyb29mdG9wJTIwYmFyJTIwbmlnaHR8ZW58MXx8fHwxNzU2MzMwMjY1fDA&ixlib=rb-4.1.0&q=80&w=1080',
      price: '$45/person',
      rating: 4.8,
      distance: '5 min walk',
      availability: 'Open',
      features: ['City Views', 'Live DJ', 'Craft Cocktails', 'Outdoor Seating'],
      color: 'from-purple-500 to-pink-500',
      trending: true,
      energyLevel: 'High Energy',
      crowd: 'Packed',
      liveVibeScore: 85,
      peopleInside: 127,
      vibeDescription: 'Electric atmosphere with live music and buzzing crowd'
    }
  ];

  // Handlers
  const handlePreferencesComplete = (preferences: any) => {
    setUserPreferences(preferences);
    setCurrentView('swipe');
    console.log('Preferences saved:', preferences);
  };

  const handlePreferencesBack = () => {
    setCurrentView('swipe');
  };

  const currentCard = matches[currentCardIndex];
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-300, 300], [-30, 30]);
  const opacity = useTransform(x, [-300, -150, 0, 150, 300], [0, 1, 1, 1, 0]);

  const handleDragEnd = (event: any, info: PanInfo) => {
    const threshold = 150;
    if (Math.abs(info.offset.x) > threshold) {
      const direction = info.offset.x > 0 ? 'right' : 'left';
      handleSwipe(direction);
    }
  };

  const handleSwipe = (direction: 'left' | 'right') => {
    setSwipeDirection(direction);
    if (currentCard) {
      if (direction === 'right') {
        console.log('Liked:', currentCard.title);
        setTimeout(() => {
          setSelectedCard(currentCard);
          if (currentCard.type === 'venue') {
            setCurrentView('venue-detail');
          } else if (currentCard.type === 'valet') {
            setCurrentView('valet-flow');
          } else if (currentCard.type === 'parking') {
            setCurrentView('parking-detail');
          }
        }, 300);
        
        if (onTriggerAchievement) {
          onTriggerAchievement();
        }
        return;
      } else {
        console.log('Passed:', currentCard.title);
        setTimeout(() => {
          setSwipeDirection(null);
        }, 300);
      }
    }
    
    setTimeout(() => {
      if (currentCardIndex < matches.length - 1) {
        setCurrentCardIndex(currentCardIndex + 1);
        x.set(0);
      } else {
        setCurrentCardIndex(0);
        x.set(0);
      }
    }, direction === 'left' ? 300 : 0);
  };

  // Render different views
  if (currentView === 'vibe-preferences') {
    return (
      <VibePreferences
        userData={userData}
        onComplete={handlePreferencesComplete}
        onBack={handlePreferencesBack}
        isOnboarding={false}
        existingPreferences={userPreferences}
      />
    );
  }

  if (currentView === 'venue-detail' && selectedCard) {
    return (
      <VenueDetail
        venue={selectedCard}
        onBack={() => setCurrentView('swipe')}
        userData={userData}
      />
    );
  }

  if (currentView === 'parking-detail' && selectedCard) {
    return (
      <ParkingDetail
        parking={selectedCard}
        onBack={() => setCurrentView('swipe')}
        userData={userData}
      />
    );
  }

  if (currentView === 'valet-flow' && selectedCard) {
    return (
      <ValetFlow
        service={selectedCard}
        onBack={() => setCurrentView('swipe')}
        userData={userData}
      />
    );
  }

  if (currentView === 'profile') {
    return (
      <ProfileSettings
        userData={userData}
        onBack={() => setCurrentView('swipe')}
        onLogout={onLogout}
      />
    );
  }

  if (currentView === 'concierge') {
    return (
      <ConciergeChat
        userData={userData}
        onBack={() => setCurrentView('swipe')}
      />
    );
  }

  if (currentView === 'insider') {
    return (
      <VenueInsider
        onBack={() => setCurrentView('swipe')}
        userData={userData}
      />
    );
  }

  // Main swipe interface
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] relative overflow-hidden">
      {/* Background Effects */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <motion.div
          className="absolute top-1/4 left-1/4 w-96 h-96 bg-gradient-to-r from-[#00BFFF]/20 via-[#FF00FF]/15 to-[#008080]/10 rounded-full blur-3xl"
          animate={{
            x: [0, 50, 0],
            y: [0, -25, 0],
            scale: [1, 1.2, 1],
          }}
          transition={{
            duration: 20,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
        <motion.div
          className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-gradient-to-r from-[#FF00FF]/15 via-[#00BFFF]/10 to-[#FF4500]/8 rounded-full blur-3xl"
          animate={{
            x: [0, -40, 0],
            y: [0, 30, 0],
            scale: [1.1, 1, 1.1],
          }}
          transition={{
            duration: 18,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
      </div>

      {/* Header */}
      <motion.div
        className="absolute top-safe z-20 w-full flex items-center justify-between p-6"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        {/* Logo/Title */}
        <div className="flex items-center space-x-3">
          <motion.div
            className="w-10 h-10 rounded-2xl bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] flex items-center justify-center"
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
          >
            <Sparkles className="w-6 h-6 text-white" />
          </motion.div>
          <div>
            <h1 className="text-white font-bold text-xl">Premium Discovery</h1>
            <p className="text-white/60 text-sm">
              {userPreferences ? 'Personalized for you' : 'Swipe to discover'}
            </p>
          </div>
        </div>

        {/* Menu Toggle */}
        <motion.button
          onClick={() => setShowMenu(!showMenu)}
          className="w-10 h-10 rounded-2xl glass-effect flex items-center justify-center text-white hover:bg-white/10 transition-colors"
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <User className="w-5 h-5" />
        </motion.button>
      </motion.div>

      {/* Menu */}
      <AnimatePresence>
        {showMenu && (
          <motion.div
            className="absolute top-20 right-6 z-30 w-64 glass-card rounded-2xl p-4 border border-white/10"
            initial={{ opacity: 0, scale: 0.9, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            <div className="space-y-2">
              <button
                onClick={() => {
                  setCurrentView('profile');
                  setShowMenu(false);
                }}
                className="w-full flex items-center space-x-3 p-3 rounded-xl hover:bg-white/10 text-white transition-colors"
              >
                <User className="w-5 h-5" />
                <span>Profile</span>
              </button>
              <button
                onClick={() => {
                  setCurrentView('vibe-preferences');
                  setShowMenu(false);
                }}
                className="w-full flex items-center space-x-3 p-3 rounded-xl hover:bg-white/10 text-white transition-colors"
              >
                <Sliders className="w-5 h-5" />
                <span>For You</span>
                {userPreferences && (
                  <div className="w-2 h-2 bg-[#00BFFF] rounded-full ml-auto"></div>
                )}
              </button>
              <button
                onClick={() => {
                  setCurrentView('insider');
                  setShowMenu(false);
                }}
                className="w-full flex items-center space-x-3 p-3 rounded-xl hover:bg-white/10 text-white transition-colors"
              >
                <BarChart3 className="w-5 h-5" />
                <span>Venue Insider</span>
              </button>
              <button
                onClick={() => {
                  setCurrentView('concierge');
                  setShowMenu(false);
                }}
                className="w-full flex items-center space-x-3 p-3 rounded-xl hover:bg-white/10 text-white transition-colors"
              >
                <MessageCircle className="w-5 h-5" />
                <span>Chat</span>
              </button>
              <div className="h-px bg-white/20 my-2"></div>
              <button
                onClick={onLogout}
                className="w-full flex items-center space-x-3 p-3 rounded-xl hover:bg-red-500/20 text-red-400 transition-colors"
              >
                <LogOut className="w-5 h-5" />
                <span>Sign Out</span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Content Area */}
      <div className="flex-1 flex items-center justify-center p-6 pt-32 pb-32">
        {currentCard ? (
          <motion.div
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            onDragEnd={handleDragEnd}
            style={{ x, rotate, opacity }}
            className="w-full max-w-sm h-[600px] cursor-grab active:cursor-grabbing"
            whileHover={{ scale: 1.02 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
          >
            <div className="w-full h-full glass-card rounded-3xl overflow-hidden relative">
              {/* Background Image */}
              <div className="absolute inset-0">
                <ImageWithFallback
                  src={currentCard.image}
                  alt={currentCard.title}
                  className="w-full h-full object-cover"
                />
                <div className={`absolute inset-0 bg-gradient-to-t ${currentCard.color} opacity-60`} />
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
              </div>

              {/* Content */}
              <div className="relative z-10 h-full flex flex-col justify-between p-6">
                {/* Header */}
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center space-x-3">
                    <motion.div
                      className={`w-12 h-12 rounded-2xl bg-gradient-to-r ${currentCard.color} flex items-center justify-center glass-effect`}
                      whileHover={{ scale: 1.1, rotate: 5 }}
                      transition={{ duration: 0.2 }}
                    >
                      {currentCard.type === 'parking' && <Car className="w-8 h-8 text-white" />}
                      {currentCard.type === 'venue' && <UtensilsCrossed className="w-8 h-8 text-white" />}
                      {currentCard.type === 'valet' && <Users className="w-8 h-8 text-white" />}
                    </motion.div>
                    
                    {currentCard.trending && (
                      <motion.div
                        className="flex items-center space-x-1 bg-red-500/20 backdrop-blur-sm rounded-full px-2 py-1 border border-red-400/30"
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: 0.1 }}
                      >
                        <TrendingUp className="w-3 h-3 text-red-400" />
                        <span className="text-red-300 text-xs font-medium">Trending</span>
                      </motion.div>
                    )}
                  </div>
                  
                  <motion.div
                    className="flex items-center space-x-1 bg-black/30 backdrop-blur-sm rounded-full px-3 py-1"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.2 }}
                  >
                    <Star className="w-4 h-4 text-yellow-400 fill-current" />
                    <span className="text-white text-sm font-medium">{currentCard.rating}</span>
                  </motion.div>
                </div>

                {/* Main Content */}
                <div className="flex-1 space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-white/70 text-sm uppercase tracking-wide">
                        {currentCard.type === 'parking' ? 'Smart Parking' : 
                         currentCard.type === 'venue' ? 'Venue Discovery' : 'Valet Services'}
                      </span>
                      <span className="text-white/70 text-sm">{currentCard.distance}</span>
                    </div>
                    
                    <h3 className="text-white text-xl font-semibold">{currentCard.title}</h3>
                    <p className="text-white/80 text-sm">{currentCard.subtitle}</p>
                  </div>

                  {/* Price and Availability */}
                  <div className="flex items-center justify-between bg-white/10 backdrop-blur-sm rounded-2xl p-3 border border-white/20">
                    <div className="flex items-center space-x-2">
                      <Clock className="w-4 h-4 text-white/60" />
                      <span className="text-white/80 text-sm">{currentCard.availability}</span>
                    </div>
                    <div className="flex items-center space-x-1">
                      <DollarSign className="w-4 h-4 text-white/60" />
                      <span className="text-white font-semibold">{currentCard.price}</span>
                    </div>
                  </div>

                  {/* Features */}
                  <div className="flex flex-wrap gap-2">
                    {currentCard.features.slice(0, 4).map((feature, index) => (
                      <span
                        key={index}
                        className="text-xs text-white/80 bg-white/20 backdrop-blur-sm rounded-full px-3 py-1 border border-white/10"
                      >
                        {feature}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        ) : (
          <div className="text-center text-white">
            <p>No more cards available</p>
          </div>
        )}
      </div>

      {/* Bottom Action Buttons */}
      <motion.div
        className="absolute bottom-safe w-full flex items-center justify-center space-x-6 p-6"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.2 }}
      >
        {/* Pass Button */}
        <motion.button
          onClick={() => handleSwipe('left')}
          className="w-16 h-16 rounded-2xl bg-gradient-to-r from-red-500 to-red-600 flex items-center justify-center shadow-lg border-0"
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          transition={{ duration: 0.2 }}
        >
          <X className="w-8 h-8 text-white" />
        </motion.button>

        {/* For You Button */}
        <motion.button
          onClick={() => setCurrentView('vibe-preferences')}
          className="w-16 h-16 rounded-2xl bg-gradient-to-r from-[#00BFFF] to-[#008080] flex items-center justify-center shadow-lg border-0 relative"
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          transition={{ duration: 0.2 }}
        >
          <Sliders className="w-8 h-8 text-white" />
          {userPreferences && (
            <motion.div
              className="absolute -top-1 -right-1 w-4 h-4 bg-[#FF00FF] rounded-full border-2 border-white"
              animate={{
                scale: [1, 1.2, 1],
              }}
              transition={{
                duration: 2,
                repeat: Infinity,
                ease: "easeInOut"
              }}
            />
          )}
        </motion.button>

        {/* Like Button */}
        <motion.button
          onClick={() => handleSwipe('right')}
          className="w-16 h-16 rounded-2xl bg-gradient-to-r from-green-500 to-green-600 flex items-center justify-center shadow-lg border-0"
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          transition={{ duration: 0.2 }}
        >
          <Heart className="w-8 h-8 text-white" />
        </motion.button>
      </motion.div>

      {/* Click outside to close menu */}
      {showMenu && (
        <div
          className="fixed inset-0 z-10"
          onClick={() => setShowMenu(false)}
        />
      )}
    </div>
  );
}