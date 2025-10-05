import React from 'react';
import { View, Text, Button, FlatList, SafeAreaView } from 'react-native';
import { api } from '../api';

export default function HostOnboarding() {
  const [state, setState] = React.useState<any>({ progress: 0, types: [] });
  const [status, setStatus] = React.useState<string | null>(null);
  React.useEffect(() => { (async () => { try { setState(await api('/api/host/onboarding/types')); } catch {} })(); }, []);
  const choose = async (key: 'venue'|'parking'|'valet') => {
    setStatus('saving...');
    try { await api('/api/host/onboarding', { method: 'POST', body: JSON.stringify({ serviceType: key, progress: 30, data: { step: 'service-type' } }) }); setStatus('saved'); } catch { setStatus('failed'); }
  };
  const cont = async () => { setStatus('saving...'); try { await api('/api/host/onboarding', { method: 'POST', body: JSON.stringify({ progress: 50, data: { step: 'details' } }) }); setStatus('saved'); } catch { setStatus('failed'); } };
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Text style={{ fontSize: 20, margin: 16 }}>Host Onboarding ({state.progress || 0}%)</Text>
      {status && <Text style={{ marginHorizontal: 16 }}>{status}</Text>}
      <FlatList data={state.types} keyExtractor={(i:any) => i.key} renderItem={({ item }: any) => (
        <View style={{ padding: 16, borderBottomWidth: 1 }}>
          <Text style={{ fontWeight: '600' }}>{item.label}</Text>
          <Text style={{ color: '#666' }}>{item.description}</Text>
          <Button title="Choose" onPress={() => choose(item.key)} />
        </View>
      )} />
      { (state.progress || 0) >= 30 && <Button title="Continue to 50%" onPress={cont} /> }
    </SafeAreaView>
  );
}

