import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  Zap,
  Activity,
  Search,
  Brain,
  Shield,
  Sparkles,
  Crown,
  Infinity,
  Eye,
  Heart,
  Users,
  Clock,
  ChevronRight,
  Check
} from 'lucide-react';
import { Button } from './ui/button';

interface VibePremiumModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUpgrade: (plan: 'monthly' | 'yearly') => void;
  userVibeScore?: number;
  currentSpots?: number;
  userData?: any;
}

interface PremiumFeature {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  gradient: string;
  details: string[];
  isExclusive?: boolean;
}

export function VibePremiumModal({
  isOpen,
  onClose,
  onUpgrade,
  userVibeScore = 78,
  currentSpots = 156,
  userData
}: VibePremiumModalProps) {
  const [selectedPlan, setSelectedPlan] = useState<'monthly' | 'yearly'>('monthly');
  const [currentFeature, setCurrentFeature] = useState(0);
  const [showBenefits, setShowBenefits] = useState(false);

  const premiumFeatures: PremiumFeature[] = [
    {
      id: 'live247',
      icon: <Activity className="w-6 h-6" />,
      title: 'Live 24/7',
      description: 'Real-time venue insights and instant availability updates',
      gradient: 'from-[#00BFFF] to-[#008080]',
      details: [
        'Live crowd levels & energy scores',
        'Real-time parking availability',
        'Instant venue status updates',
        'Live wait times & reservations'
      ]
    },
    {
      id: 'smartmatching',
      icon: <Brain className="w-6 h-6" />,
      title: 'Smart Matching',
      description: 'AI-powered personalized spot recommendations',
      gradient: 'from-[#FF00FF] to-[#FF4500]',
      details: [
        'Advanced preference learning',
        'Mood-based recommendations',
        'Context-aware suggestions',
        'Predictive discovery algorithm'
      ]
    },
    {
      id: 'instantdiscovery',
      icon: <Search className="w-6 h-6" />,
      title: 'Instant Discovery',
      description: 'Skip the search with instant spot finding',
      gradient: 'from-[#008080] to-[#00BFFF]',
      details: [
        'Zero-wait spot finding',
        'Priority in search results',
        'Advanced filter options',
        'Unlimited discovery radius'
      ]
    },
    {
      id: 'vibelearning',
      icon: <Sparkles className="w-6 h-6" />,
      title: 'Vibe Learning',
      description: 'Continuously improving recommendations',
      gradient: 'from-[#FF4500] to-[#FF00FF]',
      details: [
        'Adaptive taste profiling',
        'Social preference insights',
        'Group compatibility matching',
        'Seasonal preference tracking'
      ]
    },
    {
      id: 'exclusivevenues',
      icon: <Crown className="w-6 h-6" />,
      title: 'Exclusive Venues',
      description: 'Access to premium and member-only locations',
      gradient: 'from-[#FFD700] to-[#FFA500]',
      details: [
        'VIP venue access',
        'Member-only events',
        'Private parking spots',
        'Exclusive dining reservations'
      ],
      isExclusive: true
    }
  ];

  const currentFeatureData = premiumFeatures[currentFeature];

  useEffect(() => {
    if (!isOpen) return;

    const interval = setInterval(() => {
      setCurrentFeature((prev) => (prev + 1) % premiumFeatures.length);
    }, 4000);

    // Show benefits after a short delay
    const benefitsTimeout = setTimeout(() => {
      setShowBenefits(true);
    }, 1500);

    return () => {
      clearInterval(interval);
      clearTimeout(benefitsTimeout);
    };
  }, [isOpen]);

  const handleUpgrade = () => {
    onUpgrade(selectedPlan);
  };

  const getDiscountPercentage = () => {
    return selectedPlan === 'yearly' ? 20 : 0;
  };

  const getPrice = () => {
    const monthlyPrice = 4.99;
    const yearlyPrice = monthlyPrice * 12 * 0.8; // 20% discount
    return selectedPlan === 'yearly' ? yearlyPrice : monthlyPrice;
  };

  const getPriceDisplay = () => {
    if (selectedPlan === 'yearly') {
      return {
        price: '$3.99',
        period: '/month',
        billing: 'Billed annually ($47.88/year)',
        savings: 'Save $11.88/year'
      };
    }
    return {
      price: '$4.99',
      period: '/month',
      billing: 'Billed monthly',
      savings: null
    };
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
          />
          
          {/* Modal */}
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 safe-area-all">
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ 
                type: "spring", 
                stiffness: 400, 
                damping: 25 
              }}
              className="relative w-full max-w-lg max-h-[90vh] overflow-hidden rounded-3xl"
              style={{
                background: 'linear-gradient(135deg, rgba(18, 18, 18, 0.95) 0%, rgba(0, 191, 255, 0.05) 30%, rgba(255, 0, 255, 0.05) 70%, rgba(0, 128, 128, 0.03) 100%)',
                backdropFilter: 'blur(24px) saturate(180%)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4), 0 8px 16px rgba(0, 191, 255, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1)'
              }}
            >
              {/* Animated Background Elements */}
              <div className="absolute inset-0 overflow-hidden pointer-events-none">
                {/* Floating orbs */}
                <motion.div
                  className="absolute top-1/4 left-1/4 w-32 h-32 rounded-full opacity-20"
                  style={{
                    background: 'radial-gradient(circle, rgba(0, 191, 255, 0.3), transparent 70%)'
                  }}
                  animate={{
                    x: [0, 30, -10, 0],
                    y: [0, -20, 15, 0],
                    scale: [1, 1.2, 0.8, 1]
                  }}
                  transition={{
                    duration: 8,
                    repeat: Infinity,
                    ease: "easeInOut"
                  }}
                />
                
                <motion.div
                  className="absolute bottom-1/3 right-1/4 w-24 h-24 rounded-full opacity-15"
                  style={{
                    background: 'radial-gradient(circle, rgba(255, 0, 255, 0.4), transparent 70%)'
                  }}
                  animate={{
                    x: [0, -25, 20, 0],
                    y: [0, 25, -15, 0],
                    scale: [0.8, 1.3, 1, 0.8]
                  }}
                  transition={{
                    duration: 10,
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: 2
                  }}
                />

                {/* Sparkle particles */}
                {[...Array(6)].map((_, i) => (
                  <motion.div
                    key={i}
                    className="absolute w-1 h-1 bg-white/40 rounded-full"
                    style={{
                      left: `${20 + i * 15}%`,
                      top: `${30 + i * 10}%`,
                    }}
                    animate={{
                      opacity: [0, 1, 0],
                      scale: [0, 1.5, 0],
                      rotate: [0, 180, 360]
                    }}
                    transition={{
                      duration: 3,
                      repeat: Infinity,
                      delay: i * 0.5,
                      ease: "easeInOut"
                    }}
                  />
                ))}
              </div>

              {/* Content */}
              <div className="relative z-10">
                {/* Header */}
                <div className="relative p-6 pb-4">
                  {/* Close Button */}
                  <motion.button
                    onClick={onClose}
                    className="absolute top-6 right-6 w-8 h-8 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 flex items-center justify-center hover:bg-white/20 transition-all duration-300"
                    whileHover={{ scale: 1.1, rotate: 90 }}
                    whileTap={{ scale: 0.9 }}
                  >
                    <X className="w-4 h-4 text-white/70" />
                  </motion.button>

                  {/* Premium Badge */}
                  <motion.div
                    className="inline-flex items-center space-x-2 bg-gradient-to-r from-[#FFD700] to-[#FFA500] rounded-full px-4 py-2 mb-4"
                    initial={{ scale: 0, rotate: -10 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ delay: 0.2, type: "spring", stiffness: 400 }}
                  >
                    <Crown className="w-4 h-4 text-black" />
                    <span className="text-black font-semibold text-sm">VIBE PREMIUM</span>
                  </motion.div>

                  {/* Title */}
                  <motion.h2
                    className="text-3xl font-bold text-white mb-2 leading-tight"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 }}
                  >
                    Unlock AI-powered
                    <br />
                    <span className="text-gradient bg-gradient-to-r from-[#00BFFF] via-[#FF00FF] to-[#FF4500] bg-clip-text text-transparent">
                      Discovery
                    </span>
                  </motion.h2>

                  {/* User Stats */}
                  <motion.div
                    className="flex items-center space-x-4 mb-6"
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.4 }}
                  >
                    <div className="flex items-center space-x-2 bg-white/10 backdrop-blur-sm rounded-lg px-3 py-2 border border-white/20">
                      <Activity className="w-4 h-4 text-[#00BFFF]" />
                      <span className="text-white text-sm">
                        <span className="font-semibold">{userVibeScore}</span> Vibe Score
                      </span>
                    </div>
                    <div className="flex items-center space-x-2 bg-white/10 backdrop-blur-sm rounded-lg px-3 py-2 border border-white/20">
                      <Eye className="w-4 h-4 text-[#FF00FF]" />
                      <span className="text-white text-sm">
                        <span className="font-semibold">{currentSpots}</span> Spots Viewed
                      </span>
                    </div>
                  </motion.div>
                </div>

                {/* Feature Showcase */}
                <div className="px-6 mb-6">
                  <motion.div
                    key={currentFeature}
                    className="relative p-5 rounded-2xl border border-white/20 overflow-hidden"
                    style={{
                      background: `linear-gradient(135deg, ${currentFeatureData.gradient.split(' ')[1]} 0%, ${currentFeatureData.gradient.split(' ')[3]} 100%)`,
                      opacity: 0.9
                    }}
                    initial={{ opacity: 0, scale: 0.95, rotateY: -10 }}
                    animate={{ opacity: 0.9, scale: 1, rotateY: 0 }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                  >
                    {/* Background glow */}
                    <div
                      className="absolute inset-0 opacity-20"
                      style={{
                        background: `radial-gradient(circle at center, ${currentFeatureData.gradient.split(' ')[1]}, transparent 70%)`
                      }}
                    />

                    <div className="relative z-10">
                      <div className="flex items-start space-x-4 mb-4">
                        <motion.div
                          className="w-12 h-12 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center"
                          animate={{ rotate: [0, 5, -5, 0] }}
                          transition={{ duration: 2, repeat: Infinity }}
                        >
                          <div className="text-white">
                            {currentFeatureData.icon}
                          </div>
                        </motion.div>
                        <div className="flex-1">
                          <h3 className="text-white font-semibold text-lg mb-1">
                            {currentFeatureData.title}
                          </h3>
                          <p className="text-white/90 text-sm">
                            {currentFeatureData.description}
                          </p>
                        </div>
                        {currentFeatureData.isExclusive && (
                          <motion.div
                            className="bg-[#FFD700]/20 rounded-full px-2 py-1 border border-[#FFD700]/30"
                            animate={{ scale: [1, 1.05, 1] }}
                            transition={{ duration: 2, repeat: Infinity }}
                          >
                            <Sparkles className="w-3 h-3 text-[#FFD700]" />
                          </motion.div>
                        )}
                      </div>

                      {/* Feature details */}
                      <AnimatePresence>
                        {showBenefits && (
                          <motion.div
                            className="space-y-2"
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            transition={{ delay: 0.2 }}
                          >
                            {currentFeatureData.details.map((detail, index) => (
                              <motion.div
                                key={index}
                                className="flex items-center space-x-2 text-white/80 text-sm"
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: index * 0.1 }}
                              >
                                <Check className="w-3 h-3 text-white flex-shrink-0" />
                                <span>{detail}</span>
                              </motion.div>
                            ))}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </motion.div>

                  {/* Feature indicator dots */}
                  <div className="flex justify-center space-x-2 mt-4">
                    {premiumFeatures.map((_, index) => (
                      <motion.div
                        key={index}
                        className={`w-2 h-2 rounded-full transition-all duration-300 ${
                          index === currentFeature ? 'bg-white' : 'bg-white/30'
                        }`}
                        animate={{
                          scale: index === currentFeature ? 1.2 : 1,
                          opacity: index === currentFeature ? 1 : 0.5
                        }}
                      />
                    ))}
                  </div>
                </div>

                {/* Pricing Plans */}
                <div className="px-6 mb-6">
                  <div className="grid grid-cols-2 gap-3">
                    {/* Monthly Plan */}
                    <motion.button
                      onClick={() => setSelectedPlan('monthly')}
                      className={`relative p-4 rounded-xl border-2 transition-all duration-300 ${
                        selectedPlan === 'monthly'
                          ? 'border-[#00BFFF] bg-[#00BFFF]/10'
                          : 'border-white/20 bg-white/5'
                      }`}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      <div className="text-left">
                        <div className="text-white font-semibold mb-1">Monthly</div>
                        <div className="text-white text-xl font-bold">$4.99</div>
                        <div className="text-white/60 text-sm">per month</div>
                      </div>
                      {selectedPlan === 'monthly' && (
                        <motion.div
                          className="absolute top-2 right-2 w-5 h-5 rounded-full bg-[#00BFFF] flex items-center justify-center"
                          initial={{ scale: 0, rotate: -90 }}
                          animate={{ scale: 1, rotate: 0 }}
                          transition={{ type: "spring", stiffness: 400 }}
                        >
                          <Check className="w-3 h-3 text-white" />
                        </motion.div>
                      )}
                    </motion.button>

                    {/* Yearly Plan */}
                    <motion.button
                      onClick={() => setSelectedPlan('yearly')}
                      className={`relative p-4 rounded-xl border-2 transition-all duration-300 ${
                        selectedPlan === 'yearly'
                          ? 'border-[#FF00FF] bg-[#FF00FF]/10'
                          : 'border-white/20 bg-white/5'
                      }`}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      {/* Best Value Badge */}
                      <motion.div
                        className="absolute -top-2 -right-2 bg-gradient-to-r from-[#FF00FF] to-[#FF4500] rounded-full px-2 py-1"
                        animate={{ rotate: [0, 2, -2, 0] }}
                        transition={{ duration: 2, repeat: Infinity }}
                      >
                        <span className="text-white text-xs font-semibold">SAVE 20%</span>
                      </motion.div>

                      <div className="text-left">
                        <div className="text-white font-semibold mb-1">Yearly</div>
                        <div className="flex items-baseline space-x-1">
                          <span className="text-white text-xl font-bold">$3.99</span>
                          <span className="text-white/60 text-sm line-through">$4.99</span>
                        </div>
                        <div className="text-white/60 text-sm">per month</div>
                      </div>
                      {selectedPlan === 'yearly' && (
                        <motion.div
                          className="absolute top-2 right-8 w-5 h-5 rounded-full bg-[#FF00FF] flex items-center justify-center"
                          initial={{ scale: 0, rotate: -90 }}
                          animate={{ scale: 1, rotate: 0 }}
                          transition={{ type: "spring", stiffness: 400 }}
                        >
                          <Check className="w-3 h-3 text-white" />
                        </motion.div>
                      )}
                    </motion.button>
                  </div>

                  {/* Pricing Details */}
                  <motion.div
                    className="mt-4 text-center"
                    animate={{ opacity: [0.7, 1, 0.7] }}
                    transition={{ duration: 2, repeat: Infinity }}
                  >
                    {selectedPlan === 'yearly' && (
                      <div className="text-[#FF00FF] text-sm font-medium mb-1">
                        💰 Save $11.88/year
                      </div>
                    )}
                    <div className="text-white/60 text-xs">
                      {getPriceDisplay().billing}
                    </div>
                  </motion.div>
                </div>

                {/* CTA Button */}
                <div className="px-6 pb-6">
                  <motion.div
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    <Button
                      onClick={handleUpgrade}
                      className="w-full h-14 bg-gradient-to-r from-[#00BFFF] via-[#FF00FF] to-[#FF4500] hover:opacity-90 text-white font-semibold text-lg rounded-xl shadow-lg relative overflow-hidden"
                    >
                      {/* Button glow effect */}
                      <motion.div
                        className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent"
                        animate={{
                          x: [-100, 300]
                        }}
                        transition={{
                          duration: 2,
                          repeat: Infinity,
                          repeatDelay: 1,
                          ease: "easeInOut"
                        }}
                      />
                      <div className="relative z-10 flex items-center justify-center space-x-2">
                        <Zap className="w-5 h-5" />
                        <span>Start Premium Discovery</span>
                        <span className="text-white/80">{getPriceDisplay().price}{getPriceDisplay().period}</span>
                      </div>
                    </Button>
                  </motion.div>

                  {/* Footer text */}
                  <motion.div
                    className="text-center mt-4 text-white/60 text-xs leading-relaxed"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.8 }}
                  >
                    Cancel anytime • No commitment • Premium features activate instantly
                  </motion.div>
                </div>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}