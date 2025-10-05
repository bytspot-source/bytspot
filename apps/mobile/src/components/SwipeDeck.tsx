import React, { useRef, useState } from 'react';
import { Animated, PanResponder, View, Text, Dimensions, StyleSheet, Pressable } from 'react-native';

const SCREEN_WIDTH = Dimensions.get('window').width;
const SWIPE_THRESHOLD = 0.25 * SCREEN_WIDTH;

export type Card = { id: string; type: 'venue'|'parking'|'valet'; title: string; subtitle?: string; data?: any };

export default function SwipeDeck({ cards, onExplore, onSkip, onRefresh }: {
  cards: Card[];
  onExplore: (card: Card) => void;
  onSkip: (card: Card) => void;
  onRefresh: () => void;
}) {
  const position = useRef(new Animated.ValueXY()).current;
  const [index, setIndex] = useState(0);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: Animated.event([null, { dx: position.x, dy: position.y }], { useNativeDriver: false }),
      onPanResponderRelease: (_e, { dx, dy, vx, vy }) => {
        if (dy > 120) { onRefresh(); reset(); return; }
        if (dx > SWIPE_THRESHOLD || vx > 1.5) { forceSwipe('right'); return; }
        if (dx < -SWIPE_THRESHOLD || vx < -1.5) { forceSwipe('left'); return; }
        reset();
      },
    })
  ).current;

  const forceSwipe = (direction: 'left'|'right') => {
    const x = direction === 'right' ? SCREEN_WIDTH : -SCREEN_WIDTH;
    Animated.timing(position, { toValue: { x, y: 0 }, duration: 250, useNativeDriver: false }).start(() => onSwipeComplete(direction));
  };

  const onSwipeComplete = (direction: 'left'|'right') => {
    const card = cards[index];
    direction === 'right' ? onExplore(card) : onSkip(card);
    position.setValue({ x: 0, y: 0 });
    setIndex((i) => (i + 1) % cards.length);
  };

  const reset = () => Animated.spring(position, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start();

  if (!cards.length) return <Text>Loading...</Text>;
  const card = cards[index];

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.card, { transform: [{ translateX: position.x }, { translateY: position.y }, { rotate: position.x.interpolate({ inputRange: [-SCREEN_WIDTH, 0, SCREEN_WIDTH], outputRange: ['-15deg','0deg','15deg'] }) }] }]} {...panResponder.panHandlers} accessibilityRole="button" accessibilityLabel={`Card ${card.title}` }>
        <Pressable onPress={() => onExplore(card)}>
          <Text style={styles.title}>{card.title}</Text>
          {card.subtitle ? <Text style={styles.subtitle}>{card.subtitle}</Text> : null}
          <Text style={styles.type}>{card.type.toUpperCase()}</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16 },
  card: { width: SCREEN_WIDTH - 40, minHeight: 200, borderRadius: 12, backgroundColor: 'white', padding: 16, elevation: 3, shadowColor: '#000', shadowOpacity: 0.15, shadowOffset: { width: 0, height: 4 }, shadowRadius: 8 },
  title: { fontSize: 20, fontWeight: '600', marginBottom: 6 },
  subtitle: { fontSize: 14, color: '#666', marginBottom: 8 },
  type: { fontSize: 12, color: '#999' }
});

