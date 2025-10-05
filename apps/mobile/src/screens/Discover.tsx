import React from 'react';
import { View, Text, FlatList, Button, SafeAreaView } from 'react-native';
import { venues } from '../api';

export default function Discover({ navigation }: any) {
  const [items, setItems] = React.useState<any[]>([]);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => { (async () => {
    try { const d = await venues.discover(); setItems(d.items || []); } catch (e: any) { setErr(e.message); }
  })(); }, []);
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Text style={{ fontSize: 20, margin: 16 }}>Discover</Text>
      {err && <Text style={{ color: 'tomato', marginHorizontal: 16 }}>{err}</Text>}
      <FlatList data={items} keyExtractor={(i) => i.id} renderItem={({ item }) => (
        <View style={{ padding: 16, borderBottomWidth: 1 }}>
          <Text style={{ fontWeight: '600' }}>{item.title}</Text>
          <Text style={{ color: '#666' }}>{item.subtitle}</Text>
          <View style={{ height: 8 }} />
          <Button title="View" onPress={() => navigation.navigate('VenueDetails', { id: item.id })} />
        </View>
      )} />
    </SafeAreaView>
  );
}

