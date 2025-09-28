import React, { useState } from 'react';
import { SafeAreaView, Text, Button, FlatList, View } from 'react-native';
import * as Contacts from 'expo-contacts';
import Constants from 'expo-constants';

const BFF_URL = (Constants.expoConfig?.extra as any)?.BFF_URL || 'http://localhost:3001';

function normalizePhone(p: string) {
  return p.replace(/[^+0-9]/g, '').toLowerCase();
}
async function sha256Hex(msg: string) {
  const enc = new TextEncoder().encode(msg);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

export default function InviteFriends() {
  const [status, setStatus] = useState('');
  const [matches, setMatches] = useState<{id:string, hash:string}[]>([]);

  const load = async () => {
    setStatus('Requesting permission...');
    const { status } = await Contacts.requestPermissionsAsync();
    if (status !== 'granted') { setStatus('Permission denied'); return; }
    setStatus('Loading contacts...');
    const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers] });
    const phones = (data || []).flatMap(c => (c.phoneNumbers||[]).map(p => normalizePhone(p.number||''))).filter(Boolean);
    const unique = Array.from(new Set(phones));
    setStatus('Hashing...');
    const hashes = await Promise.all(unique.map(p => sha256Hex(p)));
    setStatus('Matching...');
    const r = await fetch(`${BFF_URL}/api/contacts/match`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes }) });
    const d = await r.json();
    if (!r.ok) { setStatus('Match failed'); return; }
    setMatches(d.matches || []);
    setStatus(`Found ${d.matches?.length||0} friends on Bytspot`);
  };

  return (
    <SafeAreaView style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 18, marginBottom: 12 }}>Invite Friends</Text>
      <Text style={{ marginBottom: 12 }}>Help your friends find the Vibe of their city. We match on-device and only send hashes; no auto-invites.</Text>
      <Button title="Find friends" onPress={load} />
      {status ? <Text style={{ marginTop: 12 }}>{status}</Text> : null}
      <FlatList data={matches} keyExtractor={m => m.hash} renderItem={({ item }) => (
        <View style={{ paddingVertical: 8 }}>
          <Text>Friend on Bytspot</Text>
          <Button title="Invite" onPress={() => { /* user-initiated invite only, no auto-send */ }} />
        </View>
      )} />
    </SafeAreaView>
  );
}

