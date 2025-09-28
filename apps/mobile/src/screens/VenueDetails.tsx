import React from 'react';
import { View, Text, Button, SafeAreaView, Animated, Platform, Linking } from 'react-native';
import { venues } from '../api';
import FooterNav from '../components/FooterNav';
import { startCheckout } from '../payments';
import { subscribeInsider } from '../realtime/socket';
import { track } from '../analytics';

function formatPhone(p?: string) {
  const s = (p || '').replace(/[^0-9]/g, '');
  if (s.length === 10) return `(${s.slice(0,3)}) ${s.slice(3,6)}-${s.slice(6)}`;
  if (s.length === 11 && s.startsWith('1')) return `+1 (${s.slice(1,4)}) ${s.slice(4,7)}-${s.slice(7)}`;
  return p || '';
}

export default function VenueDetails({ route, navigation }: any) {
  const { id } = route.params;
  const [item, setItem] = React.useState<any>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [likeStatus, setLikeStatus] = React.useState<string | null>(null);
  const [vibe, setVibe] = React.useState<number | null>(null);
  const anim = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => { (async () => {
    try { const d = await venues.get(id); setItem(d); track('venue_detail_open', { id }); } catch (e: any) { setErr(e.message); }
  })(); }, [id]);

  // Subscribe to vibe pulses for this venue
  React.useEffect(() => {
    const unsub = subscribeInsider({ interests: [], lifestyles: ['personalized'], onUpdate: (u) => {
      if (u.venueId === id && typeof u.score === 'number') {
        setVibe(u.score);
        anim.setValue(0);
        Animated.timing(anim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
      }
    }});
    return () => { if (unsub) unsub(); };
  }, [id]);

  const like = async () => {
    setLikeStatus('liking...');
    track('venue_like_attempt', { id });
    try { await venues.like(id); setLikeStatus('liked'); track('venue_like', { id, status: 'liked' }); }
    catch { setLikeStatus('failed'); track('venue_like', { id, status: 'failed' }); }
  };
  const openMaps = async () => {
    try {
      const hasCoords = typeof item?.lat === 'number' && typeof item?.lng === 'number';
      track('venue_action_navigate', { id, hasCoords });
      if (hasCoords) {
        const lat = item.lat, lng = item.lng;
        const url = Platform.select({
          ios: `http://maps.apple.com/?ll=${lat},${lng}&q=${encodeURIComponent(item?.title||'Venue')}`,
          android: `geo:${lat},${lng}?q=${encodeURIComponent(item?.title||'Venue')}`
        });
        if (url) await Linking.openURL(url);
      } else if (item?.title) {
        const url = Platform.select({
          ios: `http://maps.apple.com/?q=${encodeURIComponent(item.title)}`,
          android: `geo:0,0?q=${encodeURIComponent(item.title)}`
        });
        if (url) await Linking.openURL(url);
      }
    } catch {}
  };
  const callVenue = async () => {
    try {
      const phone = item?.phone || item?.tel;
      if (!phone) return;
      track('venue_action_call', { id });
      await Linking.openURL(`tel:${phone}`);
    } catch {}
  };
  const bookValet = async () => {
    await startCheckout([
      { name: 'Valet', amount: 1500, quantity: 1 },
      { name: 'Tip', amount: 300, quantity: 1 }
    ], undefined, undefined);
  };

  const vibeScale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1] });

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View style={{ flex: 1, padding: 16 }}>
        {err && <Text style={{ color: 'tomato' }}>{err}</Text>}
        {item && (
          <>
            <Text style={{ fontSize: 22, fontWeight: '700' }}>{item.title}</Text>
            <Text style={{ color: '#666', marginBottom: 12 }}>{item.subtitle}</Text>

            {/* Vibe + placeholders */}
            <Animated.View style={{ transform: [{ scale: vibeScale }], alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: '#eef2ff', marginBottom: 10 }}>
              <Text style={{ color: '#3730a3', fontWeight: '700' }}>Vibe {vibe ?? '—'}</Text>
            </Animated.View>
            <Text style={{ color: '#444' }}>Crowd: — (beta)</Text>
            <Text style={{ color: '#444', marginBottom: 12 }}>Wait time: — (beta)</Text>

            <Button title="Like" onPress={like} />
            <View style={{ height: 12 }} />
            <Button title="Navigate" onPress={openMaps} />
            {(item?.phone || item?.tel) && (
              <>
                <View style={{ height: 12 }} />
                <Button title={`Call ${formatPhone(item?.phone || item?.tel)}`} onPress={callVenue} />
              </>
            )}
            <View style={{ height: 12 }} />
            <Button title="Ask Concierge" onPress={() => { track('concierge_chat_open', { source: 'venue', id }); navigation.navigate('ConciergeChat'); }} />
            <View style={{ height: 12 }} />
            <Button title="Book Valet (Demo)" onPress={bookValet} />
            {likeStatus && <Text style={{ marginTop: 8 }}>{likeStatus}</Text>}
          </>
        )}
      </View>
      <FooterNav navigation={navigation} />
    </SafeAreaView>
  );
}

