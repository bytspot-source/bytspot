import React, { useMemo, useState } from 'react';
import { Dimensions, StyleSheet, Text, View, Pressable } from 'react-native';
import { PanGestureHandler } from 'react-native-gesture-handler';
import Animated, { useAnimatedGestureHandler, useAnimatedStyle, useSharedValue, withSpring, runOnJS, withTiming, interpolate, Extrapolation } from 'react-native-reanimated';

const SCREEN_WIDTH = Dimensions.get('window').width;
const SWIPE_X = SCREEN_WIDTH * 0.25;
const SWIPE_Y = 120;

export type Card = { id: string; type: 'venue'|'parking'|'valet'; title: string; subtitle?: string; data?: any };

export default function SwipeDeck({ cards, onExplore, onSkip, onRefresh }: {
  cards: Card[];
  onExplore: (card: Card) => void;
  onSkip: (card: Card) => void;
  onRefresh: () => void;
}) {
  const [index, setIndex] = useState(0);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const rotation = useSharedValue(0);

  const card = cards[index];
  const nextCard = cards.length > 1 ? cards[(index + 1) % cards.length] : undefined;

  const completeAfterExit = (dir: 'left'|'right') => {
    const current = card;
    if (!current) return;
    if (dir === 'right') onExplore(current); else onSkip(current);
    setIndex(i => (cards.length ? (i + 1) % cards.length : 0));
    x.value = 0; y.value = 0; rotation.value = 0;
  };

  const gesture = useAnimatedGestureHandler({
    onStart: (_, ctx:any) => { ctx.startX = x.value; ctx.startY = y.value; },
    onActive: (evt, ctx:any) => {
      x.value = ctx.startX + evt.translationX;
      y.value = ctx.startY + evt.translationY;
      rotation.value = (x.value / SCREEN_WIDTH) * 15;
    },
    onEnd: (evt) => {
      if (y.value > SWIPE_Y) {
        runOnJS(onRefresh)();
        x.value = withSpring(0); y.value = withSpring(0); rotation.value = withSpring(0);
        return;
      }
      if (x.value > SWIPE_X || evt.velocityX > 1000) {
        x.value = withTiming(SCREEN_WIDTH * 1.5, { duration: 200 }, () => { runOnJS(completeAfterExit)('right'); });
        return;
      }
      if (x.value < -SWIPE_X || evt.velocityX < -1000) {
        x.value = withTiming(-SCREEN_WIDTH * 1.5, { duration: 200 }, () => { runOnJS(completeAfterExit)('left'); });
        return;
      }
      x.value = withSpring(0); y.value = withSpring(0); rotation.value = withSpring(0);
    },
  });

  const topStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      { rotate: `${rotation.value}deg` },
    ]
  }));

  const nextStyle = useAnimatedStyle(() => {
    const scale = interpolate(Math.abs(x.value), [0, SWIPE_X], [0.95, 1], Extrapolation.CLAMP);
    const translateY = interpolate(Math.abs(x.value), [0, SWIPE_X], [12, 0], Extrapolation.CLAMP);
    return { transform: [{ scale }, { translateY }] };
  });

  const activeCard = useMemo(() => card, [card?.id]);
  if (!activeCard) return <Text>Loading...</Text>;

  return (
    <View style={styles.container}>
      {nextCard && (
        <Animated.View style={[styles.card, styles.cardUnder, nextStyle]}>
          <Text style={styles.title}>{nextCard.title}</Text>
          {nextCard.subtitle ? <Text style={styles.subtitle}>{nextCard.subtitle}</Text> : null}
          <Text style={styles.type}>{nextCard.type.toUpperCase()}</Text>
        </Animated.View>
      )}
      <PanGestureHandler onGestureEvent={gesture}>
        <Animated.View style={[styles.card, topStyle]} accessibilityRole="button" accessibilityLabel={`Card ${activeCard.title}`}>
          <Pressable onPress={() => onExplore(activeCard)}>
            <Text style={styles.title}>{activeCard.title}</Text>
            {activeCard.subtitle ? <Text style={styles.subtitle}>{activeCard.subtitle}</Text> : null}
            <Text style={styles.type}>{activeCard.type.toUpperCase()}</Text>
          </Pressable>
        </Animated.View>
      </PanGestureHandler>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16 },
  card: { width: SCREEN_WIDTH - 40, minHeight: 200, borderRadius: 12, backgroundColor: 'white', padding: 16, elevation: 3, shadowColor: '#000', shadowOpacity: 0.15, shadowOffset: { width: 0, height: 4 }, shadowRadius: 8 },
  cardUnder: { position: 'absolute', top: 0, left: 20, right: 20 },
  title: { fontSize: 20, fontWeight: '600', marginBottom: 6 },
  subtitle: { fontSize: 14, color: '#666', marginBottom: 8 },
  type: { fontSize: 12, color: '#999' }
});

