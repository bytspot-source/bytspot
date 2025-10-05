import React from 'react';
import { View, Text, Image, TouchableOpacity, ScrollView } from 'react-native';
import { useTheme } from '../theme';

export interface Venue {
  id: string;
  title: string;
  subtitle?: string;
  imageUrl: string;
  vibeScore: number; // 1-10 scale
  distance: number; // in miles
  travelTime: number; // in minutes
  priceRange: '$' | '$$' | '$$$' | '$$$$';
  rating: number; // 1-5 stars
  category: string;
  isOpen: boolean;
  crowdLevel: 'Low' | 'Medium' | 'High';
  features: string[];
  specialOffers?: string[];
}

interface VenueCardProps {
  data: Venue;
  onPress: () => void;
}

export default function VenueCard({ data, onPress }: VenueCardProps) {
  const theme = useTheme();
  
  const getVibeColor = () => {
    if (data.vibeScore >= 8) return '#22c55e'; // Green
    if (data.vibeScore >= 6) return '#f59e0b'; // Yellow
    if (data.vibeScore >= 4) return '#f97316'; // Orange
    return '#ef4444'; // Red
  };

  const getCrowdColor = () => {
    switch (data.crowdLevel) {
      case 'High': return '#ef4444'; // Red
      case 'Medium': return '#f59e0b'; // Yellow
      case 'Low': return '#22c55e'; // Green
      default: return '#6b7280'; // Gray
    }
  };

  const renderStars = (rating: number) => {
    const stars = [];
    for (let i = 1; i <= 5; i++) {
      stars.push(
        <Text key={i} style={{
          color: i <= rating ? '#fbbf24' : '#374151',
          fontSize: 14
        }}>
          ★
        </Text>
      );
    }
    return stars;
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
      <View style={{ height: 220, position: 'relative' }}>
        <Image 
          source={{ uri: data.imageUrl || 'https://via.placeholder.com/400x220/333/fff?text=Venue' }}
          style={{ width: '100%', height: '100%' }}
          resizeMode="cover"
        />
        
        {/* Vibe Score Badge */}
        <View style={{
          position: 'absolute',
          top: 12,
          right: 12,
          backgroundColor: getVibeColor(),
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 16,
          flexDirection: 'row',
          alignItems: 'center'
        }}>
          <Text style={{
            color: '#fff',
            fontSize: 12,
            fontWeight: '600',
            marginRight: 4
          }}>
            VIBE
          </Text>
          <Text style={{
            color: '#fff',
            fontSize: 14,
            fontWeight: '700'
          }}>
            {data.vibeScore}/10
          </Text>
        </View>

        {/* Open/Closed Status */}
        <View style={{
          position: 'absolute',
          top: 12,
          left: 12,
          backgroundColor: data.isOpen ? '#22c55e' : '#ef4444',
          paddingHorizontal: 10,
          paddingVertical: 4,
          borderRadius: 12
        }}>
          <Text style={{
            color: '#fff',
            fontSize: 11,
            fontWeight: '600'
          }}>
            {data.isOpen ? 'OPEN' : 'CLOSED'}
          </Text>
        </View>

        {/* Special Offers */}
        {data.specialOffers && data.specialOffers.length > 0 && (
          <View style={{
            position: 'absolute',
            bottom: 12,
            left: 12,
            backgroundColor: theme.color?.accent || '#22c55e',
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 8
          }}>
            <Text style={{
              color: '#000',
              fontSize: 10,
              fontWeight: '600'
            }}>
              {data.specialOffers[0]}
            </Text>
          </View>
        )}

        {/* Crowd Level */}
        <View style={{
          position: 'absolute',
          bottom: 12,
          right: 12,
          backgroundColor: getCrowdColor(),
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 8
        }}>
          <Text style={{
            color: '#fff',
            fontSize: 10,
            fontWeight: '600'
          }}>
            {data.crowdLevel.toUpperCase()}
          </Text>
        </View>
      </View>

      {/* Content */}
      <ScrollView style={{ flex: 1, padding: 16 }}>
        {/* Title and Category */}
        <Text style={{
          color: theme.color?.text || '#fff',
          fontSize: 18,
          fontWeight: '700',
          marginBottom: 4
        }}>
          {data.title}
        </Text>
        
        {data.subtitle && (
          <Text style={{
            color: theme.color?.muted || '#bbb',
            fontSize: 14,
            marginBottom: 8
          }}>
            {data.subtitle}
          </Text>
        )}

        <Text style={{
          color: theme.color?.accent || '#22c55e',
          fontSize: 12,
          fontWeight: '600',
          marginBottom: 12,
          textTransform: 'uppercase'
        }}>
          {data.category}
        </Text>

        {/* Rating and Price */}
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flexDirection: 'row', marginRight: 8 }}>
              {renderStars(data.rating)}
            </View>
            <Text style={{
              color: theme.color?.muted || '#bbb',
              fontSize: 12
            }}>
              ({data.rating.toFixed(1)})
            </Text>
          </View>
          
          <Text style={{
            color: theme.color?.text || '#fff',
            fontSize: 16,
            fontWeight: '600'
          }}>
            {data.priceRange}
          </Text>
        </View>

        {/* Distance and Travel Time */}
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          marginBottom: 16
        }}>
          <Text style={{
            color: theme.color?.muted || '#bbb',
            fontSize: 14
          }}>
            {data.distance.toFixed(1)} mi • {data.travelTime} min drive
          </Text>
        </View>

        {/* Feature Badges */}
        <View style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          marginBottom: 16
        }}>
          {data.features.map(feature => renderFeatureBadge(feature))}
        </View>

        {/* Quick Actions */}
        <View style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingTop: 16,
          borderTopWidth: 1,
          borderTopColor: theme.color?.border || '#333'
        }}>
          <TouchableOpacity style={{
            backgroundColor: theme.color?.border || '#333',
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderRadius: 16,
            flex: 1,
            marginRight: 8,
            alignItems: 'center'
          }}>
            <Text style={{
              color: theme.color?.text || '#fff',
              fontSize: 12,
              fontWeight: '600'
            }}>
              Navigate
            </Text>
          </TouchableOpacity>
          
          <TouchableOpacity style={{
            backgroundColor: theme.color?.accent || '#22c55e',
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderRadius: 16,
            flex: 1,
            marginLeft: 8,
            alignItems: 'center'
          }}>
            <Text style={{
              color: '#000',
              fontSize: 12,
              fontWeight: '600'
            }}>
              View Details
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </TouchableOpacity>
  );
}
