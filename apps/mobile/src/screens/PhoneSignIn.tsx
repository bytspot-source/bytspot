import React, { useState } from 'react';
import { SafeAreaView, Text, TextInput, Button, View } from 'react-native';
import Constants from 'expo-constants';

const BFF_URL = (Constants.expoConfig?.extra as any)?.BFF_URL || 'http://localhost:3001';

export default function PhoneSignIn({ navigation }: any) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone'|'code'>('phone');
  const [status, setStatus] = useState<string | null>(null);

  const start = async () => {
    setStatus('Sending code...');
    const r = await fetch(`${BFF_URL}/api/auth/phone/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
    if (!r.ok) { setStatus('Failed to send'); return; }
    setStatus('Code sent'); setStep('code');
  };
  const verify = async () => {
    setStatus('Verifying...');
    const r = await fetch(`${BFF_URL}/api/auth/phone/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code }) });
    const d = await r.json();
    if (!r.ok || !d.access_token) { setStatus('Invalid code'); return; }
    setStatus('Success'); navigation.replace('Discover');
  };

  return (
    <SafeAreaView style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 20, marginBottom: 12 }}>Sign in with phone</Text>
      {step === 'phone' && (
        <View>
          <TextInput placeholder="Phone (e.g., +15551234567)" autoCapitalize="none" keyboardType="phone-pad" value={phone} onChangeText={setPhone} style={{ borderWidth: 1, padding: 8, marginBottom: 8 }} />
          <Button title="Send code" onPress={start} />
        </View>
      )}
      {step === 'code' && (
        <View>
          <TextInput placeholder="6-digit code" keyboardType="number-pad" value={code} onChangeText={setCode} style={{ borderWidth: 1, padding: 8, marginBottom: 8 }} />
          <Button title="Verify" onPress={verify} />
        </View>
      )}
      {status && <Text style={{ marginTop: 12 }}>{status}</Text>}
    </SafeAreaView>
  );
}

