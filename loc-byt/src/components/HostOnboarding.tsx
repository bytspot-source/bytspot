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
import BytspotColors from './BytspotColors';

interface HostOnboardingProps {
  onBack: () => void;
  onComplete: (hostData: any) => void;
}

type ServiceType = 'parking' | 'venue' | 'valet';
type OnboardingStep = 'intro' | 'service-type' | 'category-deep-dive' | 'address-verification' | 'business-details' | 'pricing-calculator' | 'documents' | 'verification' | 'complete';

export function HostOnboarding({ onBack, onComplete }: HostOnboardingProps) {
  const [currentStep, setCurrentStep] = useState<OnboardingStep>('intro');
  const [selectedService, setSelectedService] = useState<ServiceType | null>(null);
  const [hostData, setHostData] = useState({
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
        return hostData.location.address && selectedAddressSuggestion;
      case 'business-details':
        return hostData.businessName && hostData.description && hostData.contact.phone && hostData.contact.email;
      case 'pricing-calculator':
        return hostData.pricing.basePrice;
      case 'documents':
        return hostData.documents.insurance && hostData.documents.id; // Required docs
      case 'verification':
        return hostData.requirements.insurance && hostData.requirements.identityVerified;
      default:
        return true;
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="min-h-screen relative overflow-hidden p-4 sm:p-6"
      style={{ 
        background: BytspotColors.backgroundGradient,
      }}
    >
      {/* Header with progress indicator */}
      {currentStep !== 'intro' && currentStep !== 'complete' && (
        <div className="max-w-4xl mx-auto mb-8">
          <div className="flex items-center justify-between mb-6">
            <Button
              onClick={onBack}
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/10 rounded-xl border"
              style={{ 
                backgroundColor: BytspotColors.midnight + 'CC', // 80% opacity
                borderColor: BytspotColors.lightGray + '33' // 20% opacity
              }}
            >
              <ArrowLeft className="w-5 h-5 mr-2" />
              Exit
            </Button>

            <div className="flex items-center space-x-2">
              <span className="text-sm" style={{ color: BytspotColors.lightGray }}>Step {getStepNumber()} of 7</span>
            </div>
          </div>

          {/* Progress bar */}
          <div className="w-full rounded-full h-2" style={{ backgroundColor: BytspotColors.darkGray }}>
            <motion.div
              className="h-2 rounded-full"
              style={{ 
                background: BytspotColors.progressBar,
              }}
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
              className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6"
              style={BytspotColors.primaryButton}
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
                  className="backdrop-blur-md rounded-xl p-4 border"
                  style={BytspotColors.glassCard}
                >
                  <div className="w-12 h-12 rounded-lg flex items-center justify-center mx-auto mb-3 text-white"
                    style={{ backgroundColor: BytspotColors.electricBlue + '33' }}>
                    {benefit.icon}
                  </div>
                  <h3 className="text-white font-medium mb-1">{benefit.title}</h3>
                  <p className="text-sm" style={{ color: BytspotColors.lightGray }}>{benefit.desc}</p>
                </motion.div>
              ))}
            </div>
            
            <Button
              onClick={handleNext}
              size="lg"
              className="text-white px-8 py-4 rounded-xl min-h-[56px] active:scale-95 transition-all border-0"
              style={{ 
                background: `linear-gradient(135deg, #00BFFF 0%, #FF00FF 100%)`,
                boxShadow: '0 4px 20px rgba(0, 191, 255, 0.4), 0 2px 10px rgba(255, 0, 255, 0.3)'
              }}
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
                className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6"
                style={{ 
                  background: `linear-gradient(135deg, #00BFFF 0%, #FF00FF 100%)`,
                  boxShadow: `0 8px 32px rgba(0, 191, 255, 0.3), 0 4px 16px rgba(255, 0, 255, 0.2)`
                }}
              >
                <Zap className="w-8 h-8 text-white" />
              </motion.div>
              <h2 className="text-3xl sm:text-4xl text-white mb-4">What would you like to host?</h2>
              <p className="text-lg" style={{ color: BytspotColors.lightGray }}>Choose the type of service you want to offer on Bytspot</p>
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
                    selectedService === service.id ? 'ring-2' : ''
                  }`}
                  style={{ 
                    borderColor: selectedService === service.id ? BytspotColors.electricBlue : 'transparent'
                  }}
                  onClick={() => {
                    setSelectedService(service.id);
                    updateHostData({ serviceType: service.id });
                  }}
                >
                  {/* Background glow effect */}
                  <div 
                    className="absolute inset-0 rounded-2xl blur opacity-20 group-hover:opacity-30 transition-opacity"
                    style={{ 
                      background: BytspotColors.getServiceGradient(service.id)
                    }}
                  />
                  
                  {/* Main card */}
                  <div 
                    className="relative backdrop-blur-md rounded-2xl p-6 transition-all h-full border"
                    style={{ 
                      backgroundColor: selectedService === service.id ? BytspotColors.midnight + 'E6' : BytspotColors.midnight + 'CC',
                      borderColor: selectedService === service.id ? BytspotColors.electricBlue : BytspotColors.lightGray + '33',
                      boxShadow: selectedService === service.id ? '0 8px 32px rgba(0, 191, 255, 0.3)' : '0 4px 16px rgba(18, 18, 18, 0.5)'
                    }}
                  >
                    {/* Icon */}
                    <div 
                      className="inline-flex items-center justify-center w-16 h-16 rounded-xl mb-6 text-white shadow-lg"
                      style={{ 
                        background: BytspotColors.getServiceGradient(service.id),
                        boxShadow: '0 4px 16px rgba(0, 191, 255, 0.3)'
                      }}
                    >
                      {service.icon}
                    </div>
                    
                    {/* Content */}
                    <div className="mb-6">
                      <h3 className="text-xl text-white mb-2">{service.title}</h3>
                      <p className="mb-3" style={{ color: BytspotColors.electricBlue }}>{service.subtitle}</p>
                      <p className="text-sm leading-relaxed" style={{ color: BytspotColors.lightGray }}>{service.description}</p>
                    </div>
                    
                    {/* Earnings badge */}
                    <div className="mb-4">
                      <Badge 
                        className="text-white border-none"
                        style={{ 
                          background: BytspotColors.getServiceGradient(service.id)
                        }}
                      >
                        {service.earnings}
                      </Badge>
                    </div>
                    
                    {/* Features */}
                    <ul className="space-y-2">
                      {service.features.map((feature, idx) => (
                        <li key={idx} className="flex items-center text-sm" style={{ color: BytspotColors.lightGray }}>
                          <CheckCircle className="w-4 h-4 mr-2 flex-shrink-0" style={{ color: BytspotColors.chillTeal }} />
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
                        <div 
                          className="w-8 h-8 rounded-full flex items-center justify-center shadow-lg"
                          style={{ 
                            background: BytspotColors.primaryButton.background,
                            boxShadow: '0 4px 16px rgba(0, 191, 255, 0.4)'
                          }}
                        >
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

        {currentStep === 'category-deep-dive' && (
          <motion.div
            key="category-deep-dive"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="max-w-3xl mx-auto w-full relative z-10"
          >
            <div className="text-center mb-8">
              <motion.div
                className={`w-16 h-16 bg-gradient-to-r ${serviceTypes.find(s => s.id === selectedService)?.gradient} rounded-2xl flex items-center justify-center mx-auto mb-6`}
                whileHover={{ scale: 1.05, rotate: 5 }}
              >
                {serviceTypes.find(s => s.id === selectedService)?.icon}
              </motion.div>
              <h2 className="text-3xl text-white mb-4">Optimize Your {serviceTypes.find(s => s.id === selectedService)?.title}</h2>
              <p className="text-white/70 text-lg">Let's customize your service to maximize your earnings potential</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* Market Analysis */}
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                className="backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl p-6"
              >
                <h3 className="text-xl text-white mb-4 flex items-center">
                  <BarChart3 className="w-6 h-6 mr-3 text-blue-400" />
                  Market Insights
                </h3>
                
                <div className="space-y-4">
                  <div className="p-4 bg-blue-500/10 rounded-xl border border-blue-400/20">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-blue-300">High Demand Areas</span>
                      <Badge className="bg-blue-500/20 text-blue-300 border-blue-400/30">+32%</Badge>
                    </div>
                    <p className="text-white/70 text-sm">Downtown, Business District, Entertainment Zone</p>
                  </div>
                  
                  <div className="p-4 bg-green-500/10 rounded-xl border border-green-400/20">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-green-300">Peak Hours</span>
                      <Badge className="bg-green-500/20 text-green-300 border-green-400/30">Premium</Badge>
                    </div>
                    <p className="text-white/70 text-sm">
                      {selectedService === 'venue' ? 'Evenings & Weekends' :
                       selectedService === 'parking' ? 'Business Hours & Events' :
                       'Events & Special Occasions'}
                    </p>
                  </div>
                  
                  <div className="p-4 bg-purple-500/10 rounded-xl border border-purple-400/20">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-purple-300">Average Earnings</span>
                      <Badge className="bg-purple-500/20 text-purple-300 border-purple-400/30">Competitive</Badge>
                    </div>
                    <p className="text-white/70 text-sm">{serviceTypes.find(s => s.id === selectedService)?.earnings} in your area</p>
                  </div>
                </div>
              </motion.div>

              {/* Category-Specific Questions */}
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl p-6"
              >
                <h3 className="text-xl text-white mb-4 flex items-center">
                  <Target className="w-6 h-6 mr-3 text-purple-400" />
                  Service Details
                </h3>
                
                {selectedService === 'venue' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-white mb-2">Event Capacity</label>
                      <Select 
                        onValueChange={(value) => updateHostData({
                          categorySpecific: {
                            ...hostData.categorySpecific,
                            venue: { ...hostData.categorySpecific.venue, capacity: value }
                          }
                        })}
                      >
                        <SelectTrigger className="bg-white/10 border-white/20 text-white">
                          <SelectValue placeholder="Select capacity range" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="small">1-25 people</SelectItem>
                          <SelectItem value="medium">25-75 people</SelectItem>
                          <SelectItem value="large">75-200 people</SelectItem>
                          <SelectItem value="xlarge">200+ people</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    
                    <div>
                      <label className="block text-white mb-2">Event Types</label>
                      <div className="grid grid-cols-2 gap-2">
                        {['Corporate', 'Weddings', 'Parties', 'Meetings', 'Workshops', 'Networking'].map((type) => (
                          <div key={type} className="flex items-center space-x-2">
                            <Checkbox id={type} className="border-white/30 data-[state=checked]:bg-purple-500" />
                            <label htmlFor={type} className="text-white/80 text-sm">{type}</label>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {selectedService === 'parking' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-white mb-2">Number of Spots</label>
                      <Input
                        type="number"
                        placeholder="e.g., 5"
                        className="bg-white/10 border-white/20 text-white placeholder-white/50"
                        onChange={(e) => updateHostData({
                          categorySpecific: {
                            ...hostData.categorySpecific,
                            parking: { ...hostData.categorySpecific.parking, spotCount: e.target.value }
                          }
                        })}
                      />
                    </div>
                    
                    <div>
                      <label className="block text-white mb-2">Vehicle Types</label>
                      <div className="grid grid-cols-2 gap-2">
                        {['Compact Cars', 'SUVs', 'Trucks', 'Motorcycles', 'Electric Vehicles', 'Oversized'].map((type) => (
                          <div key={type} className="flex items-center space-x-2">
                            <Checkbox id={type} className="border-white/30 data-[state=checked]:bg-blue-500" />
                            <label htmlFor={type} className="text-white/80 text-sm">{type}</label>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {selectedService === 'valet' && (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-white mb-2">Team Size</label>
                      <Select
                        onValueChange={(value) => updateHostData({
                          categorySpecific: {
                            ...hostData.categorySpecific,
                            valet: { ...hostData.categorySpecific.valet, teamSize: value }
                          }
                        })}
                      >
                        <SelectTrigger className="bg-white/10 border-white/20 text-white">
                          <SelectValue placeholder="Select team size" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="solo">Solo Operator</SelectItem>
                          <SelectItem value="small">2-5 Staff</SelectItem>
                          <SelectItem value="medium">6-15 Staff</SelectItem>
                          <SelectItem value="large">15+ Staff</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    
                    <div>
                      <label className="block text-white mb-2">Service Areas</label>
                      <div className="grid grid-cols-1 gap-2">
                        {['Restaurants', 'Hotels', 'Events', 'Hospitals', 'Corporate', 'Residential'].map((area) => (
                          <div key={area} className="flex items-center space-x-2">
                            <Checkbox id={area} className="border-white/30 data-[state=checked]:bg-green-500" />
                            <label htmlFor={area} className="text-white/80 text-sm">{area}</label>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </motion.div>
            </div>

            {/* Earnings Potential */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="mt-8 backdrop-blur-md bg-gradient-to-r from-green-500/10 to-emerald-500/10 border border-green-400/20 rounded-2xl p-6"
            >
              <h3 className="text-xl text-white mb-4 flex items-center">
                <TrendingUp className="w-6 h-6 mr-3 text-green-400" />
                Projected Earnings
              </h3>
              
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <div className="text-center">
                  <div className="text-2xl text-green-400 mb-1">
                    {selectedService === 'venue' ? '$2,400' :
                     selectedService === 'parking' ? '$3,750' :
                     '$4,800'}
                  </div>
                  <p className="text-white/70 text-sm">Monthly Potential</p>
                </div>
                
                <div className="text-center">
                  <div className="text-2xl text-green-400 mb-1">
                    {selectedService === 'venue' ? '8' :
                     selectedService === 'parking' ? '25' :
                     '40'}
                  </div>
                  <p className="text-white/70 text-sm">Avg Bookings/Month</p>
                </div>
                
                <div className="text-center">
                  <div className="text-2xl text-green-400 mb-1">92%</div>
                  <p className="text-white/70 text-sm">Host Satisfaction</p>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}

        {currentStep === 'address-verification' && (
          <motion.div
            key="address-verification"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="max-w-2xl mx-auto w-full relative z-10"
          >
            <div className="text-center mb-8">
              <motion.div
                className="w-16 h-16 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-2xl flex items-center justify-center mx-auto mb-6"
                whileHover={{ scale: 1.05 }}
              >
                <Navigation className="w-8 h-8 text-white" />
              </motion.div>
              <h2 className="text-3xl text-white mb-4">Verify Your Location</h2>
              <p className="text-white/70 text-lg">We use Google Places to ensure accurate location data</p>
            </div>

            <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl p-8">
              <div className="space-y-6">
                <div>
                  <label className="block text-white mb-3 flex items-center">
                    <MapPin className="w-5 h-5 mr-2" />
                    Search Address
                  </label>
                  <div className="relative">
                    <Input
                      ref={addressInputRef}
                      value={hostData.location.address}
                      onChange={(e) => {
                        updateHostData({
                          location: { ...hostData.location, address: e.target.value }
                        });
                        searchAddresses(e.target.value);
                      }}
                      placeholder="Start typing your business address..."
                      className="bg-white/10 border-white/20 text-white placeholder-white/50 h-12 pr-10"
                    />
                    {isLoadingAddress && (
                      <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      </div>
                    )}
                  </div>

                  {/* Address Suggestions */}
                  <AnimatePresence>
                    {addressSuggestions.length > 0 && (
                      <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="mt-2 backdrop-blur-md bg-white/10 border border-white/20 rounded-xl overflow-hidden"
                      >
                        {addressSuggestions.map((suggestion, index) => (
                          <motion.div
                            key={suggestion.placeId}
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: index * 0.1 }}
                            className="p-4 hover:bg-white/5 cursor-pointer border-b border-white/10 last:border-b-0"
                            onClick={() => {
                              setSelectedAddressSuggestion(suggestion);
                              updateHostData({
                                location: {
                                  ...hostData.location,
                                  address: suggestion.description,
                                  placeId: suggestion.placeId,
                                  coordinates: suggestion.coordinates,
                                  verified: suggestion.verified
                                }
                              });
                              setAddressSuggestions([]);
                            }}
                          >
                            <div className="flex items-start space-x-3">
                              <MapPin className="w-5 h-5 text-blue-400 mt-0.5 flex-shrink-0" />
                              <div className="flex-1">
                                <p className="text-white">{suggestion.mainText}</p>
                                <p className="text-white/60 text-sm">{suggestion.secondaryText}</p>
                              </div>
                              {suggestion.verified && (
                                <Verified className="w-5 h-5 text-green-400 flex-shrink-0" />
                              )}
                            </div>
                          </motion.div>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Verification Status */}
                  {selectedAddressSuggestion && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mt-4 p-4 bg-green-500/10 border border-green-400/20 rounded-xl"
                    >
                      <div className="flex items-center space-x-3">
                        <CheckCircle className="w-6 h-6 text-green-400" />
                        <div>
                          <p className="text-green-300 font-medium">Address Verified</p>
                          <p className="text-white/70 text-sm">Location confirmed via Google Places API</p>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </div>

                {/* Location Benefits */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
                  <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                    <Globe className="w-8 h-8 text-blue-400 mb-3" />
                    <h4 className="text-white mb-2">Global Recognition</h4>
                    <p className="text-white/70 text-sm">Your listing appears in international search results</p>
                  </div>
                  
                  <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                    <Shield className="w-8 h-8 text-green-400 mb-3" />
                    <h4 className="text-white mb-2">Verified Location</h4>
                    <p className="text-white/70 text-sm">Builds trust with potential customers</p>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {currentStep === 'business-details' && (
          <motion.div
            key="business-details"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="max-w-2xl mx-auto w-full relative z-10"
          >
            <div className="text-center mb-8">
              <motion.div
                className="w-16 h-16 bg-gradient-to-r from-purple-500 to-pink-500 rounded-2xl flex items-center justify-center mx-auto mb-6"
                whileHover={{ scale: 1.05 }}
              >
                <Building className="w-8 h-8 text-white" />
              </motion.div>
              <h2 className="text-3xl text-white mb-4">Business Information</h2>
              <p className="text-white/70 text-lg">Tell us about your service to help customers find you</p>
            </div>

            <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl p-8">
              <div className="space-y-6">
                <div>
                  <label className="block text-white mb-3">Business/Service Name *</label>
                  <Input
                    value={hostData.businessName}
                    onChange={(e) => updateHostData({ businessName: e.target.value })}
                    placeholder="Enter your business name"
                    className="bg-white/10 border-white/20 text-white placeholder-white/50 h-12 focus:border-purple-400"
                  />
                </div>
                
                <div>
                  <label className="block text-white mb-3">Service Description *</label>
                  <Textarea
                    value={hostData.description}
                    onChange={(e) => updateHostData({ description: e.target.value })}
                    placeholder="Describe your service, what makes it special, and what guests can expect"
                    className="bg-white/10 border-white/20 text-white placeholder-white/50 min-h-[120px] focus:border-purple-400"
                  />
                </div>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-white mb-3">Contact Phone *</label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-white/60" />
                      <Input
                        value={hostData.contact.phone}
                        onChange={(e) => updateHostData({ 
                          contact: { ...hostData.contact, phone: e.target.value }
                        })}
                        placeholder="Your phone number"
                        className="bg-white/10 border-white/20 text-white placeholder-white/50 pl-10 h-12 focus:border-purple-400"
                      />
                    </div>
                  </div>
                  
                  <div>
                    <label className="block text-white mb-3">Business Email *</label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-white/60" />
                      <Input
                        value={hostData.contact.email}
                        onChange={(e) => updateHostData({ 
                          contact: { ...hostData.contact, email: e.target.value }
                        })}
                        placeholder="Your email address"
                        className="bg-white/10 border-white/20 text-white placeholder-white/50 pl-10 h-12 focus:border-purple-400"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-white mb-3">Business Website</label>
                  <div className="relative">
                    <Globe className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-white/60" />
                    <Input
                      value={hostData.contact.website}
                      onChange={(e) => updateHostData({ 
                        contact: { ...hostData.contact, website: e.target.value }
                      })}
                      placeholder="https://www.yourbusiness.com"
                      className="bg-white/10 border-white/20 text-white placeholder-white/50 pl-10 h-12 focus:border-purple-400"
                    />
                  </div>
                </div>
                
                <div>
                  <label className="block text-white mb-3">Business Photos</label>
                  <div className="border-2 border-dashed border-white/30 rounded-xl p-8 text-center backdrop-blur-sm bg-white/5 hover:bg-white/10 transition-colors">
                    <Upload className="w-12 h-12 text-white/60 mx-auto mb-4" />
                    <p className="text-white/70 mb-4">Upload high-quality photos of your space or service</p>
                    <p className="text-white/50 text-sm mb-4">Professional photos can increase bookings by up to 40%</p>
                    <Button variant="outline" className="border-white/30 text-white hover:bg-white/20">
                      <Camera className="w-4 h-4 mr-2" />
                      Choose Photos
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {currentStep === 'pricing-calculator' && (
          <motion.div
            key="pricing-calculator"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="max-w-3xl mx-auto w-full relative z-10"
          >
            <div className="text-center mb-8">
              <motion.div
                className="w-16 h-16 bg-gradient-to-r from-green-500 to-emerald-500 rounded-2xl flex items-center justify-center mx-auto mb-6"
                whileHover={{ scale: 1.05 }}
              >
                <Calculator className="w-8 h-8 text-white" />
              </motion.div>
              <h2 className="text-3xl text-white mb-4">Smart Pricing Calculator</h2>
              <p className="text-white/70 text-lg">Set competitive rates based on market data</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* Pricing Input */}
              <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl p-6">
                <h3 className="text-xl text-white mb-6 flex items-center">
                  <DollarSign className="w-6 h-6 mr-3 text-green-400" />
                  Set Your Rate
                </h3>
                
                <div className="space-y-6">
                  <div className="grid grid-cols-3 gap-4">
                    <div className="col-span-2">
                      <label className="block text-white mb-3">Base Price</label>
                      <div className="relative">
                        <DollarSign className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-white/60" />
                        <Input
                          type="number"
                          value={hostData.pricing.basePrice}
                          onChange={(e) => {
                            updateHostData({ 
                              pricing: { ...hostData.pricing, basePrice: e.target.value }
                            });
                            if (e.target.value) {
                              setCalculatedEarnings(calculateEarnings(selectedService, { ...hostData.pricing, basePrice: e.target.value }, hostData.location));
                            }
                          }}
                          placeholder="0"
                          className="bg-white/10 border-white/20 text-white placeholder-white/50 pl-10 h-12 focus:border-green-400"
                        />
                      </div>
                    </div>
                    
                    <div>
                      <label className="block text-white mb-3">Per</label>
                      <Select 
                        value={hostData.pricing.unit}
                        onValueChange={(value) => updateHostData({ 
                          pricing: { ...hostData.pricing, unit: value }
                        })}
                      >
                        <SelectTrigger className="bg-white/10 border-white/20 text-white h-12 focus:border-green-400">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="hour">Hour</SelectItem>
                          <SelectItem value="day">Day</SelectItem>
                          <SelectItem value="event">Event</SelectItem>
                          <SelectItem value="month">Month</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Market Comparison */}
                  <div className="p-4 bg-white/5 rounded-xl border border-white/10">
                    <h4 className="text-white mb-3 flex items-center">
                      <BarChart3 className="w-5 h-5 mr-2" />
                      Market Analysis
                    </h4>
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <div className="text-sm text-white/60">Low End</div>
                        <div className="text-lg text-red-300">
                          {selectedService === 'venue' ? '$100' :
                           selectedService === 'parking' ? '$50' :
                           '$25'}
                        </div>
                      </div>
                      <div>
                        <div className="text-sm text-white/60">Average</div>
                        <div className="text-lg text-yellow-300">
                          {selectedService === 'venue' ? '$300' :
                           selectedService === 'parking' ? '$125' :
                           '$50'}
                        </div>
                      </div>
                      <div>
                        <div className="text-sm text-white/60">High End</div>
                        <div className="text-lg text-green-300">
                          {selectedService === 'venue' ? '$1000' :
                           selectedService === 'parking' ? '$200' :
                           '$75'}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Dynamic Pricing Toggle */}
                  <div className="flex items-center justify-between p-4 bg-purple-500/10 rounded-xl border border-purple-400/20">
                    <div>
                      <p className="text-white">Smart Dynamic Pricing</p>
                      <p className="text-white/60 text-sm">Automatically adjust rates based on demand</p>
                    </div>
                    <Checkbox 
                      checked={hostData.pricing.dynamicPricing}
                      onCheckedChange={(checked) => updateHostData({
                        pricing: { ...hostData.pricing, dynamicPricing: checked }
                      })}
                      className="border-white/30 data-[state=checked]:bg-purple-500"
                    />
                  </div>
                </div>
              </div>

              {/* Earnings Projection */}
              <div className="backdrop-blur-md bg-gradient-to-br from-green-500/10 to-emerald-500/10 border border-green-400/20 rounded-2xl p-6">
                <h3 className="text-xl text-white mb-6 flex items-center">
                  <TrendingUp className="w-6 h-6 mr-3 text-green-400" />
                  Earnings Projection
                </h3>
                
                {calculatedEarnings ? (
                  <div className="space-y-6">
                    <div className="text-center">
                      <div className="text-4xl text-green-400 mb-2">
                        ${calculatedEarnings.monthly.toLocaleString()}
                      </div>
                      <p className="text-white/70">Estimated Monthly Revenue</p>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="text-center p-4 bg-white/5 rounded-xl">
                        <div className="text-2xl text-green-300 mb-1">
                          ${calculatedEarnings.yearly.toLocaleString()}
                        </div>
                        <p className="text-white/60 text-sm">Yearly Potential</p>
                      </div>
                      
                      <div className="text-center p-4 bg-white/5 rounded-xl">
                        <div className="text-2xl text-green-300 mb-1">
                          {calculatedEarnings.avgBookings}
                        </div>
                        <p className="text-white/60 text-sm">Bookings/Month</p>
                      </div>
                    </div>

                    <div className={`p-4 rounded-xl border ${
                      calculatedEarnings.marketPosition === 'competitive' ? 'bg-green-500/10 border-green-400/20' :
                      calculatedEarnings.marketPosition === 'above-market' ? 'bg-yellow-500/10 border-yellow-400/20' :
                      'bg-red-500/10 border-red-400/20'
                    }`}>
                      <p className={`text-center ${
                        calculatedEarnings.marketPosition === 'competitive' ? 'text-green-300' :
                        calculatedEarnings.marketPosition === 'above-market' ? 'text-yellow-300' :
                        'text-red-300'
                      }`}>
                        {calculatedEarnings.marketPosition === 'competitive' ? '✓ Competitively Priced' :
                         calculatedEarnings.marketPosition === 'above-market' ? '⚡ Premium Pricing' :
                         '💡 Budget-Friendly'}
                      </p>
                    </div>

                    {/* Success Tips */}
                    <div className="space-y-3">
                      <h4 className="text-white flex items-center">
                        <Award className="w-5 h-5 mr-2 text-yellow-400" />
                        Success Tips
                      </h4>
                      <div className="space-y-2 text-sm">
                        <p className="text-white/70 flex items-start">
                          <span className="w-2 h-2 bg-green-400 rounded-full mt-2 mr-3 flex-shrink-0"></span>
                          Professional photos increase bookings by 40%
                        </p>
                        <p className="text-white/70 flex items-start">
                          <span className="w-2 h-2 bg-green-400 rounded-full mt-2 mr-3 flex-shrink-0"></span>
                          Quick response times boost customer satisfaction
                        </p>
                        <p className="text-white/70 flex items-start">
                          <span className="w-2 h-2 bg-green-400 rounded-full mt-2 mr-3 flex-shrink-0"></span>
                          Consistent availability builds trust
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <Calculator className="w-12 h-12 text-white/40 mx-auto mb-4" />
                    <p className="text-white/60">Enter your pricing to see earnings projection</p>
                  </div>
                )}
              </div>
            </div>

            {/* Availability */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="mt-8 backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl p-6"
            >
              <h3 className="text-white mb-4 flex items-center">
                <Calendar className="w-6 h-6 mr-3" />
                Availability Schedule
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
                  <div key={day} className="flex items-center space-x-3 p-3 rounded-lg bg-white/5 hover:bg-white/10 transition-colors">
                    <Checkbox id={day} className="border-white/30 data-[state=checked]:bg-green-500 data-[state=checked]:border-green-500" />
                    <label htmlFor={day} className="text-white text-sm cursor-pointer">{day}</label>
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}

        {currentStep === 'documents' && (
          <motion.div
            key="documents"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="max-w-2xl mx-auto w-full relative z-10"
          >
            <div className="text-center mb-8">
              <motion.div
                className="w-16 h-16 bg-gradient-to-r from-yellow-500 to-orange-500 rounded-2xl flex items-center justify-center mx-auto mb-6"
                whileHover={{ scale: 1.05 }}
              >
                <FileText className="w-8 h-8 text-white" />
              </motion.div>
              <h2 className="text-3xl text-white mb-4">Document Upload</h2>
              <p className="text-white/70 text-lg">Upload required documents for verification</p>
            </div>

            <div className="space-y-6">
              {[
                {
                  id: 'insurance',
                  title: 'Liability Insurance Certificate',
                  description: 'Required for all hosts to protect against claims',
                  required: true,
                  icon: <Shield className="w-6 h-6" />,
                  color: 'green'
                },
                {
                  id: 'id',
                  title: 'Government-Issued ID',
                  description: 'Driver\'s license, passport, or state ID',
                  required: true,
                  icon: <UserCheck className="w-6 h-6" />,
                  color: 'blue'
                },
                {
                  id: 'business',
                  title: 'Business License',
                  description: 'If applicable to your service type',
                  required: false,
                  icon: <Building className="w-6 h-6" />,
                  color: 'purple'
                },
                {
                  id: 'certification',
                  title: 'Professional Certification',
                  description: 'Industry-specific certifications (valet training, etc.)',
                  required: false,
                  icon: <Award className="w-6 h-6" />,
                  color: 'yellow'
                }
              ].map((doc) => (
                <motion.div
                  key={doc.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl p-6"
                >
                  <div className="flex items-start space-x-4">
                    <div className={`w-12 h-12 bg-${doc.color}-500/20 border border-${doc.color}-400/30 rounded-xl flex items-center justify-center flex-shrink-0`}>
                      {doc.icon}
                    </div>
                    
                    <div className="flex-1">
                      <div className="flex items-center space-x-3 mb-2">
                        <h3 className="text-white">{doc.title}</h3>
                        {doc.required && (
                          <Badge className="bg-red-500/20 text-red-300 border-red-400/30 text-xs">Required</Badge>
                        )}
                      </div>
                      <p className="text-white/70 text-sm mb-4">{doc.description}</p>
                      
                      <Button 
                        variant="outline" 
                        className="border-white/30 text-white hover:bg-white/10 w-full justify-start"
                        onClick={() => {
                          // Simulate document upload
                          updateHostData({
                            documents: { ...hostData.documents, [doc.id]: `${doc.title}_uploaded.pdf` }
                          });
                        }}
                      >
                        <Upload className="w-4 h-4 mr-2" />
                        {hostData.documents[doc.id] ? 'Replace Document' : 'Upload Document'}
                      </Button>
                      
                      {hostData.documents[doc.id] && (
                        <div className="mt-3 p-3 bg-green-500/10 border border-green-400/20 rounded-lg">
                          <div className="flex items-center space-x-2">
                            <CheckCircle className="w-5 h-5 text-green-400" />
                            <span className="text-green-300 text-sm">Document uploaded successfully</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>

            {/* Document Requirements Info */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="mt-8 backdrop-blur-md bg-blue-500/10 border border-blue-400/20 rounded-2xl p-6"
            >
              <h3 className="text-white mb-4 flex items-center">
                <AlertCircle className="w-6 h-6 mr-3 text-blue-400" />
                Document Guidelines
              </h3>
              <div className="space-y-2 text-sm text-white/70">
                <p>• Documents must be clear, high-resolution images or PDFs</p>
                <p>• All text must be legible and not expired</p>
                <p>• Personal information will be securely encrypted</p>
                <p>• Verification typically takes 24-48 hours</p>
              </div>
            </motion.div>
          </motion.div>
        )}

        {currentStep === 'verification' && (
          <motion.div
            key="verification"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="max-w-2xl mx-auto w-full relative z-10"
          >
            <div className="text-center mb-8">
              <motion.div
                className="w-16 h-16 bg-gradient-to-r from-green-500 to-emerald-500 rounded-2xl flex items-center justify-center mx-auto mb-6"
                whileHover={{ scale: 1.05 }}
              >
                <Shield className="w-8 h-8 text-white" />
              </motion.div>
              <h2 className="text-3xl text-white mb-4">Final Verification</h2>
              <p className="text-white/70 text-lg">Review and confirm your information</p>
            </div>

            <div className="space-y-6">
              <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl p-8">
                <h3 className="text-white mb-6 flex items-center text-xl">
                  <Shield className="w-6 h-6 mr-3 text-green-400" />
                  Verification Checklist
                </h3>
                
                <div className="space-y-6">
                  <div className="flex items-center justify-between p-4 rounded-xl bg-white/5 border border-white/10">
                    <div className="flex items-center space-x-4">
                      <Checkbox 
                        id="insurance"
                        checked={hostData.requirements.insurance}
                        onCheckedChange={(checked) => updateHostData({
                          requirements: { ...hostData.requirements, insurance: checked }
                        })}
                        className="border-white/30 data-[state=checked]:bg-green-500 data-[state=checked]:border-green-500"
                      />
                      <div>
                        <label htmlFor="insurance" className="text-white">Liability Insurance Confirmed</label>
                        <p className="text-white/60 text-sm">I have valid liability insurance coverage</p>
                      </div>
                    </div>
                    <Badge className="bg-green-500/20 text-green-400 border-green-400/30">Required</Badge>
                  </div>
                  
                  <div className="flex items-center justify-between p-4 rounded-xl bg-white/5 border border-white/10">
                    <div className="flex items-center space-x-4">
                      <Checkbox 
                        id="addressVerified"
                        checked={hostData.requirements.addressVerified}
                        onCheckedChange={(checked) => updateHostData({
                          requirements: { ...hostData.requirements, addressVerified: checked }
                        })}
                        className="border-white/30 data-[state=checked]:bg-blue-500 data-[state=checked]:border-blue-500"
                      />
                      <div>
                        <label htmlFor="addressVerified" className="text-white">Address Verified</label>
                        <p className="text-white/60 text-sm">Location confirmed via Google Places API</p>
                      </div>
                    </div>
                    <Badge className="bg-blue-500/20 text-blue-400 border-blue-400/30">Verified</Badge>
                  </div>
                  
                  <div className="flex items-center justify-between p-4 rounded-xl bg-white/5 border border-white/10">
                    <div className="flex items-center space-x-4">
                      <Checkbox 
                        id="terms"
                        checked={hostData.requirements.identityVerified}
                        onCheckedChange={(checked) => updateHostData({
                          requirements: { ...hostData.requirements, identityVerified: checked }
                        })}
                        className="border-white/30 data-[state=checked]:bg-purple-500 data-[state=checked]:border-purple-500"
                      />
                      <div>
                        <label htmlFor="terms" className="text-white">Terms & Conditions</label>
                        <p className="text-white/60 text-sm">I agree to Bytspot's hosting terms and policies</p>
                      </div>
                    </div>
                    <Badge className="bg-purple-500/20 text-purple-400 border-purple-400/30">Required</Badge>
                  </div>
                </div>
              </div>
              
              <div className="backdrop-blur-md bg-gradient-to-r from-green-500/10 to-emerald-500/10 border border-green-400/20 rounded-2xl p-8">
                <h3 className="text-white mb-4 flex items-center text-xl">
                  <Award className="w-6 h-6 mr-3 text-green-400" />
                  Ready to Launch
                </h3>
                <p className="text-white/70 mb-4">
                  Congratulations! You're all set to become a Bytspot host. Once approved, you'll be able to:
                </p>
                <div className="space-y-2 text-sm text-white/70">
                  <p className="flex items-center">
                    <CheckCircle className="w-4 h-4 mr-2 text-green-400" />
                    Start receiving bookings immediately
                  </p>
                  <p className="flex items-center">
                    <CheckCircle className="w-4 h-4 mr-2 text-green-400" />
                    Access host dashboard and analytics
                  </p>
                  <p className="flex items-center">
                    <CheckCircle className="w-4 h-4 mr-2 text-green-400" />
                    Get 24/7 host support
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        )}

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
                    title: "Address Verification",
                    description: "Google Places API validation and location confirmation",
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
            className="text-white hover:bg-white/10 rounded-xl border"
            style={{ 
              borderColor: BytspotColors.lightGray + '4D',
              backgroundColor: BytspotColors.midnight + 'CC'
            }}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Previous
          </Button>
          
          <Button
            onClick={handleNext}
            disabled={!canProceed()}
            className="text-white rounded-xl transition-all"
            style={{ 
              background: !canProceed() ? BytspotColors.darkGray : BytspotColors.primaryButton.background,
              opacity: !canProceed() ? 0.5 : 1,
              boxShadow: !canProceed() ? 'none' : BytspotColors.primaryButton.boxShadow,
              cursor: !canProceed() ? 'not-allowed' : 'pointer'
            }}
          >
            Continue
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      )}
    </motion.div>
  );
}