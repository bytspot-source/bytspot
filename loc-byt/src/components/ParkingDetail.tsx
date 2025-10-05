import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Navigation, 
  Car, 
  Shield, 
  CreditCard, 
  Clock, 
  MapPin, 
  Zap, 
  Camera, 
  Smartphone,
  Route,
  Timer,
  DollarSign,
  Lock,
  AlertCircle,
  CheckCircle,
  Star,
  Accessibility,
  Phone,
  Navigation2,
  Compass,
  ArrowLeft
} from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';

interface ParkingSpot {
  id: string;
  name: string;
  location: string;
  distance: string;
  walkingTime: string;
  price: {
    hourly: string;
    daily?: string;
    monthly?: string;
  };
  availability: {
    status: 'available' | 'limited' | 'full';
    spotsLeft: number;
    totalSpots: number;
    lastUpdated: Date;
  };
  features: {
    covered: boolean;
    security: boolean;
    evCharging: boolean;
    handicapAccessible: boolean;
    valetAvailable: boolean;
    cameraMonitored: boolean;
    keyCardAccess: boolean;
    mobilePayment: boolean;
  };
  security: {
    rating: number;
    features: string[];
    lighting: 'excellent' | 'good' | 'fair';
    patrols: boolean;
  };
  access: {
    hours: string;
    restrictions: string[];
    heightLimit?: string;
    vehicleTypes: string[];
  };
  directions: {
    entrance: string;
    landmarks: string[];
    exitInstructions: string;
  };
  contact?: {
    phone: string;
    emergencyPhone: string;
  };
  rating: number;
  reviews: number;
  image?: string;
}

interface ParkingDetailProps {
  spot: ParkingSpot;
  onNavigate: () => void;
  onReserve?: () => void;
  onCall?: (number: string) => void;
  onBack?: () => void;
}

export function ParkingDetail({ spot, onNavigate, onReserve, onCall, onBack }: ParkingDetailProps) {
  const [selectedTab, setSelectedTab] = useState<'overview' | 'directions' | 'features' | 'security'>('overview');
  const [isNavigating, setIsNavigating] = useState(false);
  const [estimatedArrival, setEstimatedArrival] = useState<Date | null>(null);

  useEffect(() => {
    if (isNavigating) {
      // Calculate estimated arrival time
      const walkingMinutes = parseInt(spot.walkingTime.split(' ')[0]);
      const arrival = new Date();
      arrival.setMinutes(arrival.getMinutes() + walkingMinutes + 2); // Add 2 min for parking
      setEstimatedArrival(arrival);
    }
  }, [isNavigating, spot.walkingTime]);

  const getAvailabilityColor = (status: string) => {
    switch (status) {
      case 'available': return 'text-green-400 bg-green-500/20';
      case 'limited': return 'text-yellow-400 bg-yellow-500/20';
      case 'full': return 'text-red-400 bg-red-500/20';
      default: return 'text-gray-400 bg-gray-500/20';
    }
  };

  const getSecurityColor = (rating: number) => {
    if (rating >= 4.5) return 'text-green-400';
    if (rating >= 3.5) return 'text-yellow-400';
    return 'text-red-400';
  };

  const handleStartNavigation = () => {
    setIsNavigating(true);
    onNavigate();
  };

  const tabContent = {
    overview: (
      <div className="space-y-6">
        {/* Real-time Availability */}
        <motion.div
          className="glass-card rounded-xl p-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-white font-medium flex items-center">
              <Car className="w-4 h-4 mr-2 text-blue-400" />
              Live Availability
            </h4>
            <Badge className={`${getAvailabilityColor(spot.availability.status)} border-0`}>
              {spot.availability.status.toUpperCase()}
            </Badge>
          </div>
          
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-white/70 text-sm">Available Spots</span>
              <span className="text-white font-medium">
                {spot.availability.spotsLeft} of {spot.availability.totalSpots}
              </span>
            </div>
            
            <Progress 
              value={(spot.availability.spotsLeft / spot.availability.totalSpots) * 100} 
              className="h-2"
            />
            
            <div className="flex items-center justify-between text-xs">
              <span className="text-white/50">
                Updated {new Date(spot.availability.lastUpdated).toLocaleTimeString()}
              </span>
              <motion.div
                className="flex items-center text-green-400"
                animate={{ opacity: [1, 0.5, 1] }}
                transition={{ duration: 2, repeat: Infinity }}
              >
                <div className="w-2 h-2 rounded-full bg-green-400 mr-1" />
                Live
              </motion.div>
            </div>
          </div>
        </motion.div>

        {/* Pricing */}
        <motion.div
          className="glass-card rounded-xl p-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <h4 className="text-white font-medium flex items-center mb-3">
            <DollarSign className="w-4 h-4 mr-2 text-green-400" />
            Pricing
          </h4>
          
          <div className="grid grid-cols-2 gap-3">
            <div className="text-center p-3 bg-white/5 rounded-lg">
              <div className="text-white font-semibold">{spot.price.hourly}</div>
              <div className="text-white/60 text-xs">per hour</div>
            </div>
            {spot.price.daily && (
              <div className="text-center p-3 bg-white/5 rounded-lg">
                <div className="text-white font-semibold">{spot.price.daily}</div>
                <div className="text-white/60 text-xs">daily max</div>
              </div>
            )}
          </div>
        </motion.div>

        {/* Quick Features */}
        <motion.div
          className="glass-card rounded-xl p-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <h4 className="text-white font-medium mb-3">Key Features</h4>
          
          <div className="grid grid-cols-2 gap-2">
            {spot.features.covered && (
              <div className="flex items-center text-sm text-white/70">
                <Shield className="w-3 h-3 mr-2 text-blue-400" />
                Covered
              </div>
            )}
            {spot.features.security && (
              <div className="flex items-center text-sm text-white/70">
                <Camera className="w-3 h-3 mr-2 text-green-400" />
                Secured
              </div>
            )}
            {spot.features.evCharging && (
              <div className="flex items-center text-sm text-white/70">
                <Zap className="w-3 h-3 mr-2 text-yellow-400" />
                EV Charging
              </div>
            )}
            {spot.features.handicapAccessible && (
              <div className="flex items-center text-sm text-white/70">
                <Accessibility className="w-3 h-3 mr-2 text-purple-400" />
                Accessible
              </div>
            )}
          </div>
        </motion.div>
      </div>
    ),

    directions: (
      <div className="space-y-6">
        {/* Navigation Card */}
        <motion.div
          className="glass-card rounded-xl p-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-white font-medium flex items-center">
              <Navigation2 className="w-4 h-4 mr-2 text-blue-400" />
              Turn-by-Turn Directions
            </h4>
            <Badge className="bg-blue-500/20 text-blue-300 border-0">
              {spot.distance} • {spot.walkingTime}
            </Badge>
          </div>

          <div className="space-y-3">
            <div className="p-3 bg-blue-500/10 rounded-lg border border-blue-400/20">
              <div className="text-blue-300 text-sm font-medium mb-1">Entrance</div>
              <div className="text-white/80 text-sm">{spot.directions.entrance}</div>
            </div>

            <div className="space-y-2">
              <div className="text-white/60 text-sm font-medium">Landmarks</div>
              {spot.directions.landmarks.map((landmark, index) => (
                <div key={index} className="flex items-center text-sm text-white/70">
                  <MapPin className="w-3 h-3 mr-2 text-green-400" />
                  {landmark}
                </div>
              ))}
            </div>

            <div className="p-3 bg-orange-500/10 rounded-lg border border-orange-400/20">
              <div className="text-orange-300 text-sm font-medium mb-1">Exit Instructions</div>
              <div className="text-white/80 text-sm">{spot.directions.exitInstructions}</div>
            </div>
          </div>
        </motion.div>

        {/* Estimated Arrival */}
        {estimatedArrival && (
          <motion.div
            className="glass-card rounded-xl p-4 border border-green-400/30"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <Timer className="w-4 h-4 mr-2 text-green-400" />
                <span className="text-white font-medium">Estimated Arrival</span>
              </div>
              <span className="text-green-300 font-semibold">
                {estimatedArrival.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </motion.div>
        )}
      </div>
    ),

    features: (
      <div className="space-y-6">
        {/* Access Information */}
        <motion.div
          className="glass-card rounded-xl p-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <h4 className="text-white font-medium flex items-center mb-3">
            <Clock className="w-4 h-4 mr-2 text-blue-400" />
            Access Information
          </h4>
          
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-white/70 text-sm">Operating Hours</span>
              <span className="text-white text-sm">{spot.access.hours}</span>
            </div>
            
            {spot.access.heightLimit && (
              <div className="flex justify-between items-center">
                <span className="text-white/70 text-sm">Height Limit</span>
                <span className="text-white text-sm">{spot.access.heightLimit}</span>
              </div>
            )}
            
            <div>
              <span className="text-white/70 text-sm block mb-2">Vehicle Types</span>
              <div className="flex flex-wrap gap-1">
                {spot.access.vehicleTypes.map((type, index) => (
                  <Badge key={index} className="bg-white/10 text-white/80 border-0 text-xs">
                    {type}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </motion.div>

        {/* Advanced Features */}
        <motion.div
          className="glass-card rounded-xl p-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <h4 className="text-white font-medium mb-3">Premium Features</h4>
          
          <div className="grid grid-cols-1 gap-3">
            {spot.features.mobilePayment && (
              <div className="flex items-center justify-between p-3 bg-green-500/10 rounded-lg">
                <div className="flex items-center">
                  <Smartphone className="w-4 h-4 mr-2 text-green-400" />
                  <span className="text-white/80 text-sm">Mobile Payment</span>
                </div>
                <CheckCircle className="w-4 h-4 text-green-400" />
              </div>
            )}
            
            {spot.features.keyCardAccess && (
              <div className="flex items-center justify-between p-3 bg-blue-500/10 rounded-lg">
                <div className="flex items-center">
                  <Lock className="w-4 h-4 mr-2 text-blue-400" />
                  <span className="text-white/80 text-sm">Keycard Access</span>
                </div>
                <CheckCircle className="w-4 h-4 text-blue-400" />
              </div>
            )}
            
            {spot.features.valetAvailable && (
              <div className="flex items-center justify-between p-3 bg-purple-500/10 rounded-lg">
                <div className="flex items-center">
                  <Car className="w-4 h-4 mr-2 text-purple-400" />
                  <span className="text-white/80 text-sm">Valet Service</span>
                </div>
                <CheckCircle className="w-4 h-4 text-purple-400" />
              </div>
            )}
          </div>
        </motion.div>

        {/* Restrictions */}
        {spot.access.restrictions.length > 0 && (
          <motion.div
            className="glass-card rounded-xl p-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <h4 className="text-white font-medium flex items-center mb-3">
              <AlertCircle className="w-4 h-4 mr-2 text-orange-400" />
              Important Restrictions
            </h4>
            
            <div className="space-y-2">
              {spot.access.restrictions.map((restriction, index) => (
                <div key={index} className="flex items-start">
                  <div className="w-1.5 h-1.5 rounded-full bg-orange-400 mt-2 mr-2 flex-shrink-0" />
                  <span className="text-white/70 text-sm">{restriction}</span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </div>
    ),

    security: (
      <div className="space-y-6">
        {/* Security Rating */}
        <motion.div
          className="glass-card rounded-xl p-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-white font-medium flex items-center">
              <Shield className="w-4 h-4 mr-2 text-green-400" />
              Security Rating
            </h4>
            <div className="flex items-center">
              <Star className={`w-4 h-4 mr-1 ${getSecurityColor(spot.security.rating)}`} />
              <span className={`font-semibold ${getSecurityColor(spot.security.rating)}`}>
                {spot.security.rating}/5.0
              </span>
            </div>
          </div>

          <Progress 
            value={(spot.security.rating / 5) * 100} 
            className="h-2 mb-3"
          />

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="flex justify-between">
              <span className="text-white/70">Lighting</span>
              <span className={`capitalize ${
                spot.security.lighting === 'excellent' ? 'text-green-400' :
                spot.security.lighting === 'good' ? 'text-yellow-400' : 'text-orange-400'
              }`}>
                {spot.security.lighting}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/70">Patrols</span>
              <span className={spot.security.patrols ? 'text-green-400' : 'text-red-400'}>
                {spot.security.patrols ? 'Active' : 'None'}
              </span>
            </div>
          </div>
        </motion.div>

        {/* Security Features */}
        <motion.div
          className="glass-card rounded-xl p-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <h4 className="text-white font-medium mb-3">Security Features</h4>
          
          <div className="space-y-2">
            {spot.security.features.map((feature, index) => (
              <div key={index} className="flex items-center text-sm text-white/70">
                <CheckCircle className="w-3 h-3 mr-2 text-green-400" />
                {feature}
              </div>
            ))}
          </div>
        </motion.div>

        {/* Emergency Contact */}
        {spot.contact && (
          <motion.div
            className="glass-card rounded-xl p-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <h4 className="text-white font-medium flex items-center mb-3">
              <Phone className="w-4 h-4 mr-2 text-red-400" />
              Emergency Contact
            </h4>
            
            <div className="space-y-3">
              <Button
                onClick={() => onCall?.(spot.contact!.phone)}
                className="w-full bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border border-blue-400/30"
              >
                <Phone className="w-4 h-4 mr-2" />
                Call Parking Office
              </Button>
              
              <Button
                onClick={() => onCall?.(spot.contact!.emergencyPhone)}
                className="w-full bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-400/30"
              >
                <AlertCircle className="w-4 h-4 mr-2" />
                Emergency Assistance
              </Button>
            </div>
          </motion.div>
        )}
      </div>
    )
  };

  return (
    <div className="space-y-6 p-6">
      {/* Back Button */}
      {onBack && (
        <Button
          onClick={onBack}
          variant="ghost"
          className="text-white hover:bg-white/10 rounded-xl mb-4"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </Button>
      )}

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-white font-semibold text-lg">{spot.name}</h2>
          <p className="text-white/60 text-sm">{spot.location}</p>
          <div className="flex items-center mt-1">
            <Star className="w-4 h-4 text-yellow-400 mr-1" />
            <span className="text-yellow-400 text-sm font-medium">{spot.rating}</span>
            <span className="text-white/50 text-sm ml-1">({spot.reviews} reviews)</span>
          </div>
        </div>
        
        <Badge className={`${getAvailabilityColor(spot.availability.status)} border-0`}>
          {spot.availability.spotsLeft} spots
        </Badge>
      </div>

      {/* Tab Navigation */}
      <div className="flex space-x-1 bg-white/5 rounded-lg p-1">
        {(['overview', 'directions', 'features', 'security'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setSelectedTab(tab)}
            className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-all ${
              selectedTab === tab
                ? 'bg-white/20 text-white'
                : 'text-white/60 hover:text-white/80'
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={selectedTab}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.3 }}
        >
          {tabContent[selectedTab]}
        </motion.div>
      </AnimatePresence>

      {/* Action Buttons */}
      <div className="space-y-3">
        <Button
          onClick={handleStartNavigation}
          disabled={isNavigating}
          className="w-full bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white"
        >
          {isNavigating ? (
            <>
              <Compass className="w-4 h-4 mr-2 animate-spin" />
              Navigating...
            </>
          ) : (
            <>
              <Navigation className="w-4 h-4 mr-2" />
              Start Navigation
            </>
          )}
        </Button>

        {onReserve && spot.availability.status !== 'full' && (
          <Button
            onClick={onReserve}
            className="w-full bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white"
          >
            <CreditCard className="w-4 h-4 mr-2" />
            Reserve Spot ({spot.price.hourly})
          </Button>
        )}
      </div>
    </div>
  );
}