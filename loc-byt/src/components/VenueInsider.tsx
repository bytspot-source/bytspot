import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Search,
  Filter,
  TrendingUp,
  Users,
  Star,
  Clock,
  MapPin,
  Heart,
  Eye,
  Flame,
  Zap,
  Calendar,
  Camera,
  Play,
  MessageCircle,
  Share,
  BookOpen,
  Timer,
  Crown,
  Gift,
  UserCheck,
  ChevronRight,
  Volume2,
  Brain,
  ArrowLeft
} from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Progress } from './ui/progress';
import { ImageWithFallback } from './figma/ImageWithFallback';


interface VenueInsiderProps {
  onBack: () => void;
  currentTheme?: string;
  weatherTheme?: string;
  locationTheme?: string;
  onWeatherChange?: (weather: string) => void;
  onLocationChange?: (location: string) => void;
  onConcierge?: () => void;
}

interface InsiderVenue {
  id: string;
  name: string;
  type: string;
  image: string;
  vibeScore: number;
  moodScore: number;
  checkIns: number;
  crowdAge: string;
  energy: string;
  isLive: boolean;
  hasStream: boolean;
  distance: string;
  rating: number;
  reviews: number;
  trending: boolean;
  exclusive: boolean;
  limitedOffer?: {
    text: string;
    countdown: number;
  };
  whyYoullLove: string[];
  recentActivity: string[];
  friendsHere: number;
  photos: string[];
  liveEvents: string[];
}

export function VenueInsider({ 
  onBack, 
  currentTheme = 'morning',
  weatherTheme = 'sunny', 
  locationTheme = 'city',
  onWeatherChange = () => {},
  onLocationChange = () => {},
  onConcierge = () => {}
}: VenueInsiderProps) {
  // Force footer to stay hidden when interacting with bottom content
  const handleBottomInteraction = useCallback(() => {
    // This will be handled by parent component's touch handlers
  }, []);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('trending');
  const [venues, setVenues] = useState<InsiderVenue[]>([]);
  const [liveData, setLiveData] = useState<{ [key: string]: any }>({});

  useEffect(() => {
    // Initialize with sample data
    const sampleVenues: InsiderVenue[] = [
      {
        id: '1',
        name: 'Neon Nights',
        type: 'Nightclub',
        image: 'https://images.unsplash.com/photo-1679887347197-b1b5248be7a3?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxuZW9uJTIwbmlnaHRjbHViJTIwaW50ZXJpb3J8ZW58MXx8fHwxNzU2MzMyMzQ1fDA&ixlib=rb-4.1.0&q=80&w=1080',
        vibeScore: 94,
        moodScore: 8.4,
        checkIns: 45,
        crowdAge: '25-35',
        energy: 'High Energy',
        isLive: true,
        hasStream: true,
        distance: '0.3 mi',
        rating: 4.8,
        reviews: 1247,
        trending: true,
        exclusive: false,
        limitedOffer: {
          text: 'Free entry before 10 PM',
          countdown: 3600 // 1 hour in seconds
        },
        whyYoullLove: ['Electric atmosphere', 'Top DJs', 'Instagrammable spots', 'Great cocktails'],
        recentActivity: ['Sarah just checked in', 'Mike shared a photo', '3 friends are here'],
        friendsHere: 3,
        photos: ['https://images.unsplash.com/photo-1679887347197-b1b5248be7a3?w=400'],
        liveEvents: ['DJ Marcus live set', 'Neon light show']
      },
      {
        id: '2',
        name: 'Skyline Rooftop',
        type: 'Rooftop Bar',
        image: 'https://images.unsplash.com/photo-1653221716413-43c674e1e56f?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxyb29mdG9wJTIwYmFyJTIwY2l0eSUyMHNreWxpbmV8ZW58MXx8fHwxNzU2MzMyMzUwfDA&ixlib=rb-4.1.0&q=80&w=1080',
        vibeScore: 88,
        moodScore: 9.1,
        checkIns: 28,
        crowdAge: '28-40',
        energy: 'Sophisticated',
        isLive: true,
        hasStream: false,
        distance: '0.8 mi',
        rating: 4.9,
        reviews: 892,
        trending: false,
        exclusive: true,
        limitedOffer: {
          text: 'Happy hour until 8 PM - 50% off cocktails',
          countdown: 7200
        },
        whyYoullLove: ['Panoramic city views', 'Craft cocktails', 'Perfect for dates', 'Golden hour magic'],
        recentActivity: ['Emma left a 5-star review', 'Alex shared sunset photos'],
        friendsHere: 1,
        photos: ['https://images.unsplash.com/photo-1653221716413-43c674e1e56f?w=400'],
        liveEvents: ['Live jazz trio', 'Sunset viewing party']
      },
      {
        id: '3',
        name: 'Underground Lounge',
        type: 'Speakeasy',
        image: 'https://images.unsplash.com/photo-1648411897425-7713de428509?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxzcGVha2Vhc3klMjBiYXIlMjBpbnRlcmlvciUyMGRhcmt8ZW58MXx8fHwxNzU2MzMyMzU1fDA&ixlib=rb-4.1.0&q=80&w=1080',
        vibeScore: 92,
        moodScore: 8.8,
        checkIns: 15,
        crowdAge: '30-45',
        energy: 'Intimate',
        isLive: false,
        hasStream: false,
        distance: '1.2 mi',
        rating: 4.7,
        reviews: 543,
        trending: true,
        exclusive: true,
        whyYoullLove: ['Hidden gem', 'Craft cocktails', 'Intimate setting', 'Secret entrance'],
        recentActivity: ['Just opened for the evening', 'Tom made a reservation'],
        friendsHere: 0,
        photos: ['https://images.unsplash.com/photo-1648411897425-7713de428509?w=400'],
        liveEvents: ['Cocktail masterclass', 'Live pianist']
      }
    ];

    setVenues(sampleVenues);

    // Simulate real-time data updates
    const interval = setInterval(() => {
      setLiveData(prev => {
        const newData = { ...prev };
        sampleVenues.forEach(venue => {
          if (venue.isLive) {
            newData[venue.id] = {
              checkIns: venue.checkIns + Math.floor(Math.random() * 5),
              vibeScore: Math.max(80, Math.min(100, venue.vibeScore + (Math.random() - 0.5) * 10)),
              viewingNow: Math.floor(Math.random() * 50) + 20
            };
          }
        });
        return newData;
      });
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const categories = [
    { id: 'trending', label: 'Trending', icon: TrendingUp },
    { id: 'live', label: 'Live Now', icon: Volume2 },
    { id: 'exclusive', label: 'Exclusive', icon: Crown },
    { id: 'friends', label: 'Friends', icon: Users }
  ];

  const filteredVenues = venues.filter(venue => {
    const matchesSearch = venue.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = 
      selectedCategory === 'trending' ? venue.trending :
      selectedCategory === 'live' ? venue.isLive :
      selectedCategory === 'exclusive' ? venue.exclusive :
      selectedCategory === 'friends' ? venue.friendsHere > 0 :
      true;
    return matchesSearch && matchesCategory;
  });

  const formatCountdown = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  };

  return (
    <div className="bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] min-h-full flex flex-col">
      {/* Header with Back Button */}
      <div className="p-4 backdrop-blur-md bg-white/10 border-b border-white/20">
        <div className="flex items-center justify-between">
          <Button
            onClick={onBack}
            variant="ghost"
            size="sm"
            className="w-10 h-10 rounded-full text-white hover:bg-white/10"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="text-lg text-white">Venue Insider</div>
          <div className="w-10" />
        </div>
      </div>

      {/* Premium Header - Mobile Optimized */}
      <div className="p-4 sm:p-6 bg-gradient-to-r from-purple-500 via-pink-500 to-purple-600 text-white">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-white/20 rounded-lg flex items-center justify-center">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg sm:text-xl">Vibe Premium</h2>
              <p className="text-white/80 text-xs sm:text-sm">Unlock AI-powered discovery</p>
            </div>
          </div>
          <Badge className="bg-white/20 text-white border-white/30 px-2 py-1 text-xs">Live 24/7</Badge>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="flex items-center space-x-2">
            <Brain className="w-4 h-4" />
            <span className="text-xs sm:text-sm">Smart Matching</span>
          </div>
          <div className="flex items-center space-x-2">
            <Zap className="w-4 h-4" />
            <span className="text-xs sm:text-sm">Instant Discovery</span>
          </div>
          <div className="flex items-center space-x-2">
            <BookOpen className="w-4 h-4" />
            <span className="text-xs sm:text-sm">Vibe Learning</span>
          </div>
          <div className="flex items-center space-x-2">
            <Crown className="w-4 h-4" />
            <span className="text-xs sm:text-sm">Exclusive Venues</span>
          </div>
        </div>

        <Button className="w-full bg-white text-purple-600 hover:bg-white/90 rounded-xl py-3 active:scale-98 transition-transform">
          <Heart className="w-4 h-4 mr-2" />
          <span className="text-sm sm:text-base">Start Premium Discovery • $4.99/month</span>
          <ChevronRight className="w-4 h-4 ml-2" />
        </Button>
      </div>

      {/* Search and Filter - Mobile Optimized */}
      <div className="p-4 backdrop-blur-md bg-white/10 border-b border-white/20">
        <div className="flex space-x-3 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-white/60" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search venues, vibes, locations..."
              className="bg-white/10 border-white/20 text-white placeholder-white/50 rounded-xl pl-10 h-12 text-base"
            />
          </div>
          <Button variant="outline" size="sm" className="border-white/30 text-white hover:bg-white/10 rounded-xl px-3 min-h-[48px] min-w-[48px] active:scale-95 transition-transform">
            <Filter className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex space-x-2 overflow-x-auto pb-2 scrollbar-hide">
          {categories.map((category) => (
            <Button
              key={category.id}
              onClick={() => setSelectedCategory(category.id)}
              variant={selectedCategory === category.id ? "default" : "outline"}
              size="sm"
              className={`whitespace-nowrap rounded-full py-2 px-4 min-h-[36px] active:scale-95 transition-all ${
                selectedCategory === category.id
                  ? 'bg-purple-500 text-white hover:bg-purple-600'
                  : 'border-white/30 text-white hover:bg-white/10'
              }`}
            >
              <category.icon className="w-4 h-4 mr-2" />
              <span className="text-sm">{category.label}</span>
            </Button>
          ))}
        </div>
      </div>

      {/* Venues Feed */}
      <div className="flex-1 p-4 space-y-4 pb-32">
        <AnimatePresence>
          {filteredVenues.map((venue, index) => (
            <motion.div
              key={venue.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ delay: index * 0.1 }}
            >
              <Card 
                className="bg-black/20 border-white/20 backdrop-blur-sm overflow-hidden cursor-pointer hover:bg-white/5 transition-all bottom-content-protection"
                onClick={() => {}}
              >
                {/* Venue Header - Mobile Optimized */}
                <div className="relative h-40 sm:h-48 overflow-hidden">
                  <ImageWithFallback
                    src={venue.image}
                    alt={venue.name}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                  
                  {/* Live Indicators */}
                  <div className="absolute top-3 left-3 flex space-x-2">
                    {venue.isLive && (
                      <Badge className="bg-red-500 text-white border-0 animate-pulse">
                        <div className="w-2 h-2 bg-white rounded-full mr-1" />
                        LIVE
                      </Badge>
                    )}
                    {venue.trending && (
                      <Badge className="bg-orange-500 text-white border-0">
                        <Flame className="w-3 h-3 mr-1" />
                        Trending
                      </Badge>
                    )}
                    {venue.exclusive && (
                      <Badge className="bg-purple-500 text-white border-0">
                        <Crown className="w-3 h-3 mr-1" />
                        Exclusive
                      </Badge>
                    )}
                  </div>

                  {/* Viewing Count */}
                  {venue.isLive && (
                    <div className="absolute top-3 right-3 bg-black/50 backdrop-blur-sm text-white px-2 py-1 rounded-full text-xs flex items-center">
                      <Eye className="w-3 h-3 mr-1" />
                      {liveData[venue.id]?.viewingNow || Math.floor(Math.random() * 50) + 20} watching
                    </div>
                  )}

                  {/* Action Buttons - Mobile Touch Optimized */}
                  <div className="absolute bottom-3 right-3 flex space-x-2">
                    {venue.hasStream && (
                      <Button size="sm" className="w-9 h-9 sm:w-8 sm:h-8 rounded-full bg-white/20 backdrop-blur-sm text-white hover:bg-white/30 active:bg-white/40 p-0 active:scale-95 transition-all">
                        <Play className="w-4 h-4" />
                      </Button>
                    )}
                    <Button size="sm" className="w-9 h-9 sm:w-8 sm:h-8 rounded-full bg-white/20 backdrop-blur-sm text-white hover:bg-white/30 active:bg-white/40 p-0 active:scale-95 transition-all">
                      <Camera className="w-4 h-4" />
                    </Button>
                  </div>

                  {/* Energy Badge */}
                  <div className="absolute bottom-3 left-3">
                    <Badge className={`${venue.energy === 'High Energy' ? 'bg-green-500' : venue.energy === 'Sophisticated' ? 'bg-blue-500' : 'bg-purple-500'} text-white border-0`}>
                      {venue.energy}
                    </Badge>
                  </div>
                </div>

                {/* Venue Info - Mobile Optimized */}
                <div className="p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-base sm:text-lg text-white mb-1 truncate">{venue.name}</h3>
                      <div className="flex items-center space-x-3 text-xs sm:text-sm text-white/60">
                        <div className="flex items-center space-x-1">
                          <Star className="w-3 h-3 sm:w-4 sm:h-4 text-yellow-400 fill-yellow-400" />
                          <span>{venue.rating}</span>
                          <span>({venue.reviews})</span>
                        </div>
                        <div className="flex items-center space-x-1">
                          <MapPin className="w-3 h-3 sm:w-4 sm:h-4" />
                          <span>{venue.distance}</span>
                        </div>
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" className="text-red-400 hover:bg-red-500/10 active:bg-red-500/20 p-2 min-h-[36px] min-w-[36px] active:scale-95 transition-all">
                      <Heart className="w-4 h-4" />
                    </Button>
                  </div>

                  {/* Real-time Stats */}
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <div className="text-center">
                      <div className="text-2xl text-white mb-1">{venue.moodScore}</div>
                      <div className="text-xs text-white/60">Mood Score</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl text-white mb-1">
                        {liveData[venue.id]?.checkIns || venue.checkIns}
                      </div>
                      <div className="text-xs text-white/60">Check-ins</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl text-white mb-1">{venue.crowdAge}</div>
                      <div className="text-xs text-white/60">Crowd Age</div>
                    </div>
                  </div>

                  {/* Vibe Score */}
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-white">Vibe Score</span>
                      <span className="text-sm text-green-400">
                        {Math.round(liveData[venue.id]?.vibeScore || venue.vibeScore)}%
                      </span>
                    </div>
                    <Progress 
                      value={liveData[venue.id]?.vibeScore || venue.vibeScore} 
                      className="h-2 bg-white/10"
                    />
                  </div>

                  {/* Limited Offer */}
                  {venue.limitedOffer && (
                    <div className="bg-gradient-to-r from-orange-500/20 to-red-500/20 border border-orange-400/30 rounded-xl p-3 mb-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <Gift className="w-4 h-4 text-orange-400" />
                          <span className="text-sm text-white">{venue.limitedOffer.text}</span>
                        </div>
                        <div className="flex items-center space-x-1 text-orange-400 text-sm">
                          <Timer className="w-4 h-4" />
                          <span>{formatCountdown(venue.limitedOffer.countdown)}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Why You'll Love It */}
                  <div className="mb-4">
                    <h4 className="text-sm text-white mb-2 flex items-center">
                      <Heart className="w-4 h-4 mr-1 text-pink-400" />
                      Why you'll love this
                    </h4>
                    <div className="flex flex-wrap gap-1">
                      {venue.whyYoullLove.slice(0, 3).map((reason, index) => (
                        <Badge key={index} variant="secondary" className="bg-pink-500/20 text-pink-300 border-0 text-xs">
                          {reason}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  {/* Friend Activity */}
                  {venue.friendsHere > 0 && (
                    <div className="mb-4">
                      <div className="flex items-center space-x-2 text-sm">
                        <UserCheck className="w-4 h-4 text-green-400" />
                        <span className="text-green-400">{venue.friendsHere} friends here</span>
                      </div>
                    </div>
                  )}

                  {/* Recent Activity */}
                  <div className="mb-4">
                    <h4 className="text-xs text-white/60 mb-2">Happening Now</h4>
                    <div className="space-y-1">
                      {venue.recentActivity.slice(0, 2).map((activity, index) => (
                        <div key={index} className="text-xs text-white/80 flex items-center">
                          <div className="w-1.5 h-1.5 bg-green-400 rounded-full mr-2 animate-pulse" />
                          {activity}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Action Buttons - Mobile Touch Optimized */}
                  <div 
                    className="grid grid-cols-3 gap-2 bottom-safe-interaction"
                    onTouchStart={handleBottomInteraction}
                    onClick={handleBottomInteraction}
                  >
                    <Button 
                      size="sm" 
                      className="bg-purple-500 hover:bg-purple-600 active:bg-purple-700 text-white rounded-xl py-2 px-3 interactive-button active:scale-95 transition-all"
                    >
                      <Calendar className="w-3 h-3 sm:w-4 sm:h-4 mr-1" />
                      <span className="text-xs sm:text-sm">Book</span>
                    </Button>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="border-white/30 text-white hover:bg-white/10 active:bg-white/20 rounded-xl py-2 px-3 interactive-button active:scale-95 transition-all"
                    >
                      <MessageCircle className="w-3 h-3 sm:w-4 sm:h-4 mr-1" />
                      <span className="text-xs sm:text-sm">Chat</span>
                    </Button>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="border-white/30 text-white hover:bg-white/10 active:bg-white/20 rounded-xl py-2 px-3 interactive-button active:scale-95 transition-all"
                    >
                      <Share className="w-3 h-3 sm:w-4 sm:h-4 mr-1" />
                      <span className="text-xs sm:text-sm">Share</span>
                    </Button>
                  </div>
                </div>
              </Card>
            </motion.div>
          ))}
        </AnimatePresence>

        {filteredVenues.length === 0 && (
          <div className="text-center py-8">
            <Search className="w-12 h-12 text-white/40 mx-auto mb-3" />
            <h3 className="text-lg text-white mb-2">No venues found</h3>
            <p className="text-white/60 mb-4">Try adjusting your search or filters</p>
            <Button onClick={onConcierge} className="bg-purple-500 hover:bg-purple-600 text-white rounded-xl">
              Ask AI Concierge for Help
            </Button>
          </div>
        )}

        {/* Bottom Fade Indicator - Shows More Content Available */}
        {filteredVenues.length > 0 && (
          <div className="relative">
            <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-[#121212] via-[#121212]/60 to-transparent pointer-events-none" />
            <div className="text-center text-white/40 text-sm py-4">
              Scroll up to see all venues
            </div>
          </div>
        )}
      </div>
    </div>
  );
}