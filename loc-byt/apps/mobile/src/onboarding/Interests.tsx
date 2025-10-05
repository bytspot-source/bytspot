import React, { useState } from 'react';
import { SafeAreaView, Text, TouchableOpacity, ScrollView, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { useTheme } from '../theme';
import { track } from '../analytics';

interface Interest {
  id: string;
  title: string;
  icon: string;
  description: string;
  category: 'entertainment' | 'services' | 'dining' | 'lifestyle';
}

const INTERESTS: Interest[] = [
  { id: 'nightlife', title: 'Nightlife & Bars', icon: '🍸', description: 'Bars, clubs, and nighttime entertainment', category: 'entertainment' },
  { id: 'smart_parking', title: 'Smart Parking', icon: '🚗', description: 'Convenient parking solutions', category: 'services' },
  { id: 'dining', title: 'Dining & Restaurants', icon: '🍽️', description: 'Fine dining and casual restaurants', category: 'dining' },
  { id: 'coffee', title: 'Coffee & Casual', icon: '☕', description: 'Coffee shops and casual meetups', category: 'dining' },
  { id: 'live_music', title: 'Live Music & Events', icon: '🎵', description: 'Concerts, shows, and live performances', category: 'entertainment' },
  { id: 'fitness', title: 'Fitness & Wellness', icon: '🏃', description: 'Gyms, yoga studios, and wellness centers', category: 'lifestyle' },
  { id: 'shopping', title: 'Shopping & Retail', icon: '🛍️', description: 'Shopping centers and retail experiences', category: 'lifestyle' },
  { id: 'arts', title: 'Arts & Culture', icon: '🎨', description: 'Museums, galleries, and cultural venues', category: 'entertainment' },
  { id: 'outdoor', title: 'Outdoor & Nature', icon: '🌿', description: 'Parks, outdoor activities, and nature spots', category: 'lifestyle' },
  { id: 'valet', title: 'Valet Services', icon: '🚙', description: 'Premium valet parking services', category: 'services' },
  { id: 'premium_parking', title: 'Premium Parking Spots', icon: '🅿️', description: 'High-end parking with premium amenities', category: 'services' }
];

interface InterestPreferencesProps {
  navigation?: any;
  onComplete?: (selectedInterests: string[]) => void;
  onBack?: () => void;
}

export default function Interests({ navigation, onComplete, onBack }: InterestPreferencesProps) {
  const theme = useTheme();
  const [selectedInterests, setSelectedInterests] = useState<string[]>([]);

  const toggleInterest = (interestId: string) => {
    setSelectedInterests(prev => {
      const newSelection = prev.includes(interestId)
        ? prev.filter(id => id !== interestId)
        : [...prev, interestId];

      track('interest_toggled', {
        interestId,
        selected: !prev.includes(interestId),
        totalSelected: newSelection.length
      });

      return newSelection;
    });
  };

  const handleComplete = async () => {
    await SecureStore.setItemAsync('interests', selectedInterests.join(','));

    track('interests_completed', {
      selectedInterests,
      totalSelected: selectedInterests.length,
      categories: INTERESTS
        .filter(i => selectedInterests.includes(i.id))
        .reduce((acc, i) => {
          acc[i.category] = (acc[i.category] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)
    });

    if (onComplete) {
      onComplete(selectedInterests);
    } else if (navigation) {
      navigation.replace('Curating', { interests: selectedInterests.join(',') });
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'entertainment': return '#8b5cf6'; // Purple
      case 'services': return '#3b82f6'; // Blue
      case 'dining': return '#f59e0b'; // Yellow
      case 'lifestyle': return '#10b981'; // Green
      default: return theme.color?.border || '#333';
    }
  };

  const renderInterestCard = (interest: Interest) => {
    const isSelected = selectedInterests.includes(interest.id);

    return (
      <TouchableOpacity
        key={interest.id}
        style={{
          backgroundColor: isSelected
            ? (theme.color?.accent || '#22c55e')
            : (theme.color?.border || '#333'),
          borderRadius: theme.radius?.md || 8,
          padding: 16,
          marginBottom: 12,
          borderWidth: 2,
          borderColor: isSelected
            ? (theme.color?.accent || '#22c55e')
            : 'transparent'
        }}
        onPress={() => toggleInterest(interest.id)}
        activeOpacity={0.8}
      >
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          marginBottom: 8
        }}>
          <Text style={{ fontSize: 24, marginRight: 12 }}>
            {interest.icon}
          </Text>
          <View style={{ flex: 1 }}>
            <Text style={{
              color: isSelected ? '#000' : (theme.color?.text || '#fff'),
              fontSize: 16,
              fontWeight: '700'
            }}>
              {interest.title}
            </Text>
            <View style={{
              backgroundColor: getCategoryColor(interest.category),
              paddingHorizontal: 8,
              paddingVertical: 2,
              borderRadius: 10,
              alignSelf: 'flex-start',
              marginTop: 4
            }}>
              <Text style={{
                color: '#fff',
                fontSize: 10,
                fontWeight: '600',
                textTransform: 'uppercase'
              }}>
                {interest.category}
              </Text>
            </View>
          </View>
          {isSelected && (
            <Text style={{
              color: '#000',
              fontSize: 20,
              fontWeight: '700'
            }}>
              ✓
            </Text>
          )}
        </View>
        <Text style={{
          color: isSelected ? '#000' : (theme.color?.muted || '#bbb'),
          fontSize: 12,
          lineHeight: 16
        }}>
          {interest.description}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={{
      flex: 1,
      backgroundColor: theme.color?.bg || '#0b0b0b'
    }}>
      <ScrollView style={{ flex: 1, padding: 20 }}>
        <Text style={{
          color: theme.color?.text || '#fff',
          fontSize: 28,
          fontWeight: '700',
          textAlign: 'center',
          marginBottom: 8
        }}>
          What interests you?
        </Text>

        <Text style={{
          color: theme.color?.muted || '#bbb',
          fontSize: 16,
          textAlign: 'center',
          marginBottom: 32,
          lineHeight: 22
        }}>
          Select your interests to get personalized recommendations.
          You can always change these later.
        </Text>

        <Text style={{
          color: theme.color?.text || '#fff',
          fontSize: 14,
          fontWeight: '600',
          marginBottom: 16
        }}>
          Selected: {selectedInterests.length} of {INTERESTS.length}
        </Text>

        {INTERESTS.map(renderInterestCard)}

        <View style={{
          backgroundColor: theme.color?.border || '#333',
          padding: 16,
          borderRadius: 8,
          marginBottom: 24
        }}>
          <Text style={{
            color: theme.color?.text || '#fff',
            fontSize: 14,
            fontWeight: '600',
            marginBottom: 8
          }}>
            💡 Pro Tip
          </Text>
          <Text style={{
            color: theme.color?.muted || '#bbb',
            fontSize: 12,
            lineHeight: 16
          }}>
            Select at least 3-5 interests for the best recommendations.
            Our AI learns from your choices to show you exactly what you're looking for.
          </Text>
        </View>
      </ScrollView>

      <View style={{
        padding: 20,
        borderTopWidth: 1,
        borderTopColor: theme.color?.border || '#333',
        flexDirection: 'row',
        gap: 12
      }}>
        {onBack && (
          <TouchableOpacity
            style={{
              backgroundColor: 'transparent',
              borderWidth: 1,
              borderColor: theme.color?.border || '#333',
              paddingVertical: 16,
              borderRadius: 12,
              alignItems: 'center',
              flex: 1
            }}
            onPress={onBack}
          >
            <Text style={{
              color: theme.color?.muted || '#bbb',
              fontSize: 16,
              fontWeight: '600'
            }}>
              Back
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={{
            backgroundColor: selectedInterests.length > 0
              ? (theme.color?.accent || '#22c55e')
              : (theme.color?.border || '#333'),
            paddingVertical: 16,
            borderRadius: 12,
            alignItems: 'center',
            flex: 2
          }}
          onPress={handleComplete}
          disabled={selectedInterests.length === 0}
        >
          <Text style={{
            color: selectedInterests.length > 0 ? '#000' : (theme.color?.muted || '#bbb'),
            fontSize: 16,
            fontWeight: '700'
          }}>
            {selectedInterests.length > 0
              ? `Continue with ${selectedInterests.length} interests`
              : 'Select at least one interest'
            }
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

