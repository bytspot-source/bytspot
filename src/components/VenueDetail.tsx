import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ArrowLeft, 
  Star, 
  MapPin, 
  Clock, 
  DollarSign, 
  Phone, 
  Heart,
  Share,
  TrendingUp,
  Users,
  Zap,
  Wifi,
  Car,
  Calendar,
  MessageCircle
} from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import { Card } from './ui/card';
import { ImageWithFallback } from './figma/ImageWithFallback';

interface VenueDetailProps {
  venue: any;
  onBack: () => void;
  onTriggerAchievement?: () => void;
}

export function VenueDetail({ venue: venueCard, onBack, onTriggerAchievement }: VenueDetailProps) {
  // Memoize venue to prevent recreation on every render
  const venue = useMemo(() => venueCard || {
    liveVibeScore: 75,
    peopleInside: 40,
    title: 'Venue',
    subtitle: 'Location',
    rating: 4.5,
    distance: 'Unknown',
    price: 'TBD',
    color: 'from-purple-500 to-pink-500',
    type: 'venue',
    image: '',
    energyLevel: 'Medium',
    vibeDescription: 'Great atmosphere',
    description: 'This venue is currently unavailable.',
    amenities: [],
    features: []
  }, [venueCard]);
  
  const [vibeScore, setVibeScore] = useState(venue.liveVibeScore || 75);
  const [currentCrowd, setCurrentCrowd] = useState(venue.peopleInside || 40);
  const [waitTime, setWaitTime] = useState(0);
  const [isLiked, setIsLiked] = useState(false);

  // Initialize state when card changes
  useEffect(() => {
    setVibeScore(venue.liveVibeScore || 75 + Math.random() * 20);
    setCurrentCrowd(venue.peopleInside || 40 + Math.random() * 40);
    setWaitTime(Math.random() * 20);
  }, [venue.liveVibeScore, venue.peopleInside]);

  // Simulate real-time data updates
  useEffect(() => {
    const interval = setInterval(() => {
      setVibeScore(prev => Math.max(60, Math.min(100, prev + (Math.random() - 0.5) * 5)));
      setCurrentCrowd(prev => Math.max(20, Math.min(200, prev + (Math.random() - 0.5) * 10)));
      setWaitTime(prev => Math.max(0, Math.min(45, prev + (Math.random() - 0.5) * 5)));
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const vibeColor = vibeScore > 80 ? 'from-green-400 to-emerald-500' : 
                   vibeScore > 60 ? 'from-yellow-400 to-orange-500' : 
                   'from-red-400 to-red-600';

  const crowdLevel = currentCrowd > 80 ? 'Packed' : 
                    currentCrowd > 60 ? 'Busy' : 
                    currentCrowd > 40 ? 'Moderate' : 
                    'Quiet';

  return (
    <motion.div
      initial={{ opacity: 0, x: 300 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 300 }}
      className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 relative overflow-hidden"
    >
      {/* Header Image */}
      <div className="relative h-64 overflow-hidden">
        <ImageWithFallback
          src={venue.image}
          alt={venue.title}
          className="w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
        
        {/* Header Controls */}
        <div className="absolute top-6 left-6 right-6 flex justify-between items-center">
          <Button
            onClick={onBack}
            variant="ghost"
            size="sm"
            className="w-10 h-10 rounded-full bg-black/30 backdrop-blur-sm text-white hover:bg-black/50"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex space-x-2">
            <Button
              onClick={() => setIsLiked(!isLiked)}
              variant="ghost"
              size="sm"
              className={`w-10 h-10 rounded-full backdrop-blur-sm ${
                isLiked 
                  ? 'bg-red-500 text-white hover:bg-red-600' 
                  : 'bg-black/30 text-white hover:bg-black/50'
              }`}
            >
              <Heart className={`w-5 h-5 ${isLiked ? 'fill-white' : ''}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-10 h-10 rounded-full bg-black/30 backdrop-blur-sm text-white hover:bg-black/50"
            >
              <Share className="w-5 h-5" />
            </Button>
          </div>
        </div>

        {/* Live Indicator */}
        <div className="absolute top-6 left-1/2 transform -translate-x-1/2">
          <div className="flex items-center space-x-2 bg-red-500 text-white px-3 py-1 rounded-full text-sm">
            <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
            <span>LIVE</span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="relative -mt-8 min-h-screen">
        <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-t-3xl p-6 space-y-6">
          {/* Venue Info */}
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-3xl text-white mb-2">{venue.title}</h1>
              <p className="text-lg text-white/80 mb-1">{venue.subtitle}</p>
              <div className="flex items-center space-x-4 text-white/60">
                <div className="flex items-center space-x-1">
                  <Star className="w-4 h-4 text-yellow-400 fill-yellow-400" />
                  <span>{venue.rating}</span>
                </div>
                <div className="flex items-center space-x-1">
                  <MapPin className="w-4 h-4" />
                  <span>{venue.distance}</span>
                </div>
                <span>{venue.price}</span>
              </div>
            </div>
            <Badge className={`bg-gradient-to-r ${venue.color} text-white border-0`}>
              {venue.type}
            </Badge>
          </div>

          {/* Vibe Score */}
          <Card className="bg-black/20 border-white/20 backdrop-blur-sm">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl text-white flex items-center space-x-2">
                  <Zap className="w-6 h-6 text-yellow-400" />
                  <span>Vibe Score</span>
                </h3>
                <motion.div 
                  className={`text-3xl font-bold bg-gradient-to-r ${vibeColor} bg-clip-text text-transparent`}
                  animate={{ scale: [1, 1.1, 1] }}
                  transition={{ duration: 2, repeat: Infinity }}
                >
                  {Math.round(vibeScore)}
                </motion.div>
              </div>
              <Progress 
                value={vibeScore} 
                className="h-3 bg-white/10"
              />
              <p className="text-white/60 mt-2">Real-time energy and atmosphere rating</p>
            </div>
          </Card>

          {/* Real-time Data */}
          <div className="grid grid-cols-2 gap-4">
            <Card className="bg-black/20 border-white/20 backdrop-blur-sm">
              <div className="p-4">
                <div className="flex items-center space-x-2 mb-2">
                  <Users className="w-5 h-5 text-blue-400" />
                  <span className="text-white">Crowd Level</span>
                </div>
                <div className="text-2xl text-white mb-1">{crowdLevel}</div>
                <Progress value={Math.min(100, currentCrowd / 2)} className="h-2 bg-white/10" />
                <p className="text-white/60 text-sm mt-1">{Math.round(currentCrowd)} people inside</p>
              </div>
            </Card>

            <Card className="bg-black/20 border-white/20 backdrop-blur-sm">
              <div className="p-4">
                <div className="flex items-center space-x-2 mb-2">
                  <Clock className="w-5 h-5 text-green-400" />
                  <span className="text-white">Energy Level</span>
                </div>
                <div className="text-2xl text-white mb-1">
                  {venue.energyLevel || 'High Energy'}
                </div>
                <p className="text-white/60 text-sm">{venue.vibeDescription || 'Great atmosphere'}</p>
              </div>
            </Card>
          </div>

          {/* Tonight's Events */}
          {venue.tonightsEvents && venue.tonightsEvents.length > 0 && (
            <Card className="bg-black/20 border-white/20 backdrop-blur-sm">
              <div className="p-6">
                <h3 className="text-xl text-white mb-4 flex items-center space-x-2">
                  <Calendar className="w-6 h-6 text-purple-400" />
                  <span>Tonight's Events</span>
                </h3>
                <div className="space-y-3">
                  {venue.tonightsEvents.map((event: any, index: number) => (
                    <div key={index} className="flex items-center justify-between p-3 bg-white/5 rounded-xl">
                      <div className="flex items-center space-x-3">
                        <div className={`w-3 h-3 rounded-full ${
                          event.type === 'Music' ? 'bg-purple-400' :
                          event.type === 'Special' ? 'bg-yellow-400' :
                          event.type === 'Access' ? 'bg-green-400' : 'bg-blue-400'
                        }`} />
                        <div>
                          <p className="text-white font-medium">{event.title}</p>
                          <p className="text-white/60 text-sm">{event.type}</p>
                          {event.description && (
                            <p className="text-white/50 text-xs">{event.description}</p>
                          )}
                        </div>
                      </div>
                      <span className="text-white/80 text-sm font-medium">{event.time}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}

          {/* Recent Reviews */}
          {venue.recentReviews && venue.recentReviews.length > 0 && (
            <Card className="bg-black/20 border-white/20 backdrop-blur-sm">
              <div className="p-6">
                <h3 className="text-xl text-white mb-4 flex items-center space-x-2">
                  <Star className="w-6 h-6 text-yellow-400" />
                  <span>Recent Reviews</span>
                </h3>
                <div className="space-y-4">
                  {venue.recentReviews.map((review: any, index: number) => (
                    <div key={index} className="space-y-2">
                      <div className="flex items-center space-x-3">
                        <div className="w-8 h-8 bg-gradient-to-r from-purple-400 to-pink-400 rounded-full flex items-center justify-center">
                          <span className="text-white text-sm font-medium">{review.initial}</span>
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center space-x-2">
                            <span className="text-white font-medium">{review.name}</span>
                            <span className="text-white/60 text-sm">{review.timeAgo}</span>
                          </div>
                          <div className="flex items-center space-x-1 mt-1">
                            {[...Array(5)].map((_, i) => (
                              <Star 
                                key={i} 
                                className={`w-3 h-3 ${i < review.rating ? 'text-yellow-400 fill-yellow-400' : 'text-white/30'}`} 
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                      <p className="text-white/70 text-sm pl-11">{review.review}</p>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}

          {/* Features & Amenities */}
          <div>
            <h3 className="text-lg text-white mb-3">Features & Amenities</h3>
            <div className="flex flex-wrap gap-2">
              {(venue.amenities || venue.features)?.map((feature: string, index: number) => (
                <Badge key={index} variant="secondary" className="bg-white/20 text-white border-0">
                  {feature}
                </Badge>
              ))}
              {venue.trending && (
                <Badge variant="secondary" className="bg-red-500/20 text-red-300 border border-red-400/30">
                  <TrendingUp className="w-3 h-3 mr-1" />
                  Trending Now
                </Badge>
              )}
            </div>
          </div>

          {/* Description */}
          <div>
            <h3 className="text-lg text-white mb-2">About</h3>
            <p className="text-white/70 leading-relaxed">{venue.description}</p>
          </div>

          {/* Action Buttons */}
          <div className="space-y-3 pt-4">
            <Button 
              onClick={() => {
                if (onTriggerAchievement) {
                  onTriggerAchievement();
                }
              }}
              className="w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white rounded-xl h-14 text-lg"
            >
              <MessageCircle className="w-5 h-5 mr-2" />
              Book Experience
            </Button>
            
            <div className="grid grid-cols-2 gap-3">
              <Button 
                variant="outline" 
                className="border-white/30 text-white hover:bg-white/10 rounded-xl h-12"
              >
                <Phone className="w-4 h-4 mr-2" />
                Call
              </Button>
              <Button 
                variant="outline" 
                className="border-white/30 text-white hover:bg-white/10 rounded-xl h-12"
              >
                <Calendar className="w-4 h-4 mr-2" />
                Reserve
              </Button>
            </div>
          </div>

          {/* Live Updates Footer */}
          <div className="flex items-center justify-center space-x-2 text-white/50 text-sm pt-4">
            <TrendingUp className="w-4 h-4" />
            <span>Updates every 30 seconds</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}