import React, { useState } from 'react';
import { View, Text, TextInput, Button, SafeAreaView } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { useTheme } from '../theme';

const BFF_URL = (Constants.expoConfig?.extra as any)?.BFF_URL || 'http://localhost:3001';

export default function SignIn({ navigation }: any) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const t = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, padding: t.space?.lg || 16, backgroundColor: t.color?.bg }}>
      <Text style={{ fontSize: t.font?.size?.xl || 20, marginBottom: t.space?.md || 12, color: t.color?.text }}>Sign in</Text>
      <TextInput placeholder="Email" placeholderTextColor={t.color?.muted}
        autoCapitalize="none" value={email} onChangeText={setEmail}
        style={{ borderWidth: 1, padding: t.space?.sm || 8, marginBottom: t.space?.sm || 8, borderColor: t.color?.border, color: t.color?.text }} />
      <TextInput placeholder="Password" placeholderTextColor={t.color?.muted}
        secureTextEntry value={password} onChangeText={setPassword}
        style={{ borderWidth: 1, padding: t.space?.sm || 8, marginBottom: t.space?.sm || 8, borderColor: t.color?.border, color: t.color?.text }} />
      {error && <Text style={{ color: t.color?.danger }}>{error}</Text>}
      <Button color={t.color?.accent} title="Sign in" onPress={async () => {
        try {
          const r = await fetch(`${BFF_URL}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
          const d = await r.json();
          if (!r.ok || !d.access_token) throw new Error('login failed');
          await SecureStore.setItemAsync('access_token', d.access_token);
          navigation.replace('Discover');
        } catch (e: any) { setError(e.message || 'Login failed'); }
      }} />
      <View style={{ height: t.space?.sm || 12 }} />
      <Button color={t.color?.border} title="Register" onPress={async () => {
        await fetch(`${BFF_URL}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
        alert('Registered. Now sign in.');
      }} />
      <View style={{ height: t.space?.sm || 12 }} />
      <Button color={t.color?.accent} title="Sign in with phone" onPress={() => navigation.navigate('PhoneSignIn')} />
      <View style={{ height: t.space?.sm || 12 }} />
      <Button color={t.color?.accent} title="Invite Friends" onPress={() => navigation.navigate('InviteFriends')} />
    </SafeAreaView>
  );
}

