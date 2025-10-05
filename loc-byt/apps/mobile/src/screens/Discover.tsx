import React from 'react';
import { SafeAreaView, Text, View } from 'react-native';
import { venues } from '../api';
import { useTheme } from '../theme';
import { track } from '../analytics';
import SwipeInterface, { SwipeCard } from '../components/SwipeInterface';

// Mock data for demonstration - replace with real API calls
const mockParkingSpots = [
  {
    id: 'parking_1',
    name: 'Downtown Garage',
    imageUrl: 'https://via.placeholder.com/400x200/333/fff?text=Parking',
    availableSpots: 23,
    totalSpots: 100,
    securityLevel: 'Premium' as const,
    hourlyPrice: 15.00,
    surgeMultiplier: 1.2,
    walkingDistance: 3,
    neighborhood: 'Financial District',
    features: ['24/7 Access', 'Attendant'],
    covered: true,
    evCharging: true,
    accessibility: true,
    securityCameras: true,
    valetAvailable: false
  }
];

const mockValetServices = [
  {
    id: 'valet_1',
    valetName: 'Michael Chen',
    valetPhoto: 'https://via.placeholder.com/120x120/333/fff?text=MC',
    rating: 4.9,
    totalServices: 500,
    baseRate: 25,
    serviceArea: 'Downtown & SOMA',
    estimatedDuration: { min: 30, max: 120 },
    availability: 'Available' as const,
    certifications: ['Certified', 'Bonded'],
    specialties: ['Luxury Vehicles', 'Quick Service'],
    responseTime: 5,
    insuranceVerified: true,
    backgroundChecked: true
  }
];

export default function Discover({ navigation }: any) {
  const theme = useTheme();
  const [cards, setCards] = React.useState<SwipeCard[]>([]);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    loadCards();
  }, []);

  const loadCards = async () => {
    try {
      // Load venue data from API
      const venueData = await venues.discover();
      const venueCards: SwipeCard[] = (venueData.items || []).map((venue: any) => ({
        id: `venue_${venue.id}`,
        type: 'venue' as const,
        data: {
          ...venue,
          imageUrl: venue.imageUrl || 'https://via.placeholder.com/400x220/333/fff?text=Venue',
          vibeScore: Math.floor(Math.random() * 4) + 7, // 7-10
          distance: Math.random() * 5 + 0.5, // 0.5-5.5 miles
          travelTime: Math.floor(Math.random() * 20) + 5, // 5-25 minutes
          priceRange: ['$', '$$', '$$$', '$$$$'][Math.floor(Math.random() * 4)],
          rating: Math.random() * 2 + 3, // 3-5 stars
          category: 'Restaurant',
          isOpen: Math.random() > 0.3,
          crowdLevel: ['Low', 'Medium', 'High'][Math.floor(Math.random() * 3)],
          features: ['WiFi', 'Outdoor Seating', 'Live Music'].slice(0, Math.floor(Math.random() * 3) + 1),
          specialOffers: Math.random() > 0.7 ? ['Happy Hour 4-6pm'] : []
        }
      }));

      // Add parking cards
      const parkingCards: SwipeCard[] = mockParkingSpots.map(spot => ({
        id: `parking_${spot.id}`,
        type: 'parking' as const,
        data: spot
      }));

      // Add valet cards
      const valetCards: SwipeCard[] = mockValetServices.map(valet => ({
        id: `valet_${valet.id}`,
        type: 'valet' as const,
        data: valet
      }));

      // Shuffle all cards together
      const allCards = [...venueCards, ...parkingCards, ...valetCards];
      setCards(allCards.sort(() => Math.random() - 0.5));
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const handleSwipeLeft = (card: SwipeCard) => {
    track('card_skipped', { cardType: card.type, cardId: card.id });
  };

  const handleSwipeRight = (card: SwipeCard) => {
    track('card_explored', { cardType: card.type, cardId: card.id });

    // Navigate to appropriate detail screen
    switch (card.type) {
      case 'venue':
        navigation.navigate('VenueDetails', { id: card.data.id });
        break;
      case 'parking':
        // Navigate to parking booking flow
        break;
      case 'valet':
        navigation.navigate('Valet');
        break;
    }
  };

  const handleSwipeUp = () => {
    track('recommendations_refreshed');
    loadCards(); // Refresh recommendations
  };

  const handleSwipeDown = () => {
    track('cards_reloaded');
    loadCards(); // Reload current recommendations
  };

  const handleCardPress = (card: SwipeCard) => {
    track('card_tapped', { cardType: card.type, cardId: card.id });
    handleSwipeRight(card); // Same action as swipe right
  };

  return (
    <SafeAreaView style={{
      flex: 1,
      backgroundColor: theme.color?.bg || '#0b0b0b'
    }}>
      {err && (
        <View style={{ padding: 16 }}>
          <Text style={{
            color: theme.color?.danger || '#fda4af',
            textAlign: 'center'
          }}>
            {err}
          </Text>
        </View>
      )}

      <SwipeInterface
        cards={cards}
        onSwipeLeft={handleSwipeLeft}
        onSwipeRight={handleSwipeRight}
        onSwipeUp={handleSwipeUp}
        onSwipeDown={handleSwipeDown}
        onCardPress={handleCardPress}
      />
    </SafeAreaView>
  );
}

