// This demo file has been removed - VibePreferences feature was removed
import { Settings, ArrowLeft, User, MapPin, Heart, Clock, Music, UtensilsCrossed } from 'lucide-react';
import { Button } from './components/ui/button';
import { VibePreferences } from './components/VibePreferences';

type ViewState = 'menu' | 'preferences' | 'onboarding-demo';

interface UserData {
  name: string;
  address: string;
  joinedDate: string;
}

interface UserPreferences {
  location: {
    address: string;
    maxDistance: number;
    coordinates?: { lat: number; lng: number };
  };
  quality: {
    minRating: number;
    priceRange: [number, number];
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

export default function VibePreferencesDemo() {
  const [currentView, setCurrentView] = useState<ViewState>('menu');
  const [userPreferences, setUserPreferences] = useState<UserPreferences | null>(null);
  
  const userData: UserData = {
    name: 'Alex Chen',
    address: 'Downtown San Francisco, CA',
    joinedDate: 'March 2024'
  };

  const handlePreferencesComplete = (preferences: UserPreferences) => {
    setUserPreferences(preferences);
    setCurrentView('menu');
    console.log('Preferences saved:', preferences);
  };

  const handleBack = () => {
    setCurrentView('menu');
  };

  const renderMenu = () => (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] p-6">
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

      <div className="max-w-2xl mx-auto relative z-10">
        {/* Header */}
        <motion.div
          className="text-center mb-12"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <h1 className="text-4xl font-bold text-white mb-4">
            Vibe Preferences Demo
          </h1>
          <p className="text-white/70 text-lg">
            Experience the comprehensive preference system for Bytspot Premium Discovery
          </p>
        </motion.div>

        {/* User Profile */}
        <motion.div
          className="glass-card rounded-2xl p-6 mb-8 border border-white/10"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
        >
          <div className="flex items-center space-x-4">
            <div className="w-16 h-16 bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] rounded-2xl flex items-center justify-center">
              <User className="w-8 h-8 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">{userData.name}</h2>
              <p className="text-white/60">{userData.address}</p>
              <p className="text-white/40 text-sm">Member since {userData.joinedDate}</p>
            </div>
          </div>
        </motion.div>

        {/* Current Preferences Status */}
        {userPreferences && (
          <motion.div
            className="glass-card rounded-2xl p-6 mb-8 border border-[#00BFFF]/20"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Current Preferences</h3>
              <div className="w-3 h-3 bg-green-400 rounded-full animate-pulse"></div>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="flex items-center space-x-2 text-sm">
                <MapPin className="w-4 h-4 text-[#00BFFF]" />
                <span className="text-white/80">{userPreferences.location.maxDistance} miles</span>
              </div>
              <div className="flex items-center space-x-2 text-sm">
                <Heart className="w-4 h-4 text-[#FF00FF]" />
                <span className="text-white/80">{userPreferences.atmosphere.energyLevel} energy</span>
              </div>
              <div className="flex items-center space-x-2 text-sm">
                <Music className="w-4 h-4 text-[#008080]" />
                <span className="text-white/80">{userPreferences.music.genres.length} genres</span>
              </div>
              <div className="flex items-center space-x-2 text-sm">
                <UtensilsCrossed className="w-4 h-4 text-[#FF4500]" />
                <span className="text-white/80">{userPreferences.cuisine.types.length} cuisines</span>
              </div>
            </div>
          </motion.div>
        )}

        {/* Demo Options */}
        <div className="space-y-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
          >
            <Button
              onClick={() => setCurrentView('onboarding-demo')}
              className="w-full h-16 rounded-2xl bg-gradient-to-r from-[#00BFFF] to-[#008080] text-white font-medium hover:shadow-lg transition-all duration-300 group"
            >
              <div className="flex items-center justify-between w-full">
                <div className="flex items-center space-x-4">
                  <div className="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center">
                    <User className="w-6 h-6" />
                  </div>
                  <div className="text-left">
                    <h3 className="font-semibold">Onboarding Experience</h3>
                    <p className="text-white/80 text-sm">Experience the step-by-step setup flow</p>
                  </div>
                </div>
                <div className="transform group-hover:translate-x-1 transition-transform">
                  →
                </div>
              </div>
            </Button>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.4 }}
          >
            <Button
              onClick={() => setCurrentView('preferences')}
              className="w-full h-16 rounded-2xl bg-gradient-to-r from-[#FF00FF] to-[#FF4500] text-white font-medium hover:shadow-lg transition-all duration-300 group"
            >
              <div className="flex items-center justify-between w-full">
                <div className="flex items-center space-x-4">
                  <div className="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center">
                    <Settings className="w-6 h-6" />
                  </div>
                  <div className="text-left">
                    <h3 className="font-semibold">Update Preferences</h3>
                    <p className="text-white/80 text-sm">{userPreferences ? 'Modify your existing preferences' : 'Set up your preferences'}</p>
                  </div>
                </div>
                <div className="transform group-hover:translate-x-1 transition-transform">
                  →
                </div>
              </div>
            </Button>
          </motion.div>
        </div>

        {/* Features Overview */}
        <motion.div
          className="mt-12 glass-card rounded-2xl p-6 border border-white/10"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.5 }}
        >
          <h3 className="text-lg font-semibold text-white mb-4">Key Features</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { icon: '🎯', title: 'Granular Control', desc: 'Fine-tune every aspect of your discovery preferences' },
              { icon: '📊', title: 'Real-time Updates', desc: 'See venue count changes as you adjust settings' },
              { icon: '🎨', title: 'Beautiful Design', desc: 'Consistent glassmorphism design with smooth animations' },
              { icon: '💫', title: 'Smart Integration', desc: 'Seamlessly integrates with registration and main app flows' },
            ].map((feature, index) => (
              <div key={index} className="flex items-start space-x-3">
                <div className="text-2xl">{feature.icon}</div>
                <div>
                  <h4 className="text-white font-medium">{feature.title}</h4>
                  <p className="text-white/60 text-sm">{feature.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">
      <AnimatePresence mode="wait">
        {currentView === 'menu' && (
          <motion.div
            key="menu"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            {renderMenu()}
          </motion.div>
        )}
        
        {(currentView === 'preferences' || currentView === 'onboarding-demo') && (
          <motion.div
            key="preferences"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <VibePreferences
              userData={userData}
              onComplete={handlePreferencesComplete}
              onBack={handleBack}
              isOnboarding={currentView === 'onboarding-demo'}
              existingPreferences={userPreferences || undefined}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}