import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Shield, 
  MapPin, 
  Wifi, 
  Bluetooth, 
  Activity, 
  Eye, 
  Lock, 
  CheckCircle, 
  XCircle, 
  AlertTriangle, 
  Info, 
  ArrowRight, 
  ArrowLeft,
  Zap,
  Target,
  Radar,
  Smartphone,
  Clock,
  Database
} from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Switch } from './ui/switch';
import { Separator } from './ui/separator';

interface SensorPermission {
  id: string;
  type: 'GPS' | 'WiFi' | 'BLE' | 'IMU';
  name: string;
  icon: React.ReactNode;
  required: boolean;
  purpose: string;
  benefits: string[];
  dataCollected: string[];
  retention: string;
  frequency: string;
  privacy: string;
  granted: boolean;
}

interface ConsentStep {
  id: string;
  title: string;
  description: string;
  permissions: string[];
  isComplete: boolean;
}

interface DataConsentFlowProps {
  isOpen: boolean;
  onComplete: (permissions: Record<string, boolean>) => void;
  onClose: () => void;
  currentTheme: any;
  themeColors: any;
}

export function DataConsentFlow({ isOpen, onComplete, onClose, currentTheme, themeColors }: DataConsentFlowProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [permissions, setPermissions] = useState<SensorPermission[]>([
    {
      id: 'gps',
      type: 'GPS',
      name: 'Location Services',
      icon: <MapPin className="w-6 h-6" />,
      required: true,
      purpose: 'Find nearby spots, parking, and venues tailored to your location',
      benefits: [
        'Personalized spot recommendations',
        'Real-time parking availability',
        'Distance-based venue suggestions',
        'Emergency location services'
      ],
      dataCollected: ['GPS coordinates', 'Location history', 'Movement patterns'],
      retention: '30 days',
      frequency: 'Continuous when app is active',
      privacy: 'Encrypted and never shared with third parties',
      granted: false
    },
    {
      id: 'wifi',
      type: 'WiFi',
      name: 'WiFi Scanning',
      icon: <Wifi className="w-6 h-6" />,
      required: false,
      purpose: 'Identify venues and provide indoor positioning for better recommendations',
      benefits: [
        'Indoor venue identification',
        'More accurate location in buildings',
        'Venue-specific recommendations',
        'Improved parking spot detection'
      ],
      dataCollected: ['WiFi network names', 'Signal strengths', 'Connection patterns'],
      retention: '7 days',
      frequency: 'Periodic scans when discovering spots',
      privacy: 'Network names anonymized, no connection details stored',
      granted: false
    },
    {
      id: 'ble',
      type: 'BLE',
      name: 'Bluetooth Proximity',
      icon: <Bluetooth className="w-6 h-6" />,
      required: false,
      purpose: 'Detect smart parking meters, venue beacons, and proximity-based features',
      benefits: [
        'Smart parking meter integration',
        'Venue beacon notifications',
        'Proximity-based recommendations',
        'Enhanced valet services'
      ],
      dataCollected: ['Bluetooth device IDs', 'Signal strengths', 'Proximity data'],
      retention: '24 hours',
      frequency: 'When near compatible devices',
      privacy: 'Device IDs anonymized, no personal device info collected',
      granted: false
    },
    {
      id: 'imu',
      type: 'IMU',
      name: 'Motion Sensors',
      icon: <Activity className="w-6 h-6" />,
      required: false,
      purpose: 'Understand your activity and movement to provide context-aware recommendations',
      benefits: [
        'Activity-based spot suggestions',
        'Walking vs driving detection',
        'Better navigation assistance',
        'Personalized timing recommendations'
      ],
      dataCollected: ['Accelerometer data', 'Gyroscope readings', 'Motion patterns'],
      retention: '3 days',
      frequency: 'Continuous background collection',
      privacy: 'Processed locally on device, raw data never leaves your phone',
      granted: false
    }
  ]);

  const consentSteps: ConsentStep[] = [
    {
      id: 'introduction',
      title: 'Welcome to Bytspot Privacy',
      description: 'We use advanced sensor data to provide personalized recommendations while keeping your privacy first.',
      permissions: [],
      isComplete: false
    },
    {
      id: 'location',
      title: 'Location Services',
      description: 'Essential for finding spots, parking, and venues near you.',
      permissions: ['gps'],
      isComplete: false
    },
    {
      id: 'sensors',
      title: 'Enhanced Sensors',
      description: 'Optional sensors that improve your experience with smart features.',
      permissions: ['wifi', 'ble', 'imu'],
      isComplete: false
    },
    {
      id: 'summary',
      title: 'Privacy Summary',
      description: 'Review your choices and complete the setup.',
      permissions: [],
      isComplete: false
    }
  ];

  const [steps, setSteps] = useState(consentSteps);

  const togglePermission = (id: string) => {
    setPermissions(prev => prev.map(p => 
      p.id === id ? { ...p, granted: !p.granted } : p
    ));
  };

  const canProceed = () => {
    const currentStepPermissions = steps[currentStep]?.permissions || [];
    if (currentStepPermissions.length === 0) return true;
    
    // Check if required permissions are granted
    const requiredPermissions = permissions.filter(p => 
      currentStepPermissions.includes(p.id) && p.required
    );
    
    return requiredPermissions.every(p => p.granted);
  };

  const getStepProgress = () => {
    return Math.round(((currentStep + 1) / steps.length) * 100);
  };

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(prev => prev + 1);
    } else {
      // Complete the flow
      const permissionMap = permissions.reduce((acc, p) => {
        acc[p.id] = p.granted;
        return acc;
      }, {} as Record<string, boolean>);
      onComplete(permissionMap);
    }
  };

  const handlePrevious = () => {
    if (currentStep > 0) {
      setCurrentStep(prev => prev - 1);
    }
  };

  const getPermissionsByStep = (stepId: string) => {
    const step = steps.find(s => s.id === stepId);
    return permissions.filter(p => step?.permissions.includes(p.id) || []);
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.9, opacity: 0, y: 20 }}
          transition={{ type: "spring", duration: 0.5 }}
          className="glass-card rounded-2xl p-6 max-w-2xl w-full max-h-[90vh] overflow-hidden"
        >
          {/* Progress Bar */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-white/70 text-sm">Step {currentStep + 1} of {steps.length}</span>
              <span className="text-white/70 text-sm">{getStepProgress()}%</span>
            </div>
            <div className="w-full bg-white/10 rounded-full h-2">
              <motion.div
                className={`h-2 rounded-full bg-gradient-to-r ${themeColors.primary}`}
                initial={{ width: 0 }}
                animate={{ width: `${getStepProgress()}%` }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              />
            </div>
          </div>

          {/* Step Content */}
          <div className="overflow-y-auto max-h-[70vh] scrollbar-hide">
            <AnimatePresence mode="wait">
              {currentStep === 0 && (
                <motion.div
                  key="intro"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="text-center space-y-6"
                >
                  <motion.div
                    className={`inline-flex p-4 rounded-2xl bg-gradient-to-r ${themeColors.primary}/20`}
                    whileHover={{ scale: 1.05 }}
                    transition={{ duration: 0.2 }}
                  >
                    <Shield className="w-12 h-12 text-white" />
                  </motion.div>
                  
                  <div>
                    <h2 className="text-white mb-3">{steps[currentStep].title}</h2>
                    <p className="text-white/70 text-lg leading-relaxed">
                      {steps[currentStep].description}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="p-4 bg-white/5 rounded-lg border border-white/10">
                      <div className="flex items-center space-x-2 mb-2">
                        <Lock className="w-4 h-4 text-green-400" />
                        <span className="text-white font-medium">Privacy First</span>
                      </div>
                      <p className="text-white/60">Your data is encrypted and processed locally whenever possible</p>
                    </div>
                    <div className="p-4 bg-white/5 rounded-lg border border-white/10">
                      <div className="flex items-center space-x-2 mb-2">
                        <Eye className="w-4 h-4 text-blue-400" />
                        <span className="text-white font-medium">Full Transparency</span>
                      </div>
                      <p className="text-white/60">See exactly what data we collect and why we need it</p>
                    </div>
                  </div>

                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-4">
                    <div className="flex items-start space-x-3">
                      <Info className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                      <div className="text-sm">
                        <p className="text-amber-200 font-medium mb-1">Important</p>
                        <p className="text-amber-200/80">
                          Bytspot is not intended for collecting personally identifiable information (PII) or securing sensitive personal data. 
                          We focus on location and sensor data to enhance your discovery experience.
                        </p>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}

              {currentStep === 1 && (
                <motion.div
                  key="location"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-6"
                >
                  <div className="text-center">
                    <h2 className="text-white mb-2">{steps[currentStep].title}</h2>
                    <p className="text-white/70">{steps[currentStep].description}</p>
                  </div>

                  {getPermissionsByStep('location').map((permission, index) => (
                    <motion.div
                      key={permission.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.1 }}
                    >
                      <Card className="bg-white/5 border-white/10">
                        <CardHeader>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-3">
                              <div className={`p-3 rounded-xl bg-gradient-to-r ${themeColors.primary}/20`}>
                                {permission.icon}
                              </div>
                              <div>
                                <CardTitle className="text-white flex items-center space-x-2">
                                  <span>{permission.name}</span>
                                  {permission.required && (
                                    <Badge variant="destructive" className="text-xs">
                                      Required
                                    </Badge>
                                  )}
                                </CardTitle>
                                <p className="text-white/60 text-sm">{permission.purpose}</p>
                              </div>
                            </div>
                            <Switch
                              checked={permission.granted}
                              onCheckedChange={() => togglePermission(permission.id)}
                              disabled={permission.required && !permission.granted}
                            />
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                            <div>
                              <h5 className="text-white font-medium mb-2 flex items-center space-x-1">
                                <Zap className="w-4 h-4" />
                                <span>Benefits</span>
                              </h5>
                              <ul className="space-y-1 text-white/70">
                                {permission.benefits.map((benefit, i) => (
                                  <li key={i} className="flex items-start space-x-2">
                                    <CheckCircle className="w-3 h-3 text-green-400 flex-shrink-0 mt-1" />
                                    <span>{benefit}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                            <div>
                              <h5 className="text-white font-medium mb-2 flex items-center space-x-1">
                                <Database className="w-4 h-4" />
                                <span>Data Details</span>
                              </h5>
                              <div className="space-y-2 text-white/70 text-xs">
                                <div>
                                  <span className="text-white/50">Collected:</span> {permission.dataCollected.join(', ')}
                                </div>
                                <div>
                                  <span className="text-white/50">Retention:</span> {permission.retention}
                                </div>
                                <div>
                                  <span className="text-white/50">Frequency:</span> {permission.frequency}
                                </div>
                              </div>
                            </div>
                          </div>
                          <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3">
                            <div className="flex items-start space-x-2">
                              <Lock className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
                              <p className="text-green-200/80 text-sm">{permission.privacy}</p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </motion.div>
                  ))}
                </motion.div>
              )}

              {currentStep === 2 && (
                <motion.div
                  key="sensors"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-6"
                >
                  <div className="text-center">
                    <h2 className="text-white mb-2">{steps[currentStep].title}</h2>
                    <p className="text-white/70">{steps[currentStep].description}</p>
                  </div>

                  <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
                    <div className="flex items-start space-x-3">
                      <Info className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
                      <div className="text-sm">
                        <p className="text-blue-200 font-medium mb-1">Optional Features</p>
                        <p className="text-blue-200/80">
                          These sensors are optional but enhance your Bytspot experience with smarter recommendations and features.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-4">
                    {getPermissionsByStep('sensors').map((permission, index) => (
                      <motion.div
                        key={permission.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.1 }}
                        className={`p-4 bg-white/5 rounded-lg border border-white/10 transition-all ${
                          permission.granted ? 'ring-2 ring-blue-500/30' : ''
                        }`}
                      >
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex items-center space-x-3">
                            <div className={`p-2 rounded-lg ${
                              permission.granted 
                                ? 'bg-blue-500/20 text-blue-400' 
                                : 'bg-gray-500/20 text-gray-400'
                            }`}>
                              {permission.icon}
                            </div>
                            <div>
                              <h4 className="text-white font-medium">{permission.name}</h4>
                              <p className="text-white/60 text-sm">{permission.purpose}</p>
                            </div>
                          </div>
                          <Switch
                            checked={permission.granted}
                            onCheckedChange={() => togglePermission(permission.id)}
                          />
                        </div>
                        
                        <div className="text-xs text-white/50 space-y-1">
                          <div>Retention: {permission.retention} • {permission.frequency}</div>
                          <div className="flex items-center space-x-1">
                            <Lock className="w-3 h-3" />
                            <span>{permission.privacy}</span>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </motion.div>
              )}

              {currentStep === 3 && (
                <motion.div
                  key="summary"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-6"
                >
                  <div className="text-center">
                    <h2 className="text-white mb-2">{steps[currentStep].title}</h2>
                    <p className="text-white/70">{steps[currentStep].description}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
                      <div className="flex items-center space-x-2 mb-2">
                        <CheckCircle className="w-5 h-5 text-green-400" />
                        <span className="text-white font-medium">Granted</span>
                      </div>
                      <div className="space-y-1">
                        {permissions.filter(p => p.granted).map(p => (
                          <div key={p.id} className="text-sm text-green-200 flex items-center space-x-2">
                            {p.icon}
                            <span>{p.name}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="p-4 bg-gray-500/10 border border-gray-500/20 rounded-lg">
                      <div className="flex items-center space-x-2 mb-2">
                        <XCircle className="w-5 h-5 text-gray-400" />
                        <span className="text-white font-medium">Not Granted</span>
                      </div>
                      <div className="space-y-1">
                        {permissions.filter(p => !p.granted).map(p => (
                          <div key={p.id} className="text-sm text-gray-400 flex items-center space-x-2">
                            {p.icon}
                            <span>{p.name}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="bg-white/5 border border-white/10 rounded-lg p-4">
                    <h4 className="text-white font-medium mb-3 flex items-center space-x-2">
                      <Shield className="w-4 h-4" />
                      <span>Your Privacy Rights</span>
                    </h4>
                    <div className="text-sm text-white/70 space-y-2">
                      <p>• You can change these permissions anytime in Settings</p>
                      <p>• Data is automatically deleted after retention periods</p>
                      <p>• You can export or delete all your data at any time</p>
                      <p>• We never sell or share your personal data</p>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Navigation */}
          <div className="flex items-center justify-between mt-6 pt-4 border-t border-white/10">
            <Button
              variant="ghost"
              onClick={handlePrevious}
              disabled={currentStep === 0}
              className="text-white/70 hover:text-white hover:bg-white/10"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Previous
            </Button>

            <div className="flex items-center space-x-2">
              {!canProceed() && (
                <div className="flex items-center space-x-2 text-amber-400 text-sm">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Location access required</span>
                </div>
              )}
              
              <Button
                onClick={handleNext}
                disabled={!canProceed()}
                className={`bg-gradient-to-r ${themeColors.primary} text-white hover:opacity-90`}
              >
                {currentStep === steps.length - 1 ? 'Complete Setup' : 'Continue'}
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}