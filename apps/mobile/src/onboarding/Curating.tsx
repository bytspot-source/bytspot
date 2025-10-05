import React from 'react';
import { SafeAreaView, View, Text, Animated, Easing } from 'react-native';
import { api } from '../api';

export default function Curating({ navigation, route }: any) {
  const interests: string = route?.params?.interests || '';
  const scale = React.useRef(new Animated.Value(0.9)).current;
  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(scale, { toValue: 0.9, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    let mounted = true;
    const run = async () => {
      try { await api(`/api/discover/cards?interests=${encodeURIComponent(interests)}`); } catch {}
      setTimeout(() => { if (mounted) navigation.replace('DiscoverSwipe', { interests }); }, 1200);
    };
    run();
    return () => { mounted = false; loop.stop(); };
  }, [interests]);

  return (
    <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A0A0A' }}>
      <Animated.View style={{ width: 160, height: 160, borderRadius: 80, borderWidth: 3, borderColor: '#00BFFF55', alignItems: 'center', justifyContent: 'center', transform: [{ scale }] }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#00BFFF' }} />
      </Animated.View>
      <Text style={{ color: 'white', marginTop: 16, fontSize: 16 }}>
        {interests ? `Curating ${interests.split(',').join(' & ').toLowerCase()} for you...` : 'Finding great spots near you...'}
      </Text>
    </SafeAreaView>
  );
}

