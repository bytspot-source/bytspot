import React from 'react';
import { View, Text, TouchableOpacity, Platform } from 'react-native';
import { onSanitizeDrops, getLastSanitizeDrops } from '../analytics';

export default function DevSanitizeBanner() {
  if (process.env.NODE_ENV === 'production') return null as any;
  const [keys, setKeys] = React.useState<string[]>(getLastSanitizeDrops());
  const [hidden, setHidden] = React.useState(false);
  React.useEffect(() => {
    const off = onSanitizeDrops((k) => { setHidden(false); setKeys(k); });
    return off;
  }, []);
  if (!keys.length || hidden) return null as any;
  return (
    <View style={{ position: 'absolute', top: Platform.select({ ios: 50, android: 20, default: 10 }), left: 10, right: 10, backgroundColor: 'rgba(17,24,39,0.95)', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 10, zIndex: 9999 }}>
      <Text style={{ color: '#fde68a', fontWeight: '700' }}>Sanitized analytics keys dropped</Text>
      <Text style={{ color: '#e5e7eb' }}>{keys.join(', ')}</Text>
      <TouchableOpacity onPress={() => setHidden(true)} style={{ position: 'absolute', right: 8, top: 6 }}>
        <Text style={{ color: '#9ca3af', fontWeight: '700' }}>Dismiss</Text>
      </TouchableOpacity>
    </View>
  );
}

