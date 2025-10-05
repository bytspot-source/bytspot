import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'motion/react';
import { 
  MapPin, 
  ChevronLeft, 
  ChevronRight, 
  Star, 
  DollarSign, 
  Users, 
  Volume2, 
  Music, 
  UtensilsCrossed, 
  Clock, 
  Calendar,
  Zap,
  Coffee,
  Waves,
  Sun,
  Moon,
  Heart,
  Check,
  Save,
  RefreshCw,
  Sliders,
  MapPinIcon,
  TrendingUp,
  Activity,
  Sparkles
} from 'lucide-react';
import { Button } from './ui/button';
import { Slider } from './ui/slider';
import { Badge } from './ui/badge';

interface VibePreferencesProps {
  userData?: any;
  onComplete?: (preferences?: UserPreferences) => void;
  onBack?: () => void;
  isOnboarding?: boolean;
  existingPreferences?: UserPreferences;
}

interface UserPreferences {
  location: {
    address: string;
    maxDistance: number;
    coordinates?: { lat: number; lng: number };
  };
  quality: {
    minRating: number;
    priceRange: [number, number]; // 1-4 scale ($, $$, $$$, $$$$)
  };
  atmosphere: {
    energyLevel: 'calm' | 'medium' | 'high' | 'electric';
    noiseLevel: 'quiet' | 'moderate' | 'lively' | 'loud';
    crowdSize: 'intimate' | 'cozy' | 'popular' | 'buzzing';
  };
  music: {
    genres: string[];
    importance: 'none' | 'background' | 'important' | 'essential';
  };
  cuisine: {
    types: string[];
    dietaryRestrictions: string[];
  };
  timing: {
    timePreferences: string[];
    dayPreferences: 'weekdays' | 'weekends' | 'both';
    plannedVsImmediate: 'planned' | 'immediate' | 'both';
  };
  advanced: {
    parkingRequired: boolean;
    accessibilityNeeds: string[];
    ambientFeatures: string[];
  };
}

const defaultPreferences: UserPreferences = {
  location: {
    address: '',
    maxDistance: 5,
  },
  quality: {
    minRating: 4.0,
    priceRange: [1, 3],
  },
  atmosphere: {
    energyLevel: 'medium',
    noiseLevel: 'moderate',
    crowdSize: 'cozy',
  },
  music: {
    genres: [],
    importance: 'background',
  },
  cuisine: {
    types: [],
    dietaryRestrictions: [],
  },
  timing: {
    timePreferences: [],
    dayPreferences: 'both',
    plannedVsImmediate: 'both',
  },
  advanced: {
    parkingRequired: false,
    accessibilityNeeds: [],
    ambientFeatures: [],
  },
};

const musicGenres = [
  { id: 'jazz', name: 'Jazz', emoji: '🎷', color: 'from-[#00BFFF] to-[#008080]' },
  { id: 'rock', name: 'Rock', emoji: '🎸', color: 'from-[#FF00FF] to-[#FF4500]' },
  { id: 'electronic', name: 'Electronic', emoji: '🎧', color: 'from-[#008080] to-[#00BFFF]' },
  { id: 'classical', name: 'Classical', emoji: '🎼', color: 'from-[#121212] to-[#008080]' },
  { id: 'indie', name: 'Indie', emoji: '🎵', color: 'from-[#FF4500] to-[#FF00FF]' },
  { id: 'hiphop', name: 'Hip Hop', emoji: '🎤', color: 'from-[#FF00FF] to-[#00BFFF]' },
  { id: 'acoustic', name: 'Acoustic', emoji: '🪕', color: 'from-[#008080] to-[#FF4500]' },
  { id: 'ambient', name: 'Ambient', emoji: '🌊', color: 'from-[#00BFFF] to-[#121212]' },
];

const cuisineTypes = [
  { id: 'italian', name: 'Italian', emoji: '🍝', color: 'from-[#00BFFF] to-[#008080]' },
  { id: 'japanese', name: 'Japanese', emoji: '🍣', color: 'from-[#FF00FF] to-[#FF4500]' },
  { id: 'mexican', name: 'Mexican', emoji: '🌮', color: 'from-[#008080] to-[#00BFFF]' },
  { id: 'indian', name: 'Indian', emoji: '🍛', color: 'from-[#FF4500] to-[#FF00FF]' },
  { id: 'american', name: 'American', emoji: '🍔', color: 'from-[#00BFFF] to-[#FF00FF]' },
  { id: 'french', name: 'French', emoji: '🥐', color: 'from-[#121212] to-[#008080]' },
  { id: 'thai', name: 'Thai', emoji: '🍜', color: 'from-[#FF00FF] to-[#00BFFF]' },
  { id: 'mediterranean', name: 'Mediterranean', emoji: '🫒', color: 'from-[#008080] to-[#FF4500]' },
  { id: 'chinese', name: 'Chinese', emoji: '🥢', color: 'from-[#FF4500] to-[#00BFFF]' },
  { id: 'korean', name: 'Korean', emoji: '🥘', color: 'from-[#00BFFF] to-[#121212]' },
];

const timeSlots = [
  { id: 'early-morning', name: 'Early Morning', time: '6-9 AM', emoji: '🌅' },
  { id: 'morning', name: 'Morning', time: '9-12 PM', emoji: '☀️' },
  { id: 'lunch', name: 'Lunch', time: '12-3 PM', emoji: '🥗' },
  { id: 'afternoon', name: 'Afternoon', time: '3-6 PM', emoji: '☕' },
  { id: 'evening', name: 'Evening', time: '6-9 PM', emoji: '🌆' },
  { id: 'night', name: 'Night', time: '9-12 AM', emoji: '🌙' },
  { id: 'late-night', name: 'Late Night', time: '12-3 AM', emoji: '🌃' },
];

export function VibePreferences({ 
  userData, 
  onComplete, 
  onBack, 
  isOnboarding = false,
  existingPreferences 
}: VibePreferencesProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [preferences, setPreferences] = useState<UserPreferences>(
    existingPreferences || defaultPreferences
  );
  const [estimatedVenues, setEstimatedVenues] = useState(247);
  const [isLoading, setIsLoading] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const steps = [
    {
      id: 'location',
      title: 'Get Started: Location & Basics',
      subtitle: 'Set your discovery parameters',
      icon: <MapPin className="w-6 h-6" />,
      color: 'from-[#00BFFF] to-[#008080]',
    },
    {
      id: 'atmosphere',
      title: 'Atmosphere & Vibe',
      subtitle: 'Define your ideal environment',
      icon: <Zap className="w-6 h-6" />,
      color: 'from-[#FF00FF] to-[#FF4500]',
    },
    {
      id: 'entertainment',
      title: 'Music & Cuisine',
      subtitle: 'Your entertainment and dining preferences',
      icon: <Music className="w-6 h-6" />,
      color: 'from-[#008080] to-[#00BFFF]',
    },
    {
      id: 'timing',
      title: 'Time Preferences',
      subtitle: 'When do you like to explore?',
      icon: <Clock className="w-6 h-6" />,
      color: 'from-[#FF4500] to-[#FF00FF]',
    },
    {
      id: 'review',
      title: 'Review Your Preferences',
      subtitle: 'Confirm your vibe profile',
      icon: <Check className="w-6 h-6" />,
      color: 'from-[#00BFFF] to-[#FF00FF]',
    },
  ];

  // Simulate venue count updates based on preferences
  useEffect(() => {
    const calculateVenueCount = () => {
      let baseCount = 450;
      
      // Distance factor
      baseCount *= (preferences.location.maxDistance / 10);
      
      // Rating factor
      baseCount *= (5 - preferences.quality.minRating) / 2;
      
      // Price range factor
      const priceSpread = preferences.quality.priceRange[1] - preferences.quality.priceRange[0] + 1;
      baseCount *= (priceSpread / 4);
      
      // Music and cuisine preferences
      if (preferences.music.genres.length > 0) {
        baseCount *= 0.8; // More specific = fewer results
      }
      if (preferences.cuisine.types.length > 0) {
        baseCount *= 0.7;
      }
      
      return Math.max(15, Math.floor(baseCount));
    };

    const newCount = calculateVenueCount();
    if (newCount !== estimatedVenues) {
      setEstimatedVenues(newCount);
    }
  }, [preferences, estimatedVenues]);

  const updatePreferences = (section: keyof UserPreferences, updates: any) => {
    setPreferences(prev => ({
      ...prev,
      [section]: { ...prev[section], ...updates }
    }));
    setHasUnsavedChanges(true);
  };

  const toggleArrayItem = (array: string[], item: string): string[] => {
    return array.includes(item)
      ? array.filter(i => i !== item)
      : [...array, item];
  };

  const handleSave = async () => {
    setIsLoading(true);
    
    // Simulate save delay
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    setHasUnsavedChanges(false);
    setIsLoading(false);
    
    if (onComplete) {
      onComplete(preferences);
    }
  };

  const handleReset = () => {
    setPreferences(defaultPreferences);
    setHasUnsavedChanges(true);
  };

  const nextStep = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleSave();
    }
  };

  const prevStep = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    } else if (onBack) {
      onBack();
    }
  };

  const renderLocationStep = () => (
    <div className="space-y-8">
      {/* Location Display */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-medium">Current Location</h3>
          <Button
            variant="outline"
            size="sm"
            className="border-[#00BFFF]/30 text-[#00BFFF] hover:bg-[#00BFFF]/10"
          >
            <MapPinIcon className="w-4 h-4 mr-2" />
            Change
          </Button>
        </div>
        
        <motion.div
          className="glass-card p-4 rounded-2xl border border-[#00BFFF]/20"
          whileHover={{ scale: 1.02 }}
          transition={{ duration: 0.2 }}
          style={{
            background: 'rgba(18, 18, 18, 0.8)',
            backdropFilter: 'blur(20px) saturate(180%)',
            border: '1px solid rgba(0, 191, 255, 0.2)',
          }}
        >
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-r from-[#00BFFF] to-[#008080] flex items-center justify-center">
              <MapPin className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="text-white font-medium">
                {preferences.location.address || userData?.address || "Downtown San Francisco, CA"}
              </p>
              <p className="text-white/60 text-sm">Verified location</p>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Distance Slider */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-medium">Discovery Distance</h3>
          <div className="flex items-center space-x-2">
            <span className="text-[#00BFFF] font-medium">{preferences.location.maxDistance} miles</span>
            <motion.div
              className="text-white/60 text-sm bg-[#00BFFF]/20 px-2 py-1 rounded-full"
              key={estimatedVenues}
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.3 }}
            >
              ~{estimatedVenues} venues
            </motion.div>
          </div>
        </div>
        
        <div className="space-y-3">
          <Slider
            value={[preferences.location.maxDistance]}
            onValueChange={(value) => updatePreferences('location', { maxDistance: value[0] })}
            max={25}
            min={1}
            step={0.5}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-white/60">
            <span>1 mile</span>
            <span>25 miles</span>
          </div>
        </div>
      </div>

      {/* Star Rating */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-medium">Minimum Rating</h3>
          <div className="flex items-center space-x-1">
            {[1, 2, 3, 4, 5].map((star) => (
              <motion.button
                key={star}
                onClick={() => updatePreferences('quality', { minRating: star })}
                className={`w-8 h-8 ${star <= preferences.quality.minRating ? 'text-yellow-400' : 'text-white/30'}`}
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
              >
                <Star className={`w-full h-full ${star <= preferences.quality.minRating ? 'fill-current' : ''}`} />
              </motion.button>
            ))}
          </div>
        </div>
      </div>

      {/* Price Range */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-medium">Price Range</h3>
          <div className="flex items-center space-x-1">
            {[1, 2, 3, 4].map((price) => (
              <motion.button
                key={price}
                onClick={() => {
                  updatePreferences('quality', { 
                    priceRange: price <= preferences.quality.priceRange[0] 
                      ? [price, preferences.quality.priceRange[1]]
                      : [preferences.quality.priceRange[0], price]
                  });
                }}
                className={`w-8 h-8 text-sm font-medium ${
                  price >= preferences.quality.priceRange[0] && price <= preferences.quality.priceRange[1]
                    ? 'text-green-400' 
                    : 'text-white/30'
                }`}
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
              >
                {'$'.repeat(price)}
              </motion.button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  const renderAtmosphereStep = () => (
    <div className="space-y-8">
      {/* Energy Level */}
      <div className="space-y-4">
        <h3 className="text-white font-medium">Crowd Energy Preference</h3>
        <div className="grid grid-cols-2 gap-3">
          {[
            { id: 'calm', name: 'Calm', description: 'Peaceful & relaxed', gradient: 'from-[#008080] to-[#00BFFF]', emoji: '🧘' },
            { id: 'medium', name: 'Medium', description: 'Balanced energy', gradient: 'from-[#00BFFF] to-[#FF00FF]', emoji: '☕' },
            { id: 'high', name: 'High Energy', description: 'Lively & vibrant', gradient: 'from-[#FF00FF] to-[#FF4500]', emoji: '⚡' },
            { id: 'electric', name: 'Electric', description: 'Maximum energy', gradient: 'from-[#FF4500] to-[#FF00FF]', emoji: '🔥' },
          ].map((level) => (
            <motion.button
              key={level.id}
              onClick={() => updatePreferences('atmosphere', { energyLevel: level.id })}
              className={`p-4 rounded-2xl border-2 transition-all duration-300 ${
                preferences.atmosphere.energyLevel === level.id
                  ? 'border-[#00BFFF] bg-[#00BFFF]/10'
                  : 'border-white/20'
              }`}
              style={{
                background: preferences.atmosphere.energyLevel === level.id 
                  ? 'rgba(0, 191, 255, 0.1)' 
                  : 'rgba(18, 18, 18, 0.8)',
                backdropFilter: 'blur(20px) saturate(180%)',
              }}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <div className="text-center space-y-2">
                <div className={`w-12 h-12 mx-auto rounded-xl bg-gradient-to-r ${level.gradient} flex items-center justify-center text-xl`}>
                  {level.emoji}
                </div>
                <h4 className="text-white font-medium">{level.name}</h4>
                <p className="text-white/60 text-sm">{level.description}</p>
              </div>
            </motion.button>
          ))}
        </div>
      </div>

      {/* Noise Level */}
      <div className="space-y-4">
        <h3 className="text-white font-medium">Noise Level Preference</h3>
        <div className="space-y-3">
          {[
            { id: 'quiet', name: 'Quiet', description: 'Whisper conversations', icon: <Volume2 className="w-4 h-4" strokeWidth={1} /> },
            { id: 'moderate', name: 'Moderate', description: 'Normal conversation', icon: <Volume2 className="w-4 h-4" strokeWidth={2} /> },
            { id: 'lively', name: 'Lively', description: 'Energetic chatter', icon: <Volume2 className="w-4 h-4" strokeWidth={3} /> },
            { id: 'loud', name: 'Loud', description: 'High energy sounds', icon: <Volume2 className="w-4 h-4" strokeWidth={4} /> },
          ].map((level) => (
            <motion.button
              key={level.id}
              onClick={() => updatePreferences('atmosphere', { noiseLevel: level.id })}
              className={`w-full p-4 rounded-2xl border transition-all duration-300 ${
                preferences.atmosphere.noiseLevel === level.id
                  ? 'border-[#FF00FF] bg-[#FF00FF]/10'
                  : 'border-white/20'
              }`}
              style={{
                background: preferences.atmosphere.noiseLevel === level.id 
                  ? 'rgba(255, 0, 255, 0.1)' 
                  : 'rgba(18, 18, 18, 0.8)',
                backdropFilter: 'blur(20px) saturate(180%)',
              }}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
            >
              <div className="flex items-center space-x-4">
                <div className={`w-10 h-10 rounded-xl bg-gradient-to-r from-[#FF00FF] to-[#FF4500] flex items-center justify-center text-white`}>
                  {level.icon}
                </div>
                <div className="flex-1 text-left">
                  <h4 className="text-white font-medium">{level.name}</h4>
                  <p className="text-white/60 text-sm">{level.description}</p>
                </div>
                {preferences.atmosphere.noiseLevel === level.id && (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="w-6 h-6 rounded-full bg-[#FF00FF] flex items-center justify-center"
                  >
                    <Check className="w-4 h-4 text-white" />
                  </motion.div>
                )}
              </div>
            </motion.button>
          ))}
        </div>
      </div>
    </div>
  );

  const renderEntertainmentStep = () => (
    <div className="space-y-8">
      {/* Music Genres */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-medium">Music Preferences</h3>
          <Badge 
            variant="secondary" 
            className="bg-[#008080]/20 text-[#008080] border-[#008080]/30"
          >
            {preferences.music.genres.length} selected
          </Badge>
        </div>
        
        <div className="grid grid-cols-2 gap-3">
          {musicGenres.map((genre) => {
            const isSelected = preferences.music.genres.includes(genre.id);
            return (
              <motion.button
                key={genre.id}
                onClick={() => updatePreferences('music', {
                  genres: toggleArrayItem(preferences.music.genres, genre.id)
                })}
                className={`p-3 rounded-2xl border transition-all duration-300 ${
                  isSelected
                    ? 'border-[#008080] bg-[#008080]/10'
                    : 'border-white/20'
                }`}
                style={{
                  background: isSelected 
                    ? 'rgba(0, 128, 128, 0.1)' 
                    : 'rgba(18, 18, 18, 0.8)',
                  backdropFilter: 'blur(20px) saturate(180%)',
                }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: musicGenres.indexOf(genre) * 0.05 }}
              >
                <div className="flex items-center space-x-3">
                  <div className={`w-10 h-10 rounded-xl bg-gradient-to-r ${genre.color} flex items-center justify-center text-lg`}>
                    {genre.emoji}
                  </div>
                  <div className="flex-1 text-left">
                    <h4 className="text-white font-medium text-sm">{genre.name}</h4>
                  </div>
                  {isSelected && (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="w-5 h-5 rounded-full bg-[#008080] flex items-center justify-center"
                    >
                      <Check className="w-3 h-3 text-white" />
                    </motion.div>
                  )}
                </div>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* Cuisine Types */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-medium">Cuisine Preferences</h3>
          <Badge 
            variant="secondary" 
            className="bg-[#FF4500]/20 text-[#FF4500] border-[#FF4500]/30"
          >
            {preferences.cuisine.types.length} selected
          </Badge>
        </div>
        
        <div className="grid grid-cols-2 gap-3 max-h-80 overflow-y-auto scrollbar-hide">
          {cuisineTypes.map((cuisine) => {
            const isSelected = preferences.cuisine.types.includes(cuisine.id);
            return (
              <motion.button
                key={cuisine.id}
                onClick={() => updatePreferences('cuisine', {
                  types: toggleArrayItem(preferences.cuisine.types, cuisine.id)
                })}
                className={`p-3 rounded-2xl border transition-all duration-300 ${
                  isSelected
                    ? 'border-[#FF4500] bg-[#FF4500]/10'
                    : 'border-white/20'
                }`}
                style={{
                  background: isSelected 
                    ? 'rgba(255, 69, 0, 0.1)' 
                    : 'rgba(18, 18, 18, 0.8)',
                  backdropFilter: 'blur(20px) saturate(180%)',
                }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: cuisineTypes.indexOf(cuisine) * 0.03 }}
              >
                <div className="flex items-center space-x-3">
                  <div className={`w-10 h-10 rounded-xl bg-gradient-to-r ${cuisine.color} flex items-center justify-center text-lg`}>
                    {cuisine.emoji}
                  </div>
                  <div className="flex-1 text-left">
                    <h4 className="text-white font-medium text-sm">{cuisine.name}</h4>
                  </div>
                  {isSelected && (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="w-5 h-5 rounded-full bg-[#FF4500] flex items-center justify-center"
                    >
                      <Check className="w-3 h-3 text-white" />
                    </motion.div>
                  )}
                </div>
              </motion.button>
            );
          })}
        </div>
      </div>
    </div>
  );

  const renderTimingStep = () => (
    <div className="space-y-8">
      {/* Time of Day */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-medium">Preferred Times</h3>
          <Badge 
            variant="secondary" 
            className="bg-[#00BFFF]/20 text-[#00BFFF] border-[#00BFFF]/30"
          >
            {preferences.timing.timePreferences.length} selected
          </Badge>
        </div>
        
        <div className="space-y-3">
          {timeSlots.map((slot) => {
            const isSelected = preferences.timing.timePreferences.includes(slot.id);
            return (
              <motion.button
                key={slot.id}
                onClick={() => updatePreferences('timing', {
                  timePreferences: toggleArrayItem(preferences.timing.timePreferences, slot.id)
                })}
                className={`w-full p-4 rounded-2xl border transition-all duration-300 ${
                  isSelected
                    ? 'border-[#00BFFF] bg-[#00BFFF]/10'
                    : 'border-white/20'
                }`}
                style={{
                  background: isSelected 
                    ? 'rgba(0, 191, 255, 0.1)' 
                    : 'rgba(18, 18, 18, 0.8)',
                  backdropFilter: 'blur(20px) saturate(180%)',
                }}
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: timeSlots.indexOf(slot) * 0.05 }}
              >
                <div className="flex items-center space-x-4">
                  <div className="text-2xl">{slot.emoji}</div>
                  <div className="flex-1 text-left">
                    <h4 className="text-white font-medium">{slot.name}</h4>
                    <p className="text-white/60 text-sm">{slot.time}</p>
                  </div>
                  {isSelected && (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="w-6 h-6 rounded-full bg-[#00BFFF] flex items-center justify-center"
                    >
                      <Check className="w-4 h-4 text-white" />
                    </motion.div>
                  )}
                </div>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* Day Preferences */}
      <div className="space-y-4">
        <h3 className="text-white font-medium">Day Preferences</h3>
        <div className="grid grid-cols-3 gap-3">
          {[
            { id: 'weekdays', name: 'Weekdays', emoji: '💼' },
            { id: 'weekends', name: 'Weekends', emoji: '🎉' },
            { id: 'both', name: 'Both', emoji: '🗓️' },
          ].map((day) => (
            <motion.button
              key={day.id}
              onClick={() => updatePreferences('timing', { dayPreferences: day.id })}
              className={`p-4 rounded-2xl border transition-all duration-300 ${
                preferences.timing.dayPreferences === day.id
                  ? 'border-[#FF00FF] bg-[#FF00FF]/10'
                  : 'border-white/20'
              }`}
              style={{
                background: preferences.timing.dayPreferences === day.id 
                  ? 'rgba(255, 0, 255, 0.1)' 
                  : 'rgba(18, 18, 18, 0.8)',
                backdropFilter: 'blur(20px) saturate(180%)',
              }}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <div className="text-center space-y-2">
                <div className="text-2xl">{day.emoji}</div>
                <h4 className="text-white font-medium text-sm">{day.name}</h4>
              </div>
            </motion.button>
          ))}
        </div>
      </div>
    </div>
  );

  const renderReviewStep = () => (
    <div className="space-y-8">
      {/* Profile Summary */}
      <motion.div
        className="p-6 rounded-2xl border border-[#00BFFF]/20"
        style={{
          background: 'rgba(18, 18, 18, 0.8)',
          backdropFilter: 'blur(20px) saturate(180%)',
        }}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="text-center space-y-4">
          <div className="w-20 h-20 mx-auto rounded-2xl bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] flex items-center justify-center">
            <Sparkles className="w-10 h-10 text-white" />
          </div>
          <div>
            <h3 className="text-2xl font-bold text-white mb-2">Your Vibe Profile</h3>
            <p className="text-white/70">Ready to discover {estimatedVenues} perfectly matched venues</p>
          </div>
        </div>
      </motion.div>

      {/* Quick Summary Cards */}
      <div className="grid grid-cols-2 gap-4">
        <motion.div
          className="p-4 rounded-2xl border border-[#00BFFF]/20"
          style={{
            background: 'rgba(18, 18, 18, 0.8)',
            backdropFilter: 'blur(20px) saturate(180%)',
          }}
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.1 }}
        >
          <div className="text-center space-y-2">
            <MapPin className="w-8 h-8 mx-auto text-[#00BFFF]" />
            <h4 className="text-white font-medium">Location</h4>
            <p className="text-white/70 text-sm">{preferences.location.maxDistance} mile radius</p>
          </div>
        </motion.div>

        <motion.div
          className="p-4 rounded-2xl border border-[#FF00FF]/20"
          style={{
            background: 'rgba(18, 18, 18, 0.8)',
            backdropFilter: 'blur(20px) saturate(180%)',
          }}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.2 }}
        >
          <div className="text-center space-y-2">
            <Zap className="w-8 h-8 mx-auto text-[#FF00FF]" />
            <h4 className="text-white font-medium">Energy</h4>
            <p className="text-white/70 text-sm capitalize">{preferences.atmosphere.energyLevel}</p>
          </div>
        </motion.div>

        <motion.div
          className="p-4 rounded-2xl border border-[#008080]/20"
          style={{
            background: 'rgba(18, 18, 18, 0.8)',
            backdropFilter: 'blur(20px) saturate(180%)',
          }}
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.3 }}
        >
          <div className="text-center space-y-2">
            <Music className="w-8 h-8 mx-auto text-[#008080]" />
            <h4 className="text-white font-medium">Music</h4>
            <p className="text-white/70 text-sm">{preferences.music.genres.length} genres</p>
          </div>
        </motion.div>

        <motion.div
          className="p-4 rounded-2xl border border-[#FF4500]/20"
          style={{
            background: 'rgba(18, 18, 18, 0.8)',
            backdropFilter: 'blur(20px) saturate(180%)',
          }}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.4 }}
        >
          <div className="text-center space-y-2">
            <Clock className="w-8 h-8 mx-auto text-[#FF4500]" />
            <h4 className="text-white font-medium">Timing</h4>
            <p className="text-white/70 text-sm">{preferences.timing.timePreferences.length} time slots</p>
          </div>
        </motion.div>
      </div>

      {/* Selected preferences preview */}
      <div className="space-y-4">
        {preferences.music.genres.length > 0 && (
          <motion.div
            className="p-4 rounded-2xl border border-white/10"
            style={{
              background: 'rgba(18, 18, 18, 0.8)',
              backdropFilter: 'blur(20px) saturate(180%)',
            }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
          >
            <h4 className="text-white font-medium mb-3">Music Preferences</h4>
            <div className="flex flex-wrap gap-2">
              {preferences.music.genres.slice(0, 4).map((genreId) => {
                const genre = musicGenres.find(g => g.id === genreId);
                return genre ? (
                  <Badge key={genreId} className="bg-[#008080]/20 text-[#008080] border-[#008080]/30">
                    {genre.emoji} {genre.name}
                  </Badge>
                ) : null;
              })}
              {preferences.music.genres.length > 4 && (
                <Badge className="bg-white/10 text-white/60">
                  +{preferences.music.genres.length - 4} more
                </Badge>
              )}
            </div>
          </motion.div>
        )}

        {preferences.cuisine.types.length > 0 && (
          <motion.div
            className="p-4 rounded-2xl border border-white/10"
            style={{
              background: 'rgba(18, 18, 18, 0.8)',
              backdropFilter: 'blur(20px) saturate(180%)',
            }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
          >
            <h4 className="text-white font-medium mb-3">Cuisine Preferences</h4>
            <div className="flex flex-wrap gap-2">
              {preferences.cuisine.types.slice(0, 4).map((cuisineId) => {
                const cuisine = cuisineTypes.find(c => c.id === cuisineId);
                return cuisine ? (
                  <Badge key={cuisineId} className="bg-[#FF4500]/20 text-[#FF4500] border-[#FF4500]/30">
                    {cuisine.emoji} {cuisine.name}
                  </Badge>
                ) : null;
              })}
              {preferences.cuisine.types.length > 4 && (
                <Badge className="bg-white/10 text-white/60">
                  +{preferences.cuisine.types.length - 4} more
                </Badge>
              )}
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );

  const renderStepContent = () => {
    switch (steps[currentStep].id) {
      case 'location':
        return renderLocationStep();
      case 'atmosphere':
        return renderAtmosphereStep();
      case 'entertainment':
        return renderEntertainmentStep();
      case 'timing':
        return renderTimingStep();
      case 'review':
        return renderReviewStep();
      default:
        return renderLocationStep();
    }
  };

  const currentStepData = steps[currentStep];

  return (
    <div 
      ref={containerRef}
      className="min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] p-4 md:p-6 overflow-hidden"
    >
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

      <div className="max-w-lg mx-auto relative z-10">
        {/* Header */}
        <motion.div
          className="text-center mb-8"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <div className="flex items-center justify-between mb-6">
            <motion.button
              onClick={prevStep}
              className="w-12 h-12 rounded-2xl flex items-center justify-center text-white hover:bg-white/10 transition-colors"
              style={{
                background: 'rgba(18, 18, 18, 0.8)',
                backdropFilter: 'blur(20px) saturate(180%)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <ChevronLeft className="w-6 h-6" />
            </motion.button>

            <div className="text-center">
              <h1 className="text-3xl font-bold text-white mb-2">Let's Find Your Perfect Vibe</h1>
              <p className="text-white/70 text-base mb-4">
                We'll create your personalized discovery profile across 4 comprehensive sections.
              </p>
              <p className="text-white/60 text-sm">
                {isOnboarding ? 'Customize your discovery experience' : 'Update your preferences'}
              </p>
            </div>

            <div className="w-12 h-12" /> {/* Spacer */}
          </div>

          {/* Progress Steps */}
          <div className="flex items-center justify-center space-x-2 mb-6">
            {steps.map((step, index) => (
              <div key={step.id} className="flex items-center">
                <motion.div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center border-2 transition-all duration-300 ${
                    index === currentStep
                      ? 'border-[#00BFFF] bg-[#00BFFF]/20'
                      : index < currentStep
                      ? 'border-green-400 bg-green-400/20'
                      : 'border-white/30 bg-white/5'
                  }`}
                  whileHover={{ scale: 1.05 }}
                >
                  {index < currentStep ? (
                    <Check className="w-5 h-5 text-green-400" />
                  ) : (
                    <div className={`text-sm font-medium ${
                      index === currentStep ? 'text-[#00BFFF]' : 'text-white/60'
                    }`}>
                      {index + 1}
                    </div>
                  )}
                </motion.div>
                {index < steps.length - 1 && (
                  <div className={`w-8 h-1 mx-2 rounded-full transition-all duration-300 ${
                    index < currentStep ? 'bg-green-400' : 'bg-white/20'
                  }`} />
                )}
              </div>
            ))}
          </div>

          {/* Current Step Info */}
          <motion.div
            key={currentStep}
            className="text-center"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <div className={`inline-flex items-center space-x-2 mb-2 px-3 py-1 rounded-full bg-gradient-to-r ${currentStepData.color}`}>
              {currentStepData.icon}
              <span className="text-white font-medium text-sm">Step {currentStep + 1} of {steps.length}</span>
            </div>
            <h2 className="text-xl font-semibold text-white mb-1">{currentStepData.title}</h2>
            <p className="text-white/70 text-sm">{currentStepData.subtitle}</p>
          </motion.div>
        </motion.div>

        {/* Step Content */}
        <motion.div
          key={currentStep}
          className="mb-8"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.4 }}
        >
          {renderStepContent()}
        </motion.div>

        {/* Footer */}
        <motion.div
          className="flex items-center justify-between mb-8"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          <Button
            variant="outline"
            onClick={prevStep}
            className="bg-white/10 border-white/20 text-white hover:bg-white/20"
          >
            <ChevronLeft className="w-4 h-4 mr-2" />
            Back
          </Button>

          <div className="text-center text-white/60 text-sm">
            <p>~{estimatedVenues} venues match your preferences</p>
          </div>

          <Button
            onClick={nextStep}
            disabled={isLoading}
            className="bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] text-white hover:opacity-90"
          >
            {isLoading ? (
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
            ) : currentStep === steps.length - 1 ? (
              <Save className="w-4 h-4 mr-2" />
            ) : (
              <ChevronRight className="w-4 h-4 mr-2" />
            )}
            {isLoading ? 'Saving...' : currentStep === steps.length - 1 ? 'Complete Profile' : 'Next'}
          </Button>
        </motion.div>
      </div>
    </div>
  );
}