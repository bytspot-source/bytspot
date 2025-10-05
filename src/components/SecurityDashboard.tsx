import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Shield, 
  Lock, 
  Eye, 
  AlertTriangle, 
  CheckCircle, 
  XCircle, 
  Activity, 
  Zap, 
  Database, 
  Globe, 
  MapPin, 
  Wifi, 
  Bluetooth, 
  Smartphone,
  Clock,
  TrendingUp,
  TrendingDown,
  BarChart3,
  PieChart,
  Settings,
  RefreshCw,
  WifiOff,
  ShieldCheck,
  ShieldAlert,
  Timer,
  Target
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Progress } from './ui/progress';

interface SecurityMetric {
  id: string;
  name: string;
  value: number;
  maxValue: number;
  status: 'secure' | 'warning' | 'critical';
  trend: 'up' | 'down' | 'stable';
  description: string;
  lastUpdated: Date;
}

interface DataFlow {
  id: string;
  type: 'GPS' | 'WiFi' | 'BLE' | 'IMU';
  source: string;
  destination: string;
  bytesTransferred: number;
  encrypted: boolean;
  status: 'active' | 'idle' | 'blocked';
  timestamp: Date;
}

interface SecurityAlert {
  id: string;
  type: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
  timestamp: Date;
  resolved: boolean;
  actionRequired: boolean;
}

interface SecurityDashboardProps {
  isVisible: boolean;
  currentTheme: any;
  themeColors: any;
}

export function SecurityDashboard({ isVisible, currentTheme, themeColors }: SecurityDashboardProps) {
  const [securityMetrics, setSecurityMetrics] = useState<SecurityMetric[]>([
    {
      id: 'encryption',
      name: 'Data Encryption',
      value: 100,
      maxValue: 100,
      status: 'secure',
      trend: 'stable',
      description: 'All sensor data encrypted end-to-end',
      lastUpdated: new Date()
    },
    {
      id: 'privacy',
      name: 'Privacy Score',
      value: 94,
      maxValue: 100,
      status: 'secure',
      trend: 'up',
      description: 'Strong privacy protection with minimal data collection',
      lastUpdated: new Date(Date.now() - 1000 * 60 * 5)
    },
    {
      id: 'dataMinimization',
      name: 'Data Minimization',
      value: 89,
      maxValue: 100,
      status: 'secure',
      trend: 'stable',
      description: 'Collecting only essential data for app functionality',
      lastUpdated: new Date(Date.now() - 1000 * 60 * 10)
    },
    {
      id: 'retention',
      name: 'Data Retention',
      value: 76,
      maxValue: 100,
      status: 'warning',
      trend: 'down',
      description: 'Some data approaching retention limits',
      lastUpdated: new Date(Date.now() - 1000 * 60 * 15)
    }
  ]);

  const [dataFlows, setDataFlows] = useState<DataFlow[]>([
    {
      id: '1',
      type: 'GPS',
      source: 'Device GPS',
      destination: 'Local Processing',
      bytesTransferred: 2047,
      encrypted: true,
      status: 'active',
      timestamp: new Date(Date.now() - 1000 * 30)
    },
    {
      id: '2',
      type: 'WiFi',
      source: 'WiFi Scanner',
      destination: 'Venue Database',
      bytesTransferred: 524,
      encrypted: true,
      status: 'idle',
      timestamp: new Date(Date.now() - 1000 * 60 * 5)
    },
    {
      id: '3',
      type: 'BLE',
      source: 'Bluetooth Scanner',
      destination: 'Local Cache',
      bytesTransferred: 156,
      encrypted: true,
      status: 'blocked',
      timestamp: new Date(Date.now() - 1000 * 60 * 30)
    },
    {
      id: '4',
      type: 'IMU',
      source: 'Motion Sensors',
      destination: 'Activity Engine',
      bytesTransferred: 1024,
      encrypted: true,
      status: 'active',
      timestamp: new Date(Date.now() - 1000 * 60)
    }
  ]);

  const [securityAlerts, setSecurityAlerts] = useState<SecurityAlert[]>([
    {
      id: '1',
      type: 'info',
      title: 'Weekly Privacy Report Available',
      description: 'Your weekly data usage summary is ready for review',
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2),
      resolved: false,
      actionRequired: false
    },
    {
      id: '2',
      type: 'warning',
      title: 'Data Retention Notice',
      description: 'Some location data will be automatically deleted in 3 days',
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 6),
      resolved: false,
      actionRequired: false
    }
  ]);

  const [realTimeStats, setRealTimeStats] = useState({
    activeConnections: 3,
    encryptedDataFlows: 4,
    blockedAttempts: 0,
    privacyScore: 94
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'secure': return 'text-green-400 bg-green-500/20 border-green-500/30';
      case 'warning': return 'text-yellow-400 bg-yellow-500/20 border-yellow-500/30';
      case 'critical': return 'text-red-400 bg-red-500/20 border-red-500/30';
      case 'active': return 'text-blue-400 bg-blue-500/20 border-blue-500/30';
      case 'idle': return 'text-gray-400 bg-gray-500/20 border-gray-500/30';
      case 'blocked': return 'text-red-400 bg-red-500/20 border-red-500/30';
      default: return 'text-gray-400 bg-gray-500/20 border-gray-500/30';
    }
  };

  const getTrendIcon = (trend: string) => {
    switch (trend) {
      case 'up': return <TrendingUp className="w-4 h-4 text-green-400" />;
      case 'down': return <TrendingDown className="w-4 h-4 text-red-400" />;
      case 'stable': return <Activity className="w-4 h-4 text-blue-400" />;
      default: return <Activity className="w-4 h-4 text-gray-400" />;
    }
  };

  const getSensorIcon = (type: string) => {
    switch (type) {
      case 'GPS': return <MapPin className="w-4 h-4" />;
      case 'WiFi': return <Wifi className="w-4 h-4" />;
      case 'BLE': return <Bluetooth className="w-4 h-4" />;
      case 'IMU': return <Activity className="w-4 h-4" />;
      default: return <Smartphone className="w-4 h-4" />;
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatTimeAgo = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    
    if (minutes < 60) return `${minutes}m ago`;
    return `${hours}h ago`;
  };

  // Simulate real-time updates
  useEffect(() => {
    if (!isVisible) return;

    const interval = setInterval(() => {
      // Update data flows
      setDataFlows(prev => prev.map(flow => ({
        ...flow,
        bytesTransferred: flow.status === 'active' 
          ? flow.bytesTransferred + Math.floor(Math.random() * 100)
          : flow.bytesTransferred,
        timestamp: flow.status === 'active' ? new Date() : flow.timestamp
      })));

      // Update real-time stats
      setRealTimeStats(prev => ({
        ...prev,
        activeConnections: Math.max(1, prev.activeConnections + (Math.random() > 0.5 ? 1 : -1)),
        privacyScore: Math.min(100, Math.max(85, prev.privacyScore + (Math.random() - 0.5) * 2))
      }));
    }, 3000);

    return () => clearInterval(interval);
  }, [isVisible]);

  if (!isVisible) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="space-y-6"
    >
      {/* Security Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <motion.div
          whileHover={{ scale: 1.02 }}
          className="glass-card p-4 rounded-xl border border-white/10"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="p-2 rounded-lg bg-green-500/20 text-green-400">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
            >
              <RefreshCw className="w-4 h-4 text-white/60" />
            </motion.div>
          </div>
          <h3 className="text-white font-medium mb-1">Security Status</h3>
          <div className="flex items-center space-x-2">
            <Badge className="text-xs text-green-400 bg-green-500/20 border-green-500/30">
              Secure
            </Badge>
            <span className="text-white/60 text-xs">All systems protected</span>
          </div>
        </motion.div>

        <motion.div
          whileHover={{ scale: 1.02 }}
          className="glass-card p-4 rounded-xl border border-white/10"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="p-2 rounded-lg bg-blue-500/20 text-blue-400">
              <Activity className="w-5 h-5" />
            </div>
            <span className="text-white/60 text-xs">Live</span>
          </div>
          <h3 className="text-white font-medium mb-1">Active Connections</h3>
          <div className="flex items-center space-x-2">
            <span className="text-white text-lg font-semibold">{realTimeStats.activeConnections}</span>
            <span className="text-white/60 text-xs">encrypted channels</span>
          </div>
        </motion.div>

        <motion.div
          whileHover={{ scale: 1.02 }}
          className="glass-card p-4 rounded-xl border border-white/10"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="p-2 rounded-lg bg-purple-500/20 text-purple-400">
              <Lock className="w-5 h-5" />
            </div>
            <div className="text-xs text-purple-400">100%</div>
          </div>
          <h3 className="text-white font-medium mb-1">Data Encryption</h3>
          <div className="w-full bg-white/10 rounded-full h-2">
            <div className="h-2 rounded-full bg-gradient-to-r from-purple-500 to-purple-400 w-full" />
          </div>
        </motion.div>

        <motion.div
          whileHover={{ scale: 1.02 }}
          className="glass-card p-4 rounded-xl border border-white/10"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="p-2 rounded-lg bg-emerald-500/20 text-emerald-400">
              <Eye className="w-5 h-5" />
            </div>
            <motion.div
              animate={{ scale: [1, 1.2, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
              className="text-xs text-emerald-400"
            >
              {realTimeStats.privacyScore}%
            </motion.div>
          </div>
          <h3 className="text-white font-medium mb-1">Privacy Score</h3>
          <div className="w-full bg-white/10 rounded-full h-2">
            <motion.div 
              className="h-2 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400"
              initial={{ width: 0 }}
              animate={{ width: `${realTimeStats.privacyScore}%` }}
              transition={{ duration: 1 }}
            />
          </div>
        </motion.div>
      </div>

      {/* Security Metrics */}
      <Card className="bg-white/5 border-white/10">
        <CardHeader>
          <CardTitle className="text-white flex items-center space-x-2">
            <BarChart3 className="w-5 h-5" />
            <span>Security Metrics</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {securityMetrics.map((metric, index) => (
            <motion.div
              key={metric.id}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.1 }}
              className="flex items-center justify-between p-3 bg-white/5 rounded-lg border border-white/10"
            >
              <div className="flex-1">
                <div className="flex items-center space-x-3 mb-2">
                  <h4 className="text-white font-medium">{metric.name}</h4>
                  <Badge className={`text-xs ${getStatusColor(metric.status)}`}>
                    {metric.status}
                  </Badge>
                  {getTrendIcon(metric.trend)}
                </div>
                <p className="text-white/60 text-sm mb-2">{metric.description}</p>
                <div className="flex items-center space-x-4">
                  <div className="flex-1">
                    <Progress 
                      value={metric.value} 
                      max={metric.maxValue}
                      className="h-2"
                    />
                  </div>
                  <span className="text-white/70 text-sm font-medium">
                    {metric.value}/{metric.maxValue}
                  </span>
                </div>
                <p className="text-white/50 text-xs mt-1">
                  Updated {formatTimeAgo(metric.lastUpdated)}
                </p>
              </div>
            </motion.div>
          ))}
        </CardContent>
      </Card>

      {/* Real-time Data Flows */}
      <Card className="bg-white/5 border-white/10">
        <CardHeader>
          <CardTitle className="text-white flex items-center space-x-2">
            <Globe className="w-5 h-5" />
            <span>Real-time Data Flows</span>
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
              className="ml-auto"
            >
              <RefreshCw className="w-4 h-4 text-blue-400" />
            </motion.div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3">
            {dataFlows.map((flow, index) => (
              <motion.div
                key={flow.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.1 }}
                className="flex items-center justify-between p-3 bg-white/5 rounded-lg border border-white/10"
              >
                <div className="flex items-center space-x-3">
                  <div className={`p-2 rounded-lg ${getStatusColor(flow.status)}`}>
                    {getSensorIcon(flow.type)}
                  </div>
                  <div>
                    <div className="flex items-center space-x-2">
                      <h5 className="text-white font-medium">{flow.type} Data</h5>
                      <Badge className={`text-xs ${getStatusColor(flow.status)}`}>
                        {flow.status}
                      </Badge>
                      {flow.encrypted && (
                        <div className="flex items-center space-x-1 text-green-400">
                          <Lock className="w-3 h-3" />
                          <span className="text-xs">Encrypted</span>
                        </div>
                      )}
                    </div>
                    <p className="text-white/60 text-sm">
                      {flow.source} → {flow.destination}
                    </p>
                    <div className="flex items-center space-x-4 text-xs text-white/50 mt-1">
                      <span>{formatBytes(flow.bytesTransferred)} transferred</span>
                      <span>•</span>
                      <span>{formatTimeAgo(flow.timestamp)}</span>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <motion.div
                    animate={flow.status === 'active' ? { scale: [1, 1.2, 1] } : {}}
                    transition={{ duration: 1, repeat: Infinity }}
                    className={`w-3 h-3 rounded-full ${
                      flow.status === 'active' ? 'bg-green-400' :
                      flow.status === 'idle' ? 'bg-gray-400' :
                      'bg-red-400'
                    }`}
                  />
                </div>
              </motion.div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Security Alerts */}
      <Card className="bg-white/5 border-white/10">
        <CardHeader>
          <CardTitle className="text-white flex items-center space-x-2">
            <AlertTriangle className="w-5 h-5" />
            <span>Security Alerts</span>
            <Badge className="text-xs text-blue-400 bg-blue-500/20">
              {securityAlerts.filter(a => !a.resolved).length} Active
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {securityAlerts.length === 0 ? (
            <div className="text-center py-8">
              <CheckCircle className="w-12 h-12 text-green-400 mx-auto mb-3" />
              <h4 className="text-white font-medium mb-2">All Clear</h4>
              <p className="text-white/60">No security alerts at this time</p>
            </div>
          ) : (
            <div className="space-y-3">
              {securityAlerts.map((alert, index) => (
                <motion.div
                  key={alert.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.1 }}
                  className={`p-3 rounded-lg border ${
                    alert.type === 'critical' ? 'bg-red-500/10 border-red-500/20' :
                    alert.type === 'warning' ? 'bg-yellow-500/10 border-yellow-500/20' :
                    'bg-blue-500/10 border-blue-500/20'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start space-x-3">
                      <div className={`p-1 rounded ${
                        alert.type === 'critical' ? 'bg-red-500/20 text-red-400' :
                        alert.type === 'warning' ? 'bg-yellow-500/20 text-yellow-400' :
                        'bg-blue-500/20 text-blue-400'
                      }`}>
                        {alert.type === 'critical' ? <XCircle className="w-4 h-4" /> :
                         alert.type === 'warning' ? <AlertTriangle className="w-4 h-4" /> :
                         <Shield className="w-4 h-4" />}
                      </div>
                      <div>
                        <h5 className="text-white font-medium">{alert.title}</h5>
                        <p className="text-white/70 text-sm mt-1">{alert.description}</p>
                        <p className="text-white/50 text-xs mt-2">
                          {formatTimeAgo(alert.timestamp)}
                        </p>
                      </div>
                    </div>
                    {alert.actionRequired && (
                      <Button size="sm" variant="outline" className="text-white border-white/20">
                        Review
                      </Button>
                    )}
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Data Protection Summary */}
      <Card className="bg-white/5 border-white/10">
        <CardHeader>
          <CardTitle className="text-white flex items-center space-x-2">
            <Database className="w-5 h-5" />
            <span>Data Protection Summary</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="text-center p-4 bg-white/5 rounded-lg border border-white/10">
              <div className="p-3 rounded-full bg-green-500/20 text-green-400 w-fit mx-auto mb-3">
                <Lock className="w-6 h-6" />
              </div>
              <h4 className="text-white font-medium mb-1">Encryption</h4>
              <p className="text-white/60 text-sm">End-to-end encryption for all sensor data</p>
            </div>
            
            <div className="text-center p-4 bg-white/5 rounded-lg border border-white/10">
              <div className="p-3 rounded-full bg-blue-500/20 text-blue-400 w-fit mx-auto mb-3">
                <Timer className="w-6 h-6" />
              </div>
              <h4 className="text-white font-medium mb-1">Retention</h4>
              <p className="text-white/60 text-sm">Automatic deletion based on data type</p>
            </div>
            
            <div className="text-center p-4 bg-white/5 rounded-lg border border-white/10">
              <div className="p-3 rounded-full bg-purple-500/20 text-purple-400 w-fit mx-auto mb-3">
                <Target className="w-6 h-6" />
              </div>
              <h4 className="text-white font-medium mb-1">Minimization</h4>
              <p className="text-white/60 text-sm">Only essential data collection</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}