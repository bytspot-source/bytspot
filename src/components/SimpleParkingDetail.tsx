import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { 
  ArrowLeft, 
  Star, 
  MapPin, 
  Clock, 
  DollarSign, 
  Phone, 
  Car,
  Shield,
  Zap,
  Navigation,
  Calendar,
  CheckCircle
} from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import { Card } from './ui/card';
import { ImageWithFallback } from './figma/ImageWithFallback';

interface SimpleParkingDetailProps {
  card: any;
  onBack: () => void;
  onTriggerAchievement?: () => void;
}

export function SimpleParkingDetail({ card, onBack, onTriggerAchievement }: SimpleParkingDetailProps) {
  // Defensive programming - provide defaults if card is undefined
  const parking = card || {
    title: 'Parking Spot',
    subtitle: 'Secure Parking',
    rating: 4.0,
    distance: 'Unknown',
    price: 'TBD',
    color: 'from-blue-500 to-cyan-500',
    image: '',
    spotsAvailable: 0,
    totalSpots: 1,
    securityLevel: 'Standard',
    accessMethod: [],
    restrictions: [],
    description: 'This parking spot is currently unavailable.',
    features: []
  };

  const [availabilityScore, setAvailabilityScore] = useState(
    parking.spotsAvailable && parking.totalSpots 
      ? (parking.spotsAvailable / parking.totalSpots) * 100 
      : 50
  );

  // Simulate real-time data updates
  useEffect(() => {
    const interval = setInterval(() => {
      setAvailabilityScore(prev => Math.max(20, Math.min(100, prev + (Math.random() - 0.5) * 10)));
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const availabilityColor = availabilityScore > 70 ? 'from-green-400 to-emerald-500' : 
                           availabilityScore > 40 ? 'from-yellow-400 to-orange-500' : 
                           'from-red-400 to-red-600';

  const availabilityText = availabilityScore > 70 ? 'Plenty Available' :
                          availabilityScore > 40 ? 'Limited Available' :
                          'Nearly Full';

  return (
    <motion.div
      initial={{ opacity: 0, x: 300 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 300 }}
      className="min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] relative overflow-hidden"
    >
      {/* Header Image */}
      <div className="relative h-64 overflow-hidden">
        <ImageWithFallback
          src={parking.image}
          alt={parking.title}
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
        </div>

        {/* Live Indicator */}
        <div className="absolute top-6 left-1/2 transform -translate-x-1/2">
          <div className="flex items-center space-x-2 bg-green-500 text-white px-3 py-1 rounded-full text-sm">
            <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
            <span>LIVE</span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="relative -mt-8 min-h-screen">
        <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-t-3xl p-6 space-y-6">
          {/* Parking Info */}
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-3xl text-white mb-2">{parking.title}</h1>
              <p className="text-lg text-white/80 mb-1">{parking.subtitle}</p>
              <div className="flex items-center space-x-4 text-white/60">
                <div className="flex items-center space-x-1">
                  <Star className="w-4 h-4 text-yellow-400 fill-yellow-400" />
                  <span>{parking.rating}</span>
                </div>
                <div className="flex items-center space-x-1">
                  <MapPin className="w-4 h-4" />
                  <span>{parking.distance}</span>
                </div>
                <span>{parking.price}</span>
              </div>
            </div>
            <Badge className={`bg-gradient-to-r ${parking.color} text-white border-0`}>
              Parking
            </Badge>
          </div>

          {/* Availability Score */}
          <Card className="bg-black/20 border-white/20 backdrop-blur-sm">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl text-white flex items-center space-x-2">
                  <Car className="w-6 h-6 text-green-400" />
                  <span>Live Availability</span>
                </h3>
                <motion.div 
                  className={`text-3xl font-bold bg-gradient-to-r ${availabilityColor} bg-clip-text text-transparent`}
                  animate={{ scale: [1, 1.1, 1] }}
                  transition={{ duration: 2, repeat: Infinity }}
                >
                  {Math.round(availabilityScore)}%
                </motion.div>
              </div>
              <Progress 
                value={availabilityScore} 
                className="h-3 bg-white/10"
              />
              <p className="text-white/60 mt-2">{availabilityText}</p>
            </div>
          </Card>

          {/* Security & Features */}
          <div className="grid grid-cols-2 gap-4">
            <Card className="bg-black/20 border-white/20 backdrop-blur-sm">
              <div className="p-4">
                <div className="flex items-center space-x-2 mb-2">
                  <Shield className="w-5 h-5 text-blue-400" />
                  <span className="text-white">Security Level</span>
                </div>
                <div className="text-2xl text-white mb-1">{parking.securityLevel || 'Standard'}</div>
                <p className="text-white/60 text-sm">24/7 monitoring</p>
              </div>
            </Card>

            <Card className="bg-black/20 border-white/20 backdrop-blur-sm">
              <div className="p-4">
                <div className="flex items-center space-x-2 mb-2">
                  <Clock className="w-5 h-5 text-green-400" />
                  <span className="text-white">Access</span>
                </div>
                <div className="text-2xl text-white mb-1">24/7</div>
                <p className="text-white/60 text-sm">Always available</p>
              </div>
            </Card>
          </div>

          {/* Available Spots */}
          {parking.spotsAvailable && parking.totalSpots && (
            <Card className="bg-black/20 border-white/20 backdrop-blur-sm">
              <div className="p-6">
                <h3 className="text-xl text-white mb-4 flex items-center space-x-2">
                  <Car className="w-6 h-6 text-blue-400" />
                  <span>Current Status</span>
                </h3>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-white/80">Available Spots</span>
                  <span className="text-white text-lg font-semibold">
                    {parking.spotsAvailable} of {parking.totalSpots}
                  </span>
                </div>
                <Progress 
                  value={(parking.spotsAvailable / parking.totalSpots) * 100} 
                  className="h-2 bg-white/10"
                />
              </div>
            </Card>
          )}

          {/* Features & Amenities */}
          <div>
            <h3 className="text-lg text-white mb-3">Features & Amenities</h3>
            <div className="flex flex-wrap gap-2">
              {(parking.features || []).map((feature: string, index: number) => (
                <Badge key={index} variant="secondary" className="bg-white/20 text-white border-0">
                  {feature}
                </Badge>
              ))}
              <Badge variant="secondary" className="bg-green-500/20 text-green-300 border border-green-400/30">
                <CheckCircle className="w-3 h-3 mr-1" />
                Available Now
              </Badge>
            </div>
          </div>

          {/* Access Methods */}
          {parking.accessMethod && parking.accessMethod.length > 0 && (
            <Card className="bg-black/20 border-white/20 backdrop-blur-sm">
              <div className="p-6">
                <h3 className="text-xl text-white mb-4">Access Methods</h3>
                <div className="space-y-2">
                  {parking.accessMethod.map((method: string, index: number) => (
                    <div key={index} className="flex items-center space-x-2">
                      <CheckCircle className="w-4 h-4 text-green-400" />
                      <span className="text-white/80">{method}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}

          {/* Description */}
          <div>
            <h3 className="text-lg text-white mb-2">About</h3>
            <p className="text-white/70 leading-relaxed">{parking.description}</p>
          </div>

          {/* Action Buttons */}
          <div className="space-y-3 pt-4">
            <Button 
              onClick={() => {
                if (onTriggerAchievement) {
                  onTriggerAchievement();
                }
              }}
              className="w-full bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white rounded-xl h-14 text-lg"
            >
              <Navigation className="w-5 h-5 mr-2" />
              Reserve Parking Spot
            </Button>
            
            <div className="grid grid-cols-2 gap-3">
              <Button 
                variant="outline" 
                className="border-white/30 text-white hover:bg-white/10 rounded-xl h-12"
              >
                <Navigation className="w-4 h-4 mr-2" />
                Navigate
              </Button>
              <Button 
                variant="outline" 
                className="border-white/30 text-white hover:bg-white/10 rounded-xl h-12"
              >
                <Phone className="w-4 h-4 mr-2" />
                Contact
              </Button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}