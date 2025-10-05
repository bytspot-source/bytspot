import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Zap, MapPin, Car, UtensilsCrossed, Users, Search, Compass } from 'lucide-react';
import { Button } from './ui/button';

interface DiscoverySearchProps {
  userData: any;
  onComplete: () => void;
}

interface DiscoveredSpot {
  id: string;
  name: string;
  type: 'parking' | 'venue' | 'valet';
  area: string;
  confidence: number;
  details?: string;
}

interface SearchPhase {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  duration: number;
  color: string;
}

export function DiscoverySearch({ userData, onComplete }: DiscoverySearchProps) {
  const [currentPhase, setCurrentPhase] = useState(0);
  const [progress, setProgress] = useState(0);
  const [isSearching, setIsSearching] = useState(true);
  const [foundMatches, setFoundMatches] = useState(0);
  const [discoveredSpots, setDiscoveredSpots] = useState<DiscoveredSpot[]>([]);

  // Customize search phases based on user's selected preferences
  const getSearchPhases = () => {
    const basePhases = [
      {
        id: 'location',
        title: 'Initializing Discovery',
        description: 'Preparing to find your perfect spots...',
        icon: <Search className="w-8 h-8" />,
        duration: 2000,
        color: 'from-blue-400 to-cyan-400'
      }
    ];

    // Add specific phases based on user's registration preferences
    const userPreferences = userData.preferences || [];
    
    if (userPreferences.includes('Smart Parking Solutions')) {
      basePhases.push({
        id: 'parking',
        title: 'Finding Smart Parking',
        description: 'Discovering premium parking solutions with real-time availability...',
        icon: <Car className="w-8 h-8" />,
        duration: 2500,
        color: 'from-green-400 to-emerald-400'
      });
    }

    if (userPreferences.includes('Venue Discovery & Dining')) {
      basePhases.push({
        id: 'venues',
        title: 'Curating Perfect Venues',
        description: 'Matching exclusive dining experiences to your taste profile...',
        icon: <UtensilsCrossed className="w-8 h-8" />,
        duration: 3000,
        color: 'from-purple-400 to-pink-400'
      });
    }

    if (userPreferences.includes('Premium Valet Services')) {
      basePhases.push({
        id: 'valet',
        title: 'Locating Elite Valet Services',
        description: 'Finding premium white-glove concierge services...',
        icon: <Users className="w-8 h-8" />,
        duration: 2000,
        color: 'from-yellow-400 to-orange-400'
      });
    }

    // If no preferences were selected, show a default discovery message
    if (basePhases.length === 1) {
      basePhases.push({
        id: 'general',
        title: 'Discovering Local Spots',
        description: 'Finding the best spots in your area...',
        icon: <Search className="w-8 h-8" />,
        duration: 2500,
        color: 'from-cyan-400 to-blue-400'
      });
    }

    return basePhases;
  };

  const searchPhases: SearchPhase[] = getSearchPhases();

  // Initialize personalized spots
  useEffect(() => {
    generatePersonalizedSpots();
  }, []);

  // Generate personalized spots based on user preferences
  const generatePersonalizedSpots = () => {
    const spots: DiscoveredSpot[] = [];
    const userPreferences = userData.preferences || [];
    
    // Generate spots based only on user's selected preferences
    let spotIndex = 0;
    
    // Smart Parking Solutions
    if (userPreferences.includes('Smart Parking Solutions')) {
      const parkingSpots = [
        { name: 'Tesla Supercharger Hub', details: 'EV charging • 24/7 availability • $12/hour', confidence: 0.95 },
        { name: 'SkyPark Premium Garage', details: 'Covered • Valet available • $15/hour', confidence: 0.92 },
        { name: 'AutoPark Smart Lot', details: 'App-controlled • Real-time spots • $8/hour', confidence: 0.89 },
        { name: 'CityCenter Parking Plaza', details: 'Reserved spots • Security monitored • $10/hour', confidence: 0.87 },
        { name: 'GreenSpace Eco Garage', details: 'Solar powered • Bike storage • $11/hour', confidence: 0.84 }
      ];
      
      parkingSpots.forEach((spot, i) => {
        if (i < 5) { // Limit to 5 spots per category
          spots.push({
            id: `parking-${spotIndex++}`,
            name: spot.name,
            type: 'parking',
            area: 'Premium Location',
            confidence: spot.confidence,
            details: spot.details
          });
        }
      });
    }

    // Venue Discovery & Dining
    if (userPreferences.includes('Venue Discovery & Dining')) {
      const venueSpots = [
        { name: 'Skyline Rooftop', details: 'Fine dining • City views • Reservations recommended', confidence: 0.96 },
        { name: 'The Artisan Table', details: 'Farm-to-table • Chef\'s tasting menu • Wine pairing', confidence: 0.93 },
        { name: 'Neon Kitchen', details: 'Modern fusion • Live music • Craft cocktails', confidence: 0.91 },
        { name: 'Harbor View Bistro', details: 'Waterfront dining • Fresh seafood • Private booths', confidence: 0.88 },
        { name: 'Heritage Restaurant', details: 'Historic venue • Traditional cuisine • Garden seating', confidence: 0.86 }
      ];
      
      venueSpots.forEach((spot, i) => {
        if (i < 5) {
          spots.push({
            id: `venue-${spotIndex++}`,
            name: spot.name,
            type: 'venue',
            area: 'Curated Selection',
            confidence: spot.confidence,
            details: spot.details
          });
        }
      });
    }

    // Premium Valet Services
    if (userPreferences.includes('Premium Valet Services')) {
      const valetSpots = [
        { name: 'Platinum Concierge', details: 'White-glove service • Car detailing • 24/7 availability', confidence: 0.94 },
        { name: 'Elite Auto Care', details: 'Luxury vehicle specialists • Indoor storage • Insurance coverage', confidence: 0.91 },
        { name: 'Crown Valet Services', details: 'Professional attendants • Key tracking • Premium locations', confidence: 0.89 },
        { name: 'Metropolitan Valet', details: 'Corporate accounts • Event services • Secure parking', confidence: 0.87 },
        { name: 'VIP Auto Concierge', details: 'Personal vehicle care • Maintenance alerts • Mobile app', confidence: 0.85 }
      ];
      
      valetSpots.forEach((spot, i) => {
        if (i < 5) {
          spots.push({
            id: `valet-${spotIndex++}`,
            name: spot.name,
            type: 'valet',
            area: 'Elite Service',
            confidence: spot.confidence,
            details: spot.details
          });
        }
      });
    }

    // If no preferences, show a curated mix
    if (spots.length === 0) {
      const defaultSpots = [
        { name: 'CitySpot Hub', type: 'parking' as const, details: 'Multi-level parking • App booking • $9/hour', confidence: 0.88 },
        { name: 'Local Flavors', type: 'venue' as const, details: 'Neighborhood favorite • Casual dining • Great reviews', confidence: 0.85 },
        { name: 'QuickPark Valet', type: 'valet' as const, details: 'Fast service • Secure handling • Reasonable rates', confidence: 0.82 }
      ];
      
      defaultSpots.forEach((spot, i) => {
        spots.push({
          id: `default-${i}`,
          name: spot.name,
          type: spot.type,
          area: 'Featured',
          confidence: spot.confidence,
          details: spot.details
        });
      });
    }
    
    setDiscoveredSpots(spots);
  };



  useEffect(() => {
    let interval: NodeJS.Timeout;
    
    if (isSearching && currentPhase < searchPhases.length) {
      const phase = searchPhases[currentPhase];
      const incrementInterval = phase.duration / 100;
      
      interval = setInterval(() => {
        setProgress(prev => {
          if (prev >= 100) {
            if (currentPhase < searchPhases.length - 1) {
              // Count spots found for this specific phase based on user preferences
              const spotsForPhase = discoveredSpots.filter(spot => {
                if (phase.id === 'location') return false; // Don't count location phase
                if (phase.id === 'general') return true; // Count all for general discovery
                return spot.type === phase.id;
              });
              
              const actualSpotsFound = spotsForPhase.length;
              setFoundMatches(prev => prev + actualSpotsFound);
              setCurrentPhase(curr => curr + 1);
              
              return 0;
            } else {
              setIsSearching(false);
              setTimeout(() => onComplete(), 1500);
              return 100;
            }
          }
          return prev + 1;
        });
      }, incrementInterval);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [currentPhase, isSearching, onComplete, discoveredSpots, searchPhases]);

  const currentSearchPhase = searchPhases[currentPhase];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="min-h-screen flex flex-col items-center justify-center p-6 relative z-10"
    >


      {/* Spot Discovery Animation */}
      <motion.div
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
        className="relative mb-12"
      >
        {/* Outer Radar Rings */}
        {[1, 2, 3].map((ring) => (
          <motion.div
            key={ring}
            className="absolute inset-0 border-2 border-blue-400/30 rounded-full"
            style={{
              width: `${120 + ring * 40}px`,
              height: `${120 + ring * 40}px`,
              left: `${-ring * 20}px`,
              top: `${-ring * 20}px`,
            }}
            animate={{
              scale: [1, 1.2, 1],
              opacity: [0.3, 0.1, 0.3],
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
              delay: ring * 0.3,
              ease: "easeInOut"
            }}
          />
        ))}

        {/* Main Spot Discovery Circle */}
        <motion.div
          className="relative w-32 h-32 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full flex items-center justify-center"
          animate={{
            boxShadow: [
              "0 0 20px rgba(59, 130, 246, 0.4)",
              "0 0 40px rgba(59, 130, 246, 0.6)",
              "0 0 60px rgba(34, 211, 238, 0.4)",
              "0 0 40px rgba(59, 130, 246, 0.6)",
              "0 0 20px rgba(59, 130, 246, 0.4)"
            ]
          }}
          transition={{
            duration: 3,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        >
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
            className="relative"
          >
            <Compass className="w-16 h-16 text-white" />
            {/* Compass needle effect */}
            <motion.div
              className="absolute top-2 left-1/2 w-0.5 h-6 bg-gradient-to-b from-red-400 to-transparent transform -translate-x-1/2"
              animate={{
                rotate: [0, 45, 90, 135, 180, 225, 270, 315, 360],
                opacity: [1, 0.7, 1, 0.7, 1, 0.7, 1, 0.7, 1]
              }}
              transition={{
                duration: 8,
                repeat: Infinity,
                ease: "linear"
              }}
            />
          </motion.div>
          
          {/* Location discovery indicators */}
          {[...Array(6)].map((_, i) => (
            <motion.div
              key={`indicator-${i}`}
              className="absolute w-1 h-1 bg-white rounded-full"
              style={{
                left: `${50 + Math.cos((i * Math.PI * 2) / 6) * 45}%`,
                top: `${50 + Math.sin((i * Math.PI * 2) / 6) * 45}%`,
              }}
              animate={{
                scale: [0, 1.5, 0],
                opacity: [0, 1, 0]
              }}
              transition={{
                duration: 2,
                repeat: Infinity,
                delay: i * 0.3,
                ease: "easeInOut"
              }}
            />
          ))}
        </motion.div>

        {/* Scanning Lines */}
        <motion.div
          className="absolute inset-0 overflow-hidden rounded-full"
          style={{ width: '128px', height: '128px' }}
        >
          <motion.div
            className="absolute w-full h-0.5 bg-gradient-to-r from-transparent via-white to-transparent"
            style={{ top: '50%', left: 0 }}
            animate={{
              rotate: 360,
              opacity: [0, 1, 0]
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
              ease: "linear"
            }}
          />
        </motion.div>

        {/* Location Spot Markers */}
        {[...Array(12)].map((_, i) => (
          <motion.div
            key={i}
            className="absolute flex items-center justify-center"
            style={{
              left: `${50 + Math.cos((i * Math.PI * 2) / 12) * (60 + (i % 3) * 15)}px`,
              top: `${50 + Math.sin((i * Math.PI * 2) / 12) * (60 + (i % 3) * 15)}px`,
              width: '16px',
              height: '16px'
            }}
            animate={{
              scale: [0, 1.2, 0.8, 1],
              opacity: [0, 1, 0.7, 0],
              rotate: [0, 180, 360]
            }}
            transition={{
              duration: 3,
              repeat: Infinity,
              delay: i * 0.15,
              ease: "easeInOut"
            }}
          >
            <div className="w-3 h-3 bg-gradient-to-r from-blue-400 to-cyan-400 rounded-full relative">
              <motion.div
                className="absolute inset-0 bg-gradient-to-r from-blue-400 to-cyan-400 rounded-full"
                animate={{
                  scale: [1, 2, 1],
                  opacity: [0.8, 0, 0.8]
                }}
                transition={{
                  duration: 2,
                  repeat: Infinity,
                  delay: i * 0.1
                }}
              />
              <MapPin className="w-2 h-2 text-white absolute top-0.5 left-0.5" />
            </div>
          </motion.div>
        ))}

        {/* Discovery Pulse Waves */}
        {[...Array(4)].map((_, i) => (
          <motion.div
            key={`pulse-${i}`}
            className="absolute border-2 border-cyan-400/20 rounded-full"
            style={{
              width: `${120 + i * 30}px`,
              height: `${120 + i * 30}px`,
              left: `${-i * 15}px`,
              top: `${-i * 15}px`,
            }}
            animate={{
              scale: [1, 1.4, 1],
              opacity: [0.6, 0.1, 0.6],
              rotate: [0, 90, 180, 270, 360]
            }}
            transition={{
              duration: 4,
              repeat: Infinity,
              delay: i * 0.4,
              ease: "easeInOut"
            }}
          />
        ))}
      </motion.div>

      {/* Spot Discovery Status */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
        className="text-center mb-8 relative"
      >
        <motion.h1
          className="text-4xl text-white mb-4 relative"
          animate={{ opacity: [1, 0.7, 1] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          Spot Discovery
          
          {/* Animated location pins around title */}
          {[...Array(4)].map((_, i) => (
            <motion.div
              key={`title-pin-${i}`}
              className="absolute"
              style={{
                left: `${10 + i * 25}%`,
                top: i % 2 === 0 ? '-20px' : '60px',
              }}
              animate={{
                y: [0, -8, 0],
                opacity: [0.4, 0.8, 0.4],
                rotate: [0, 10, -10, 0]
              }}
              transition={{
                duration: 3,
                repeat: Infinity,
                delay: i * 0.4,
                ease: "easeInOut"
              }}
            >
              <MapPin className="w-4 h-4 text-cyan-400" />
            </motion.div>
          ))}
        </motion.h1>
        
        <motion.p
          className="text-white/70 text-lg relative"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8 }}
        >
          {userData.preferences && userData.preferences.length > 0 
            ? `Curating ${userData.preferences.join(' & ').toLowerCase()} just for you`
            : 'Finding your perfect spots with smart location insights'
          }
        </motion.p>
      </motion.div>

      {/* Search Progress */}
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.7 }}
        className="w-full max-w-md mb-12"
      >
        <div className="glass-card rounded-2xl p-6">
          {/* Current Phase Display */}
          <div className="flex items-center space-x-4 mb-6">
            <motion.div
              className={`flex items-center justify-center w-12 h-12 bg-gradient-to-r ${currentSearchPhase?.color || 'from-blue-400 to-cyan-400'} rounded-xl`}
              animate={{
                scale: [1, 1.1, 1],
                rotate: [0, 5, -5, 0]
              }}
              transition={{
                duration: 2,
                repeat: Infinity,
                ease: "easeInOut"
              }}
            >
              {currentSearchPhase?.icon}
            </motion.div>
            <div className="flex-1">
              <h3 className="text-white font-semibold mb-1">
                {currentSearchPhase?.title || 'Initializing...'}
              </h3>
              <p className="text-white/60 text-sm">
                {currentSearchPhase?.description || 'Setting up discovery...'}
              </p>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="relative">
            <div className="w-full bg-white/10 rounded-full h-3 overflow-hidden">
              <motion.div
                className={`h-full bg-gradient-to-r ${currentSearchPhase?.color || 'from-blue-400 to-cyan-400'} rounded-full relative`}
                style={{ width: `${progress}%` }}
                animate={{
                  backgroundPosition: ["0% 50%", "100% 50%", "0% 50%"]
                }}
                transition={{
                  duration: 3,
                  repeat: Infinity,
                  ease: "linear"
                }}
              />
            </div>
            <div className="flex justify-between text-xs text-white/50 mt-2">
              <span>Phase {currentPhase + 1} of {searchPhases.length}</span>
              <span>{Math.round(progress)}%</span>
            </div>
          </div>

          {/* Matches Found */}
          {foundMatches > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 p-3 bg-green-500/10 border border-green-400/20 rounded-lg"
            >
              <div className="flex items-center space-x-2">
                <motion.div
                  animate={{ scale: [1, 1.2, 1] }}
                  transition={{ duration: 1, repeat: Infinity }}
                >
                  <Zap className="w-4 h-4 text-green-400" />
                </motion.div>
                <span className="text-green-400 text-sm font-medium">
                  {foundMatches} spots discovered
                </span>
              </div>
            </motion.div>
          )}
        </div>
      </motion.div>


    </motion.div>
  );
}