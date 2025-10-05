// @ts-nocheck

import React from 'react';
import { SafeAreaView, View, Text, Animated, Easing, TouchableOpacity } from 'react-native';
import FooterNav from '../components/FooterNav';
import * as SecureStore from 'expo-secure-store';
import * as Location from 'expo-location';
import { subscribeInsider } from '../realtime/socket';
import MapView, { Marker } from 'react-native-maps';
import { track, screen } from '../analytics';

function Pulse({ label }: { label: string }) {
  const scale = React.useRef(new Animated.Value(0.6)).current;
  const opacity = React.useRef(new Animated.Value(0.9)).current;
  React.useEffect(() => {
    const loop = Animated.loop(Animated.parallel([
      Animated.sequence([
        Animated.timing(scale, { toValue: 1, duration: 1200, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(scale, { toValue: 0.6, duration: 0, useNativeDriver: true })
      ]),
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.2, duration: 1200, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.9, duration: 0, useNativeDriver: true })
      ])
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  return (
    <Animated.View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: '#4f46e5', opacity, transform: [{ scale }], alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontSize: 10 }}>{label}</Text>
    </Animated.View>
  );
}

function Cluster({ count }: { count: number }) {
  return (
    <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: '#1f2937', borderWidth: 2, borderColor: '#4f46e5', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontWeight: '600' }}>{count}</Text>
    </View>
  );
}

export default function Map({ navigation }: any) {
  const [pulses, setPulses] = React.useState([] as any[]);
  const mapRef = React.useRef(null as any);
  const [region, setRegion] = React.useState({ latitude: 37.7749, longitude: -122.4194, latitudeDelta: 0.05, longitudeDelta: 0.05 });
  const firstPulseRef = React.useRef(false);

  React.useEffect(() => { screen('Map'); }, []);

  React.useEffect(() => {
    const sub = async () => {
      const savedI = await SecureStore.getItemAsync('interests');
      const interestsArr = (savedI || '').split(',').filter(Boolean);
      const unsub = subscribeInsider({ interests: interestsArr, lifestyles: ['personalized'], onUpdate: (u) => {
        if (!firstPulseRef.current) { track('vibe_first_pulse'); firstPulseRef.current = true; }
        setPulses(prev => [{ id: u.venueId, score: u.score, ts: u.ts, lat: u.lat, lng: u.lng, title: u.title }, ...prev].slice(0, 200));
      }});
      return unsub;
    };
    let cleanup:any; sub().then((u)=>{ cleanup=u; });
    return () => { if (cleanup) cleanup(); };
  }, []);

  React.useEffect(() => {
    // Ask for location permission and center on user
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const loc = await Location.getCurrentPositionAsync({});
          const next = { latitude: loc.coords.latitude, longitude: loc.coords.longitude, latitudeDelta: 0.05, longitudeDelta: 0.05 };
          setRegion(next);
          if (mapRef.current) mapRef.current.animateToRegion(next, 600);
        }
      } catch {}
    })();
  }, []);

  const onRecenter = async () => {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const loc = await Location.getCurrentPositionAsync({});
      const next = { latitude: loc.coords.latitude, longitude: loc.coords.longitude, latitudeDelta: region.latitudeDelta, longitudeDelta: region.longitudeDelta };
      setRegion(next);
      if (mapRef.current) mapRef.current.animateToRegion(next, 600);
      const q = (n:number) => Math.round(n * 100) / 100; // ~1.1km precision
      track('map_recenter', { lat: q(next.latitude), lng: q(next.longitude) });
    } catch {}
  };

  const clusters = React.useMemo(() => {
    if (!pulses.length) return [] as any[];
    const cellLat = Math.max(region.latitudeDelta / 20, 0.0025);
    const cellLng = Math.max(region.longitudeDelta / 20, 0.0025);
    const groups = new Map<string, { lat: number, lng: number, items: any[] }>();
    for (const p of pulses) {
      if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
      const gx = Math.floor(p.lat / cellLat);
      const gy = Math.floor(p.lng / cellLng);
      const key = gx + ':' + gy;
      const g = groups.get(key) || { lat: 0, lng: 0, items: [] };
      g.lat += p.lat; g.lng += p.lng; g.items.push(p);
      groups.set(key, g);
    }
    const out:any[] = [];
    groups.forEach((g) => {
      const count = g.items.length;
      const lat = g.lat / count;
      const lng = g.lng / count;
      // label: show avg score or top score
      const top = g.items[0];
      out.push({ count, lat, lng, label: String(top?.score ?? ''), items: g.items });
    });
    return out;
  }, [pulses, region.latitudeDelta, region.longitudeDelta]);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <MapView
          ref={(r) => { mapRef.current = r; }}
          style={{ flex: 1 }}
          initialRegion={region}
          onRegionChangeComplete={(r) => setRegion(r as any)}
          showsUserLocation
        >
          {clusters.map((c, idx) => (
            <Marker key={idx} coordinate={{ latitude: c.lat, longitude: c.lng }}>
              {c.count > 1 ? <Cluster count={c.count} /> : <Pulse label={c.label} />}
            </Marker>
          ))}
        </MapView>
        {!pulses.length && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
            <Text>Listening for Vibe pulses…</Text>
          </View>
        )}
        <TouchableOpacity onPress={onRecenter} style={{ position: 'absolute', right: 16, bottom: 100, backgroundColor: '#fff', borderRadius: 20, paddingVertical: 10, paddingHorizontal: 14, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 6 }}>
          <Text style={{ color: '#111827', fontWeight: '600' }}>Recenter</Text>
        </TouchableOpacity>
      </View>
      <FooterNav navigation={navigation} />
    </SafeAreaView>
  );
}
