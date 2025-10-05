import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Dimensions, Alert, Modal } from 'react-native';
import MapView, { Marker, Circle, Callout } from 'react-native-maps';
import * as Location from 'expo-location';
import { useTheme } from '../theme';
import { track } from '../analytics';
import { getSocket } from '../realtime/socket';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

interface MapLocation {
  id: string;
  type: 'parking' | 'venue' | 'valet' | 'ev_charging';
  title: string;
  subtitle?: string;
  coordinate: {
    latitude: number;
    longitude: number;
  };
  availability?: number; // 0-100 percentage
  price?: number;
  rating?: number;
  features?: string[];
}

interface FilterState {
  priceRange: [number, number];
  securityLevel: string[];
  features: string[];
  showRadius: boolean;
  radiusDistance: number; // in miles
}

const MOCK_LOCATIONS: MapLocation[] = [
  {
    id: 'parking_1',
    type: 'parking',
    title: 'Downtown Garage',
    subtitle: '$15/hr • 23 spots available',
    coordinate: { latitude: 37.7749, longitude: -122.4194 },
    availability: 75,
    price: 15,
    features: ['Covered', 'Security Cameras', 'EV Charging']
  },
  {
    id: 'venue_1',
    type: 'venue',
    title: 'The Rooftop Bar',
    subtitle: 'Cocktails • 4.8★ • Open',
    coordinate: { latitude: 37.7849, longitude: -122.4094 },
    rating: 4.8,
    features: ['Live Music', 'Outdoor Seating']
  },
  {
    id: 'valet_1',
    type: 'valet',
    title: 'Premium Valet',
    subtitle: '$25/hr • Available',
    coordinate: { latitude: 37.7649, longitude: -122.4294 },
    price: 25,
    features: ['Insured', 'Background Checked']
  },
  {
    id: 'ev_1',
    type: 'ev_charging',
    title: 'Tesla Supercharger',
    subtitle: '8 stalls • 2 available',
    coordinate: { latitude: 37.7549, longitude: -122.4394 },
    availability: 25,
    features: ['Tesla', 'CCS', 'Fast Charging']
  }
];

interface MapInterfaceProps {
  onLocationSelect?: (location: MapLocation) => void;
  onNavigate?: (location: MapLocation) => void;
  onReserve?: (location: MapLocation) => void;
}

export default function MapInterface({ onLocationSelect, onNavigate, onReserve }: MapInterfaceProps) {
  const theme = useTheme();
  const mapRef = useRef<MapView>(null);
  const [userLocation, setUserLocation] = useState<Location.LocationObject | null>(null);
  const [locations, setLocations] = useState<MapLocation[]>(MOCK_LOCATIONS);
  const [selectedLocation, setSelectedLocation] = useState<MapLocation | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<FilterState>({
    priceRange: [0, 100],
    securityLevel: [],
    features: [],
    showRadius: false,
    radiusDistance: 0.5
  });

  useEffect(() => {
    getCurrentLocation();
    setupRealtimeUpdates();
  }, []);

  const getCurrentLocation = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission denied', 'Location permission is required to show your position on the map.');
        return;
      }

      const location = await Location.getCurrentPositionAsync({});
      setUserLocation(location);
      
      // Center map on user location
      if (mapRef.current) {
        mapRef.current.animateToRegion({
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
          latitudeDelta: 0.01,
          longitudeDelta: 0.01
        });
      }
    } catch (error) {
      console.error('Error getting location:', error);
    }
  };

  const setupRealtimeUpdates = () => {
    const socket = getSocket();
    
    socket.on('location:availability_update', (update: { locationId: string; availability: number }) => {
      setLocations(prev => prev.map(loc => 
        loc.id === update.locationId 
          ? { ...loc, availability: update.availability }
          : loc
      ));
    });

    return () => {
      socket.off('location:availability_update');
    };
  };

  const getMarkerColor = (location: MapLocation) => {
    switch (location.type) {
      case 'parking':
        if (!location.availability) return '#6b7280'; // Gray
        if (location.availability > 50) return '#22c55e'; // Green
        if (location.availability > 25) return '#f59e0b'; // Yellow
        return '#ef4444'; // Red
      case 'venue':
        return '#8b5cf6'; // Purple
      case 'valet':
        return '#3b82f6'; // Blue
      case 'ev_charging':
        return '#10b981'; // Emerald
      default:
        return '#6b7280';
    }
  };

  const getMarkerIcon = (type: string) => {
    switch (type) {
      case 'parking': return '🅿️';
      case 'venue': return '🏢';
      case 'valet': return '🚗';
      case 'ev_charging': return '⚡';
      default: return '📍';
    }
  };

  const handleMarkerPress = (location: MapLocation) => {
    setSelectedLocation(location);
    onLocationSelect?.(location);
    track('map_marker_tapped', { 
      locationType: location.type, 
      locationId: location.id 
    });
  };

  const handleNavigate = (location: MapLocation) => {
    onNavigate?.(location);
    track('map_navigate_pressed', { 
      locationType: location.type, 
      locationId: location.id 
    });
  };

  const handleReserve = (location: MapLocation) => {
    onReserve?.(location);
    track('map_reserve_pressed', { 
      locationType: location.type, 
      locationId: location.id 
    });
  };

  const renderMarker = (location: MapLocation) => (
    <Marker
      key={location.id}
      coordinate={location.coordinate}
      onPress={() => handleMarkerPress(location)}
      pinColor={getMarkerColor(location)}
    >
      <View style={{
        backgroundColor: getMarkerColor(location),
        borderRadius: 20,
        padding: 8,
        borderWidth: 2,
        borderColor: '#fff',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
        elevation: 5
      }}>
        <Text style={{ fontSize: 16 }}>
          {getMarkerIcon(location.type)}
        </Text>
      </View>
      
      <Callout>
        <View style={{ width: 200, padding: 8 }}>
          <Text style={{ fontWeight: '700', fontSize: 14, marginBottom: 4 }}>
            {location.title}
          </Text>
          {location.subtitle && (
            <Text style={{ color: '#666', fontSize: 12, marginBottom: 8 }}>
              {location.subtitle}
            </Text>
          )}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              style={{
                backgroundColor: '#3b82f6',
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 6,
                flex: 1,
                alignItems: 'center'
              }}
              onPress={() => handleNavigate(location)}
            >
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>
                Navigate
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{
                backgroundColor: '#22c55e',
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 6,
                flex: 1,
                alignItems: 'center'
              }}
              onPress={() => handleReserve(location)}
            >
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>
                Reserve
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Callout>
    </Marker>
  );

  const renderRadiusCircle = () => {
    if (!filters.showRadius || !userLocation) return null;
    
    return (
      <Circle
        center={{
          latitude: userLocation.coords.latitude,
          longitude: userLocation.coords.longitude
        }}
        radius={filters.radiusDistance * 1609.34} // Convert miles to meters
        strokeColor="rgba(34, 197, 94, 0.5)"
        fillColor="rgba(34, 197, 94, 0.1)"
        strokeWidth={2}
      />
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.color?.bg || '#0b0b0b' }}>
      <MapView
        ref={mapRef}
        style={{ flex: 1 }}
        initialRegion={{
          latitude: 37.7749,
          longitude: -122.4194,
          latitudeDelta: 0.01,
          longitudeDelta: 0.01
        }}
        showsUserLocation
        showsMyLocationButton={false}
        showsCompass={false}
        showsScale
      >
        {locations.map(renderMarker)}
        {renderRadiusCircle()}
      </MapView>

      {/* Filter Toggle Button */}
      <TouchableOpacity
        style={{
          position: 'absolute',
          top: 50,
          right: 16,
          backgroundColor: theme.color?.accent || '#22c55e',
          borderRadius: 20,
          paddingHorizontal: 16,
          paddingVertical: 8,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.3,
          shadowRadius: 4,
          elevation: 5
        }}
        onPress={() => setShowFilters(!showFilters)}
      >
        <Text style={{
          color: '#000',
          fontWeight: '600',
          fontSize: 14
        }}>
          Filters
        </Text>
      </TouchableOpacity>

      {/* Recenter Button */}
      <TouchableOpacity
        style={{
          position: 'absolute',
          bottom: 100,
          right: 16,
          backgroundColor: '#fff',
          borderRadius: 20,
          paddingHorizontal: 16,
          paddingVertical: 8,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.3,
          shadowRadius: 4,
          elevation: 5
        }}
        onPress={getCurrentLocation}
      >
        <Text style={{
          color: '#000',
          fontWeight: '600',
          fontSize: 14
        }}>
          📍 Recenter
        </Text>
      </TouchableOpacity>

      {/* Filter Modal */}
      <Modal
        visible={showFilters}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowFilters(false)}
      >
        <View style={{
          flex: 1,
          backgroundColor: theme.color?.bg || '#0b0b0b',
          padding: 20
        }}>
          <Text style={{
            color: theme.color?.text || '#fff',
            fontSize: 24,
            fontWeight: '700',
            marginBottom: 20
          }}>
            Map Filters
          </Text>
          
          {/* Filter options would go here */}
          <Text style={{
            color: theme.color?.muted || '#bbb',
            fontSize: 16,
            marginBottom: 20
          }}>
            Filter options coming soon...
          </Text>

          <TouchableOpacity
            style={{
              backgroundColor: theme.color?.accent || '#22c55e',
              paddingVertical: 16,
              borderRadius: 12,
              alignItems: 'center',
              marginTop: 'auto'
            }}
            onPress={() => setShowFilters(false)}
          >
            <Text style={{
              color: '#000',
              fontSize: 16,
              fontWeight: '700'
            }}>
              Apply Filters
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}
