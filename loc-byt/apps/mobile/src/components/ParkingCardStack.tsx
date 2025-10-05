import React from 'react';
import { View, Text, Image, TouchableOpacity, ScrollView } from 'react-native';
import { useTheme } from '../theme';

export interface ParkingSpot {
  id: string;
  name: string;
  imageUrl: string;
  availableSpots: number;
  totalSpots: number;
  securityLevel: 'Basic' | 'Premium' | 'Ultra';
  hourlyPrice: number;
  surgeMultiplier?: number;
  walkingDistance: number; // in minutes
  neighborhood: string;
  features: string[];
  covered: boolean;
  evCharging: boolean;
  accessibility: boolean;
  securityCameras: boolean;
  valetAvailable: boolean;
}

interface ParkingCardStackProps {
  data: ParkingSpot;
  onPress: () => void;
}

export default function ParkingCardStack({ data, onPress }: ParkingCardStackProps) {
  const theme = useTheme();
  
  const getAvailabilityColor = () => {
    const percentage = (data.availableSpots / data.totalSpots) * 100;
    if (percentage > 50) return '#22c55e'; // Green
    if (percentage > 25) return '#f59e0b'; // Yellow
    return '#ef4444'; // Red
  };

  const getSecurityColor = () => {
    switch (data.securityLevel) {
      case 'Ultra': return '#8b5cf6'; // Purple
      case 'Premium': return '#3b82f6'; // Blue
      case 'Basic': return '#6b7280'; // Gray
      default: return '#6b7280';
    }
  };

  const getCurrentPrice = () => {
    const basePrice = data.hourlyPrice;
    const surgePrice = data.surgeMultiplier ? basePrice * data.surgeMultiplier : basePrice;
    return surgePrice;
  };

  const renderFeatureBadge = (feature: string) => (
    <View key={feature} style={{
      backgroundColor: theme.color?.border || '#333',
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 12,
      marginRight: 6,
      marginBottom: 4
    }}>
      <Text style={{
        color: theme.color?.text || '#fff',
        fontSize: 10,
        fontWeight: '500'
      }}>
        {feature}
      </Text>
    </View>
  );

  return (
    <TouchableOpacity 
      style={{
        flex: 1,
        backgroundColor: theme.color?.bg || '#0b0b0b',
        borderRadius: theme.radius?.md || 8,
        overflow: 'hidden'
      }}
      onPress={onPress}
      activeOpacity={0.9}
    >
      {/* Hero Image */}
      <View style={{ height: 200, position: 'relative' }}>
        <Image 
          source={{ uri: data.imageUrl || 'https://via.placeholder.com/400x200/333/fff?text=Parking' }}
          style={{ width: '100%', height: '100%' }}
          resizeMode="cover"
        />
        
        {/* Availability Badge */}
        <View style={{
          position: 'absolute',
          top: 12,
          right: 12,
          backgroundColor: getAvailabilityColor(),
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 16,
          flexDirection: 'row',
          alignItems: 'center'
        }}>
          <View style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: '#fff',
            marginRight: 6
          }} />
          <Text style={{
            color: '#fff',
            fontSize: 12,
            fontWeight: '600'
          }}>
            {data.availableSpots}/{data.totalSpots}
          </Text>
        </View>

        {/* Security Level Badge */}
        <View style={{
          position: 'absolute',
          top: 12,
          left: 12,
          backgroundColor: getSecurityColor(),
          paddingHorizontal: 10,
          paddingVertical: 4,
          borderRadius: 12
        }}>
          <Text style={{
            color: '#fff',
            fontSize: 11,
            fontWeight: '600'
          }}>
            {data.securityLevel}
          </Text>
        </View>

        {/* Surge Pricing Indicator */}
        {data.surgeMultiplier && data.surgeMultiplier > 1 && (
          <View style={{
            position: 'absolute',
            bottom: 12,
            right: 12,
            backgroundColor: '#ef4444',
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 8
          }}>
            <Text style={{
              color: '#fff',
              fontSize: 10,
              fontWeight: '600'
            }}>
              {data.surgeMultiplier}x SURGE
            </Text>
          </View>
        )}
      </View>

      {/* Content */}
      <ScrollView style={{ flex: 1, padding: 16 }}>
        {/* Title and Location */}
        <Text style={{
          color: theme.color?.text || '#fff',
          fontSize: 18,
          fontWeight: '700',
          marginBottom: 4
        }}>
          {data.name}
        </Text>
        
        <Text style={{
          color: theme.color?.muted || '#bbb',
          fontSize: 14,
          marginBottom: 12
        }}>
          {data.neighborhood} • {data.walkingDistance} min walk
        </Text>

        {/* Pricing */}
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          marginBottom: 16
        }}>
          <Text style={{
            color: theme.color?.accent || '#22c55e',
            fontSize: 24,
            fontWeight: '700'
          }}>
            ${getCurrentPrice().toFixed(2)}
          </Text>
          <Text style={{
            color: theme.color?.muted || '#bbb',
            fontSize: 14,
            marginLeft: 4
          }}>
            /hour
          </Text>
          {data.surgeMultiplier && data.surgeMultiplier > 1 && (
            <Text style={{
              color: '#ef4444',
              fontSize: 12,
              marginLeft: 8,
              textDecorationLine: 'line-through'
            }}>
              ${data.hourlyPrice.toFixed(2)}
            </Text>
          )}
        </View>

        {/* Feature Badges */}
        <View style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          marginBottom: 16
        }}>
          {data.covered && renderFeatureBadge('Covered')}
          {data.securityCameras && renderFeatureBadge('Security Cameras')}
          {data.evCharging && renderFeatureBadge('EV Charging')}
          {data.accessibility && renderFeatureBadge('Accessible')}
          {data.valetAvailable && renderFeatureBadge('Valet Available')}
          {data.features.map(feature => renderFeatureBadge(feature))}
        </View>

        {/* Quick Stats */}
        <View style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingTop: 16,
          borderTopWidth: 1,
          borderTopColor: theme.color?.border || '#333'
        }}>
          <View style={{ alignItems: 'center' }}>
            <Text style={{
              color: theme.color?.muted || '#bbb',
              fontSize: 12
            }}>
              Available
            </Text>
            <Text style={{
              color: getAvailabilityColor(),
              fontSize: 16,
              fontWeight: '600'
            }}>
              {data.availableSpots}
            </Text>
          </View>
          
          <View style={{ alignItems: 'center' }}>
            <Text style={{
              color: theme.color?.muted || '#bbb',
              fontSize: 12
            }}>
              Security
            </Text>
            <Text style={{
              color: getSecurityColor(),
              fontSize: 16,
              fontWeight: '600'
            }}>
              {data.securityLevel}
            </Text>
          </View>
          
          <View style={{ alignItems: 'center' }}>
            <Text style={{
              color: theme.color?.muted || '#bbb',
              fontSize: 12
            }}>
              Walk
            </Text>
            <Text style={{
              color: theme.color?.text || '#fff',
              fontSize: 16,
              fontWeight: '600'
            }}>
              {data.walkingDistance}m
            </Text>
          </View>
        </View>
      </ScrollView>
    </TouchableOpacity>
  );
}
