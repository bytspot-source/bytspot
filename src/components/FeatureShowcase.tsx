import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Sun, CloudRain, Cloud, CloudSnow, Mountain, Waves, Building, TreePine, Award, Zap } from 'lucide-react';
import { Button } from './ui/button';

interface FeatureShowcaseProps {
  currentTheme: string;
  weatherTheme: string;
  locationTheme: string;
  onWeatherChange: (weather: string) => void;
  onLocationChange: (location: string) => void;
  onTriggerAchievement: () => void;
}

export function FeatureShowcase({
  currentTheme,
  weatherTheme,
  locationTheme,
  onWeatherChange,
  onLocationChange,
  onTriggerAchievement
}: FeatureShowcaseProps) {
  const [showControls, setShowControls] = useState(false);

  const weatherOptions = [
    { id: 'sunny', name: 'Sunny', icon: <Sun className="w-4 h-4" />, color: 'from-yellow-400 to-orange-400' },
    { id: 'rainy', name: 'Rainy', icon: <CloudRain className="w-4 h-4" />, color: 'from-blue-400 to-gray-400' },
    { id: 'cloudy', name: 'Cloudy', icon: <Cloud className="w-4 h-4" />, color: 'from-gray-300 to-slate-400' },
    { id: 'snowy', name: 'Snowy', icon: <CloudSnow className="w-4 h-4" />, color: 'from-blue-200 to-cyan-200' },
    { id: 'stormy', name: 'Stormy', icon: <CloudRain className="w-4 h-4" />, color: 'from-purple-500 to-indigo-600' },
    { id: 'foggy', name: 'Foggy', icon: <Cloud className="w-4 h-4" />, color: 'from-gray-400 to-zinc-400' }
  ];

  const locationOptions = [
    { id: 'beach', name: 'Beach', icon: <Waves className="w-4 h-4" />, color: 'from-cyan-400 to-blue-400' },
    { id: 'city', name: 'City', icon: <Building className="w-4 h-4" />, color: 'from-gray-400 to-slate-400' },
    { id: 'mountain', name: 'Mountain', icon: <Mountain className="w-4 h-4" />, color: 'from-stone-400 to-green-400' },
    { id: 'forest', name: 'Forest', icon: <TreePine className="w-4 h-4" />, color: 'from-green-500 to-emerald-500' },
    { id: 'desert', name: 'Desert', icon: <Sun className="w-4 h-4" />, color: 'from-orange-400 to-yellow-400' },
    { id: 'suburban', name: 'Suburban', icon: <Building className="w-4 h-4" />, color: 'from-green-400 to-lime-400' }
  ];

  return (
    <>
      {/* Toggle Button */}
      <motion.button
        onClick={() => setShowControls(!showControls)}
        className="fixed bottom-8 right-8 z-50 w-14 h-14 glass-effect rounded-full flex items-center justify-center text-white hover:bg-white/20 transition-all duration-300"
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.9 }}
        animate={{ 
          rotate: showControls ? 45 : 0,
          scale: [1, 1.05, 1]
        }}
        transition={{ 
          rotate: { duration: 0.3 },
          scale: { duration: 2, repeat: Infinity }
        }}
      >
        <Zap className="w-6 h-6" />
      </motion.button>

      {/* Feature Controls */}
      {showControls && (
        <motion.div
          initial={{ opacity: 0, scale: 0.8, x: 20, y: 20 }}
          animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
          exit={{ opacity: 0, scale: 0.8, x: 20, y: 20 }}
          className="fixed bottom-24 right-8 z-50 glass-card rounded-2xl p-6 max-w-xs"
        >
          <h3 className="text-white font-semibold mb-4 text-center">Theme Controls</h3>
          
          {/* Current Status */}
          <div className="mb-4 p-3 glass-effect rounded-xl">
            <p className="text-white/70 text-sm mb-1">Current Context:</p>
            <p className="text-white text-sm font-medium capitalize">
              {currentTheme} • {weatherTheme} • {locationTheme}
            </p>
          </div>

          {/* Weather Controls */}
          <div className="mb-4">
            <p className="text-white/80 text-sm font-medium mb-2">Weather</p>
            <div className="grid grid-cols-2 gap-2">
              {weatherOptions.map(weather => (
                <motion.button
                  key={weather.id}
                  onClick={() => onWeatherChange(weather.id)}
                  className={`flex items-center space-x-2 p-2 rounded-lg transition-all duration-200 text-sm ${
                    weatherTheme === weather.id 
                      ? `bg-gradient-to-r ${weather.color} text-white` 
                      : 'bg-white/10 text-white/70 hover:bg-white/20'
                  }`}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  {weather.icon}
                  <span>{weather.name}</span>
                </motion.button>
              ))}
            </div>
          </div>

          {/* Location Controls */}
          <div className="mb-4">
            <p className="text-white/80 text-sm font-medium mb-2">Location</p>
            <div className="grid grid-cols-2 gap-2">
              {locationOptions.map(location => (
                <motion.button
                  key={location.id}
                  onClick={() => onLocationChange(location.id)}
                  className={`flex items-center space-x-2 p-2 rounded-lg transition-all duration-200 text-sm ${
                    locationTheme === location.id 
                      ? `bg-gradient-to-r ${location.color} text-white` 
                      : 'bg-white/10 text-white/70 hover:bg-white/20'
                  }`}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  {location.icon}
                  <span>{location.name}</span>
                </motion.button>
              ))}
            </div>
          </div>

          {/* Smart Recommendation Trigger */}
          <motion.div
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            <Button
              onClick={onTriggerAchievement}
              className="w-full btn-primary rounded-xl py-2 text-sm font-medium border-0 flex items-center justify-center space-x-2"
            >
              <Award className="w-4 h-4" />
              <span>Get Smart Recommendation</span>
            </Button>
          </motion.div>

          <p className="text-white/50 text-xs text-center mt-3">
            Tap options to see dynamic theme changes!
          </p>
        </motion.div>
      )}
    </>
  );
}