import React, { useState, useRef } from 'react';
import { View, Dimensions, PanResponder, Animated } from 'react-native';
import { useTheme } from '../theme';
import ParkingCardStack from './ParkingCardStack';
import VenueCard from './VenueCard';
import ValetCard from './ValetCard';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

export type CardType = 'parking' | 'venue' | 'valet';

export interface SwipeCard {
  id: string;
  type: CardType;
  data: any;
}

interface SwipeInterfaceProps {
  cards: SwipeCard[];
  onSwipeLeft: (card: SwipeCard) => void;
  onSwipeRight: (card: SwipeCard) => void;
  onSwipeUp: () => void;
  onSwipeDown: () => void;
  onCardPress: (card: SwipeCard) => void;
}

export default function SwipeInterface({
  cards,
  onSwipeLeft,
  onSwipeRight,
  onSwipeUp,
  onSwipeDown,
  onCardPress
}: SwipeInterfaceProps) {
  const theme = useTheme();
  const [currentIndex, setCurrentIndex] = useState(0);
  const position = useRef(new Animated.ValueXY()).current;
  const rotate = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const panResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    
    onPanResponderMove: (_, gesture) => {
      position.setValue({ x: gesture.dx, y: gesture.dy });
      rotate.setValue(gesture.dx * 0.1);
    },

    onPanResponderRelease: (_, gesture) => {
      const { dx, dy, vx, vy } = gesture;
      const swipeThreshold = screenWidth * 0.3;
      const velocityThreshold = 0.5;

      // Determine swipe direction
      if (Math.abs(dx) > Math.abs(dy)) {
        // Horizontal swipe
        if (dx > swipeThreshold || vx > velocityThreshold) {
          // Swipe right - explore details
          animateCardOut('right');
        } else if (dx < -swipeThreshold || vx < -velocityThreshold) {
          // Swipe left - skip
          animateCardOut('left');
        } else {
          // Return to center
          resetCard();
        }
      } else {
        // Vertical swipe
        if (dy < -swipeThreshold || vy < -velocityThreshold) {
          // Swipe up - refresh recommendations
          animateCardOut('up');
        } else if (dy > swipeThreshold || vy > velocityThreshold) {
          // Swipe down - reload
          animateCardOut('down');
        } else {
          // Return to center
          resetCard();
        }
      }
    }
  });

  const animateCardOut = (direction: 'left' | 'right' | 'up' | 'down') => {
    const currentCard = cards[currentIndex];
    if (!currentCard) return;

    let toValue = { x: 0, y: 0 };
    
    switch (direction) {
      case 'left':
        toValue = { x: -screenWidth * 1.5, y: 0 };
        break;
      case 'right':
        toValue = { x: screenWidth * 1.5, y: 0 };
        break;
      case 'up':
        toValue = { x: 0, y: -screenHeight * 1.5 };
        break;
      case 'down':
        toValue = { x: 0, y: screenHeight * 1.5 };
        break;
    }

    Animated.parallel([
      Animated.timing(position, {
        toValue,
        duration: 300,
        useNativeDriver: false
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver: false
      })
    ]).start(() => {
      // Handle swipe action
      switch (direction) {
        case 'left':
          onSwipeLeft(currentCard);
          break;
        case 'right':
          onSwipeRight(currentCard);
          break;
        case 'up':
          onSwipeUp();
          break;
        case 'down':
          onSwipeDown();
          break;
      }
      
      // Move to next card
      setCurrentIndex(prev => prev + 1);
      resetCard();
    });
  };

  const resetCard = () => {
    position.setValue({ x: 0, y: 0 });
    rotate.setValue(0);
    opacity.setValue(1);
  };

  const renderCard = (card: SwipeCard, index: number) => {
    if (index < currentIndex) return null;
    
    const isCurrentCard = index === currentIndex;
    const cardStyle = isCurrentCard ? {
      transform: [
        ...position.getTranslateTransform(),
        { rotate: rotate.interpolate({
          inputRange: [-200, 0, 200],
          outputRange: ['-15deg', '0deg', '15deg']
        })}
      ],
      opacity
    } : {
      transform: [
        { scale: 0.95 - (index - currentIndex) * 0.05 },
        { translateY: (index - currentIndex) * 10 }
      ],
      opacity: 1 - (index - currentIndex) * 0.2
    };

    const CardComponent = getCardComponent(card.type);
    
    return (
      <Animated.View
        key={card.id}
        style={[
          {
            position: 'absolute',
            width: screenWidth - 32,
            height: screenHeight * 0.7,
            borderRadius: theme.radius?.md || 8,
            backgroundColor: theme.color?.border || '#333',
            zIndex: cards.length - index
          },
          cardStyle
        ]}
        {...(isCurrentCard ? panResponder.panHandlers : {})}
      >
        <CardComponent 
          data={card.data} 
          onPress={() => onCardPress(card)}
        />
      </Animated.View>
    );
  };

  const getCardComponent = (type: CardType) => {
    switch (type) {
      case 'parking':
        return ParkingCardStack;
      case 'venue':
        return VenueCard;
      case 'valet':
        return ValetCard;
      default:
        return VenueCard;
    }
  };

  return (
    <View style={{
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.color?.bg || '#0b0b0b',
      paddingHorizontal: 16
    }}>
      {cards.slice(currentIndex, currentIndex + 3).map((card, index) => 
        renderCard(card, currentIndex + index)
      )}
    </View>
  );
}
