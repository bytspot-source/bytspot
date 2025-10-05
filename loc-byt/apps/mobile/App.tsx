import React from 'react';
import RootNav from './src/navigation';
import { SafeAreaView, Text } from 'react-native';
import { track } from './src/analytics';

export default function App() {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => { setReady(true); track('app_start'); }, []);
  if (!ready) return <SafeAreaView><Text>Loading...</Text></SafeAreaView>;
  return <RootNav />;
}

