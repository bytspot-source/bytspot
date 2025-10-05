import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ArrowLeft, 
  ArrowRight, 
  Car, 
  UtensilsCrossed, 
  Users, 
  MapPin, 
  Upload, 
  CheckCircle,
  DollarSign,
  Calendar,
  Clock,
  Star,
  Shield,
  Phone,
  Mail,
  Camera,
  FileText,
  Zap,
  Send,
  Check,
  TrendingUp,
  Target,
  Calculator,
  Award,
  BarChart3,
  Globe,
  Building,
  CreditCard,
  UserCheck,
  AlertCircle,
  Search,
  Navigation,
  Verified
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Checkbox } from './ui/checkbox';
import { Badge } from './ui/badge';
import { ImageWithFallback } from './figma/ImageWithFallback';

interface HostOnboardingProps {
  onBack: () => void;
  onComplete: (hostData: any) => void;
}

type ServiceType = 'parking' | 'venue' | 'valet';
type OnboardingStep = 'intro' | 'service-type' | 'category-deep-dive' | 'address-verification' | 'business-details' | 'pricing-calculator' | 'documents' | 'verification' | 'complete';

// This file is deprecated - functionality moved to HostOnboarding.tsx
export function HostOnboarding({ onBack, onComplete }: HostOnboardingProps) {
  // Redirect to main HostOnboarding component
  return null;
}
    serviceType: '',
    businessName: '',
    description: '',
    location: {
      address: '',
      placeId: '',
      coordinates: { lat: 0, lng: 0 },
      verified: false,
      city: '',
      state: '',
      country: '',
      postalCode: ''
    },
    contact: {
      phone: '',
      email: '',
      website: '',
      socialMedia: {
        instagram: '',
        facebook: '',
        twitter: ''
      }
    },
    pricing: {
      basePrice: '',
      currency: 'USD',
      unit: 'hour',
      estimatedMonthlyRevenue: 0,
      comparativeRate: '',
      dynamicPricing: false
    },
    categorySpecific: {
      venue: {
        capacity: '',
        eventTypes: [],
        cateringOptions: false,
        liquorLicense: false,
        accessibilityFeatures: []
      },
      parking: {
        spotCount: '',
        vehicleTypes: [],
        securityFeatures: [],
        accessHours: '24/7',
        evCharging: false
      },
      valet: {
        teamSize: '',
        serviceAreas: [],
        languages: [],
        uniformed: true,
        specialtyVehicles: []
      }
    },
    availability: [],
    photos: [],
    amenities: [],
    requirements: {
      insurance: false,
      license: false,
      background: false,
      addressVerified: false,
      identityVerified: false,
      businessVerified: false
    },
    documents: {
      insurance: null,
      license: null,
      id: null,
      business: null,
      certification: null
    },
    earningsGoal: '',
    marketAnalysis: null
  });

  const [addressSuggestions, setAddressSuggestions] = useState([]);
  const [isLoadingAddress, setIsLoadingAddress] = useState(false);
  const [selectedAddressSuggestion, setSelectedAddressSuggestion] = useState(null);
  const [calculatedEarnings, setCalculatedEarnings] = useState(null);
  const addressInputRef = useRef(null);

  const serviceTypes = [
    {
      id: 'venue' as ServiceType,
      title: 'Venue Hosting',
      subtitle: 'Share your space',
      description: 'List your restaurant, bar, event space, or unique venue for bookings and special events.',
      icon: <UtensilsCrossed className="w-8 h-8" />,
      gradient: 'from-purple-500 to-pink-500',
      bgGradient: 'from-purple-500/20 to-pink-500/20',
      earnings: '$100-1000/event',
      features: ['Event management', 'Guest reviews', 'Marketing support']
    },
    {
      id: 'parking' as ServiceType,
      title: 'Smart Parking',
      subtitle: 'Monetize your space',
      description: 'Rent out your garage, driveway, or parking lot to drivers looking for convenient parking.',
      icon: <Car className="w-8 h-8" />,
      gradient: 'from-blue-500 to-cyan-500',
      bgGradient: 'from-blue-500/20 to-cyan-500/20',
      earnings: '$50-200/day',
      features: ['Flexible hours', 'Automated payments', 'Security monitoring']
    },
    {
      id: 'valet' as ServiceType,
      title: 'Valet Services',
      subtitle: 'Professional service',
      description: 'Provide premium valet parking services for events, restaurants, and high-end venues.',
      icon: <Users className="w-8 h-8" />,
      gradient: 'from-green-500 to-emerald-500',
      bgGradient: 'from-green-500/20 to-emerald-500/20',
      earnings: '$25-75/hour',
      features: ['Instant bookings', 'Insurance coverage', 'Professional training']
    }
  ];

  const getStepNumber = () => {
    switch (currentStep) {
      case 'service-type': return 1;
      case 'category-deep-dive': return 2;
      case 'address-verification': return 3;
      case 'business-details': return 4;
      case 'pricing-calculator': return 5;
      case 'documents': return 6;
      case 'verification': return 7;
      default: return 1;
    }
  };

  // Google Places API simulation (replace with real implementation)
  const searchAddresses = async (query) => {
    if (query.length < 3) {
      setAddressSuggestions([]);
      return;
    }

    setIsLoadingAddress(true);
    
    // Simulate API call - replace with actual Google Places API
    setTimeout(() => {
      const mockSuggestions = [
        {
          placeId: 'place_1',
          description: `${query} Downtown, Main Street, City, State 12345`,
          mainText: `${query} Downtown`,
          secondaryText: 'Main Street, City, State 12345',
          coordinates: { lat: 40.7128, lng: -74.0060 },
          verified: true
        },
        {
          placeId: 'place_2', 
          description: `${query} Business District, Oak Avenue, City, State 12346`,
          mainText: `${query} Business District`,
          secondaryText: 'Oak Avenue, City, State 12346',
          coordinates: { lat: 40.7580, lng: -73.9855 },
          verified: true
        },
        {
          placeId: 'place_3',
          description: `${query} Shopping Center, Mall Road, City, State 12347`,
          mainText: `${query} Shopping Center`,
          secondaryText: 'Mall Road, City, State 12347',
          coordinates: { lat: 40.6892, lng: -74.0445 },
          verified: true
        }
      ];
      
      setAddressSuggestions(mockSuggestions);
      setIsLoadingAddress(false);
    }, 500);
  };

  // Calculate earnings based on service type and location
  const calculateEarnings = (serviceType, pricing, location) => {
    const baseRates = {
      venue: { min: 100, max: 1000, avgBookingsPerMonth: 8 },
      parking: { min: 50, max: 200, avgBookingsPerMonth: 25 },
      valet: { min: 25, max: 75, avgBookingsPerMonth: 40 }
    };
    
    const rates = baseRates[serviceType];
    if (!rates || !pricing.basePrice) return null;

    const price = parseFloat(pricing.basePrice);
    const monthlyRevenue = price * rates.avgBookingsPerMonth;
    const yearlyRevenue = monthlyRevenue * 12;
    
    return {
      monthly: monthlyRevenue,
      yearly: yearlyRevenue,
      avgBookings: rates.avgBookingsPerMonth,
      marketPosition: price < rates.min ? 'below-market' : 
                     price > rates.max ? 'above-market' : 'competitive'
    };
  };

  const handleNext = () => {
    const steps: OnboardingStep[] = ['intro', 'service-type', 'category-deep-dive', 'address-verification', 'business-details', 'pricing-calculator', 'documents', 'verification', 'complete'];
    const currentIndex = steps.indexOf(currentStep);
    if (currentIndex < steps.length - 1) {
      setCurrentStep(steps[currentIndex + 1]);
    }
  };

  const handlePrevious = () => {
    const steps: OnboardingStep[] = ['intro', 'service-type', 'category-deep-dive', 'address-verification', 'business-details', 'pricing-calculator', 'documents', 'verification', 'complete'];
    const currentIndex = steps.indexOf(currentStep);
    if (currentIndex > 0) {
      setCurrentStep(steps[currentIndex - 1]);
    }
  };

  const updateHostData = (updates: any) => {
    setHostData(prev => ({ ...prev, ...updates }));
  };

  const canProceed = () => {
    switch (currentStep) {
      case 'intro':
        return true;
      case 'service-type':
        return selectedService !== null;
      case 'category-deep-dive':
        return true; // Basic category info is optional for proceeding
      case 'address-verification':
        return hostData.location.address && hostData.location.verified;
      case 'business-details':
        return hostData.businessName && hostData.description && hostData.contact.phone && hostData.contact.email;
      case 'pricing-calculator':
        return hostData.pricing.basePrice;
      case 'documents':
        return hostData.documents.insurance && hostData.documents.id; // Required docs
      case 'verification':
        return hostData.requirements.insurance && hostData.requirements.addressVerified;
      default:
        return true;
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 relative overflow-hidden p-4 sm:p-6"
    >
      {/* Header with progress indicator */}
      {currentStep !== 'intro' && currentStep !== 'complete' && (
        <div className="max-w-4xl mx-auto mb-8">
          <div className="flex items-center justify-between mb-6">
            <Button
              onClick={onBack}
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/10 rounded-xl"
            >
              <ArrowLeft className="w-5 h-5 mr-2" />
              Exit
            </Button>

            <div className="flex items-center space-x-2">
              <span className="text-white/60 text-sm">Step {getStepNumber()} of 7</span>
            </div>
          </div>

          {/* Progress bar */}
          <div className="w-full bg-white/20 rounded-full h-2">
            <motion.div
              className="bg-gradient-to-r from-purple-500 to-pink-500 h-2 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${(getStepNumber() / 7) * 100}%` }}
              transition={{ duration: 0.5 }}
            />
          </div>
        </div>
      )}

      {/* Step Content */}
      <AnimatePresence mode="wait">
        {currentStep === 'intro' && (
          <motion.div
            key="intro"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="text-center max-w-2xl mx-auto"
          >
            <motion.div
              className="w-20 h-20 bg-gradient-to-r from-purple-400 to-pink-400 rounded-2xl flex items-center justify-center mx-auto mb-6"
              whileHover={{ scale: 1.05, rotate: 5 }}
            >
              <Zap className="w-10 h-10 text-white" />
            </motion.div>
            
            <h2 className="text-3xl sm:text-4xl text-white mb-4">Become a Bytspot Host</h2>
            <p className="text-lg text-white/80 mb-8 leading-relaxed">
              Turn your space, skills, or services into income. Join thousands of hosts who are earning money by sharing what they have with the Bytspot community.
            </p>
            
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
              {[
                { icon: <DollarSign className="w-6 h-6" />, title: 'Earn Money', desc: 'Set your own rates' },
                { icon: <Shield className="w-6 h-6" />, title: 'Protected', desc: 'Full insurance coverage' },
                { icon: <Star className="w-6 h-6" />, title: 'Grow', desc: 'Build your reputation' }
              ].map((benefit, index) => (
                <motion.div
                  key={benefit.title}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 + index * 0.1 }}
                  className="backdrop-blur-md bg-white/10 border border-white/20 rounded-xl p-4"
                >
                  <div className="w-12 h-12 bg-white/20 rounded-lg flex items-center justify-center mx-auto mb-3 text-white">
                    {benefit.icon}
                  </div>
                  <h3 className="text-white font-medium mb-1">{benefit.title}</h3>
                  <p className="text-white/60 text-sm">{benefit.desc}</p>
                </motion.div>
              ))}
            </div>
            
            <Button
              onClick={handleNext}
              size="lg"
              className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white px-8 py-4 rounded-xl min-h-[56px] active:scale-95 transition-all border-0"
            >
              Get Started
              <ArrowRight className="w-5 h-5 ml-2" />
            </Button>
          </motion.div>
        )}

        {currentStep === 'service-type' && (
          <motion.div
            key="service-type"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="max-w-4xl mx-auto w-full relative z-10"
          >
            <div className="text-center mb-12">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.2 }}
                className="w-16 h-16 bg-gradient-to-r from-purple-500 to-pink-500 rounded-2xl flex items-center justify-center mx-auto mb-6"
              >
                <Zap className="w-8 h-8 text-white" />
              </motion.div>
              <h2 className="text-3xl sm:text-4xl text-white mb-4">What would you like to host?</h2>
              <p className="text-white/70 text-lg">Choose the type of service you want to offer on Bytspot</p>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {serviceTypes.map((service, index) => (
                <motion.div
                  key={service.id}
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.15 }}
                  whileHover={{ y: -8, scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className={`group cursor-pointer relative ${
                    selectedService === service.id ? 'ring-2 ring-purple-400/50' : ''
                  }`}
                  onClick={() => {
                    setSelectedService(service.id);
                    updateHostData({ serviceType: service.id });
                  }}
                >
                  {/* Background glow effect */}
                  <div className={`absolute inset-0 bg-gradient-to-r ${service.bgGradient} rounded-2xl blur opacity-20 group-hover:opacity-30 transition-opacity`} />
                  
                  {/* Main card */}
                  <div className={`relative backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl p-6 transition-all h-full ${
                    selectedService === service.id ? 'bg-white/20 border-purple-400/50' : 'group-hover:bg-white/15'
                  }`}>
                    {/* Icon */}
                    <div className={`inline-flex items-center justify-center w-16 h-16 bg-gradient-to-r ${service.gradient} rounded-xl mb-6 text-white shadow-lg`}>
                      {service.icon}
                    </div>
                    
                    {/* Content */}
                    <div className="mb-6">
                      <h3 className="text-xl text-white mb-2">{service.title}</h3>
                      <p className="text-purple-200 mb-3">{service.subtitle}</p>
                      <p className="text-white/70 text-sm leading-relaxed">{service.description}</p>
                    </div>
                    
                    {/* Earnings badge */}
                    <div className="mb-4">
                      <Badge className={`bg-gradient-to-r ${service.gradient} text-white border-none`}>
                        {service.earnings}
                      </Badge>
                    </div>
                    
                    {/* Features */}
                    <ul className="space-y-2">
                      {service.features.map((feature, idx) => (
                        <li key={idx} className="flex items-center text-white/80 text-sm">
                          <CheckCircle className="w-4 h-4 text-green-400 mr-2 flex-shrink-0" />
                          {feature}
                        </li>
                      ))}
                    </ul>
                    
                    {/* Selection indicator */}
                    {selectedService === service.id && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="absolute top-4 right-4"
                      >
                        <div className="w-8 h-8 bg-gradient-to-r from-purple-500 to-pink-500 rounded-full flex items-center justify-center shadow-lg">
                          <CheckCircle className="w-5 h-5 text-white" />
                        </div>
                      </motion.div>
                    )}
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}

        {/* Add other steps here */}
        {currentStep === 'complete' && (
          <motion.div
            key="complete"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="text-center max-w-2xl mx-auto relative z-10"
          >
            <motion.div
              initial={{ scale: 0, rotate: -180 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ delay: 0.2, type: "spring", bounce: 0.4 }}
              className="w-24 h-24 bg-gradient-to-r from-green-500 to-emerald-500 rounded-full flex items-center justify-center mx-auto mb-8 shadow-lg"
            >
              <CheckCircle className="w-12 h-12 text-white" />
            </motion.div>
            
            <h2 className="text-4xl text-white mb-4">Welcome to Bytspot!</h2>
            <p className="text-xl text-white/80 mb-8 leading-relaxed">
              Your host application has been submitted successfully. We'll review your information and get back to you within 24-48 hours.
            </p>
            
            <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl p-8 mb-8">
              <h3 className="text-white text-xl mb-6 flex items-center justify-center">
                <Clock className="w-6 h-6 mr-3" />
                What happens next?
              </h3>
              <div className="space-y-4 text-left">
                {[
                  {
                    number: 1,
                    title: "Document Review",
                    description: "We'll verify your documents and information",
                    color: "from-purple-500 to-pink-500"
                  },
                  {
                    number: 2,
                    title: "Account Setup",
                    description: "Complete your host profile and listing details",
                    color: "from-blue-500 to-cyan-500"
                  },
                  {
                    number: 3,
                    title: "Go Live",
                    description: "Start receiving bookings and earning money",
                    color: "from-green-500 to-emerald-500"
                  }
                ].map((step, index) => (
                  <motion.div 
                    key={step.number}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.4 + index * 0.1 }}
                    className="flex items-start space-x-4 p-4 rounded-xl bg-white/5 border border-white/10"
                  >
                    <div className={`w-8 h-8 bg-gradient-to-r ${step.color} rounded-full flex items-center justify-center text-white flex-shrink-0 mt-1`}>
                      {step.number}
                    </div>
                    <div>
                      <p className="text-white mb-1">{step.title}</p>
                      <p className="text-white/70 text-sm">{step.description}</p>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
            
            <Button
              onClick={() => onComplete(hostData)}
              size="lg"
              className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white px-8 py-4 rounded-xl min-h-[56px] active:scale-95 transition-all shadow-lg border-0"
            >
              Return to Home
              <ArrowRight className="w-5 h-5 ml-2" />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Navigation buttons */}
      {currentStep !== 'intro' && currentStep !== 'complete' && (
        <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 flex space-x-4 z-50">
          <Button
            onClick={handlePrevious}
            variant="outline"
            className="border-white/30 text-white hover:bg-white/10 rounded-xl"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Previous
          </Button>
          
          <Button
            onClick={handleNext}
            disabled={!canProceed()}
            className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white rounded-xl disabled:opacity-50"
          >
            Continue
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      )}
    </motion.div>
  );
}