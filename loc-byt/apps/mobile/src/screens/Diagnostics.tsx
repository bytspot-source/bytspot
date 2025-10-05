import React from 'react';
import { View, Text, SafeAreaView, Button, ScrollView } from 'react-native';
import { track } from '../analytics';

export default function Diagnostics() {
  const provider = (process.env.EXPO_PUBLIC_ANALYTICS_PROVIDER || 'posthog');
  const keyPresent = !!process.env.EXPO_PUBLIC_POSTHOG_KEY || !!process.env.EXPO_PUBLIC_SEGMENT_WRITE_KEY || !!process.env.EXPO_PUBLIC_AMPLITUDE_API_KEY;
  const host = process.env.EXPO_PUBLIC_POSTHOG_HOST || '';

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={{ fontSize: 20, fontWeight: '700', marginBottom: 8 }}>Diagnostics</Text>
        <Text style={{ color: '#666' }}>Analytics Provider: {provider}</Text>
        <Text style={{ color: '#666' }}>Key present: {String(keyPresent)}</Text>
        {host ? <Text style={{ color: '#666' }}>PostHog Host: {host}</Text> : null}

        <View style={{ height: 16 }} />
        <Button title="Send Test Event" onPress={() => track('diagnostics_ping', { ts: Date.now(), provider })} />

        <View style={{ height: 16 }} />
        <Text style={{ color: '#666' }}>Note: Keys are read from build-time env. For staging, set POSTHOG_KEY_STAGING in GitHub Actions. For production, set POSTHOG_KEY_PRODUCTION.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

