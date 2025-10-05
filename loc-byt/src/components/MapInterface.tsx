import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, MapPin, Navigation, Car, UtensilsCrossed, Users, Star, Clock, Phone, Globe, X, Zap, Shield, DollarSign, Camera, Activity, TrendingUp, Heart, ThumbsUp, Share2, Bookmark, Filter, Search, Layers, Menu } from 'lucide-react';

// Pure mockup interfaces - no external API dependencies
interface MockVenue {
  id: string;
  name: string;
  category: 'parking' | 'venue' | 'valet';
  status: 'trending' | 'prime' | 'available' | 'limited';
  vibe: 'energetic' | 'quiet' | 'social' | 'premium';
  price: string;
  rating: number;
  distance: string;
  features: string[];
  x: number; // Position on mockup map (percentage)
  y: number; // Position on mockup map (percentage)
  trending_score: number;
  real_time_activity: number;
  ai_confidence: number;
  description: string;
  address: string;
  isOpen: boolean;
}

interface MapInterfaceProps {
  onBack: () => void;
  userData?: any;
  currentTheme?: string;
  weatherTheme?: string;
  locationTheme?: string;
  className?: string;
}

const MapInterface: React.FC<MapInterfaceProps> = ({
  onBack,
  userData,
  currentTheme = 'modern',
  weatherTheme = 'clear',
  locationTheme = 'urban',
  className = ''
}) => {
  const [selectedVenue, setSelectedVenue] = useState<MockVenue | null>(null);
  const [activeFilter, setActiveFilter] = useState<'all' | 'parking' | 'venue' | 'valet'>('all');
  const [viewMode, setViewMode] = useState<'map' | 'list'>('map');
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [mapZoom, setMapZoom] = useState(14);
  const [userLocation] = useState({ x: 50, y: 50 }); // Mock user location at center

  // Mock venues data with realistic positioning
  const [venues] = useState<MockVenue[]>([
    {
      id: '1',
      name: 'Premium Garage Downtown',
      category: 'parking',
      status: 'prime',
      vibe: 'premium',
      price: '$15/hr',
      rating: 4.8,
      distance: '0.2 mi',
      features: ['Covered', 'Security', 'EV Charging'],
      x: 45,
      y: 35,
      trending_score: 85,
      real_time_activity: 78,
      ai_confidence: 92,
      description: 'Secure covered parking with premium amenities',
      address: '123 Financial Plaza, Downtown',
      isOpen: true
    },
    {
      id: '2',
      name: 'Street Parking Zone A',
      category: 'parking',
      status: 'available',
      vibe: 'quiet',
      price: '$6/hr',
      rating: 4.2,
      distance: '0.1 mi',
      features: ['Well-lit', 'Mobile Payment'],
      x: 32,
      y: 48,
      trending_score: 45,
      real_time_activity: 34,
      ai_confidence: 76,
      description: 'Convenient street parking near main attractions',
      address: '456 Main Street',
      isOpen: true
    },
    {
      id: '3',
      name: 'Skyline Rooftop Bar',
      category: 'venue',
      status: 'trending',
      vibe: 'energetic',
      price: '$35/person',
      rating: 4.9,
      distance: '0.3 mi',
      features: ['City Views', 'Live Music', 'Craft Cocktails'],
      x: 65,
      y: 28,
      trending_score: 95,
      real_time_activity: 88,
      ai_confidence: 94,
      description: 'Stunning city views with live entertainment',
      address: '789 High Street, 25th Floor',
      isOpen: true
    },
    {
      id: '4',
      name: 'Cozy Coffee Corner',
      category: 'venue',
      status: 'available',
      vibe: 'quiet',
      price: '$12/person',
      rating: 4.6,
      distance: '0.4 mi',
      features: ['WiFi', 'Study Space', 'Local Roast'],
      x: 28,
      y: 62,
      trending_score: 68,
      real_time_activity: 45,
      ai_confidence: 82,
      description: 'Perfect spot for work or relaxation',
      address: '321 Café Lane',
      isOpen: true
    },
    {
      id: '5',
      name: 'Elite Valet Service',
      category: 'valet',
      status: 'prime',
      vibe: 'premium',
      price: '$25/hr',
      rating: 4.7,
      distance: '0.2 mi',
      features: ['White Glove', '24/7 Service', 'Car Care'],
      x: 58,
      y: 42,
      trending_score: 78,
      real_time_activity: 67,
      ai_confidence: 89,
      description: 'Premium valet service with car care',
      address: '555 Luxury Ave',
      isOpen: true
    },
    {
      id: '6',
      name: 'Underground Art Gallery',
      category: 'venue',
      status: 'trending',
      vibe: 'social',
      price: '$18/person',
      rating: 4.8,
      distance: '0.5 mi',
      features: ['Local Art', 'Photography', 'Events'],
      x: 72,
      y: 55,
      trending_score: 86,
      real_time_activity: 72,
      ai_confidence: 88,
      description: 'Local art scene with rotating exhibitions',
      address: '111 Culture Street',
      isOpen: false
    },
    {
      id: '7',
      name: 'Tech Hub Parking',
      category: 'parking',
      status: 'limited',
      vibe: 'quiet',
      price: '$8/hr',
      rating: 4.3,
      distance: '0.6 mi',
      features: ['Near Metro', 'Covered', 'Safe'],
      x: 82,
      y: 38,
      trending_score: 58,
      real_time_activity: 42,
      ai_confidence: 74,
      description: 'Convenient parking near tech district',
      address: '999 Innovation Drive',
      isOpen: true
    },
    {
      id: '8',
      name: 'White Glove Valet',
      category: 'valet',
      status: 'available',
      vibe: 'premium',
      price: '$30/hr',
      rating: 4.9,
      distance: '0.3 mi',
      features: ['Luxury Service', 'Car Wash', 'Concierge'],
      x: 38,
      y: 25,
      trending_score: 81,
      real_time_activity: 59,
      ai_confidence: 91,
      description: 'Ultimate luxury valet experience',
      address: '777 Premium Plaza',
      isOpen: true
    }
  ]);

  // Filter venues based on active filter and search
  const filteredVenues = venues.filter(venue => {
    const matchesFilter = activeFilter === 'all' || venue.category === activeFilter;
    const matchesSearch = venue.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         venue.features.some(feature => feature.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesFilter && matchesSearch;
  });

  // Get marker color based on status
  const getMarkerColor = (venue: MockVenue) => {
    switch (venue.status) {
      case 'trending': return '#FF00FF';
      case 'prime': return '#00BFFF';
      case 'limited': return '#FFA500';
      default: return '#32CD32';
    }
  };

  // Get category icon
  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'parking': return Car;
      case 'venue': return UtensilsCrossed;
      case 'valet': return Users;
      default: return MapPin;
    }
  };

  // Mock streets and areas for visual map
  const mockStreets = [
    { x1: 10, y1: 30, x2: 90, y2: 35, name: 'Main Street' },
    { x1: 15, y1: 50, x2: 85, y2: 45, name: 'Commerce Ave' },
    { x1: 25, y1: 70, x2: 75, y2: 65, name: 'Broadway' },
    { x1: 40, y1: 10, x2: 45, y2: 90, name: 'Center St' },
    { x1: 60, y1: 15, x2: 65, y2: 85, name: 'Park Ave' }
  ];

  const mockAreas = [
    { x: 20, y: 20, width: 25, height: 20, name: 'Financial District', color: 'rgba(0, 191, 255, 0.1)' },
    { x: 55, y: 15, width: 30, height: 25, name: 'Arts District', color: 'rgba(255, 0, 255, 0.1)' },
    { x: 15, y: 55, width: 35, height: 25, name: 'Shopping Center', color: 'rgba(0, 128, 128, 0.1)' },
    { x: 65, y: 50, width: 25, height: 30, name: 'Entertainment', color: 'rgba(255, 69, 0, 0.1)' }
  ];

  // Zoom controls
  const handleZoomIn = () => {
    setMapZoom(prev => Math.min(prev + 1, 18));
  };

  const handleZoomOut = () => {
    setMapZoom(prev => Math.max(prev - 1, 10));
  };

  return (
    <div className={`min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] relative ${className}`}>
      {/* Header */}
      <motion.div
        className="absolute top-0 left-0 right-0 z-50 safe-area-top"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="flex items-center justify-between p-4 backdrop-blur-enhanced bg-black/40 border-b border-white/10">
          <motion.button
            onClick={onBack}
            className="w-10 h-10 rounded-full backdrop-blur-enhanced flex items-center justify-center border border-white/20 touch-target"
            style={{
              background: 'linear-gradient(135deg, rgba(18, 18, 18, 0.95) 0%, rgba(255, 0, 255, 0.1) 100%)',
            }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <ArrowLeft className="w-5 h-5 text-white" />
          </motion.button>

          <div className="text-center">
            <h1 className="text-white text-lg font-semibold">Live Map</h1>
            <p className="text-white/60 text-sm">AI-Powered Discovery</p>
          </div>

          <div className="flex items-center space-x-2">
            <motion.button
              onClick={() => setViewMode(viewMode === 'map' ? 'list' : 'map')}
              className="w-10 h-10 rounded-full backdrop-blur-enhanced flex items-center justify-center border border-white/20 touch-target"
              style={{
                background: viewMode === 'list' 
                  ? 'linear-gradient(135deg, rgba(0, 191, 255, 0.2) 0%, rgba(255, 0, 255, 0.1) 100%)'
                  : 'linear-gradient(135deg, rgba(18, 18, 18, 0.95) 0%, rgba(0, 191, 255, 0.1) 100%)',
              }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              {viewMode === 'map' ? <Layers className="w-5 h-5 text-white" /> : <MapPin className="w-5 h-5 text-white" />}
            </motion.button>

            <motion.button
              onClick={() => setShowFilters(!showFilters)}
              className="w-10 h-10 rounded-full backdrop-blur-enhanced flex items-center justify-center border border-white/20 touch-target relative"
              style={{
                background: showFilters 
                  ? 'linear-gradient(135deg, rgba(255, 0, 255, 0.2) 0%, rgba(0, 191, 255, 0.1) 100%)'
                  : 'linear-gradient(135deg, rgba(18, 18, 18, 0.95) 0%, rgba(255, 0, 255, 0.1) 100%)',
              }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <Filter className="w-5 h-5 text-white" />
              {filteredVenues.length !== venues.length && (
                <motion.div
                  className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-gradient-to-r from-[#00BFFF] to-[#FF00FF]"
                  animate={{
                    scale: [1, 1.2, 1],
                    opacity: [0.8, 1, 0.8]
                  }}
                  transition={{
                    duration: 2,
                    repeat: Infinity,
                    ease: "easeInOut"
                  }}
                />
              )}
            </motion.button>
          </div>
        </div>
      </motion.div>

      {/* Search and Filter Controls */}
      <motion.div
        className="absolute top-16 left-4 right-4 z-40 safe-area-top"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        {/* Search Bar */}
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-white/60" />
          <input
            type="text"
            placeholder="Search venues, parking..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-3 rounded-xl backdrop-blur-enhanced border border-white/20 bg-black/40 text-white placeholder-white/60 text-sm focus:outline-none focus:border-[#00BFFF]/50"
          />
        </div>

        {/* Category Filters */}
        <AnimatePresence>
          {showFilters && (
            <motion.div
              className="flex space-x-2 overflow-x-auto scrollbar-hide mb-3"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3 }}
            >
              {[
                { key: 'all', label: 'All Spots', icon: MapPin, count: venues.length },
                { key: 'parking', label: 'Parking', icon: Car, count: venues.filter(v => v.category === 'parking').length },
                { key: 'venue', label: 'Venues', icon: UtensilsCrossed, count: venues.filter(v => v.category === 'venue').length },
                { key: 'valet', label: 'Valet', icon: Users, count: venues.filter(v => v.category === 'valet').length }
              ].map(({ key, label, icon: Icon, count }) => (
                <motion.button
                  key={key}
                  onClick={() => setActiveFilter(key as typeof activeFilter)}
                  className={`flex-shrink-0 px-4 py-2 rounded-full backdrop-blur-enhanced border touch-target relative overflow-hidden ${
                    activeFilter === key 
                      ? 'border-[#00BFFF]/50 bg-[#00BFFF]/20' 
                      : 'border-white/20 bg-black/40'
                  } transition-all duration-300`}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  {activeFilter === key && (
                    <motion.div
                      className="absolute inset-0 bg-gradient-to-r from-[#00BFFF]/20 to-[#FF00FF]/10 rounded-full"
                      layoutId="activeFilter"
                      transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    />
                  )}
                  
                  <div className="flex items-center space-x-2 relative z-10">
                    <Icon className={`w-4 h-4 ${
                      activeFilter === key ? 'text-[#00BFFF]' : 'text-white/70'
                    }`} />
                    <span className={`text-sm font-medium ${
                      activeFilter === key ? 'text-[#00BFFF]' : 'text-white/70'
                    }`}>
                      {label}
                    </span>
                    {count > 0 && (
                      <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                        activeFilter === key 
                          ? 'bg-[#00BFFF]/30 text-[#00BFFF]' 
                          : 'bg-white/10 text-white/60'
                      }`}>
                        {count}
                      </span>
                    )}
                  </div>
                </motion.button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Main Content */}
      <div className="absolute inset-0 pt-32 pb-24 z-10">
        <AnimatePresence mode="wait">
          {viewMode === 'map' ? (
            /* Map View */
            <motion.div
              key="map"
              className="relative w-full h-full overflow-hidden"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.05 }}
              transition={{ duration: 0.4 }}
            >
              {/* Mock Map Background */}
              <div className="absolute inset-0 bg-gradient-to-br from-[#1a1a1a] to-[#0f0f0f] border border-white/10 rounded-xl mx-4 overflow-hidden">
                {/* Grid Pattern */}
                <div 
                  className="absolute inset-0 opacity-20"
                  style={{
                    backgroundImage: `
                      linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)
                    `,
                    backgroundSize: `${20 * (mapZoom / 14)}px ${20 * (mapZoom / 14)}px`
                  }}
                />

                {/* Areas */}
                {mockAreas.map((area, index) => (
                  <motion.div
                    key={index}
                    className="absolute rounded-lg border border-white/5"
                    style={{
                      left: `${area.x}%`,
                      top: `${area.y}%`,
                      width: `${area.width * (mapZoom / 14)}%`,
                      height: `${area.height * (mapZoom / 14)}%`,
                      backgroundColor: area.color,
                    }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: index * 0.1 }}
                  >
                    <div className="p-2">
                      <span className="text-xs text-white/60 font-medium">{area.name}</span>
                    </div>
                  </motion.div>
                ))}

                {/* Streets */}
                {mockStreets.map((street, index) => (
                  <motion.div
                    key={index}
                    className="absolute bg-white/10 rounded-full"
                    style={{
                      left: `${Math.min(street.x1, street.x2)}%`,
                      top: `${Math.min(street.y1, street.y2)}%`,
                      width: `${Math.abs(street.x2 - street.x1)}%`,
                      height: `${Math.max(Math.abs(street.y2 - street.y1), 0.5)}%`,
                      transform: `rotate(${Math.atan2(street.y2 - street.y1, street.x2 - street.x1) * 180 / Math.PI}deg)`,
                      transformOrigin: 'left center'
                    }}
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ delay: 0.5 + index * 0.1, duration: 0.8 }}
                  />
                ))}

                {/* User Location */}
                <motion.div
                  className="absolute w-4 h-4 -translate-x-1/2 -translate-y-1/2 z-20"
                  style={{ left: `${userLocation.x}%`, top: `${userLocation.y}%` }}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ delay: 1, type: "spring", stiffness: 400 }}
                >
                  <div className="w-full h-full rounded-full bg-[#00BFFF] border-2 border-white shadow-lg relative">
                    <motion.div
                      className="absolute inset-0 rounded-full border-2 border-[#00BFFF]"
                      animate={{ scale: [1, 2, 1], opacity: [0.8, 0, 0.8] }}
                      transition={{ duration: 2, repeat: Infinity }}
                    />
                  </div>
                </motion.div>

                {/* Venue Markers */}
                {filteredVenues.map((venue, index) => {
                  const Icon = getCategoryIcon(venue.category);
                  return (
                    <motion.div
                      key={venue.id}
                      className="absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer z-30"
                      style={{ 
                        left: `${venue.x}%`, 
                        top: `${venue.y}%`,
                        transform: `translate(-50%, -50%) scale(${mapZoom / 14})`
                      }}
                      initial={{ scale: 0, rotate: -180 }}
                      animate={{ scale: mapZoom / 14, rotate: 0 }}
                      transition={{ 
                        delay: 1.2 + index * 0.1, 
                        type: "spring", 
                        stiffness: 400,
                        damping: 15
                      }}
                      whileHover={{ scale: (mapZoom / 14) * 1.1, z: 50 }}
                      whileTap={{ scale: (mapZoom / 14) * 0.95 }}
                      onClick={() => setSelectedVenue(venue)}
                    >
                      {/* Pulsing ring for trending venues */}
                      {venue.status === 'trending' && (
                        <motion.div
                          className="absolute inset-0 rounded-full border-2"
                          style={{ borderColor: getMarkerColor(venue) }}
                          animate={{ 
                            scale: [1, 1.5, 1], 
                            opacity: [0.6, 0.2, 0.6] 
                          }}
                          transition={{ 
                            duration: 2, 
                            repeat: Infinity,
                            ease: "easeInOut"
                          }}
                        />
                      )}

                      {/* Main marker */}
                      <div 
                        className="w-10 h-10 rounded-full flex items-center justify-center shadow-lg relative"
                        style={{
                          background: `linear-gradient(135deg, ${getMarkerColor(venue)}, ${getMarkerColor(venue)}dd)`,
                          border: '2px solid rgba(255, 255, 255, 0.3)'
                        }}
                      >
                        <Icon className="w-5 h-5 text-white" />
                        
                        {/* AI confidence indicator */}
                        {venue.ai_confidence > 80 && (
                          <motion.div
                            className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-[#00BFFF] border border-white"
                            animate={{ 
                              scale: [1, 1.2, 1],
                              opacity: [1, 0.6, 1]
                            }}
                            transition={{ duration: 2, repeat: Infinity }}
                          />
                        )}

                        {/* Real-time activity indicator */}
                        {venue.real_time_activity > 60 && (
                          <motion.div
                            className="absolute -bottom-1 -right-1 w-2 h-2 rounded-full bg-[#FF00FF]"
                            animate={{ 
                              opacity: [0.8, 0.3, 0.8]
                            }}
                            transition={{ duration: 1, repeat: Infinity }}
                          />
                        )}
                      </div>

                      {/* Venue name tooltip */}
                      <motion.div
                        className="absolute top-full left-1/2 transform -translate-x-1/2 mt-1 px-2 py-1 bg-black/80 backdrop-blur-sm rounded text-xs text-white whitespace-nowrap"
                        initial={{ opacity: 0, y: -5 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 1.5 + index * 0.1 }}
                      >
                        {venue.name}
                      </motion.div>
                    </motion.div>
                  );
                })}

                {/* Zoom Controls */}
                <div className="absolute bottom-4 right-4 flex flex-col space-y-2 z-40">
                  <motion.button
                    onClick={handleZoomIn}
                    className="w-10 h-10 rounded-lg backdrop-blur-enhanced bg-black/40 border border-white/20 flex items-center justify-center text-white hover:bg-black/60 transition-colors"
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    disabled={mapZoom >= 18}
                  >
                    <span className="text-lg font-bold">+</span>
                  </motion.button>
                  <motion.button
                    onClick={handleZoomOut}
                    className="w-10 h-10 rounded-lg backdrop-blur-enhanced bg-black/40 border border-white/20 flex items-center justify-center text-white hover:bg-black/60 transition-colors"
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    disabled={mapZoom <= 10}
                  >
                    <span className="text-lg font-bold">−</span>
                  </motion.button>
                </div>
              </div>

              {/* Map Stats Overlay */}
              <motion.div
                className="absolute bottom-4 left-4 right-20"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 2 }}
              >
                <div className="backdrop-blur-enhanced rounded-xl p-3 border border-white/10 bg-black/40">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center space-x-2">
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
                      >
                        <Activity className="w-4 h-4 text-[#00BFFF]" />
                      </motion.div>
                      <span className="text-white text-sm font-medium">Live Intelligence</span>
                    </div>
                    <span className="text-xs text-white/60">
                      {filteredVenues.length} spots found
                    </span>
                  </div>
                  
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div className="text-center">
                      <div className="text-[#00BFFF] font-semibold">
                        {filteredVenues.filter(v => v.trending_score > 70).length}
                      </div>
                      <div className="text-white/60">Trending</div>
                    </div>
                    <div className="text-center">
                      <div className="text-[#FF00FF] font-semibold">
                        {Math.floor(filteredVenues.reduce((sum, v) => sum + v.real_time_activity, 0) / filteredVenues.length)}%
                      </div>
                      <div className="text-white/60">Activity</div>
                    </div>
                    <div className="text-center">
                      <div className="text-[#008080] font-semibold">
                        {Math.floor(filteredVenues.reduce((sum, v) => sum + v.ai_confidence, 0) / filteredVenues.length)}%
                      </div>
                      <div className="text-white/60">AI Match</div>
                    </div>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          ) : (
            /* List View */
            <motion.div
              key="list"
              className="w-full h-full overflow-y-auto px-4"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.4 }}
            >
              <div className="space-y-4">
                {filteredVenues.map((venue, index) => {
                  const Icon = getCategoryIcon(venue.category);
                  return (
                    <motion.div
                      key={venue.id}
                      className="bg-white/5 backdrop-blur-sm rounded-xl p-4 border border-white/10 cursor-pointer"
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.1 }}
                      whileHover={{ scale: 1.02, backgroundColor: 'rgba(255, 255, 255, 0.08)' }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setSelectedVenue(venue)}
                    >
                      <div className="flex items-start space-x-3">
                        <div 
                          className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0"
                          style={{
                            background: `linear-gradient(135deg, ${getMarkerColor(venue)}, ${getMarkerColor(venue)}dd)`
                          }}
                        >
                          <Icon className="w-6 h-6 text-white" />
                        </div>
                        
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center space-x-2 mb-1">
                            <h3 className="text-white font-medium text-sm truncate">{venue.name}</h3>
                            <span className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${
                              venue.status === 'trending' ? 'bg-[#FF00FF]/20 text-[#FF00FF]' :
                              venue.status === 'prime' ? 'bg-[#00BFFF]/20 text-[#00BFFF]' :
                              venue.status === 'limited' ? 'bg-orange-500/20 text-orange-400' :
                              'bg-green-500/20 text-green-400'
                            }`}>
                              {venue.status}
                            </span>
                            {!venue.isOpen && (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 flex-shrink-0">
                                Closed
                              </span>
                            )}
                          </div>
                          
                          <div className="flex items-center space-x-3 text-xs text-white/60 mb-2">
                            <span>{venue.distance}</span>
                            <span>{venue.price}</span>
                            <div className="flex items-center space-x-1">
                              <Star className="w-3 h-3 text-yellow-400 fill-current" />
                              <span>{venue.rating}</span>
                            </div>
                          </div>
                          
                          <p className="text-xs text-white/70 mb-2">{venue.description}</p>
                          
                          <div className="flex items-center space-x-2 mb-2">
                            <div className="flex-1 bg-white/10 rounded-full h-1.5">
                              <div 
                                className="h-full bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] rounded-full transition-all duration-1000"
                                style={{ width: `${venue.ai_confidence}%` }}
                              />
                            </div>
                            <span className="text-xs text-[#00BFFF] flex-shrink-0">AI: {venue.ai_confidence}%</span>
                          </div>

                          <div className="flex flex-wrap gap-1">
                            {venue.features.slice(0, 3).map((feature, idx) => (
                              <span 
                                key={idx}
                                className="text-xs px-2 py-0.5 rounded bg-white/10 text-white/70"
                              >
                                {feature}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}

                {filteredVenues.length === 0 && (
                  <div className="text-center py-12">
                    <MapPin className="w-12 h-12 text-white/40 mx-auto mb-4" />
                    <h3 className="text-white/60 text-lg mb-2">No spots found</h3>
                    <p className="text-white/40 text-sm">Try adjusting your search or filters</p>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Venue Details Modal */}
      <AnimatePresence>
        {selectedVenue && (
          <motion.div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSelectedVenue(null)}
          >
            <motion.div
              className="bg-gradient-to-br from-[#121212] to-[#1a1a1a] rounded-t-2xl p-6 w-full max-w-md mx-4 mb-4 border border-white/10 safe-area-bottom"
              initial={{ y: 300 }}
              animate={{ y: 0 }}
              exit={{ y: 300 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-white text-lg font-semibold">{selectedVenue.name}</h3>
                <button
                  onClick={() => setSelectedVenue(null)}
                  className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center hover:bg-white/20 transition-colors"
                >
                  <X className="w-4 h-4 text-white" />
                </button>
              </div>
              
              <div className="space-y-4">
                <div className="flex items-center space-x-4">
                  <div 
                    className="w-12 h-12 rounded-full flex items-center justify-center"
                    style={{
                      background: `linear-gradient(135deg, ${getMarkerColor(selectedVenue)}, ${getMarkerColor(selectedVenue)}dd)`
                    }}
                  >
                    {React.createElement(getCategoryIcon(selectedVenue.category), { className: "w-6 h-6 text-white" })}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center space-x-2 mb-1">
                      <span className="text-white/70 text-sm">{selectedVenue.distance}</span>
                      <span className="text-white font-medium">{selectedVenue.price}</span>
                      {!selectedVenue.isOpen && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">
                          Closed
                        </span>
                      )}
                    </div>
                    <div className="flex items-center space-x-1 mb-1">
                      <Star className="w-4 h-4 text-yellow-400 fill-current" />
                      <span className="text-white text-sm">{selectedVenue.rating}/5</span>
                    </div>
                    <p className="text-xs text-white/60">{selectedVenue.address}</p>
                  </div>
                </div>

                <p className="text-white/80 text-sm">{selectedVenue.description}</p>

                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="bg-white/5 rounded-lg p-2">
                    <div className="text-[#00BFFF] font-semibold">{selectedVenue.trending_score}%</div>
                    <div className="text-white/60">Trending</div>
                  </div>
                  <div className="bg-white/5 rounded-lg p-2">
                    <div className="text-[#FF00FF] font-semibold">{selectedVenue.real_time_activity}%</div>
                    <div className="text-white/60">Activity</div>
                  </div>
                  <div className="bg-white/5 rounded-lg p-2">
                    <div className="text-[#008080] font-semibold">{selectedVenue.ai_confidence}%</div>
                    <div className="text-white/60">AI Match</div>
                  </div>
                </div>

                <div>
                  <h4 className="text-white font-medium text-sm mb-2">Features</h4>
                  <div className="flex flex-wrap gap-2">
                    {selectedVenue.features.map((feature, idx) => (
                      <span 
                        key={idx}
                        className="text-xs px-3 py-1 rounded-full bg-white/10 text-white/70 border border-white/10"
                      >
                        {feature}
                      </span>
                    ))}
                  </div>
                </div>
                
                <div className="flex space-x-3 pt-4">
                  <motion.button
                    className="flex-1 py-3 bg-gradient-to-r from-[#00BFFF] to-[#008080] rounded-xl font-medium text-white disabled:opacity-50"
                    whileHover={{ scale: selectedVenue.isOpen ? 1.02 : 1 }}
                    whileTap={{ scale: selectedVenue.isOpen ? 0.98 : 1 }}
                    disabled={!selectedVenue.isOpen}
                    onClick={() => {
                      console.log('Get directions to:', selectedVenue.name);
                    }}
                  >
                    <div className="flex items-center justify-center space-x-2">
                      <Navigation className="w-4 h-4" />
                      <span>Directions</span>
                    </div>
                  </motion.button>
                  
                  <motion.button
                    className="flex-1 py-3 bg-gradient-to-r from-[#FF00FF] to-[#FF4500] rounded-xl font-medium text-white disabled:opacity-50"
                    whileHover={{ scale: selectedVenue.isOpen ? 1.02 : 1 }}
                    whileTap={{ scale: selectedVenue.isOpen ? 0.98 : 1 }}
                    disabled={!selectedVenue.isOpen}
                    onClick={() => {
                      console.log('Reserve:', selectedVenue.name);
                    }}
                  >
                    <div className="flex items-center justify-center space-x-2">
                      <Zap className="w-4 h-4" />
                      <span>{selectedVenue.isOpen ? 'Reserve' : 'Closed'}</span>
                    </div>
                  </motion.button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default MapInterface;