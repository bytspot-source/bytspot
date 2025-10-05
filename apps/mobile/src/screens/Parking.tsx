import React from 'react';
import { SafeAreaView, Text, FlatList, Button } from 'react-native';
import Constants from 'expo-constants';

const BFF_URL = (Constants.expoConfig?.extra as any)?.BFF_URL || 'http://localhost:3001';

export default function Parking() {
  const [items, setItems] = React.useState<any[]>([]);
  const [status, setStatus] = React.useState('');
  const search = async () => {
    setStatus('Searching...');
    const r = await fetch(`${BFF_URL}/api/parking/search`);
    const d = await r.json();
    setItems(d.items||[]); setStatus('');
  };
  React.useEffect(() => { search(); }, []);
  return (
    <SafeAreaView style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 18, marginBottom: 12 }}>Smart Parking</Text>
      {status ? <Text>{status}</Text> : null}
      <FlatList data={items} keyExtractor={(x) => x.id} renderItem={({ item }) => (
        <Text>{item.name} • {item.distance} • ${item.price}</Text>
      )} />
      <Button title="Reserve first spot" onPress={async () => {
        if (!items[0]) return;
        await fetch(`${BFF_URL}/api/parking/reservations`, { method: 'POST' });
        alert('Reserved');
      }} />
    </SafeAreaView>
  );
}

