import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  MapPin, 
  Bell, 
  Camera, 
  Check, 
  ChevronRight, 
  Shield, 
  Zap, 
  Heart,
  ArrowLeft,
  Car,
  UtensilsCrossed,
  Users
} from 'lucide-react';
import { Button } from './ui/button';

interface RegistrationFlowProps {
  userData: any;
  onDataUpdate: (data: any) => void;
  onComplete: () => void;
  onBack: () => void;
}

interface Permission {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  benefit: string;
  required: boolean;
  color: string;
}

export function RegistrationFlow({ userData, onDataUpdate, onComplete, onBack }: RegistrationFlowProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [permissions, setPermissions] = useState({
    location: false,
    notifications: false,
    camera: false
  });
  const [selectedPreferences, setSelectedPreferences] = useState<string[]>([]);

  const permissionSteps: Permission[] = [
    {
      id: 'location',
      title: 'Location Services',
      description: 'Allow us to suggest spots and venues in your area',
      icon: <MapPin className="w-12 h-12" />,
      benefit: 'Get personalized recommendations based on your general area',
      required: true,
      color: 'from-blue-400 to-cyan-400'
    },
    {
      id: 'notifications',
      title: 'Push Notifications',
      description: 'Stay updated with real-time availability and special offers',
      icon: <Bell className="w-12 h-12" />,
      benefit: 'Never miss out on perfect parking spots and venue deals',
      required: false,
      color: 'from-purple-400 to-pink-400'
    },
    {
      id: 'camera',
      title: 'Camera Access',
      description: 'Quickly scan QR codes for instant booking confirmations',
      icon: <Camera className="w-12 h-12" />,
      benefit: 'Seamless check-in process at parking spots and venues',
      required: false,
      color: 'from-green-400 to-emerald-400'
    }
  ];

  // Smart suggestions based on what user was looking for
  const getSmartPreferences = () => {
    const basePreferences = [
      { id: 'parking', label: 'Smart Parking', icon: <Car className="w-6 h-6" /> },
      { id: 'dining', label: 'Fine Dining', icon: <UtensilsCrossed className="w-6 h-6" /> },
      { id: 'nightlife', label: 'Nightlife', icon: <Users className="w-6 h-6" /> },
      { id: 'events', label: 'Events', icon: <Heart className="w-6 h-6" /> },
      { id: 'valet', label: 'Valet Services', icon: <Shield className="w-6 h-6" /> },
      { id: 'premium', label: 'Premium Spots', icon: <Zap className="w-6 h-6" /> }
    ];

    // Pre-select based on smart suggestion from home page
    if (userData.address?.includes('Parking') || userData.address?.includes('parking')) {
      if (!selectedPreferences.includes('parking')) {
        setSelectedPreferences(prev => [...prev, 'parking']);
      }
    }
    if (userData.address?.includes('Dinner') || userData.address?.includes('dining')) {
      if (!selectedPreferences.includes('dining')) {
        setSelectedPreferences(prev => [...prev, 'dining']);
      }
    }
    if (userData.address?.includes('Valet') || userData.address?.includes('valet')) {
      if (!selectedPreferences.includes('valet')) {
        setSelectedPreferences(prev => [...prev, 'valet']);
      }
    }

    return basePreferences;
  };

  const preferences = getSmartPreferences();

  const handlePermissionToggle = (permissionId: string) => {
    setPermissions(prev => ({
      ...prev,
      [permissionId]: !prev[permissionId as keyof typeof prev]
    }));
  };

  const handlePreferenceToggle = (preferenceId: string) => {
    setSelectedPreferences(prev => 
      prev.includes(preferenceId)
        ? prev.filter(id => id !== preferenceId)
        : [...prev, preferenceId]
    );
  };

  const handleNext = () => {
    if (currentStep < permissionSteps.length) {
      setCurrentStep(currentStep + 1);
    } else if (currentStep === permissionSteps.length) {
      // Preferences step
      setCurrentStep(currentStep + 1);
    } else {
      // Complete
      onDataUpdate({
        permissions,
        preferences: selectedPreferences
      });
      onComplete();
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    } else {
      onBack();
    }
  };

  const canProceed = () => {
    if (currentStep < permissionSteps.length) {
      const currentPermission = permissionSteps[currentStep];
      return !currentPermission.required || permissions[currentPermission.id as keyof typeof permissions];
    }
    if (currentStep === permissionSteps.length) {
      return selectedPreferences.length > 0;
    }
    return true;
  };

  const renderPermissionStep = (permission: Permission) => (
    <motion.div
      key={permission.id}
      initial={{ opacity: 0, x: 50 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -50 }}
      className="flex flex-col items-center text-center"
    >
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
        className={`relative mb-8`}
      >
        <div className={`absolute inset-0 bg-gradient-to-r ${permission.color} rounded-3xl blur opacity-50`} />
        <motion.div 
          className={`relative w-24 h-24 bg-gradient-to-r ${permission.color} rounded-3xl flex items-center justify-center text-white glow-dynamic color-shift`}
          animate={{
            scale: [1, 1.05, 1],
            rotate: [0, 2, -2, 0]
          }}
          transition={{
            duration: 4,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        >
          <motion.div
            animate={{
              scale: [1, 1.1, 1],
              rotate: [0, 5, -5, 0]
            }}
            transition={{
              duration: 3,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          >
            {permission.icon}
          </motion.div>
        </motion.div>
        {permissions[permission.id as keyof typeof permissions] && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute -top-2 -right-2 w-8 h-8 bg-green-500 rounded-full flex items-center justify-center"
          >
            <Check className="w-5 h-5 text-white" />
          </motion.div>
        )}
      </motion.div>

      <motion.h2
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="text-3xl text-white mb-4"
      >
        {permission.title}
        {permission.required && <span className="text-red-400 ml-2">*</span>}
      </motion.h2>

      <motion.p
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="text-white/70 text-lg mb-6 max-w-md leading-relaxed"
      >
        {permission.description}
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
        className="backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl p-6 mb-8 max-w-md"
      >
        <div className="flex items-start space-x-3">
          <div className="w-8 h-8 bg-green-500/20 rounded-full flex items-center justify-center flex-shrink-0 mt-1">
            <Check className="w-4 h-4 text-green-400" />
          </div>
          <div className="text-white/80">{permission.benefit}</div>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6 }}
        className="space-y-4 w-full max-w-md"
      >
        <Button
          onClick={() => handlePermissionToggle(permission.id)}
          className={`w-full py-4 rounded-2xl text-lg transition-all duration-200 border-0 ${
            permissions[permission.id as keyof typeof permissions]
              ? `bg-gradient-to-r ${permission.color} text-white shadow-lg`
              : 'bg-white/10 border border-white/20 text-white hover:bg-white/20'
          }`}
        >
          {permissions[permission.id as keyof typeof permissions] ? 'Permission Granted' : 'Grant Permission'}
        </Button>

        {!permission.required && (
          <Button
            onClick={handleNext}
            variant="ghost"
            className="w-full text-white/60 hover:text-white hover:bg-white/10 py-3 rounded-xl"
          >
            Skip for now
          </Button>
        )}
      </motion.div>
    </motion.div>
  );

  const renderPreferencesStep = () => (
    <motion.div
      initial={{ opacity: 0, x: 50 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -50 }}
      className="flex flex-col items-center text-center w-full max-w-2xl"
    >
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
        className="w-24 h-24 bg-gradient-to-r from-purple-400 to-pink-400 rounded-3xl flex items-center justify-center text-white mb-8"
      >
        <Heart className="w-12 h-12" />
      </motion.div>

      <motion.h2
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="text-3xl text-white mb-4"
      >
        What interests you?
      </motion.h2>

      <motion.p
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="text-white/70 text-lg mb-8 max-w-md leading-relaxed"
      >
        Select your preferences to get personalized recommendations
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
        className="grid grid-cols-2 gap-4 w-full mb-8"
      >
        {preferences.map((pref, index) => (
          <motion.button
            key={pref.id}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.6 + index * 0.1 }}
            onClick={() => handlePreferenceToggle(pref.id)}
            className={`relative p-6 rounded-2xl border transition-all duration-200 ${
              selectedPreferences.includes(pref.id)
                ? 'bg-gradient-to-r from-purple-500/20 to-pink-500/20 border-purple-400 text-white'
                : 'bg-white/10 border-white/20 text-white/70 hover:bg-white/20 hover:text-white'
            }`}
          >
            <div className="flex flex-col items-center space-y-3">
              <div className={`transition-colors ${
                selectedPreferences.includes(pref.id) ? 'text-purple-400' : ''
              }`}>
                {pref.icon}
              </div>
              <span className="text-sm">{pref.label}</span>
            </div>
            {selectedPreferences.includes(pref.id) && (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                className="absolute -top-2 -right-2 w-6 h-6 bg-purple-500 rounded-full flex items-center justify-center"
              >
                <Check className="w-3 h-3 text-white" />
              </motion.div>
            )}
          </motion.button>
        ))}
      </motion.div>
    </motion.div>
  );

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="min-h-screen flex flex-col items-center justify-center p-6 relative z-10"
    >
      {/* Enhanced Back Button */}
      <motion.button
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        onClick={handleBack}
        className="absolute top-6 left-6 z-50 flex items-center space-x-2 px-4 py-2 rounded-xl text-white/70 hover:text-white transition-all duration-300 hover:bg-white/10 backdrop-blur-sm border border-white/10 hover:border-white/20 group"
        whileHover={{ 
          scale: 1.05,
          x: -2
        }}
        whileTap={{ scale: 0.95 }}
      >
        <motion.div
          className="flex items-center justify-center"
          animate={{ rotate: [0, -5, 0] }}
          transition={{ duration: 0.3 }}
          whileHover={{ rotate: -10 }}
        >
          <ArrowLeft className="w-5 h-5 group-hover:text-[#00BFFF] transition-colors duration-200" />
        </motion.div>
        <span className="text-sm font-medium">Back</span>
        
        {/* Subtle glow effect on hover */}
        <motion.div
          className="absolute inset-0 rounded-xl bg-gradient-to-r from-[#00BFFF]/5 to-[#FF00FF]/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 -z-10"
          initial={false}
        />
      </motion.button>

      {/* Enhanced Progress Bar */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-lg mb-12 px-4"
      >
        {/* Progress Header with Enhanced Typography */}
        <div className="flex justify-between items-center mb-6">
          <motion.div 
            className="flex items-center space-x-3"
            whileHover={{ scale: 1.02 }}
          >
            <div className="flex items-center space-x-2">
              <motion.div
                className="w-8 h-8 rounded-lg bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] flex items-center justify-center"
                animate={{ 
                  rotate: [0, 5, -5, 0],
                  scale: [1, 1.05, 1] 
                }}
                transition={{ 
                  duration: 3, 
                  repeat: Infinity,
                  ease: "easeInOut"
                }}
              >
                <span className="text-white text-xs font-bold">{currentStep + 1}</span>
              </motion.div>
              <div>
                <div className="text-white text-sm font-medium">
                  Step {currentStep + 1} of {permissionSteps.length + 1}
                </div>
                <div className="text-white/50 text-xs">
                  {currentStep < permissionSteps.length 
                    ? permissionSteps[currentStep].title 
                    : 'Preferences'}
                </div>
              </div>
            </div>
          </motion.div>
          
          <motion.div 
            className="flex items-center space-x-2 bg-white/10 backdrop-blur-sm rounded-lg px-3 py-1.5 border border-white/10"
            whileHover={{ 
              scale: 1.05,
              borderColor: 'rgba(0, 191, 255, 0.3)'
            }}
          >
            <motion.div
              className="w-2 h-2 rounded-full bg-gradient-to-r from-[#00BFFF] to-[#FF00FF]"
              animate={{ 
                scale: [1, 1.2, 1],
                opacity: [0.7, 1, 0.7]
              }}
              transition={{ 
                duration: 2, 
                repeat: Infinity 
              }}
            />
            <span className="text-white text-sm font-bold">
              {Math.round(((currentStep + 1) / (permissionSteps.length + 1)) * 100)}%
            </span>
          </motion.div>
        </div>
        
        {/* Enhanced Progress Track */}
        <div className="relative w-full">
          <div className="w-full bg-white/15 rounded-full h-3 shadow-inner border border-white/5">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${((currentStep + 1) / (permissionSteps.length + 1)) * 100}%` }}
              transition={{ 
                duration: 0.8, 
                ease: "easeInOut",
                type: "spring",
                stiffness: 100
              }}
              className="bg-gradient-to-r from-[#00BFFF] via-[#FF00FF] to-[#FF4500] h-3 rounded-full relative overflow-hidden"
              style={{
                boxShadow: '0 0 10px rgba(0, 191, 255, 0.5), 0 0 20px rgba(255, 0, 255, 0.3)'
              }}
            >
              {/* Shimmer effect */}
              <motion.div
                className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent"
                animate={{ x: ['-100%', '100%'] }}
                transition={{ 
                  duration: 2, 
                  repeat: Infinity, 
                  ease: "linear" 
                }}
                style={{ width: '50%' }}
              />
            </motion.div>
          </div>
          
          {/* Progress dots */}
          <div className="absolute top-1/2 -translate-y-1/2 w-full flex justify-between px-1">
            {Array.from({ length: permissionSteps.length + 1 }, (_, index) => (
              <motion.div
                key={index}
                className={`w-3 h-3 rounded-full border-2 ${
                  index <= currentStep 
                    ? 'bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] border-white shadow-lg' 
                    : 'bg-white/20 border-white/30'
                }`}
                animate={index <= currentStep ? {
                  scale: [1, 1.2, 1],
                  rotate: [0, 180, 360]
                } : {}}
                transition={{
                  duration: 1.5,
                  repeat: index === currentStep ? Infinity : 0,
                  ease: "easeInOut"
                }}
                whileHover={{ scale: 1.3 }}
              />
            ))}
          </div>
        </div>
        
        {/* Step Navigation Preview */}
        <div className="flex justify-between mt-4 text-xs text-white/40">
          <span>Setup</span>
          <span>Permissions</span>
          <span>Preferences</span>
          <span>Complete</span>
        </div>
      </motion.div>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center w-full">
        <AnimatePresence mode="wait">
          {currentStep < permissionSteps.length ? (
            renderPermissionStep(permissionSteps[currentStep])
          ) : (
            renderPreferencesStep()
          )}
        </AnimatePresence>
      </div>

      {/* Enhanced Next Button */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md px-4"
      >
        <motion.div
          whileHover={{ scale: canProceed() ? 1.02 : 1 }}
          whileTap={{ scale: canProceed() ? 0.98 : 1 }}
        >
          <Button
            onClick={handleNext}
            disabled={!canProceed()}
            className={`w-full py-5 rounded-2xl text-lg font-medium transition-all duration-300 border-0 relative overflow-hidden group ${
              canProceed()
                ? 'bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] hover:from-[#0099CC] hover:to-[#CC00CC] text-white shadow-lg hover:shadow-xl'
                : 'bg-white/10 text-white/40 cursor-not-allowed border border-white/20'
            }`}
            style={canProceed() ? {
              boxShadow: '0 8px 25px rgba(0, 191, 255, 0.3), 0 4px 12px rgba(255, 0, 255, 0.2)'
            } : {}}
          >
            {/* Button content */}
            <div className="flex items-center justify-center space-x-3 relative z-10">
              <span>
                {currentStep === permissionSteps.length ? 'Start Discovering' : 'Continue'}
              </span>
              <motion.div
                animate={canProceed() ? { x: [0, 3, 0] } : {}}
                transition={{ 
                  duration: 1.5, 
                  repeat: Infinity,
                  ease: "easeInOut"
                }}
              >
                <ChevronRight className={`w-5 h-5 ${canProceed() ? 'text-white' : 'text-white/40'}`} />
              </motion.div>
            </div>
            
            {/* Enhanced shimmer effect for enabled state */}
            {canProceed() && (
              <motion.div
                className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent opacity-0 group-hover:opacity-100"
                animate={{ x: ['-100%', '100%'] }}
                transition={{ 
                  duration: 1.5, 
                  repeat: Infinity, 
                  ease: "linear",
                  repeatDelay: 2
                }}
                style={{ width: '50%' }}
              />
            )}
            
            {/* Pulsing border for enabled state */}
            {canProceed() && (
              <motion.div
                className="absolute inset-0 rounded-2xl border-2 border-white/20"
                animate={{ 
                  opacity: [0, 0.5, 0],
                  scale: [1, 1.02, 1]
                }}
                transition={{ 
                  duration: 2, 
                  repeat: Infinity,
                  ease: "easeInOut"
                }}
              />
            )}
          </Button>
        </motion.div>
        
        {/* Progress hint below button */}
        {!canProceed() && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center text-white/50 text-sm mt-3 flex items-center justify-center space-x-2"
          >
            <motion.div
              className="w-1 h-1 rounded-full bg-white/60"
              animate={{ scale: [1, 1.5, 1], opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 1, repeat: Infinity }}
            />
            <span>
              {currentStep < permissionSteps.length && permissionSteps[currentStep].required
                ? 'Permission required to continue'
                : currentStep === permissionSteps.length
                ? 'Select at least one preference'
                : 'Complete this step to continue'
              }
            </span>
            <motion.div
              className="w-1 h-1 rounded-full bg-white/60"
              animate={{ scale: [1, 1.5, 1], opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 1, repeat: Infinity, delay: 0.5 }}
            />
          </motion.div>
        )}
      </motion.div>
    </motion.div>
  );
}