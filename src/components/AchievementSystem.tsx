import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Award, Star, Trophy, Crown, Gift, Sparkles, Heart, Zap, Users, MapPin } from 'lucide-react';

interface Achievement {
  id: string;
  title: string;
  description: string;
  type: 'milestone' | 'discovery' | 'social' | 'streak' | 'special';
  icon: React.ReactNode;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  timestamp: Date;
  progress?: number;
  maxProgress?: number;
}

interface RewardParticle {
  id: string;
  x: number;
  y: number;
  velocity: { x: number; y: number };
  color: string;
  size: number;
  life: number;
  maxLife: number;
  type: 'star' | 'sparkle' | 'coin' | 'heart';
}

interface AchievementSystemProps {
  onAchievementUnlocked?: (achievement: Achievement) => void;
  themeColors?: {
    primary: string;
    secondary: string;
    accent: string;
    particles: string;
  };
}

export function AchievementSystem({ onAchievementUnlocked, themeColors }: AchievementSystemProps) {
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [activeAchievement, setActiveAchievement] = useState<Achievement | null>(null);
  const [rewardParticles, setRewardParticles] = useState<RewardParticle[]>([]);

  // Predefined achievements
  const availableAchievements: Omit<Achievement, 'timestamp'>[] = [
    {
      id: 'first_match',
      title: 'First Match!',
      description: 'Found your first perfect parking spot',
      type: 'milestone',
      icon: <Heart className="w-6 h-6" />,
      rarity: 'common'
    },
    {
      id: 'early_bird',
      title: 'Early Bird',
      description: 'Booked a spot before 7 AM',
      type: 'special',
      icon: <Award className="w-6 h-6" />,
      rarity: 'rare'
    },
    {
      id: 'night_owl',
      title: 'Night Owl',
      description: 'Found venues after midnight',
      type: 'discovery',
      icon: <Star className="w-6 h-6" />,
      rarity: 'rare'
    },
    {
      id: 'streak_7',
      title: 'Week Warrior',
      description: 'Used Bytspot for 7 days straight',
      type: 'streak',
      icon: <Crown className="w-6 h-6" />,
      rarity: 'epic'
    },
    {
      id: 'social_butterfly',
      title: 'Social Butterfly',
      description: 'Shared 10 venue recommendations',
      type: 'social',
      icon: <Users className="w-6 h-6" />,
      rarity: 'epic'
    },
    {
      id: 'explorer',
      title: 'City Explorer',
      description: 'Discovered 25 unique venues',
      type: 'discovery',
      icon: <MapPin className="w-6 h-6" />,
      rarity: 'epic'
    },
    {
      id: 'speed_demon',
      title: 'Speed Demon',
      description: 'Booked valet service in under 30 seconds',
      type: 'special',
      icon: <Zap className="w-6 h-6" />,
      rarity: 'legendary'
    },
    {
      id: 'master_discoverer',
      title: 'Discovery Master',
      description: 'Explored all venue types in your city',
      type: 'discovery',
      icon: <Trophy className="w-6 h-6" />,
      rarity: 'legendary'
    },
    {
      id: 'weather_master',
      title: 'Weather Warrior',
      description: 'Used the app in 5 different weather conditions',
      type: 'special',
      icon: <Sparkles className="w-6 h-6" />,
      rarity: 'legendary'
    },
    {
      id: 'platinum_member',
      title: 'Platinum Member',
      description: 'Achieved VIP status with 100+ bookings',
      type: 'milestone',
      icon: <Crown className="w-6 h-6" />,
      rarity: 'legendary'
    }
  ];

  // Create particle explosion
  const createParticleExplosion = (x: number, y: number, rarity: Achievement['rarity']) => {
    const particleCount = {
      common: 8,
      rare: 12,
      epic: 16,
      legendary: 24
    }[rarity];

    const colors = {
      common: ['#22d3ee', '#34d399', '#60a5fa'],
      rare: ['#8b5cf6', '#ec4899', '#f59e0b'],
      epic: ['#f59e0b', '#ef4444', '#ec4899'],
      legendary: ['#fbbf24', '#f59e0b', '#ec4899', '#8b5cf6', '#22d3ee']
    }[rarity];

    const newParticles: RewardParticle[] = [];

    for (let i = 0; i < particleCount; i++) {
      const angle = (Math.PI * 2 * i) / particleCount + (Math.random() - 0.5) * 0.5;
      const velocity = 3 + Math.random() * 4;
      const color = colors[Math.floor(Math.random() * colors.length)];

      newParticles.push({
        id: `${Date.now()}-${i}`,
        x: x + (Math.random() - 0.5) * 50,
        y: y + (Math.random() - 0.5) * 50,
        velocity: {
          x: Math.cos(angle) * velocity,
          y: Math.sin(angle) * velocity
        },
        color,
        size: rarity === 'legendary' ? 8 : rarity === 'epic' ? 6 : 4,
        life: 80,
        maxLife: 80,
        type: ['star', 'sparkle', 'coin', 'heart'][Math.floor(Math.random() * 4)] as RewardParticle['type']
      });
    }

    setRewardParticles(prev => [...prev, ...newParticles]);
  };

  // Trigger achievement
  const unlockAchievement = (achievementId: string, customProgress?: number) => {
    const achievementTemplate = availableAchievements.find(a => a.id === achievementId);
    if (!achievementTemplate || achievements.find(a => a.id === achievementId)) return;

    const newAchievement: Achievement = {
      ...achievementTemplate,
      timestamp: new Date(),
      progress: customProgress,
      maxProgress: customProgress ? 100 : undefined
    };

    setAchievements(prev => [newAchievement, ...prev]);
    setActiveAchievement(newAchievement);

    // Create particle explosion at center of screen
    createParticleExplosion(window.innerWidth / 2, window.innerHeight / 2, newAchievement.rarity);

    // Call callback if provided
    onAchievementUnlocked?.(newAchievement);

    // Auto-hide after 5 seconds
    setTimeout(() => {
      setActiveAchievement(null);
    }, 5000);
  };

  // Simulate random achievements for demo
  useEffect(() => {
    const interval = setInterval(() => {
      const unlockedIds = achievements.map(a => a.id);
      const availableToUnlock = availableAchievements.filter(a => !unlockedIds.includes(a.id));
      
      if (availableToUnlock.length > 0 && Math.random() < 0.3) {
        const randomAchievement = availableToUnlock[Math.floor(Math.random() * availableToUnlock.length)];
        unlockAchievement(randomAchievement.id);
      }
    }, 20000 + Math.random() * 40000); // Random interval between 20-60 seconds

    return () => clearInterval(interval);
  }, [achievements]);

  // Update particles
  useEffect(() => {
    const interval = setInterval(() => {
      setRewardParticles(prev => {
        return prev.map(particle => {
          const newLife = particle.life - 1;
          if (newLife <= 0) return null;

          return {
            ...particle,
            x: particle.x + particle.velocity.x,
            y: particle.y + particle.velocity.y,
            velocity: {
              x: particle.velocity.x * 0.99,
              y: particle.velocity.y * 0.99 + 0.15 // gravity
            },
            life: newLife
          };
        }).filter(Boolean) as RewardParticle[];
      });
    }, 16);

    return () => clearInterval(interval);
  }, []);

  const getRarityConfig = (rarity: Achievement['rarity']) => {
    const configs = {
      common: {
        bgClass: 'achievement-common',
        iconBg: 'bg-gradient-to-r from-green-400 to-emerald-500',
        glowClass: 'glow-emerald',
        textColor: 'text-green-300',
        borderColor: 'border-green-400/30'
      },
      rare: {
        bgClass: 'achievement-rare',
        iconBg: 'bg-gradient-to-r from-blue-500 to-cyan-500',
        glowClass: 'glow-cyan',
        textColor: 'text-blue-300',
        borderColor: 'border-blue-400/30'
      },
      epic: {
        bgClass: 'achievement-epic',
        iconBg: 'bg-gradient-to-r from-purple-500 to-pink-500',
        glowClass: 'glow-purple',
        textColor: 'text-purple-300',
        borderColor: 'border-purple-400/30'
      },
      legendary: {
        bgClass: 'achievement-legendary',
        iconBg: 'bg-gradient-to-r from-yellow-400 to-orange-500',
        glowClass: 'glow-orange',
        textColor: 'text-yellow-300',
        borderColor: 'border-yellow-400/30'
      }
    };
    return configs[rarity];
  };

  // Expose method to trigger achievements from parent components
  React.useImperativeHandle(React.useRef(), () => ({
    unlockAchievement
  }));

  return (
    <>
      {/* Active Achievement Display */}
      <AnimatePresence>
        {activeAchievement && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 100 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: -100 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
            className="fixed bottom-8 left-1/2 transform -translate-x-1/2 z-50 pointer-events-none"
          >
            <div className={`glass-card rounded-3xl p-8 max-w-sm ${getRarityConfig(activeAchievement.rarity).bgClass}`}>
              <motion.div
                animate={{ 
                  scale: [1, 1.05, 1],
                  rotate: [0, 2, -2, 0]
                }}
                transition={{ duration: 3, repeat: Infinity }}
                className="text-center"
              >
                {/* Achievement Icon */}
                <motion.div
                  className={`inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-6 ${
                    getRarityConfig(activeAchievement.rarity).iconBg
                  } ${getRarityConfig(activeAchievement.rarity).glowClass}`}
                  animate={{ 
                    scale: [1, 1.1, 1],
                    rotate: activeAchievement.rarity === 'legendary' ? [0, 360] : [0, 10, -10, 0]
                  }}
                  transition={{ 
                    scale: { duration: 2, repeat: Infinity },
                    rotate: { duration: activeAchievement.rarity === 'legendary' ? 4 : 3, repeat: Infinity, ease: "linear" }
                  }}
                >
                  <motion.div
                    animate={{ 
                      scale: [1, 1.2, 1],
                      opacity: [1, 0.8, 1]
                    }}
                    transition={{ duration: 1.5, repeat: Infinity }}
                  >
                    {activeAchievement.icon}
                  </motion.div>
                </motion.div>
                
                {/* Achievement Text */}
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                >
                  <motion.h3 
                    className="text-white text-2xl font-bold mb-3 text-gradient-dynamic"
                    animate={{ opacity: [0.9, 1, 0.9] }}
                    transition={{ duration: 2, repeat: Infinity }}
                  >
                    Achievement Unlocked!
                  </motion.h3>
                  
                  <h4 className="text-white/90 text-lg font-semibold mb-2">
                    {activeAchievement.title}
                  </h4>
                  
                  <p className="text-white/70 text-sm mb-4">
                    {activeAchievement.description}
                  </p>
                  
                  {/* Progress bar if applicable */}
                  {activeAchievement.progress !== undefined && activeAchievement.maxProgress && (
                    <div className="w-full bg-white/20 rounded-full h-2 mb-4">
                      <motion.div
                        className={`h-2 rounded-full bg-gradient-to-r ${themeColors?.primary || 'from-purple-400 to-pink-400'}`}
                        initial={{ width: 0 }}
                        animate={{ width: `${(activeAchievement.progress / activeAchievement.maxProgress) * 100}%` }}
                        transition={{ duration: 1.5, ease: "easeOut" }}
                      />
                    </div>
                  )}
                  
                  {/* Rarity Badge */}
                  <motion.div 
                    className={`inline-block px-4 py-2 rounded-full text-xs font-bold ${
                      getRarityConfig(activeAchievement.rarity).textColor
                    } ${getRarityConfig(activeAchievement.rarity).borderColor} border`}
                    style={{
                      backgroundColor: `${getRarityConfig(activeAchievement.rarity).iconBg.includes('green') ? '#22c55e' : 
                                       getRarityConfig(activeAchievement.rarity).iconBg.includes('blue') ? '#3b82f6' : 
                                       getRarityConfig(activeAchievement.rarity).iconBg.includes('purple') ? '#a855f7' : 
                                       '#f59e0b'}20`
                    }}
                    animate={{ 
                      scale: [1, 1.05, 1],
                      opacity: [0.8, 1, 0.8] 
                    }}
                    transition={{ duration: 2, repeat: Infinity }}
                  >
                    {activeAchievement.rarity.toUpperCase()}
                  </motion.div>
                </motion.div>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reward Particles */}
      {rewardParticles.map(particle => (
        <motion.div
          key={particle.id}
          className="fixed pointer-events-none z-40"
          style={{
            left: particle.x,
            top: particle.y,
            width: particle.size,
            height: particle.size,
          }}
          animate={{
            opacity: particle.life / particle.maxLife,
            rotate: particle.type === 'star' ? [0, 360] : [0, 180, 360],
            scale: [1, 1.3, 0.8, 1.2, 0.6]
          }}
          transition={{
            rotate: { duration: 2, repeat: Infinity, ease: "linear" },
            scale: { duration: 1.5, repeat: Infinity, ease: "easeInOut" }
          }}
        >
          <div 
            className={`w-full h-full rounded-full ${
              particle.type === 'star' ? 'reward-particle-star' : 
              particle.type === 'heart' ? 'reward-particle-heart' : ''
            }`}
            style={{ 
              backgroundColor: particle.color,
              boxShadow: `0 0 ${particle.size * 3}px ${particle.color}66`,
            }}
          />
        </motion.div>
      ))}
    </>
  );
}

// Export achievement trigger function for external use
export const useAchievementTrigger = () => {
  return {
    triggerAchievement: (id: string, progress?: number) => {
      // This would be connected to the AchievementSystem instance
      console.log(`Triggering achievement: ${id}`, progress);
    }
  };
};