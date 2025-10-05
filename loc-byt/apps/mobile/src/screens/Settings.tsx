import React from 'react';
import { View, Text, Switch, SafeAreaView, Button } from 'react-native';
import Constants from 'expo-constants';

export default function Settings({ navigation }: any) {
  const flags = (Constants.expoConfig?.extra as any) || {};
  const [vibeEnabled, setVibeEnabled] = React.useState(!!flags.VIBE_ENABLED);
  const [geoEnabled, setGeoEnabled] = React.useState(!!flags.GEOfence_ENABLED);
  return (
    <SafeAreaView style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 20, marginBottom: 12 }}>Privacy & Settings</Text>
      <View style={{ paddingVertical: 8 }}>
        <Text style={{ fontWeight: '600' }}>Vibe</Text>
        <Text style={{ color: '#666' }}>On-device analysis of ambient sound and motion to estimate venue vibe. No audio is recorded or uploaded.</Text>
        <Switch value={vibeEnabled} onValueChange={setVibeEnabled} />
      </View>
      <View style={{ paddingVertical: 8 }}>
        <Text style={{ fontWeight: '600' }}>Geofencing</Text>
        <Text style={{ color: '#666' }}>Detect venue entry/exit to run Vibe only in context. Requires location permission.</Text>
        <Switch value={geoEnabled} onValueChange={setGeoEnabled} />
      </View>
      <Text style={{ marginTop: 16, color: '#666' }}>Battery: Vibe samples briefly and infrequently; geofencing runs at low power. You can disable any time.</Text>
      <View style={{ marginTop: 20 }}>
        <Button title="Open Beta Guide" onPress={() => navigation.navigate('BetaGuide')} />
      </View>
      <View style={{ marginTop: 12 }}>
        <Button title="Open Diagnostics" onPress={() => navigation.navigate('Diagnostics')} />
      </View>
    </SafeAreaView>
  );
}

