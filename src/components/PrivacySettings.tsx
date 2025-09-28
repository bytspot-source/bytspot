import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Shield, 
  Lock, 
  Eye, 
  EyeOff, 
  MapPin, 
  Wifi, 
  Bluetooth, 
  Smartphone, 
  Activity, 
  AlertTriangle, 
  CheckCircle, 
  XCircle, 
  Settings, 
  Download, 
  Trash2, 
  Clock, 
  Globe, 
  Database,
  FileText,
  UserCheck,
  Zap,
  Target,
  Radar
} from 'lucide-react';
import { Switch } from './ui/switch';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';

interface SensorData {
  type: 'GPS' | 'WiFi' | 'BLE' | 'IMU';
  status: 'active' | 'inactive' | 'restricted';
  lastAccessed: Date;
  dataPoints: number;
  purpose: string;
  retention: string;
  encryption: boolean;
}

interface PrivacyConsent {
  id: string;
  type: 'location' | 'sensors' | 'analytics' | 'marketing';
  granted: boolean;
  grantedAt?: Date;
  required: boolean;
  description: string;
}

interface DataTransparencyItem {
  category: string;
  dataType: string;
  purpose: string;
  retention: string;
  sharing: string[];
  userControl: boolean;
}

interface PrivacySettingsProps {
  isOpen: boolean;
  onClose: () => void;
  currentTheme: any;
  themeColors: any;
}

export function PrivacySettings({ isOpen, onClose, currentTheme, themeColors }: PrivacySettingsProps) {
  const [activeTab, setActiveTab] = useState<'permissions' | 'data' | 'security' | 'rights'>('permissions');
  const [sensorData, setSensorData] = useState<SensorData[]>([
    {
      type: 'GPS',
      status: 'active',
      lastAccessed: new Date(Date.now() - 1000 * 60 * 2),
      dataPoints: 1247,
      purpose: 'Location-based recommendations and spot discovery',
      retention: '30 days',
      encryption: true
    },
    {
      type: 'WiFi',
      status: 'active',
      lastAccessed: new Date(Date.now() - 1000 * 60 * 5),
      dataPoints: 89,
      purpose: 'Venue identification and indoor positioning',
      retention: '7 days',
      encryption: true
    },
    {
      type: 'BLE',
      status: 'inactive',
      lastAccessed: new Date(Date.now() - 1000 * 60 * 60 * 2),
      dataPoints: 34,
      purpose: 'Proximity detection and smart parking',
      retention: '24 hours',
      encryption: true
    },
    {
      type: 'IMU',
      status: 'restricted',
      lastAccessed: new Date(Date.now() - 1000 * 60 * 15),
      dataPoints: 567,
      purpose: 'Activity recognition and navigation assistance',
      retention: '3 days',
      encryption: true
    }
  ]);

  const [privacyConsents, setPrivacyConsents] = useState<PrivacyConsent[]>([
    {
      id: 'location',
      type: 'location',
      granted: true,
      grantedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3),
      required: true,
      description: 'Access device location for spot discovery and recommendations'
    },
    {
      id: 'sensors',
      type: 'sensors',
      granted: true,
      grantedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3),
      required: false,
      description: 'Access motion sensors and environmental data for enhanced experiences'
    },
    {
      id: 'analytics',
      type: 'analytics',
      granted: false,
      required: false,
      description: 'Anonymous usage analytics to improve app performance'
    },
    {
      id: 'marketing',
      type: 'marketing',
      granted: false,
      required: false,
      description: 'Personalized offers and recommendations from partners'
    }
  ]);

  const [dataTransparency] = useState<DataTransparencyItem[]>([
    {
      category: 'Location Data',
      dataType: 'GPS Coordinates, Venue Check-ins',
      purpose: 'Personalized recommendations, Safety features',
      retention: '30 days',
      sharing: ['Map Services', 'Local Partners'],
      userControl: true
    },
    {
      category: 'Sensor Data',
      dataType: 'Motion, Orientation, Environmental',
      purpose: 'Activity detection, Indoor navigation',
      retention: '7 days',
      sharing: ['None'],
      userControl: true
    },
    {
      category: 'Usage Analytics',
      dataType: 'App interactions, Feature usage',
      purpose: 'Product improvement, Bug fixes',
      retention: '1 year (aggregated)',
      sharing: ['Analytics providers'],
      userControl: true
    }
  ]);

  const [securitySettings, setSecuritySettings] = useState({
    dataEncryption: true,
    anonymousMode: false,
    locationObfuscation: false,
    autoDataDeletion: true,
    shareMinimalData: true,
    secureTransmission: true
  });

  const getSensorIcon = (type: string) => {
    switch (type) {
      case 'GPS': return <MapPin className="w-5 h-5" />;
      case 'WiFi': return <Wifi className="w-5 h-5" />;
      case 'BLE': return <Bluetooth className="w-5 h-5" />;
      case 'IMU': return <Activity className="w-5 h-5" />;
      default: return <Smartphone className="w-5 h-5" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return 'text-green-400 bg-green-500/20 border-green-500/30';
      case 'inactive': return 'text-gray-400 bg-gray-500/20 border-gray-500/30';
      case 'restricted': return 'text-yellow-400 bg-yellow-500/20 border-yellow-500/30';
      default: return 'text-gray-400 bg-gray-500/20 border-gray-500/30';
    }
  };

  const toggleConsent = (id: string) => {
    setPrivacyConsents(prev => prev.map(consent => 
      consent.id === id 
        ? { 
            ...consent, 
            granted: !consent.granted,
            grantedAt: !consent.granted ? new Date() : undefined
          }
        : consent
    ));
  };

  const toggleSecuritySetting = (setting: keyof typeof securitySettings) => {
    setSecuritySettings(prev => ({
      ...prev,
      [setting]: !prev[setting]
    }));
  };

  const formatTimeAgo = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  const handleDataExport = () => {
    // In real app, this would trigger data export
    console.log('Exporting user data...');
  };

  const handleDataDeletion = () => {
    // In real app, this would trigger data deletion
    console.log('Initiating data deletion...');
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.9, opacity: 0, y: 20 }}
          transition={{ type: "spring", duration: 0.5 }}
          className="glass-card rounded-2xl p-6 max-w-4xl w-full max-h-[90vh] overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center space-x-3">
              <motion.div
                className={`p-3 rounded-xl bg-gradient-to-r ${themeColors.primary}/20`}
                whileHover={{ scale: 1.05 }}
              >
                <Shield className="w-6 h-6 text-white" />
              </motion.div>
              <div>
                <h2 className="text-white">Privacy & Security</h2>
                <p className="text-white/70 text-sm">Manage your data and privacy preferences</p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="text-white/70 hover:text-white hover:bg-white/10"
            >
              <XCircle className="w-5 h-5" />
            </Button>
          </div>

          {/* Tab Navigation */}
          <div className="flex space-x-1 mb-6 p-1 bg-white/5 rounded-lg">
            {[
              { id: 'permissions', label: 'Permissions', icon: UserCheck },
              { id: 'data', label: 'Data', icon: Database },
              { id: 'security', label: 'Security', icon: Lock },
              { id: 'rights', label: 'Your Rights', icon: FileText }
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center space-x-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  activeTab === tab.id
                    ? 'bg-white/10 text-white'
                    : 'text-white/60 hover:text-white/80 hover:bg-white/5'
                }`}
              >
                <tab.icon className="w-4 h-4" />
                <span>{tab.label}</span>
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="overflow-y-auto max-h-[60vh] scrollbar-hide">
            {activeTab === 'permissions' && (
              <div className="space-y-6">
                {/* Sensor Data Collection */}
                <Card className="bg-white/5 border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white flex items-center space-x-2">
                      <Radar className="w-5 h-5" />
                      <span>Multi-Modal Sensor Data</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {sensorData.map((sensor, index) => (
                      <motion.div
                        key={sensor.type}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.1 }}
                        className="flex items-center justify-between p-4 bg-white/5 rounded-lg border border-white/10"
                      >
                        <div className="flex items-center space-x-4">
                          <div className={`p-2 rounded-lg ${getStatusColor(sensor.status)}`}>
                            {getSensorIcon(sensor.type)}
                          </div>
                          <div>
                            <div className="flex items-center space-x-2">
                              <h4 className="text-white font-medium">{sensor.type} Sensor</h4>
                              <Badge 
                                variant={sensor.status === 'active' ? 'default' : 'secondary'}
                                className={`text-xs ${getStatusColor(sensor.status)}`}
                              >
                                {sensor.status}
                              </Badge>
                            </div>
                            <p className="text-white/60 text-sm">{sensor.purpose}</p>
                            <div className="flex items-center space-x-4 text-xs text-white/50 mt-1">
                              <span>Last: {formatTimeAgo(sensor.lastAccessed)}</span>
                              <span>•</span>
                              <span>{sensor.dataPoints} points</span>
                              <span>•</span>
                              <span>Retention: {sensor.retention}</span>
                              {sensor.encryption && (
                                <>
                                  <span>•</span>
                                  <div className="flex items-center space-x-1">
                                    <Lock className="w-3 h-3" />
                                    <span>Encrypted</span>
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        <Switch
                          checked={sensor.status === 'active'}
                          onCheckedChange={(checked) => {
                            setSensorData(prev => prev.map(s => 
                              s.type === sensor.type 
                                ? { ...s, status: checked ? 'active' : 'inactive' }
                                : s
                            ));
                          }}
                        />
                      </motion.div>
                    ))}
                  </CardContent>
                </Card>

                {/* Privacy Consents */}
                <Card className="bg-white/5 border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white flex items-center space-x-2">
                      <CheckCircle className="w-5 h-5" />
                      <span>Privacy Consents</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {privacyConsents.map((consent, index) => (
                      <motion.div
                        key={consent.id}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.1 }}
                        className="flex items-center justify-between p-4 bg-white/5 rounded-lg border border-white/10"
                      >
                        <div className="flex-1">
                          <div className="flex items-center space-x-2">
                            <h4 className="text-white font-medium capitalize">{consent.type} Access</h4>
                            {consent.required && (
                              <Badge variant="destructive" className="text-xs">
                                Required
                              </Badge>
                            )}
                            {consent.granted && consent.grantedAt && (
                              <Badge variant="secondary" className="text-xs text-green-400 bg-green-500/20">
                                Granted {formatTimeAgo(consent.grantedAt)}
                              </Badge>
                            )}
                          </div>
                          <p className="text-white/60 text-sm mt-1">{consent.description}</p>
                        </div>
                        <Switch
                          checked={consent.granted}
                          onCheckedChange={() => !consent.required && toggleConsent(consent.id)}
                          disabled={consent.required}
                        />
                      </motion.div>
                    ))}
                  </CardContent>
                </Card>
              </div>
            )}

            {activeTab === 'data' && (
              <div className="space-y-6">
                {/* Data Transparency */}
                <Card className="bg-white/5 border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white flex items-center space-x-2">
                      <Eye className="w-5 h-5" />
                      <span>Data Transparency</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {dataTransparency.map((item, index) => (
                      <motion.div
                        key={index}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.1 }}
                        className="p-4 bg-white/5 rounded-lg border border-white/10"
                      >
                        <div className="flex items-start justify-between mb-3">
                          <h4 className="text-white font-medium">{item.category}</h4>
                          {item.userControl && (
                            <Badge className="text-xs text-blue-400 bg-blue-500/20">
                              User Controlled
                            </Badge>
                          )}
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                          <div>
                            <p className="text-white/50 mb-1">Data Type</p>
                            <p className="text-white/80">{item.dataType}</p>
                          </div>
                          <div>
                            <p className="text-white/50 mb-1">Purpose</p>
                            <p className="text-white/80">{item.purpose}</p>
                          </div>
                          <div>
                            <p className="text-white/50 mb-1">Retention</p>
                            <p className="text-white/80">{item.retention}</p>
                          </div>
                          <div>
                            <p className="text-white/50 mb-1">Sharing</p>
                            <p className="text-white/80">{item.sharing.join(', ')}</p>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </CardContent>
                </Card>

                {/* Real-time Data Status */}
                <Card className="bg-white/5 border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white flex items-center space-x-2">
                      <Activity className="w-5 h-5" />
                      <span>Real-time Data Collection</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      {sensorData.map((sensor) => (
                        <div
                          key={sensor.type}
                          className="text-center p-3 bg-white/5 rounded-lg border border-white/10"
                        >
                          <div className={`inline-flex p-2 rounded-full mb-2 ${getStatusColor(sensor.status)}`}>
                            {getSensorIcon(sensor.type)}
                          </div>
                          <p className="text-white text-sm font-medium">{sensor.type}</p>
                          <p className="text-white/60 text-xs capitalize">{sensor.status}</p>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {activeTab === 'security' && (
              <div className="space-y-6">
                {/* Security Settings */}
                <Card className="bg-white/5 border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white flex items-center space-x-2">
                      <Lock className="w-5 h-5" />
                      <span>Security Controls</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {[
                      {
                        key: 'dataEncryption',
                        title: 'End-to-End Encryption',
                        description: 'All sensor data is encrypted during transmission and storage',
                        icon: Lock,
                        recommended: true
                      },
                      {
                        key: 'anonymousMode',
                        title: 'Anonymous Mode',
                        description: 'Use app features without linking to your identity',
                        icon: EyeOff,
                        recommended: false
                      },
                      {
                        key: 'locationObfuscation',
                        title: 'Location Obfuscation',
                        description: 'Add random noise to location data for extra privacy',
                        icon: Target,
                        recommended: false
                      },
                      {
                        key: 'autoDataDeletion',
                        title: 'Auto Data Deletion',
                        description: 'Automatically delete sensor data after retention period',
                        icon: Clock,
                        recommended: true
                      },
                      {
                        key: 'shareMinimalData',
                        title: 'Minimal Data Sharing',
                        description: 'Only share essential data required for functionality',
                        icon: Shield,
                        recommended: true
                      },
                      {
                        key: 'secureTransmission',
                        title: 'Secure Transmission',
                        description: 'Use secure protocols for all data transmission',
                        icon: Zap,
                        recommended: true
                      }
                    ].map((setting, index) => (
                      <motion.div
                        key={setting.key}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.1 }}
                        className="flex items-center justify-between p-4 bg-white/5 rounded-lg border border-white/10"
                      >
                        <div className="flex items-center space-x-4">
                          <div className={`p-2 rounded-lg ${
                            securitySettings[setting.key as keyof typeof securitySettings]
                              ? 'text-green-400 bg-green-500/20'
                              : 'text-gray-400 bg-gray-500/20'
                          }`}>
                            <setting.icon className="w-5 h-5" />
                          </div>
                          <div>
                            <div className="flex items-center space-x-2">
                              <h4 className="text-white font-medium">{setting.title}</h4>
                              {setting.recommended && (
                                <Badge className="text-xs text-green-400 bg-green-500/20">
                                  Recommended
                                </Badge>
                              )}
                            </div>
                            <p className="text-white/60 text-sm">{setting.description}</p>
                          </div>
                        </div>
                        <Switch
                          checked={securitySettings[setting.key as keyof typeof securitySettings]}
                          onCheckedChange={() => toggleSecuritySetting(setting.key as keyof typeof securitySettings)}
                        />
                      </motion.div>
                    ))}
                  </CardContent>
                </Card>

                {/* Security Status */}
                <Card className="bg-white/5 border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white flex items-center space-x-2">
                      <Shield className="w-5 h-5" />
                      <span>Security Status</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-center p-6">
                      <div className="text-center">
                        <motion.div
                          className="inline-flex p-4 rounded-full bg-green-500/20 text-green-400 mb-4"
                          animate={{ scale: [1, 1.05, 1] }}
                          transition={{ duration: 2, repeat: Infinity }}
                        >
                          <CheckCircle className="w-8 h-8" />
                        </motion.div>
                        <h4 className="text-white font-medium mb-2">Highly Secure</h4>
                        <p className="text-white/60 text-sm">
                          Your data is protected with industry-standard security measures
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {activeTab === 'rights' && (
              <div className="space-y-6">
                {/* User Rights */}
                <Card className="bg-white/5 border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white flex items-center space-x-2">
                      <FileText className="w-5 h-5" />
                      <span>Your Data Rights</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <motion.div
                        whileHover={{ scale: 1.02 }}
                        className="p-4 bg-white/5 rounded-lg border border-white/10 cursor-pointer"
                        onClick={handleDataExport}
                      >
                        <div className="flex items-start space-x-3">
                          <div className="p-2 rounded-lg bg-blue-500/20 text-blue-400">
                            <Download className="w-5 h-5" />
                          </div>
                          <div>
                            <h4 className="text-white font-medium mb-1">Export Your Data</h4>
                            <p className="text-white/60 text-sm">
                              Download all your personal data in a portable format
                            </p>
                          </div>
                        </div>
                      </motion.div>

                      <motion.div
                        whileHover={{ scale: 1.02 }}
                        className="p-4 bg-white/5 rounded-lg border border-white/10 cursor-pointer"
                        onClick={handleDataDeletion}
                      >
                        <div className="flex items-start space-x-3">
                          <div className="p-2 rounded-lg bg-red-500/20 text-red-400">
                            <Trash2 className="w-5 h-5" />
                          </div>
                          <div>
                            <h4 className="text-white font-medium mb-1">Delete Your Data</h4>
                            <p className="text-white/60 text-sm">
                              Permanently delete all your personal data
                            </p>
                          </div>
                        </div>
                      </motion.div>
                    </div>
                  </CardContent>
                </Card>

                {/* Privacy Policy */}
                <Card className="bg-white/5 border-white/10">
                  <CardHeader>
                    <CardTitle className="text-white flex items-center space-x-2">
                      <Globe className="w-5 h-5" />
                      <span>Legal & Compliance</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="text-sm text-white/70 space-y-2">
                      <p>
                        <strong className="text-white">Data Processing:</strong> We process your sensor data locally on your device whenever possible, minimizing cloud processing.
                      </p>
                      <p>
                        <strong className="text-white">Data Retention:</strong> GPS data is retained for 30 days, sensor data for 7 days, and can be deleted immediately upon request.
                      </p>
                      <p>
                        <strong className="text-white">Third Parties:</strong> We never sell your personal data. Limited sharing occurs only with explicit consent for essential services.
                      </p>
                      <p>
                        <strong className="text-white">Your Rights:</strong> You have the right to access, correct, port, and delete your data at any time.
                      </p>
                    </div>
                    <Separator className="bg-white/10" />
                    <div className="flex space-x-4 text-sm">
                      <Button variant="ghost" size="sm" className="text-blue-400 hover:text-blue-300">
                        Privacy Policy
                      </Button>
                      <Button variant="ghost" size="sm" className="text-blue-400 hover:text-blue-300">
                        Terms of Service
                      </Button>
                      <Button variant="ghost" size="sm" className="text-blue-400 hover:text-blue-300">
                        Contact Privacy Team
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between mt-6 pt-4 border-t border-white/10">
            <div className="text-xs text-white/50">
              Last updated: {new Date().toLocaleDateString()}
            </div>
            <div className="flex items-center space-x-2">
              <div className="flex items-center space-x-1 text-xs text-green-400">
                <CheckCircle className="w-3 h-3" />
                <span>Secure</span>
              </div>
              <div className="flex items-center space-x-1 text-xs text-blue-400">
                <Lock className="w-3 h-3" />
                <span>Encrypted</span>
              </div>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}