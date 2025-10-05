import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ArrowLeft, 
  Edit3, 
  Camera, 
  Crown, 
  CreditCard, 
  History, 
  Gift, 
  HelpCircle, 
  User, 
  Heart, 
  Banknote, 
  Bell, 
  Shield, 
  Award, 
  Settings,
  ChevronRight,
  Sun,
  CloudRain,
  Cloud,
  CloudSnow,
  MapPin,
  Mountain,
  Building,
  Palmtree,
  TreePine,
  Lock,
  Eye,
  EyeOff,
  Wifi,
  Bluetooth,
  Smartphone,
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  Trash2,
  Download,
  Upload,
  LogOut,
  Sparkles
} from 'lucide-react';
import { Button } from './ui/button';
import { Progress } from './ui/progress';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Switch } from './ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { ImageWithFallback } from './figma/ImageWithFallback';

interface ProfileSettingsProps {
  userData: any;
  onBack: () => void;
  onLogout: () => void;
  currentTheme?: string;
  weatherTheme?: string;
  locationTheme?: string;
  onWeatherChange?: (weather: string) => void;
  onLocationChange?: (location: string) => void;
  onTriggerAchievement?: () => void;
  onTriggerSystemNotification?: () => void;
  onTriggerRecommendation?: () => void;
}

type SettingsView = 'main' | 'personal' | 'vibe' | 'payment' | 'notifications' | 'privacy' | 'help' | 'rewards' | 'app-settings';

export function ProfileSettings({ 
  userData, 
  onBack, 
  onLogout,
  currentTheme = 'morning',
  weatherTheme = 'sunny',
  locationTheme = 'city',
  onWeatherChange = () => {},
  onLocationChange = () => {},
  onTriggerAchievement = () => {},
  onTriggerSystemNotification = () => {},
  onTriggerRecommendation = () => {}
}: ProfileSettingsProps) {
  const [currentSettingsView, setCurrentSettingsView] = useState<SettingsView>('main');
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [locationEnabled, setLocationEnabled] = useState(true);
  const [privateProfile, setPrivateProfile] = useState(false);
  
  // Privacy & Security State
  const [gpsEnabled, setGpsEnabled] = useState(true);
  const [wifiScanningEnabled, setWifiScanningEnabled] = useState(true);
  const [bluetoothEnabled, setBluetoothEnabled] = useState(true);
  const [imuSensorsEnabled, setImuSensorsEnabled] = useState(true);
  const [biometricAuth, setBiometricAuth] = useState(true);
  const [autoLock, setAutoLock] = useState(true);
  const [dataEncryption, setDataEncryption] = useState(true);
  const [anonymousAnalytics, setAnonymousAnalytics] = useState(true);
  const [locationHistory, setLocationHistory] = useState(true);
  const [crashReporting, setCrashReporting] = useState(true);
  
  // Data usage tracking (simulated)
  const dataUsage = {
    gps: { sessions: 42, accuracy: '3-5m', lastUpdate: '2 min ago' },
    wifi: { networks: 127, scanning: true, lastScan: '30s ago' },
    bluetooth: { devices: 8, scanning: false, lastScan: '5 min ago' },
    imu: { steps: 3847, motion: 'Walking', calibrated: true }
  };

  const userPoints = 2450;
  const maxPoints = 3000;
  const pointsToNextLevel = maxPoints - userPoints;
  const progressPercentage = (userPoints / maxPoints) * 100;

  const renderMainProfile = () => (
    <div className="space-y-6">
      {/* Profile Header */}
      <motion.div 
        className="flex items-center space-x-4 p-6"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <div className="relative">
          <div className="w-20 h-20 rounded-full overflow-hidden ring-4 ring-purple-400/30">
            <ImageWithFallback
              src="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face&auto=format"
              alt="Profile" 
              className="w-full h-full object-cover"
            />
          </div>
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.95 }}
            className="absolute bottom-0 right-0 w-8 h-8 bg-gradient-to-r from-purple-500 to-pink-500 rounded-full flex items-center justify-center shadow-lg"
          >
            <Camera className="w-4 h-4 text-white" />
          </motion.button>
        </div>
        
        <div className="flex-1">
          <div className="flex items-center space-x-2 mb-1">
            <h2 className="text-2xl text-white font-semibold">
              {userData.name || 'Alex Chen'}
            </h2>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <Edit3 className="w-4 h-4 text-white/60 hover:text-white transition-colors" />
            </motion.button>
          </div>
          <p className="text-white/70 mb-1">alex.chen@email.com</p>
          <p className="text-white/50 text-sm">Member since January 2024</p>
        </div>
      </motion.div>

      {/* Bytspot Points */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        <Card className="glass-effect border-white/20 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-3">
              <div className="w-12 h-12 bg-gradient-to-r from-yellow-400 to-orange-500 rounded-2xl flex items-center justify-center">
                <Crown className="w-6 h-6 text-white" />
              </div>
              <div>
                <h3 className="text-white font-semibold">Bytspot Points</h3>
                <p className="text-white/60 text-sm">Gold Member</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-3xl font-bold text-white">{userPoints.toLocaleString()}</p>
              <p className="text-white/60 text-sm">points available</p>
            </div>
          </div>
          
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-white/70">Progress to Platinum</span>
              <span className="text-white/70">{pointsToNextLevel} points to go</span>
            </div>
            <Progress value={progressPercentage} className="h-2" />
          </div>
        </Card>
      </motion.div>

      {/* Quick Actions */}
      <motion.div 
        className="grid grid-cols-4 gap-4"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        {[
          { icon: CreditCard, label: 'Payment', id: 'payment' },
          { icon: History, label: 'History', id: 'history' },
          { icon: Gift, label: 'Rewards', id: 'rewards' },
          { icon: HelpCircle, label: 'Help', id: 'help' }
        ].map((action, index) => (
          <motion.button
            key={action.id}
            onClick={() => setCurrentSettingsView(action.id as SettingsView)}
            className="glass-effect p-4 rounded-2xl flex flex-col items-center space-y-2 text-white hover:bg-white/10 transition-colors"
            whileHover={{ scale: 1.02, y: -2 }}
            whileTap={{ scale: 0.98 }}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 + index * 0.1 }}
          >
            <action.icon className="w-6 h-6" />
            <span className="text-xs font-medium">{action.label}</span>
          </motion.button>
        ))}
      </motion.div>

      {/* Account Section */}
      <motion.div 
        className="space-y-4"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
      >
        <h3 className="text-lg font-semibold text-white mb-3">Account</h3>
        
        {[
          { icon: User, label: 'Personal Information', id: 'personal' },
          { icon: Heart, label: 'Vibe Preferences', id: 'vibe', badge: 'Premium', badgeColor: 'from-purple-500 to-pink-500' },
          { icon: CreditCard, label: 'Payment Methods', id: 'payment' },
          { icon: Bell, label: 'Notifications', id: 'notifications' },
          { icon: Shield, label: 'Privacy & Security', id: 'privacy' }
        ].map((item, index) => (
          <motion.button
            key={item.id}
            onClick={() => setCurrentSettingsView(item.id as SettingsView)}
            className="w-full glass-effect p-4 rounded-2xl flex items-center justify-between text-white hover:bg-white/10 transition-colors"
            whileHover={{ scale: 1.01, x: 4 }}
            whileTap={{ scale: 0.99 }}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.6 + index * 0.1 }}
          >
            <div className="flex items-center space-x-3">
              <item.icon className="w-5 h-5 text-white/70" />
              <span className="font-medium">{item.label}</span>
              {item.badge && (
                <Badge className={`bg-gradient-to-r ${item.badgeColor} text-white border-0 text-xs`}>
                  {item.badge}
                </Badge>
              )}
            </div>
            <ChevronRight className="w-4 h-4 text-white/50" />
          </motion.button>
        ))}
      </motion.div>

      {/* Support Section */}
      <motion.div 
        className="space-y-4"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.8 }}
      >
        <h3 className="text-lg font-semibold text-white mb-3">Support</h3>
        
        {[
          { icon: HelpCircle, label: 'Help Center', id: 'help' },
          { icon: Award, label: 'Rewards Program', id: 'rewards' },
          { icon: Settings, label: 'App Settings', id: 'app-settings' }
        ].map((item, index) => (
          <motion.button
            key={item.id}
            onClick={() => setCurrentSettingsView(item.id as SettingsView)}
            className="w-full glass-effect p-4 rounded-2xl flex items-center justify-between text-white hover:bg-white/10 transition-colors"
            whileHover={{ scale: 1.01, x: 4 }}
            whileTap={{ scale: 0.99 }}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.9 + index * 0.1 }}
          >
            <div className="flex items-center space-x-3">
              <item.icon className="w-5 h-5 text-white/70" />
              <span className="font-medium">{item.label}</span>
            </div>
            <ChevronRight className="w-4 h-4 text-white/50" />
          </motion.button>
        ))}
      </motion.div>

      {/* Logout Button */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.0 }}
      >
        <Button
          onClick={onLogout}
          variant="outline"
          className="w-full bg-transparent border-red-400/30 text-red-400 hover:bg-red-400/10 hover:text-red-300 transition-colors"
        >
          <LogOut className="w-4 h-4 mr-2" />
          Sign Out
        </Button>
      </motion.div>
    </div>
  );

  const renderCurrentView = () => {
    switch (currentSettingsView) {
      case 'main':
        return renderMainProfile();
      case 'notifications':
        return (
          <div className="space-y-6">
            <h3 className="text-lg font-semibold text-white">Notifications & Alerts</h3>
            
            {/* Active Notifications Summary */}
            <Card className="glass-effect border-white/20 p-6">
              <h4 className="text-white font-medium mb-4 flex items-center">
                <Bell className="w-5 h-5 mr-2 text-[#00BFFF]" />
                Notification Center
              </h4>
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="flex items-center space-x-3 p-3 rounded-xl bg-green-500/10 border border-green-500/20">
                  <CheckCircle className="w-5 h-5 text-green-400" />
                  <div>
                    <p className="text-white text-sm font-medium">3 New Spots</p>
                    <p className="text-white/60 text-xs">Nearby</p>
                  </div>
                </div>
                <div className="flex items-center space-x-3 p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
                  <AlertTriangle className="w-5 h-5 text-yellow-400" />
                  <div>
                    <p className="text-white text-sm font-medium">1 Alert</p>
                    <p className="text-white/60 text-xs">Parking</p>
                  </div>
                </div>
                <div className="flex items-center space-x-3 p-3 rounded-xl bg-purple-500/10 border border-purple-500/20">
                  <Gift className="w-5 h-5 text-purple-400" />
                  <div>
                    <p className="text-white text-sm font-medium">2 Rewards</p>
                    <p className="text-white/60 text-xs">Available</p>
                  </div>
                </div>
                <div className="flex items-center space-x-3 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20">
                  <RefreshCw className="w-5 h-5 text-blue-400" />
                  <div>
                    <p className="text-white text-sm font-medium">Live</p>
                    <p className="text-white/60 text-xs">Updates</p>
                  </div>
                </div>
              </div>
            </Card>

            {/* Notification Settings */}
            <Card className="glass-effect border-white/20 p-6">
              <h4 className="text-white font-medium mb-4">Notification Preferences</h4>
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <Smartphone className="w-5 h-5 text-[#00BFFF]" />
                    <div>
                      <p className="text-white font-medium">Push Notifications</p>
                      <p className="text-white/60 text-sm">Receive notifications about new spots and matches</p>
                    </div>
                  </div>
                  <Switch checked={notificationsEnabled} onCheckedChange={setNotificationsEnabled} />
                </div>
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <MapPin className="w-5 h-5 text-[#FF00FF]" />
                    <div>
                      <p className="text-white font-medium">Location Alerts</p>
                      <p className="text-white/60 text-sm">Get notified about nearby trending spots</p>
                    </div>
                  </div>
                  <Switch checked={locationEnabled} onCheckedChange={setLocationEnabled} />
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <Gift className="w-5 h-5 text-[#008080]" />
                    <div>
                      <p className="text-white font-medium">Rewards & Points</p>
                      <p className="text-white/60 text-sm">Notifications for earned points and rewards</p>
                    </div>
                  </div>
                  <Switch checked={true} onCheckedChange={() => {}} />
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <AlertTriangle className="w-5 h-5 text-[#FF4500]" />
                    <div>
                      <p className="text-white font-medium">Safety Alerts</p>
                      <p className="text-white/60 text-sm">Important safety and security notifications</p>
                    </div>
                  </div>
                  <Switch checked={true} onCheckedChange={() => {}} />
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <RefreshCw className="w-5 h-5 text-[#00BFFF]" />
                    <div>
                      <p className="text-white font-medium">Live Updates</p>
                      <p className="text-white/60 text-sm">Real-time updates about spot availability</p>
                    </div>
                  </div>
                  <Switch checked={true} onCheckedChange={() => {}} />
                </div>
              </div>
            </Card>

            {/* Testing Controls */}
            {process.env.NODE_ENV === 'development' && (
              <Card className="glass-effect border-white/20 p-6">
                <h4 className="text-white font-medium mb-4 flex items-center">
                  <AlertTriangle className="w-5 h-5 mr-2 text-yellow-400" />
                  Developer Testing
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Button
                    onClick={onTriggerSystemNotification}
                    className="bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] hover:from-[#00BFFF]/80 hover:to-[#FF00FF]/80 text-white transition-all duration-200"
                    size="sm"
                  >
                    <Bell className="w-4 h-4 mr-2" />
                    Test System Notification
                  </Button>
                  
                  <Button
                    onClick={onTriggerRecommendation}
                    className="bg-gradient-to-r from-[#FF00FF] to-[#FF4500] hover:from-[#FF00FF]/80 hover:to-[#FF4500]/80 text-white transition-all duration-200"
                    size="sm"
                  >
                    <Sparkles className="w-4 h-4 mr-2" />
                    Test Smart Recommendation
                  </Button>
                </div>
                <p className="text-white/60 text-xs mt-3">
                  These controls are only visible in development mode for testing notification features.
                </p>
              </Card>
            )}

            {/* Notification History */}
            <Card className="glass-effect border-white/20 p-6">
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-white font-medium">Recent Notifications</h4>
                <Button 
                  variant="ghost" 
                  size="sm"
                  className="text-white/60 hover:text-white"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Clear All
                </Button>
              </div>
              <div className="space-y-3">
                {[
                  { icon: CheckCircle, text: "3 new trending spots discovered near you", time: "2 min ago", color: "text-green-400" },
                  { icon: Gift, text: "You earned 50 Bytspot points!", time: "1 hour ago", color: "text-purple-400" },
                  { icon: AlertTriangle, text: "Parking meter expires in 15 minutes", time: "3 hours ago", color: "text-yellow-400" },
                  { icon: MapPin, text: "New valet service available at The Grove", time: "1 day ago", color: "text-blue-400" }
                ].map((notification, index) => (
                  <div key={index} className="flex items-start space-x-3 p-3 rounded-xl bg-white/5">
                    <notification.icon className={`w-5 h-5 ${notification.color} flex-shrink-0 mt-0.5`} />
                    <div className="flex-1">
                      <p className="text-white text-sm">{notification.text}</p>
                      <p className="text-white/60 text-xs mt-1">{notification.time}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        );
      case 'privacy':
        return (
          <div className="space-y-6">
            <h3 className="text-lg font-semibold text-white">Privacy & Security</h3>
            <Card className="glass-effect border-white/20 p-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-white font-medium">Private Profile</p>
                    <p className="text-white/60 text-sm">Hide your profile from other users</p>
                  </div>
                  <Switch checked={privateProfile} onCheckedChange={setPrivateProfile} />
                </div>
                
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-white font-medium">Data Encryption</p>
                    <p className="text-white/60 text-sm">Encrypt your data</p>
                  </div>
                  <Switch checked={dataEncryption} onCheckedChange={setDataEncryption} />
                </div>
              </div>
            </Card>
          </div>
        );
      case 'app-settings':
        return (
          <div className="space-y-6">
            <h3 className="text-lg font-semibold text-white">App Settings</h3>
            <Card className="glass-effect border-white/20 p-6">
              <h4 className="text-white font-medium mb-4">Dynamic Themes</h4>
              <div className="space-y-4">
                <div>
                  <label className="text-white/80 text-sm font-medium mb-2 block">
                    Weather Theme
                  </label>
                  <Select value={weatherTheme} onValueChange={onWeatherChange}>
                    <SelectTrigger className="glass-effect border-white/20 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sunny">
                        <div className="flex items-center space-x-2">
                          <Sun className="w-4 h-4 text-yellow-500" />
                          <span>Sunny</span>
                        </div>
                      </SelectItem>
                      <SelectItem value="rainy">
                        <div className="flex items-center space-x-2">
                          <CloudRain className="w-4 h-4 text-blue-500" />
                          <span>Rainy</span>
                        </div>
                      </SelectItem>
                      <SelectItem value="cloudy">
                        <div className="flex items-center space-x-2">
                          <Cloud className="w-4 h-4 text-gray-500" />
                          <span>Cloudy</span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <label className="text-white/80 text-sm font-medium mb-2 block">
                    Location Theme
                  </label>
                  <Select value={locationTheme} onValueChange={onLocationChange}>
                    <SelectTrigger className="glass-effect border-white/20 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="city">
                        <div className="flex items-center space-x-2">
                          <Building className="w-4 h-4 text-gray-500" />
                          <span>City</span>
                        </div>
                      </SelectItem>
                      <SelectItem value="beach">
                        <div className="flex items-center space-x-2">
                          <Palmtree className="w-4 h-4 text-cyan-500" />
                          <span>Beach</span>
                        </div>
                      </SelectItem>
                      <SelectItem value="mountain">
                        <div className="flex items-center space-x-2">
                          <Mountain className="w-4 h-4 text-stone-500" />
                          <span>Mountain</span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Button
                  onClick={onTriggerAchievement}
                  className="w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white"
                >
                  Trigger Smart Recommendation
                </Button>
              </div>
            </Card>
          </div>
        );
      default:
        return (
          <div className="flex items-center justify-center h-64">
            <div className="text-center text-white">
              <h3 className="text-lg font-medium mb-2">Coming Soon</h3>
              <p className="text-white/60">This feature is under development</p>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] relative overflow-hidden">
      {/* Header */}
      <motion.div 
        className="sticky top-0 z-50 backdrop-blur-xl border-b border-white/10"
        style={{
          background: 'linear-gradient(135deg, rgba(18, 18, 18, 0.95) 0%, rgba(0, 191, 255, 0.1) 50%, rgba(255, 0, 255, 0.1) 100%)',
        }}
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="flex items-center justify-between p-4">
          <motion.button
            onClick={currentSettingsView === 'main' ? onBack : () => setCurrentSettingsView('main')}
            className="w-10 h-10 bg-white/10 backdrop-blur-md rounded-full border border-white/20 flex items-center justify-center"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <ArrowLeft className="w-5 h-5 text-white" />
          </motion.button>
          
          <h1 className="text-white text-lg font-semibold">
            {currentSettingsView === 'main' ? 'Profile' : 
             currentSettingsView === 'notifications' ? 'Notifications' :
             currentSettingsView === 'privacy' ? 'Privacy & Security' :
             currentSettingsView === 'app-settings' ? 'App Settings' :
             'Settings'}
          </h1>
          
          <div className="w-10" />
        </div>
      </motion.div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 pb-32">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentSettingsView}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.3 }}
            >
              {renderCurrentView()}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}