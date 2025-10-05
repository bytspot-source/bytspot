import React from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';

export default function FooterNav({ navigation }: any) {
  const go = (name: string, params?: any) => navigation.navigate(name as never, params as never);
  return (
    <View style={styles.bar}>
      <TouchableOpacity style={styles.tab} onPress={() => go('DiscoverSwipe')}><Text>Discover</Text></TouchableOpacity>
      <TouchableOpacity style={styles.tab} onPress={() => go('Map')}><Text>Map</Text></TouchableOpacity>
      <TouchableOpacity style={styles.tab} onPress={() => go('DiscoverSwipe', { mode: 'insider' })}><Text>Insider</Text></TouchableOpacity>
      <TouchableOpacity style={styles.tab} onPress={() => go('ConciergeChat')}><Text>Concierge</Text></TouchableOpacity>
      <TouchableOpacity style={styles.tab} onPress={() => go('Settings')}><Text>Profile</Text></TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', justifyContent: 'space-between', padding: 12, borderTopWidth: StyleSheet.hairlineWidth, backgroundColor: '#fff' },
  tab: { paddingHorizontal: 8 }
});

