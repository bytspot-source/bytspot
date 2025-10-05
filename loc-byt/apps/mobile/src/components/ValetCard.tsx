import React from 'react';
import { View, Text, Image, TouchableOpacity, ScrollView } from 'react-native';
import { useTheme } from '../theme';

export interface ValetService {
  id: string;
  valetName: string;
  valetPhoto: string;
  rating: number; // 1-5 stars
  totalServices: number;
  baseRate: number; // per hour
  serviceArea: string;
  estimatedDuration: { min: number; max: number }; // in minutes
  availability: 'Available' | 'Busy' | 'Offline';
  certifications: string[];
  specialties: string[];
  responseTime: number; // in minutes
  insuranceVerified: boolean;
  backgroundChecked: boolean;
}

interface ValetCardProps {
  data: ValetService;
  onPress: () => void;
}

export default function ValetCard({ data, onPress }: ValetCardProps) {
  const theme = useTheme();
  
  const getAvailabilityColor = () => {
    switch (data.availability) {
      case 'Available': return '#22c55e'; // Green
      case 'Busy': return '#f59e0b'; // Yellow
      case 'Offline': return '#6b7280'; // Gray
      default: return '#6b7280';
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

  const renderCertificationBadge = (cert: string) => (
    <View key={cert} style={{
      backgroundColor: '#3b82f6',
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 12,
      marginRight: 6,
      marginBottom: 4
    }}>
      <Text style={{
        color: '#fff',
        fontSize: 10,
        fontWeight: '600'
      }}>
        {cert}
      </Text>
    </View>
  );

  const renderSpecialtyBadge = (specialty: string) => (
    <View key={specialty} style={{
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
        {specialty}
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
      {/* Header with Valet Photo */}
      <View style={{ 
        height: 180, 
        backgroundColor: theme.color?.border || '#333',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative'
      }}>
        <Image 
          source={{ uri: data.valetPhoto || 'https://via.placeholder.com/120x120/333/fff?text=Valet' }}
          style={{ 
            width: 80, 
            height: 80, 
            borderRadius: 40,
            borderWidth: 3,
            borderColor: theme.color?.accent || '#22c55e'
          }}
          resizeMode="cover"
        />
        
        {/* Availability Status */}
        <View style={{
          position: 'absolute',
          top: 12,
          right: 12,
          backgroundColor: getAvailabilityColor(),
          paddingHorizontal: 10,
          paddingVertical: 4,
          borderRadius: 12
        }}>
          <Text style={{
            color: '#fff',
            fontSize: 11,
            fontWeight: '600'
          }}>
            {data.availability.toUpperCase()}
          </Text>
        </View>

        {/* Verification Badges */}
        <View style={{
          position: 'absolute',
          top: 12,
          left: 12,
          flexDirection: 'row'
        }}>
          {data.insuranceVerified && (
            <View style={{
              backgroundColor: '#10b981',
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: 8,
              marginRight: 4
            }}>
              <Text style={{
                color: '#fff',
                fontSize: 9,
                fontWeight: '600'
              }}>
                INSURED
              </Text>
            </View>
          )}
          {data.backgroundChecked && (
            <View style={{
              backgroundColor: '#8b5cf6',
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: 8
            }}>
              <Text style={{
                color: '#fff',
                fontSize: 9,
                fontWeight: '600'
              }}>
                VERIFIED
              </Text>
            </View>
          )}
        </View>

        {/* Response Time */}
        <View style={{
          position: 'absolute',
          bottom: 12,
          backgroundColor: 'rgba(0,0,0,0.7)',
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 8
        }}>
          <Text style={{
            color: '#fff',
            fontSize: 10,
            fontWeight: '600'
          }}>
            {data.responseTime} min response
          </Text>
        </View>
      </View>

      {/* Content */}
      <ScrollView style={{ flex: 1, padding: 16 }}>
        {/* Valet Name and Rating */}
        <Text style={{
          color: theme.color?.text || '#fff',
          fontSize: 18,
          fontWeight: '700',
          marginBottom: 4,
          textAlign: 'center'
        }}>
          {data.valetName}
        </Text>
        
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 8
        }}>
          <View style={{ flexDirection: 'row', marginRight: 8 }}>
            {renderStars(data.rating)}
          </View>
          <Text style={{
            color: theme.color?.muted || '#bbb',
            fontSize: 12
          }}>
            ({data.rating.toFixed(1)}) • {data.totalServices}+ services
          </Text>
        </View>

        {/* Service Area */}
        <Text style={{
          color: theme.color?.muted || '#bbb',
          fontSize: 14,
          textAlign: 'center',
          marginBottom: 16
        }}>
          Serving {data.serviceArea}
        </Text>

        {/* Pricing */}
        <View style={{
          alignItems: 'center',
          marginBottom: 16
        }}>
          <Text style={{
            color: theme.color?.accent || '#22c55e',
            fontSize: 28,
            fontWeight: '700'
          }}>
            ${data.baseRate}
          </Text>
          <Text style={{
            color: theme.color?.muted || '#bbb',
            fontSize: 14
          }}>
            per hour
          </Text>
        </View>

        {/* Service Duration */}
        <View style={{
          backgroundColor: theme.color?.border || '#333',
          padding: 12,
          borderRadius: 8,
          marginBottom: 16
        }}>
          <Text style={{
            color: theme.color?.text || '#fff',
            fontSize: 12,
            fontWeight: '600',
            textAlign: 'center'
          }}>
            Estimated Service Time
          </Text>
          <Text style={{
            color: theme.color?.accent || '#22c55e',
            fontSize: 16,
            fontWeight: '700',
            textAlign: 'center',
            marginTop: 4
          }}>
            {data.estimatedDuration.min}-{data.estimatedDuration.max} minutes
          </Text>
        </View>

        {/* Certifications */}
        {data.certifications.length > 0 && (
          <View style={{ marginBottom: 16 }}>
            <Text style={{
              color: theme.color?.text || '#fff',
              fontSize: 14,
              fontWeight: '600',
              marginBottom: 8
            }}>
              Certifications
            </Text>
            <View style={{
              flexDirection: 'row',
              flexWrap: 'wrap'
            }}>
              {data.certifications.map(cert => renderCertificationBadge(cert))}
            </View>
          </View>
        )}

        {/* Specialties */}
        {data.specialties.length > 0 && (
          <View style={{ marginBottom: 16 }}>
            <Text style={{
              color: theme.color?.text || '#fff',
              fontSize: 14,
              fontWeight: '600',
              marginBottom: 8
            }}>
              Specialties
            </Text>
            <View style={{
              flexDirection: 'row',
              flexWrap: 'wrap'
            }}>
              {data.specialties.map(specialty => renderSpecialtyBadge(specialty))}
            </View>
          </View>
        )}

        {/* Book Now Button */}
        <TouchableOpacity style={{
          backgroundColor: data.availability === 'Available' 
            ? (theme.color?.accent || '#22c55e')
            : (theme.color?.border || '#333'),
          paddingVertical: 16,
          borderRadius: 12,
          alignItems: 'center',
          marginTop: 8
        }}
        disabled={data.availability !== 'Available'}
        >
          <Text style={{
            color: data.availability === 'Available' ? '#000' : (theme.color?.muted || '#bbb'),
            fontSize: 16,
            fontWeight: '700'
          }}>
            {data.availability === 'Available' ? 'Book Valet Service' : 'Currently Unavailable'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </TouchableOpacity>
  );
}
