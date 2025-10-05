import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { screen as trackScreen } from './analytics';
import SignIn from './screens/SignIn';
import PhoneSignIn from './screens/PhoneSignIn';
import DevSanitizeBanner from './components/DevSanitizeBanner';
import Discover from './screens/Discover';
import DiscoverSwipe from './screens/DiscoverSwipe';
import VenueDetails from './screens/VenueDetails';
import HostOnboarding from './screens/HostOnboarding';
import Settings from './screens/Settings';
import InviteFriends from './screens/InviteFriends';
import Parking from './screens/Parking';
import Valet from './screens/Valet';
import Interests from './onboarding/Interests';
import Permissions from './onboarding/Permissions';
import Curating from './onboarding/Curating';
import ConciergeChat from './screens/ConciergeChat';
import Map from './screens/Map';
import BetaGuide from './screens/BetaGuide';
import Diagnostics from './screens/Diagnostics';

const Stack = createNativeStackNavigator();

export default function RootNav() {
  const routeNameRef = React.useRef<string | null>(null);
  const navigationRef = React.useRef<any>(null);

  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={() => {
        const rn = navigationRef.current?.getCurrentRoute?.()?.name;
        routeNameRef.current = rn || null;
        if (rn) trackScreen(rn);
      }}
      onStateChange={() => {
        const prev = routeNameRef.current;
        const rn = navigationRef.current?.getCurrentRoute?.()?.name;
        if (rn && prev !== rn) {
          trackScreen(rn);
          routeNameRef.current = rn;
        }
      }}
    >
      <>
        <Stack.Navigator>
          <Stack.Screen name="SignIn" component={SignIn} />
          <Stack.Screen name="PhoneSignIn" component={PhoneSignIn} options={{ title: 'Phone Sign-In' }} />
          <Stack.Screen name="Discover" component={Discover} />
          <Stack.Screen name="DiscoverSwipe" component={DiscoverSwipe} options={{ title: 'Discover' }} />
          <Stack.Screen name="VenueDetails" component={VenueDetails} options={{ title: 'Venue' }} />
          <Stack.Screen name="HostOnboarding" component={HostOnboarding} options={{ title: 'Host Onboarding' }} />
          <Stack.Screen name="InviteFriends" component={InviteFriends} options={{ title: 'Invite Friends' }} />
          <Stack.Screen name="Parking" component={Parking} options={{ title: 'Smart Parking' }} />
          <Stack.Screen name="Valet" component={Valet} options={{ title: 'Valet Command Center' }} />
          <Stack.Screen name="Interests" component={Interests} options={{ title: 'Your Interests' }} />
          <Stack.Screen name="Permissions" component={Permissions} options={{ title: 'Permissions' }} />
          <Stack.Screen name="Curating" component={Curating} options={{ title: 'Curating' }} />
          <Stack.Screen name="ConciergeChat" component={ConciergeChat} options={{ title: 'Concierge' }} />
          <Stack.Screen name="Map" component={Map} options={{ title: 'Map' }} />
          <Stack.Screen name="Settings" component={Settings} options={{ title: 'Privacy & Settings' }} />
          <Stack.Screen name="BetaGuide" component={BetaGuide} options={{ title: 'Beta Guide' }} />
          <Stack.Screen name="Diagnostics" component={Diagnostics} options={{ title: 'Diagnostics' }} />
        </Stack.Navigator>
        {process.env.NODE_ENV !== 'production' ? <DevSanitizeBanner /> : null}
      </>
    </NavigationContainer>
  );
}

