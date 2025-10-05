import React from 'react';
import { SafeAreaView, Text, Button, FlatList } from 'react-native';
import Constants from 'expo-constants';

import { getSocket } from '../realtime/socket';
import { track } from '../analytics';

const BFF_URL = (Constants.expoConfig?.extra as any)?.BFF_URL || 'http://localhost:3001';

export default function Valet() {
  const [tasks, setTasks] = React.useState<any[]>([]);
  const [status, setStatus] = React.useState('');
  const load = async () => {
    setStatus('Loading tasks...');
    const r = await fetch(`${BFF_URL}/api/valet/tasks`);
    const d = await r.json();
    setTasks(d.items||[]); setStatus('');
  };
  React.useEffect(() => { load(); }, []);

  // Socket listener for live valet tasks
  React.useEffect(() => {
    const s = getSocket();
    const onTask = (t:any) => {
      setTasks(prev => {
        const idx = prev.findIndex(x=>x.id===t.id);
        if (idx>=0) { const copy=[...prev]; copy[idx]=t; return copy; }
        return [t, ...prev];
      });
    };
    s.on('valet:task', onTask);
    return () => { s.off('valet:task', onTask); };
  }, []);
  return (
    <SafeAreaView style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 18, marginBottom: 12 }}>Valet Command Center</Text>
      {status ? <Text>{status}</Text> : null}
      <FlatList data={tasks} keyExtractor={(x)=>x.id} renderItem={({ item }) => (
        <Text>{item.type} • {item.user} • {item.eta} • {item.status}</Text>
      )} />
      <Button title="Start intake" onPress={async () => {
        track('valet_intake_started');
        const r = await fetch(`${BFF_URL}/api/valet/intake`, { method: 'POST' });
        const d = await r.json();
        if (d?.ticket) track('valet_intake_completed', { ticket: d.ticket });
        alert(`Ticket ${d.ticket}`);
      }} />
    </SafeAreaView>
  );
}

