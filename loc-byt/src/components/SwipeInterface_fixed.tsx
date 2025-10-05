import React, { useState, useRef, useEffect } from 'react';
import { motion, PanInfo, useMotionValue, useTransform, AnimatePresence } from 'motion/react';

// Import correct components
import { VenueDetail } from './VenueDetail';
import { SimpleParkingDetail } from './SimpleParkingDetail';

// Sample data and types from the original file
interface MatchCard {
  id: string;
  type: 'parking' | 'venue' | 'valet';
  title: string;
  subtitle: string;
  description: string;
  image: string;
  price: string;
  rating: number;
  distance: string;
  availability: string;
  features: string[];
  color: string;
  liveVibeScore?: number;
  peopleInside?: number;
  spotsAvailable?: number;
  totalSpots?: number;
  securityLevel?: string;
  accessMethod?: string[];
}

// Simple test component
export function SwipeInterface({ 
  userData, 
  onBack, 
  onLogout,
  onTriggerAchievement = () => {}
}: {
  userData: any;
  onBack: () => void;
  onLogout: () => void;
  onTriggerAchievement?: () => void;
}) {
  const [selectedCard, setSelectedCard] = useState<MatchCard | null>(null);
  const [currentView, setCurrentView] = useState<'swipe' | 'venue-detail' | 'parking-detail'>('swipe');

  // Test card data
  const testCard: MatchCard = {
    id: '1',
    type: 'parking',
    title: 'Downtown Garage',
    subtitle: 'Premium Secure Parking',
    description: 'State-of-the-art parking facility with advanced security systems.',
    image: 'https://images.unsplash.com/photo-1514836876796-56c8ba8b2e3c',
    price: '$8/hr',
    rating: 4.8,
    distance: '2 min walk',
    availability: 'Available',
    features: ['Covered', '24/7 Security', 'EV Charging'],
    color: 'from-blue-500 to-cyan-500',
    spotsAvailable: 12,
    totalSpots: 50,
    securityLevel: 'Premium',
    accessMethod: ['Keycard Access', 'Mobile App']
  };

  const handleCardClick = () => {
    setSelectedCard(testCard);
    setCurrentView('parking-detail');
  };

  if (currentView === 'parking-detail' && selectedCard) {
    return (
      <SimpleParkingDetail 
        card={selectedCard}
        onBack={() => setCurrentView('swipe')}
        onTriggerAchievement={onTriggerAchievement}
      />
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] flex flex-col pb-20 pt-6">
      <div className="flex-1">
        <div className="p-6">
          <h1 className="text-white text-2xl mb-4">Swipe Interface Test</h1>
          <button
            onClick={handleCardClick}
            className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded"
          >
            Test Parking Detail
          </button>
        </div>
      </div>
    </div>
  );
}