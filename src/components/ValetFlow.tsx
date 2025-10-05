import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ArrowLeft, 
  Car, 
  MapPin, 
  Clock, 
  DollarSign, 
  Check, 
  User, 
  Phone,
  CreditCard,
  Bell,
  Star,
  Shield,
  Zap,
  Navigation,
  Key
} from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Progress } from './ui/progress';
import { ImageWithFallback } from './figma/ImageWithFallback';

interface ValetFlowProps {
  service: any;
  onBack: () => void;
  onTriggerAchievement?: () => void;
}

type FlowStep = 'overview' | 'booking' | 'payment' | 'active' | 'retrieval' | 'complete';

export function ValetFlow({ service, onBack, onTriggerAchievement }: ValetFlowProps) {
  // Use service prop directly or provide fallback data
  const valet = service || {
    title: 'Elite Valet Service',
    subtitle: 'Premium valet service',
    image: 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHx2YWxldCUyMHNlcnZpY2V8ZW58MXx8fHwxNzU2MzMwMjY1fDA&ixlib=rb-4.1.0&q=80&w=1080',
    price: '$25/hour'
  };
  const [currentStep, setCurrentStep] = useState<FlowStep>('overview');
  const [userInfo, setUserInfo] = useState({
    name: '',
    phone: '',
    carMake: '',
    carModel: '',
    licensePlate: '',
    specialInstructions: ''
  });
  const [estimatedTime, setEstimatedTime] = useState(3);
  const [valetLocation, setValetLocation] = useState('Arriving at pickup location...');
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    
    if (currentStep === 'active') {
      interval = setInterval(() => {
        setEstimatedTime(prev => {
          if (prev <= 1) {
            setCurrentStep('retrieval');
            return 0;
          }
          return prev - 1;
        });
      }, 60000); // Update every minute
    }
    
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [currentStep]);

  const handleNext = () => {
    switch (currentStep) {
      case 'overview':
        setCurrentStep('booking');
        break;
      case 'booking':
        setCurrentStep('payment');
        break;
      case 'payment':
        setIsProcessing(true);
        setTimeout(() => {
          setIsProcessing(false);
          setCurrentStep('active');
        }, 2000);
        break;
      case 'active':
        setCurrentStep('retrieval');
        break;
      case 'retrieval':
        setCurrentStep('complete');
        break;
    }
  };

  const renderStepIndicator = () => {
    const steps = [
      { id: 'overview', label: 'Overview' },
      { id: 'booking', label: 'Details' },
      { id: 'payment', label: 'Payment' },
      { id: 'active', label: 'Active' },
      { id: 'retrieval', label: 'Pickup' },
      { id: 'complete', label: 'Complete' }
    ];

    const currentIndex = steps.findIndex(step => step.id === currentStep);

    return (
      <div className="flex items-center justify-between mb-6">
        {steps.map((step, index) => (
          <div key={step.id} className="flex items-center">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm ${
                index <= currentIndex
                  ? 'bg-gradient-to-r from-green-400 to-emerald-500 text-white'
                  : 'bg-white/20 text-white/60'
              }`}
            >
              {index < currentIndex ? <Check className="w-4 h-4" /> : index + 1}
            </div>
            <span className="text-xs text-white/60 ml-1 hidden sm:block">{step.label}</span>
            {index < steps.length - 1 && (
              <div
                className={`w-8 h-0.5 mx-2 ${
                  index < currentIndex ? 'bg-green-400' : 'bg-white/20'
                }`}
              />
            )}
          </div>
        ))}
      </div>
    );
  };

  const renderOverview = () => (
    <motion.div
      initial={{ opacity: 0, x: 50 }}
      animate={{ opacity: 1, x: 0 }}
      className="space-y-6"
    >
      <div className="relative h-48 rounded-2xl overflow-hidden">
        <ImageWithFallback
          src={valet.image}
          alt={valet.title}
          className="w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
        <div className="absolute bottom-4 left-4 right-4">
          <h2 className="text-2xl text-white mb-1">{valet.title}</h2>
          <p className="text-white/80">{valet.subtitle}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card className="bg-black/20 border-white/20 backdrop-blur-sm p-4">
          <div className="flex items-center space-x-2 mb-2">
            <DollarSign className="w-5 h-5 text-green-400" />
            <span className="text-white">Service Fee</span>
          </div>
          <div className="text-2xl text-white">{valet.price}</div>
        </Card>

        <Card className="bg-black/20 border-white/20 backdrop-blur-sm p-4">
          <div className="flex items-center space-x-2 mb-2">
            <Clock className="w-5 h-5 text-blue-400" />
            <span className="text-white">Response Time</span>
          </div>
          <div className="text-2xl text-white">2-4 min</div>
        </Card>
      </div>

      <Card className="bg-black/20 border-white/20 backdrop-blur-sm p-4">
        <h3 className="text-lg text-white mb-3 flex items-center">
          <Shield className="w-5 h-5 mr-2 text-green-400" />
          Service Includes
        </h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          {[
            'Professional valet staff',
            'Secure vehicle handling',
            'Full insurance coverage',
            'Real-time tracking',
            'White-glove service',
            '24/7 availability'
          ].map((feature, index) => (
            <div key={index} className="flex items-center space-x-2 text-white/80">
              <Check className="w-4 h-4 text-green-400" />
              <span>{feature}</span>
            </div>
          ))}
        </div>
      </Card>

      <Button
        onClick={handleNext}
        className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white rounded-xl h-14 text-lg"
      >
        Request Valet Service
      </Button>
    </motion.div>
  );

  const renderBooking = () => (
    <motion.div
      initial={{ opacity: 0, x: 50 }}
      animate={{ opacity: 1, x: 0 }}
      className="space-y-4"
    >
      <h2 className="text-2xl text-white mb-6">Vehicle & Contact Details</h2>

      <div className="space-y-4">
        <div>
          <label className="block text-white mb-2">Full Name</label>
          <Input
            value={userInfo.name}
            onChange={(e) => setUserInfo(prev => ({ ...prev, name: e.target.value }))}
            placeholder="Enter your full name"
            className="bg-white/10 border-white/20 text-white placeholder-white/50 rounded-xl"
          />
        </div>

        <div>
          <label className="block text-white mb-2">Phone Number</label>
          <Input
            value={userInfo.phone}
            onChange={(e) => setUserInfo(prev => ({ ...prev, phone: e.target.value }))}
            placeholder="(555) 123-4567"
            className="bg-white/10 border-white/20 text-white placeholder-white/50 rounded-xl"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-white mb-2">Car Make</label>
            <Input
              value={userInfo.carMake}
              onChange={(e) => setUserInfo(prev => ({ ...prev, carMake: e.target.value }))}
              placeholder="Tesla, BMW, etc."
              className="bg-white/10 border-white/20 text-white placeholder-white/50 rounded-xl"
            />
          </div>
          <div>
            <label className="block text-white mb-2">Car Model</label>
            <Input
              value={userInfo.carModel}
              onChange={(e) => setUserInfo(prev => ({ ...prev, carModel: e.target.value }))}
              placeholder="Model S, X5, etc."
              className="bg-white/10 border-white/20 text-white placeholder-white/50 rounded-xl"
            />
          </div>
        </div>

        <div>
          <label className="block text-white mb-2">License Plate</label>
          <Input
            value={userInfo.licensePlate}
            onChange={(e) => setUserInfo(prev => ({ ...prev, licensePlate: e.target.value }))}
            placeholder="ABC-1234"
            className="bg-white/10 border-white/20 text-white placeholder-white/50 rounded-xl"
          />
        </div>

        <div>
          <label className="block text-white mb-2">Special Instructions (Optional)</label>
          <Input
            value={userInfo.specialInstructions}
            onChange={(e) => setUserInfo(prev => ({ ...prev, specialInstructions: e.target.value }))}
            placeholder="Any special handling instructions..."
            className="bg-white/10 border-white/20 text-white placeholder-white/50 rounded-xl"
          />
        </div>
      </div>

      <Button
        onClick={handleNext}
        disabled={!userInfo.name || !userInfo.phone || !userInfo.carMake || !userInfo.licensePlate}
        className="w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white rounded-xl h-14 text-lg disabled:opacity-50"
      >
        Continue to Payment
      </Button>
    </motion.div>
  );

  const renderPayment = () => (
    <motion.div
      initial={{ opacity: 0, x: 50 }}
      animate={{ opacity: 1, x: 0 }}
      className="space-y-6"
    >
      <h2 className="text-2xl text-white mb-6">Payment Details</h2>

      <Card className="bg-black/20 border-white/20 backdrop-blur-sm p-4">
        <h3 className="text-lg text-white mb-4">Service Summary</h3>
        <div className="space-y-2">
          <div className="flex justify-between text-white/80">
            <span>Valet Service</span>
            <span>{valet.price}</span>
          </div>
          <div className="flex justify-between text-white/80">
            <span>Service Fee</span>
            <span>$3.00</span>
          </div>
          <div className="border-t border-white/20 pt-2 mt-2">
            <div className="flex justify-between text-white text-lg">
              <span>Total</span>
              <span>$28.00</span>
            </div>
          </div>
        </div>
      </Card>

      <div className="space-y-4">
        <div>
          <label className="block text-white mb-2">Card Number</label>
          <Input
            placeholder="1234 5678 9012 3456"
            className="bg-white/10 border-white/20 text-white placeholder-white/50 rounded-xl"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-white mb-2">Expiry Date</label>
            <Input
              placeholder="MM/YY"
              className="bg-white/10 border-white/20 text-white placeholder-white/50 rounded-xl"
            />
          </div>
          <div>
            <label className="block text-white mb-2">CVV</label>
            <Input
              placeholder="123"
              className="bg-white/10 border-white/20 text-white placeholder-white/50 rounded-xl"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center space-x-2 text-white/80 text-sm">
        <Shield className="w-4 h-4 text-green-400" />
        <span>Your payment is secured with 256-bit SSL encryption</span>
      </div>

      <Button
        onClick={handleNext}
        disabled={isProcessing}
        className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white rounded-xl h-14 text-lg disabled:opacity-50"
      >
        {isProcessing ? (
          <div className="flex items-center space-x-2">
            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            <span>Processing...</span>
          </div>
        ) : (
          'Confirm & Request Valet'
        )}
      </Button>
    </motion.div>
  );

  const renderActive = () => (
    <motion.div
      initial={{ opacity: 0, x: 50 }}
      animate={{ opacity: 1, x: 0 }}
      className="space-y-6"
    >
      <div className="text-center">
        <motion.div
          className="w-24 h-24 bg-gradient-to-r from-green-400 to-emerald-500 rounded-full flex items-center justify-center mx-auto mb-4"
          animate={{ scale: [1, 1.1, 1] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          <Car className="w-12 h-12 text-white" />
        </motion.div>
        <h2 className="text-2xl text-white mb-2">Valet En Route</h2>
        <p className="text-white/80">Your professional valet is on the way to pick up your vehicle</p>
      </div>

      <Card className="bg-black/20 border-white/20 backdrop-blur-sm p-6">
        <div className="text-center mb-4">
          <div className="text-3xl text-white mb-1">{estimatedTime} min</div>
          <p className="text-white/60">Estimated arrival time</p>
        </div>
        <Progress value={(5 - estimatedTime) * 20} className="h-2 bg-white/10" />
      </Card>

      <Card className="bg-black/20 border-white/20 backdrop-blur-sm p-4">
        <h3 className="text-lg text-white mb-3 flex items-center">
          <User className="w-5 h-5 mr-2 text-blue-400" />
          Your Valet
        </h3>
        <div className="flex items-center space-x-3">
          <div className="w-12 h-12 bg-gradient-to-r from-blue-400 to-cyan-400 rounded-full flex items-center justify-center">
            <User className="w-6 h-6 text-white" />
          </div>
          <div>
            <div className="text-white">Michael Chen</div>
            <div className="text-white/60 text-sm flex items-center">
              <Star className="w-4 h-4 text-yellow-400 fill-yellow-400 mr-1" />
              4.9 • 500+ services
            </div>
          </div>
        </div>
      </Card>

      <Card className="bg-black/20 border-white/20 backdrop-blur-sm p-4">
        <div className="space-y-3">
          <div className="flex items-center space-x-2 text-white/80">
            <Navigation className="w-4 h-4 text-green-400" />
            <span>{valetLocation}</span>
          </div>
          <div className="flex items-center space-x-2 text-white/80">
            <Car className="w-4 h-4 text-blue-400" />
            <span>{userInfo.carMake} {userInfo.carModel} • {userInfo.licensePlate}</span>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="outline"
          className="border-white/30 text-white hover:bg-white/10 rounded-xl h-12"
        >
          <Phone className="w-4 h-4 mr-2" />
          Call Valet
        </Button>
        <Button
          variant="outline"
          className="border-white/30 text-white hover:bg-white/10 rounded-xl h-12"
        >
          <MapPin className="w-4 h-4 mr-2" />
          Track Live
        </Button>
      </div>
    </motion.div>
  );

  const renderRetrieval = () => (
    <motion.div
      initial={{ opacity: 0, x: 50 }}
      animate={{ opacity: 1, x: 0 }}
      className="space-y-6"
    >
      <div className="text-center">
        <motion.div
          className="w-24 h-24 bg-gradient-to-r from-purple-400 to-pink-400 rounded-full flex items-center justify-center mx-auto mb-4"
          animate={{ rotate: [0, 10, -10, 0] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          <Key className="w-12 h-12 text-white" />
        </motion.div>
        <h2 className="text-2xl text-white mb-2">Ready for Pickup</h2>
        <p className="text-white/80">Your valet is waiting with your vehicle at the designated pickup location</p>
      </div>

      <Card className="bg-green-500/20 border-green-400/30 backdrop-blur-sm p-4">
        <div className="flex items-center space-x-2 text-green-300">
          <Check className="w-5 h-5" />
          <span>Vehicle secured and ready</span>
        </div>
      </Card>

      <Card className="bg-black/20 border-white/20 backdrop-blur-sm p-4">
        <h3 className="text-lg text-white mb-3">Pickup Location</h3>
        <div className="space-y-2">
          <div className="flex items-center space-x-2 text-white/80">
            <MapPin className="w-4 h-4 text-red-400" />
            <span>Main Street Entrance</span>
          </div>
          <div className="flex items-center space-x-2 text-white/80">
            <User className="w-4 h-4 text-blue-400" />
            <span>Michael Chen is waiting</span>
          </div>
          <div className="flex items-center space-x-2 text-white/80">
            <Car className="w-4 h-4 text-green-400" />
            <span>Silver {userInfo.carMake} {userInfo.carModel}</span>
          </div>
        </div>
      </Card>

      <Card className="bg-black/20 border-white/20 backdrop-blur-sm p-4">
        <h3 className="text-lg text-white mb-3">Verification Code</h3>
        <div className="text-center">
          <div className="text-4xl text-white mb-2 tracking-wider">8472</div>
          <p className="text-white/60 text-sm">Show this code to your valet</p>
        </div>
      </Card>

      <Button
        onClick={handleNext}
        className="w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white rounded-xl h-14 text-lg"
      >
        Confirm Pickup Complete
      </Button>
    </motion.div>
  );

  const renderComplete = () => (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="space-y-6 text-center"
    >
      <motion.div
        className="w-32 h-32 bg-gradient-to-r from-green-400 to-emerald-500 rounded-full flex items-center justify-center mx-auto"
        animate={{ scale: [1, 1.1, 1] }}
        transition={{ duration: 2, repeat: Infinity }}
      >
        <Check className="w-16 h-16 text-white" />
      </motion.div>

      <div>
        <h2 className="text-3xl text-white mb-2">Service Complete!</h2>
        <p className="text-white/80">Thank you for using {valet.title}. Your experience was seamless and secure.</p>
      </div>

      <Card className="bg-black/20 border-white/20 backdrop-blur-sm p-6">
        <h3 className="text-lg text-white mb-4">Service Summary</h3>
        <div className="space-y-2 text-white/80">
          <div className="flex justify-between">
            <span>Service Duration</span>
            <span>2 hours 15 minutes</span>
          </div>
          <div className="flex justify-between">
            <span>Total Cost</span>
            <span>$28.00</span>
          </div>
          <div className="flex justify-between">
            <span>Valet Rating</span>
            <div className="flex items-center">
              <Star className="w-4 h-4 text-yellow-400 fill-yellow-400" />
              <span className="ml-1">4.9</span>
            </div>
          </div>
        </div>
      </Card>

      <div className="space-y-3">
        <h3 className="text-white">Rate Your Experience</h3>
        <div className="flex justify-center space-x-2">
          {[1, 2, 3, 4, 5].map((star) => (
            <Button
              key={star}
              variant="ghost"
              size="sm"
              className="w-10 h-10 p-0 hover:bg-yellow-400/20"
            >
              <Star className="w-6 h-6 text-yellow-400 fill-yellow-400" />
            </Button>
          ))}
        </div>
      </div>

      <Button
        onClick={onBack}
        className="w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white rounded-xl h-14 text-lg"
      >
        Return to Matches
      </Button>
    </motion.div>
  );

  return (
    <motion.div
      initial={{ opacity: 0, x: 300 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 300 }}
      className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 relative overflow-hidden"
    >
      {/* Header */}
      <div className="backdrop-blur-md bg-white/10 border-b border-white/20 p-4">
        <div className="flex items-center justify-between">
          <Button
            onClick={onBack}
            variant="ghost"
            size="sm"
            className="w-10 h-10 rounded-full text-white hover:bg-white/10"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="text-lg text-white">Valet Service</div>
          <div className="w-10" />
        </div>
      </div>

      {/* Content */}
      <div className="p-6">
        {renderStepIndicator()}
        
        <AnimatePresence mode="wait">
          {currentStep === 'overview' && renderOverview()}
          {currentStep === 'booking' && renderBooking()}
          {currentStep === 'payment' && renderPayment()}
          {currentStep === 'active' && renderActive()}
          {currentStep === 'retrieval' && renderRetrieval()}
          {currentStep === 'complete' && renderComplete()}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}