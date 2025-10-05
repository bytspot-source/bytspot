// This temporary file has been removed - functionality restored to main SwipeInterface
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
  ThumbsUp
} from 'lucide-react';
import { Button } from './ui/button';
import { ImageWithFallback } from './figma/ImageWithFallback';
import { VenueDetail } from './VenueDetail';
import { ParkingDetail } from './ParkingDetail';
import { ConciergeChat } from './ConciergeChat';
import { ValetFlow } from './ValetFlow';
import { VenueInsider } from './VenueInsider';
import { ProfileSettings } from './ProfileSettings';
import { VibePreferencesModal } from './VibePreferencesModal';

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
  // Enhanced venue details
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
  // Enhanced parking details
  spotsAvailable?: number;
  totalSpots?: number;
  securityLevel?: 'Basic' | 'Standard' | 'Premium' | 'Maximum';
  accessMethod?: string[];
  restrictions?: string[];
  // Enhanced valet details
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
  const [currentView, setCurrentView] = useState<'swipe' | 'map' | 'insider' | 'concierge' | 'venue-detail' | 'parking-detail' | 'valet-flow' | 'profile'>('swipe');
  const [showVibePreferences, setShowVibePreferences] = useState(false);
  const [hasPersonalizedPreferences, setHasPersonalizedPreferences] = useState(false);
  const [selectedCard, setSelectedCard] = useState<MatchCard | null>(null);
  const [activities, setActivities] = useState<ActivityNotification[]>([]);
  const [swipeDirection, setSwipeDirection] = useState<'left' | 'right' | null>(null);
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
      vibeDescription: 'Electric atmosphere with live music and buzzing crowd',
      tonightsEvents: [
        {
          time: '9:00 PM',
          type: 'Music',
          title: 'Live DJ Set',
          description: 'House & Electronic'
        },
        {
          time: '10:30 PM',
          type: 'Special',
          title: 'Happy Hour Extended',
          description: '2-for-1 cocktails'
        },
        {
          time: '11:00 PM',
          type: 'Access',
          title: 'Rooftop Opens',
          description: 'Full terrace access'
        }
      ],
      amenities: ['City Views', 'Live DJ', 'Craft Cocktails', 'Outdoor Seating', 'Premium Sound System', 'VIP Areas'],
      recentReviews: [
        {
          name: 'Sarah M.',
          initial: 'S',
          review: 'Amazing atmosphere and great cocktails!',
          rating: 5,
          timeAgo: '2h ago'
        },
        {
          name: 'Mike R.',
          initial: 'M', 
          review: 'Perfect for a night out with friends',
          rating: 5,
          timeAgo: '4h ago'
        },
        {
          name: 'Emma L.',
          initial: 'E',
          review: 'The rooftop view is incredible',
          rating: 4,
          timeAgo: '1d ago'
        }
      ]
    }
  ];

  // All hooks must be called at the top level
  const currentCard = matches[currentCardIndex];
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-300, 300], [-30, 30]);
  
  const handleVibePreferencesComplete = (preferences: any) => {
    console.log('Vibe preferences completed:', preferences);
    setHasPersonalizedPreferences(true);
    setShowVibePreferences(false);
    
    // Trigger achievement notification for completing preferences
    if (onTriggerAchievement) {
      onTriggerAchievement();
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 text-white relative overflow-hidden">
      {/* Top Header */}
      <div className="relative z-20 flex items-center justify-between p-6 safe-area-top">
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={onBack}
          className="text-white/80 hover:text-white hover:bg-white/10"
        >
          <X className="w-5 h-5" />
        </Button>
        
        <h1 className="text-white font-semibold">Premium Discovery</h1>
        
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={() => setShowMenu(!showMenu)}
          className="text-white/80 hover:text-white hover:bg-white/10"
        >
          <User className="w-5 h-5" />
        </Button>
      </div>

      {/* Hamburger Menu */}
      <AnimatePresence>
        {showMenu && (
          <motion.div
            initial={{ opacity: 0, x: 300 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 300 }}
            className="fixed top-0 right-0 h-full w-80 bg-gradient-to-b from-gray-900/95 to-purple-900/95 backdrop-blur-xl border-l border-white/10 z-50 safe-area-top"
          >
            <div className="p-6">
              <div className="flex items-center justify-between mb-8">
                <h2 className="text-white font-semibold text-lg">Menu</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowMenu(false)}
                  className="text-white/60 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </Button>
              </div>

              <div className="space-y-4">
                {/* For You Button - Add this to the menu */}
                <motion.button
                  onClick={() => {
                    setShowVibePreferences(true);
                    setShowMenu(false);
                  }}
                  className="w-full flex items-center space-x-3 p-4 rounded-xl bg-gradient-to-r from-[#00BFFF]/20 to-[#FF00FF]/20 border border-[#00BFFF]/30 hover:from-[#00BFFF]/30 hover:to-[#FF00FF]/30 transition-all duration-200 relative"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] flex items-center justify-center">
                    <Sparkles className="w-5 h-5 text-white" />
                  </div>
                  <div className="flex-1 text-left">
                    <div className="text-white font-medium">For You</div>
                    <div className="text-white/60 text-sm">Set your preferences</div>
                  </div>
                  {hasPersonalizedPreferences && (
                    <div className="w-2 h-2 bg-[#00BFFF] rounded-full" />
                  )}
                </motion.button>

                <Button
                  variant="ghost"
                  className="w-full justify-start text-white/80 hover:text-white hover:bg-white/10"
                  onClick={() => {
                    setCurrentView('map');
                    setShowMenu(false);
                  }}
                >
                  <Map className="w-5 h-5 mr-3" />
                  Live Map
                </Button>

                <Button
                  variant="ghost"
                  className="w-full justify-start text-white/80 hover:text-white hover:bg-white/10"
                  onClick={() => {
                    setCurrentView('insider');
                    setShowMenu(false);
                  }}
                >
                  <BarChart3 className="w-5 h-5 mr-3" />
                  Venue Insider
                </Button>

                <Button
                  variant="ghost"
                  className="w-full justify-start text-white/80 hover:text-white hover:bg-white/10"
                  onClick={() => {
                    setCurrentView('concierge');
                    setShowMenu(false);
                  }}
                >
                  <MessageCircle className="w-5 h-5 mr-3" />
                  Bytspot Concierge
                </Button>

                <Button
                  variant="ghost"
                  className="w-full justify-start text-white/80 hover:text-white hover:bg-white/10"
                  onClick={() => {
                    setCurrentView('profile');
                    setShowMenu(false);
                  }}
                >
                  <Settings className="w-5 h-5 mr-3" />
                  Profile Settings
                </Button>

                <Button
                  variant="ghost"
                  className="w-full justify-start text-red-400 hover:text-red-300 hover:bg-red-500/10"
                  onClick={onLogout}
                >
                  <LogOut className="w-5 h-5 mr-3" />
                  Sign Out
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Content Area */}
      <div className="flex-1 p-6">
        {currentView === 'swipe' && (
          <div className="h-[calc(100vh-200px)] relative">
            <div className="text-center text-white mb-6">
              <h2 className="text-2xl font-bold mb-2">Discover Your Perfect Spot</h2>
              <p className="text-white/70">Swipe to find amazing places around you</p>
            </div>
            
            {/* Simple card display */}
            {currentCard && (
              <motion.div className="w-full h-96 glass-card rounded-3xl overflow-hidden relative">
                <ImageWithFallback
                  src={currentCard.image}
                  alt={currentCard.title}
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 p-6">
                  <h3 className="text-white text-xl font-semibold mb-2">{currentCard.title}</h3>
                  <p className="text-white/80 text-sm mb-4">{currentCard.subtitle}</p>
                  <div className="flex items-center space-x-4">
                    <div className="flex items-center space-x-1">
                      <Star className="w-4 h-4 text-yellow-400 fill-current" />
                      <span className="text-white text-sm">{currentCard.rating}</span>
                    </div>
                    <span className="text-white/70 text-sm">{currentCard.distance}</span>
                    <span className="text-white font-medium">{currentCard.price}</span>
                  </div>
                </div>
              </motion.div>
            )}
          </div>
        )}

        {currentView === 'map' && (
          <div className="text-center text-white">
            <h2 className="text-2xl font-bold mb-4">Live Map</h2>
            <p>Map view would be implemented here</p>
          </div>
        )}

        {currentView === 'insider' && (
          <VenueInsider onBack={() => setCurrentView('swipe')} />
        )}

        {currentView === 'concierge' && (
          <ConciergeChat onBack={() => setCurrentView('swipe')} />
        )}

        {currentView === 'profile' && (
          <ProfileSettings
            userData={userData}
            onBack={() => setCurrentView('swipe')}
            onLogout={onLogout}
          />
        )}

        {currentView === 'venue-detail' && selectedCard && (
          <VenueDetail
            venue={selectedCard}
            onBack={() => setCurrentView('swipe')}
          />
        )}

        {currentView === 'parking-detail' && selectedCard && (
          <ParkingDetail
            spot={selectedCard}
            onBack={() => setCurrentView('swipe')}
          />
        )}

        {currentView === 'valet-flow' && selectedCard && (
          <ValetFlow
            service={selectedCard}
            onBack={() => setCurrentView('swipe')}
          />
        )}
      </div>

      {/* Bottom Action Buttons - Add For You button here too */}
      {currentView === 'swipe' && (
        <div className="fixed bottom-0 left-0 right-0 p-6 safe-area-bottom">
          <div className="flex items-center justify-center space-x-4">
            <Button
              variant="ghost"
              size="lg"
              className="w-16 h-16 rounded-full bg-red-500/20 hover:bg-red-500/30 border border-red-400/30"
            >
              <X className="w-6 h-6 text-red-400" />
            </Button>

            {/* Central For You Button */}
            <motion.button
              onClick={() => setShowVibePreferences(true)}
              className="w-20 h-20 rounded-full bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] flex items-center justify-center shadow-2xl relative"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              style={{
                boxShadow: '0 8px 32px rgba(0, 191, 255, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.1)'
              }}
            >
              <Sparkles className="w-8 h-8 text-white" />
              {hasPersonalizedPreferences && (
                <div className="absolute -top-1 -right-1 w-4 h-4 bg-[#00BFFF] rounded-full border-2 border-white" />
              )}
            </motion.button>

            <Button
              variant="ghost"
              size="lg"
              className="w-16 h-16 rounded-full bg-green-500/20 hover:bg-green-500/30 border border-green-400/30"
            >
              <Heart className="w-6 h-6 text-green-400" />
            </Button>
          </div>
        </div>
      )}

      {/* Vibe Preferences Modal */}
      <VibePreferencesModal
        isOpen={showVibePreferences}
        onClose={() => setShowVibePreferences(false)}
        onComplete={handleVibePreferencesComplete}
      />
    </div>
  );
}