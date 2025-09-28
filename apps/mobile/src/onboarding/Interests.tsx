import React from 'react';
import { SafeAreaView, Text, View, Button } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { track } from '../analytics';

const options = [
  { id: 'parking', label: 'Smart Parking' },
  { id: 'dining', label: 'Fine Dining' },
  { id: 'nightlife', label: 'Nightlife' },
  { id: 'events', label: 'Events' },
  { id: 'valet', label: 'Valet Services' },
  { id: 'premium', label: 'Premium Spots' },
];

export default function Interests({ navigation }: any) {
  const [selected, setSelected] = React.useState<string[]>([]);
  const toggle = (id: string) => setSelected(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);
  const save = async () => {
    await SecureStore.setItemAsync('interests', selected.join(','));
    track('onboarding_completed', { count: selected.length });
    navigation.replace('Curating', { interests: selected.join(',') });
  };
  return (
    <SafeAreaView style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 18, marginBottom: 12 }}>What interests you?</Text>
      <View style={{ gap: 8 }}>
        {options.map(o => (
          <Button key={o.id} title={`${selected.includes(o.id)?'✓ ':''}${o.label}`} onPress={() => toggle(o.id)} />
        ))}
      </View>
      <View style={{ height: 16 }} />
      <Button title="Continue" onPress={save} />
    </SafeAreaView>
  );
}

