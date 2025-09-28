import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Mail, Lock, User, Eye, EyeOff } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuth: (data: { email: string; name: string }) => void;
  isLoading?: boolean;
  smartSuggestion?: string;
}

export function AuthModal({ 
  isOpen, 
  onClose, 
  onAuth, 
  isLoading: externalLoading = false,
  smartSuggestion 
}: AuthModalProps) {
  const [isSignUp, setIsSignUp] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: ''
  });
  const [isLoading, setIsLoading] = useState(false);
  const isSubmitDisabled = isLoading || externalLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    
    // Simulate API call
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    onAuth({
      email: formData.email,
      name: formData.name || formData.email.split('@')[0]
    });
    
    setIsLoading(false);
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Enhanced Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/60 backdrop-blur-md"
        onClick={onClose}
      />

      {/* Enhanced Modal */}
      <motion.div
        initial={{ scale: 0.8, opacity: 0, y: 50 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.8, opacity: 0, y: 50 }}
        transition={{ type: "spring", stiffness: 400, damping: 25 }}
        className="relative w-full max-w-md"
      >
        {/* Enhanced background with multiple gradients */}
        <div className="absolute inset-0 bg-gradient-to-br from-purple-400/30 via-pink-400/25 to-orange-400/30 rounded-3xl blur-xl glow-purple" />
        <div className="absolute inset-0 bg-gradient-to-tl from-cyan-400/20 via-transparent to-emerald-400/20 rounded-3xl blur-lg" />
        
        <div className="relative glass-card rounded-3xl p-8 interactive-hover">
          {/* Close Button */}
          <motion.div
            whileHover={{ scale: 1.1, rotate: 90 }}
            whileTap={{ scale: 0.9 }}
          >
            <Button
              onClick={onClose}
              variant="ghost"
              size="sm"
              className="absolute top-4 right-4 text-white/60 hover:text-white hover:bg-white/15 rounded-xl touch-feedback"
            >
              <X className="w-5 h-5" />
            </Button>
          </motion.div>

          {/* Enhanced Header */}
          <div className="text-center mb-8">
            <motion.div
              animate={{ 
                rotate: 360,
                scale: [1, 1.1, 1]
              }}
              transition={{ 
                rotate: { duration: 8, repeat: Infinity, ease: "linear" },
                scale: { duration: 3, repeat: Infinity, ease: "easeInOut" }
              }}
              className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-r from-purple-400 via-pink-400 to-orange-400 rounded-2xl mb-4 glow-purple color-shift"
            >
              <User className="w-8 h-8 text-white" />
            </motion.div>
            <motion.h2 
              className="text-2xl text-gradient-rainbow mb-2"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
            >
              {isSignUp ? 'Create Account' : 'Welcome Back'}
            </motion.h2>
            <motion.p 
              className="text-white/80"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
            >
              {isSignUp 
                ? 'Join thousands finding their perfect matches' 
                : 'Sign in to continue your journey'
              }
            </motion.p>
          </div>

          {/* Enhanced Form */}
          <form onSubmit={handleSubmit} className="space-y-6">
            <AnimatePresence mode="wait">
              {isSignUp && (
                <motion.div
                  initial={{ height: 0, opacity: 0, scale: 0.95 }}
                  animate={{ height: 'auto', opacity: 1, scale: 1 }}
                  exit={{ height: 0, opacity: 0, scale: 0.95 }}
                  transition={{ type: "spring", stiffness: 400, damping: 25 }}
                  className="overflow-hidden"
                >
                  <div className="space-y-2">
                    <Label htmlFor="name" className="text-white/90 font-medium">Full Name</Label>
                    <div className="relative group">
                      <motion.div
                        animate={{ rotate: [0, 5, -5, 0] }}
                        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                      >
                        <User className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-white/50 group-focus-within:text-purple-400 transition-colors" />
                      </motion.div>
                      <Input
                        id="name"
                        type="text"
                        placeholder="Enter your full name"
                        value={formData.name}
                        onChange={(e) => handleInputChange('name', e.target.value)}
                        className="pl-10 glass-effect border-white/30 text-white placeholder-white/60 focus:border-purple-400 focus:glow-purple rounded-xl transition-all duration-300"
                        required={isSignUp}
                      />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="space-y-2">
              <Label htmlFor="email" className="text-white/90 font-medium">Email</Label>
              <div className="relative group">
                <motion.div
                  animate={{ scale: [1, 1.1, 1] }}
                  transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                >
                  <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-white/50 group-focus-within:text-pink-400 transition-colors" />
                </motion.div>
                <Input
                  id="email"
                  type="email"
                  placeholder="Enter your email"
                  value={formData.email}
                  onChange={(e) => handleInputChange('email', e.target.value)}
                  className="pl-10 glass-effect border-white/30 text-white placeholder-white/60 focus:border-pink-400 focus:glow-pink rounded-xl transition-all duration-300"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-white/90 font-medium">Password</Label>
              <div className="relative group">
                <motion.div
                  animate={{ rotate: [0, 10, -10, 0] }}
                  transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
                >
                  <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-white/50 group-focus-within:text-orange-400 transition-colors" />
                </motion.div>
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter your password"
                  value={formData.password}
                  onChange={(e) => handleInputChange('password', e.target.value)}
                  className="pl-10 pr-10 glass-effect border-white/30 text-white placeholder-white/60 focus:border-orange-400 focus:glow-orange rounded-xl transition-all duration-300"
                  required
                />
                <motion.div
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.9 }}
                >
                  <Button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    variant="ghost"
                    size="sm"
                    className="absolute right-2 top-1/2 transform -translate-y-1/2 text-white/50 hover:text-white/80 p-1 rounded-lg"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </Button>
                </motion.div>
              </div>
            </div>

            <motion.div
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <Button
                type="submit"
                disabled={isSubmitDisabled}
                className="w-full btn-primary py-3 rounded-xl fab interactive-hover border-0 font-semibold"
              >
                {isLoading ? (
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                    className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full"
                  />
                ) : (
                  <motion.span
                    animate={{ opacity: [0.8, 1, 0.8] }}
                    transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                  >
                    {isSignUp ? 'Create Account' : 'Sign In'}
                  </motion.span>
                )}
              </Button>
            </motion.div>
          </form>

          {/* Enhanced Toggle */}
          <div className="text-center mt-6">
            <motion.button
              onClick={() => setIsSignUp(!isSignUp)}
              className="text-white/70 hover:text-white transition-colors text-gradient hover:text-gradient-rainbow"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              {isSignUp 
                ? 'Already have an account? Sign in' 
                : "Don't have an account? Sign up"
              }
            </motion.button>
          </div>

          {/* Enhanced Social Login */}
          <div className="mt-6">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-white/30" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-3 glass-effect rounded-full text-white/70">Or continue with</span>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                <Button
                  variant="outline"
                  className="glass-effect border-white/30 text-white hover:bg-white/15 backdrop-blur-enhanced rounded-xl touch-feedback interactive-hover"
                >
                  <motion.span
                    animate={{ opacity: [0.8, 1, 0.8] }}
                    transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                  >
                    Google
                  </motion.span>
                </Button>
              </motion.div>
              <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                <Button
                  variant="outline"
                  className="glass-effect border-white/30 text-white hover:bg-white/15 backdrop-blur-enhanced rounded-xl touch-feedback interactive-hover"
                >
                  <motion.span
                    animate={{ opacity: [0.8, 1, 0.8] }}
                    transition={{ duration: 3, repeat: Infinity, ease: "easeInOut", delay: 0.5 }}
                  >
                    Apple
                  </motion.span>
                </Button>
              </motion.div>
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}