// @ts-nocheck

import React from 'react';
import { SafeAreaView, ScrollView, Text, View } from 'react-native';

export default function BetaGuide() {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={{ fontSize: 22, fontWeight: '700', marginBottom: 12 }}>Beta Tester Guide</Text>

        <Section title="What to try first">
          <Bullet>Grant Location so Map can center on you and show nearby vibes.</Bullet>
          <Bullet>Set a few Interests in onboarding (e.g., brunch, live music).</Bullet>
          <Bullet>Explore a few venues from the Discover swipe deck.</Bullet>
        </Section>

        <Section title="Map (Live Vibe)">
          <Bullet>Animated pulses show where the vibe is rising.</Bullet>
          <Bullet>Tap Recenter to jump back to your location.</Bullet>
        </Section>

        <Section title="Venue details">
          <Bullet>See Vibe updates in real time (badge animates when new data arrives).</Bullet>
          <Bullet>Use actions: Navigate, Ask Concierge, or Book Valet (demo checkout).</Bullet>
        </Section>

        <Section title="Valet (demo)">
          <Bullet>Start intake to create a digital ticket and see status updates.</Bullet>
          <Bullet>Complete payment via secure checkout (test mode).</Bullet>
        </Section>

        <Section title="Notifications & privacy">
          <Bullet>Notifications are optional; used for meaningful status updates only.</Bullet>
          <Bullet>No contacts are auto-uploaded; any matching is on-device with consent.</Bullet>
        </Section>

        <Section title="Feedback">
          <Bullet>Report any crash, map stutter, or confusing copy.</Bullet>
          <Bullet>Suggest venues or vibe moments we should surface.</Bullet>
        </Section>

        <Text style={{ color: '#6b7280', marginTop: 16 }}>Thank you for helping us shape a better night out.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: any) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ fontSize: 16, fontWeight: '700', marginBottom: 6 }}>{title}</Text>
      <View style={{ paddingLeft: 10 }}>{children}</View>
    </View>
  );
}

function Bullet({ children }: any) {
  return (
    <View style={{ flexDirection: 'row', marginBottom: 4 }}>
      <Text style={{ marginRight: 6 }}>•</Text>
      <Text style={{ flex: 1 }}>{children}</Text>
    </View>
  );
}

