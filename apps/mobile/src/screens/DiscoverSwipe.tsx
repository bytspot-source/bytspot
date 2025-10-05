import React from 'react';
import { SafeAreaView, View, Text, TouchableOpacity } from 'react-native';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import SwipeDeck, { type Card } from '../components/SwipeDeckRNGH';
import { subscribeInsider } from '../realtime/socket';

const BFF_URL = (Constants.expoConfig?.extra as any)?.BFF_URL || 'http://localhost:3001';

export default function DiscoverSwipe({ navigation, route }: any) {
  const [cards, setCards] = React.useState<Card[]>([]);
  const [lastVibe, setLastVibe] = React.useState<any>(null);
  const load = async () => {
    try {
      const saved = await SecureStore.getItemAsync('interests');
      const interests = route?.params?.interests || saved || '';
      const url = interests ? `${BFF_URL}/api/discover/cards?interests=${encodeURIComponent(interests)}` : `${BFF_URL}/api/discover/cards`;
      const r = await fetch(url);
      const d = await r.json();
      setCards(d.items || []);
    } catch (e) { console.log('load cards failed', e); }
  };
  React.useEffect(() => { load(); }, []);

  // Insider realtime Vibes subscription (interests + lifestyle). Lifestyle kept lightweight for beta.
  React.useEffect(() => {
    const mode = route?.params?.mode;
    const sub = async () => {
      if (mode !== 'insider') return;
      const savedI = await SecureStore.getItemAsync('interests');
      const savedL = await SecureStore.getItemAsync('lifestyles');
      const interestsArr = (route?.params?.interests || savedI || '').split(',').filter(Boolean);
      const lifestylesArr = (savedL && savedL.length) ? savedL.split(',').filter(Boolean) : ['personalized'];
      const unsub = subscribeInsider({ interests: interestsArr, lifestyles: lifestylesArr, onUpdate: (u) => setLastVibe({ ...u, shownAt: Date.now() }) });
      return unsub;
    };
    let cleanup: any;
    sub().then((u)=>{ cleanup = u; });
    return () => { if (cleanup) cleanup(); };
  }, [route?.params?.mode, route?.params?.interests]);

  // Auto-hide overlay after a few seconds
  React.useEffect(() => {
    if (!lastVibe) return;
    const t = setTimeout(() => setLastVibe(null), 3000);
    return () => clearTimeout(t);
  }, [lastVibe?.ts]);

  const since = (ts?: number) => {
    if (!ts) return 'now';
    const s = Math.max(0, Math.round((Date.now() - ts)/1000));
    return s <= 1 ? 'now' : `${s}s ago`;
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <SwipeDeck
        cards={cards}
        onExplore={(c) => {
          if (c.type === 'venue') navigation.navigate('VenueDetails', { id: c.data?.id || c.id });
          else if (c.type === 'parking') navigation.navigate('Valet');
          else if (c.type === 'valet') navigation.navigate('Valet');
        }}
        onSkip={() => { /* no-op; deck handles progression */ }}
        onRefresh={load}
      />
      {lastVibe ? (
        <TouchableOpacity onPress={() => navigation.navigate('VenueDetails', { id: lastVibe.venueId })} style={{ position: 'absolute', top: 12, right: 12 }}>
          <View style={{ backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12 }}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>Vibe {lastVibe.score}</Text>
            <Text style={{ color: '#fff' }}>{lastVibe.venueId} • {since(lastVibe.ts)}</Text>
          </View>
        </TouchableOpacity>
      ) : null}
    </SafeAreaView>
  );
}

