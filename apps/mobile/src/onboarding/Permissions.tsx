import React from 'react';
import { SafeAreaView, Text, View, Button } from 'react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Camera } from 'expo-camera';
import { api } from '../api';

export default function Permissions({ navigation }: any) {
  const [status, setStatus] = React.useState<string>('');

  const askLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    setStatus(`Location: ${status}`);
  };
  const askPush = async () => {
    const { status } = await Notifications.requestPermissionsAsync();
    try {
      const tokenData = await Notifications.getExpoPushTokenAsync();
      const token = (tokenData as any)?.data || '';
      if (token) await api('/api/devices/register', { method: 'POST', body: JSON.stringify({ token, role: 'user' }) });
    } catch {}
    setStatus(`Push: ${status}`);
  };
  const askCamera = async () => {
    const { status } = await Camera.requestCameraPermissionsAsync();
    setStatus(`Camera: ${status}`);
  };

  return (
    <SafeAreaView style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 18, marginBottom: 12 }}>Permissions</Text>
      <View style={{ gap: 8 }}>
        <Button title="Allow Location" onPress={askLocation} />
        <Button title="Allow Push Notifications" onPress={askPush} />
        <Button title="Allow Camera" onPress={askCamera} />
      </View>
      {status ? <Text style={{ marginTop: 12 }}>{status}</Text> : null}
      <View style={{ height: 16 }} />
      <Button title="Continue" onPress={() => navigation.replace('Interests')} />
    </SafeAreaView>
  );
}

