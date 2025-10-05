import React from 'react';
import { SafeAreaView, Text, TouchableOpacity, FlatList, View } from 'react-native';
import Constants from 'expo-constants';
import { useTheme } from '../theme';
import { getSocket } from '../realtime/socket';
import { track } from '../analytics';
import ValetFlow from '../components/ValetFlow';

const BFF_URL = (Constants.expoConfig?.extra as any)?.BFF_URL || 'http://localhost:3001';

export default function Valet() {
  const theme = useTheme();
  const [tasks, setTasks] = React.useState<any[]>([]);
  const [status, setStatus] = React.useState('');
  const [showValetFlow, setShowValetFlow] = React.useState(false);

  const load = async () => {
    setStatus('Loading tasks...');
    const r = await fetch(`${BFF_URL}/api/valet/tasks`);
    const d = await r.json();
    setTasks(d.items||[]); setStatus('');
  };
  React.useEffect(() => { load(); }, []);

  // Socket listener for live valet tasks
  React.useEffect(() => {
    const s = getSocket();
    const onTask = (t:any) => {
      setTasks(prev => {
        const idx = prev.findIndex(x=>x.id===t.id);
        if (idx>=0) { const copy=[...prev]; copy[idx]=t; return copy; }
        return [t, ...prev];
      });
    };
    s.on('valet:task', onTask);
    return () => { s.off('valet:task', onTask); };
  }, []);

  const handleValetBookingComplete = (bookingData: any) => {
    setShowValetFlow(false);
    track('valet_booking_completed', { bookingId: bookingData.bookingId });
    // Refresh tasks to show new booking
    load();
  };

  const handleStartIntake = async () => {
    track('valet_intake_started');
    const r = await fetch(`${BFF_URL}/api/valet/intake`, { method: 'POST' });
    const d = await r.json();
    if (d?.ticket) track('valet_intake_completed', { ticket: d.ticket });
    alert(`Ticket ${d.ticket}`);
  };

  return (
    <SafeAreaView style={{
      flex: 1,
      backgroundColor: theme.color?.bg || '#0b0b0b'
    }}>
      <View style={{ flex: 1, padding: 16 }}>
        <Text style={{
          fontSize: 24,
          fontWeight: '700',
          color: theme.color?.text || '#fff',
          marginBottom: 8
        }}>
          Valet Command Center
        </Text>

        <Text style={{
          fontSize: 16,
          color: theme.color?.muted || '#bbb',
          marginBottom: 24
        }}>
          Manage your valet services and bookings
        </Text>

        {/* Quick Actions */}
        <View style={{
          flexDirection: 'row',
          gap: 12,
          marginBottom: 24
        }}>
          <TouchableOpacity
            style={{
              backgroundColor: theme.color?.accent || '#22c55e',
              paddingVertical: 12,
              paddingHorizontal: 16,
              borderRadius: 8,
              flex: 1,
              alignItems: 'center'
            }}
            onPress={() => setShowValetFlow(true)}
          >
            <Text style={{
              color: '#000',
              fontSize: 16,
              fontWeight: '700'
            }}>
              🚗 Book Valet
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={{
              backgroundColor: theme.color?.border || '#333',
              paddingVertical: 12,
              paddingHorizontal: 16,
              borderRadius: 8,
              flex: 1,
              alignItems: 'center'
            }}
            onPress={handleStartIntake}
          >
            <Text style={{
              color: theme.color?.text || '#fff',
              fontSize: 16,
              fontWeight: '600'
            }}>
              📋 Start Intake
            </Text>
          </TouchableOpacity>
        </View>

        {/* Status */}
        {status ? (
          <Text style={{
            color: theme.color?.muted || '#bbb',
            fontSize: 14,
            marginBottom: 16
          }}>
            {status}
          </Text>
        ) : null}

        {/* Active Tasks */}
        <Text style={{
          fontSize: 18,
          fontWeight: '600',
          color: theme.color?.text || '#fff',
          marginBottom: 12
        }}>
          Active Tasks ({tasks.length})
        </Text>

        <FlatList
          data={tasks}
          keyExtractor={(x) => x.id}
          renderItem={({ item }) => (
            <View style={{
              backgroundColor: theme.color?.border || '#333',
              padding: 16,
              borderRadius: 8,
              marginBottom: 8
            }}>
              <Text style={{
                color: theme.color?.text || '#fff',
                fontSize: 16,
                fontWeight: '600',
                marginBottom: 4
              }}>
                {item.type} • {item.user}
              </Text>
              <Text style={{
                color: theme.color?.muted || '#bbb',
                fontSize: 14
              }}>
                ETA: {item.eta} • Status: {item.status}
              </Text>
            </View>
          )}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={{
              backgroundColor: theme.color?.border || '#333',
              padding: 20,
              borderRadius: 8,
              alignItems: 'center'
            }}>
              <Text style={{
                color: theme.color?.muted || '#bbb',
                fontSize: 16,
                textAlign: 'center'
              }}>
                No active tasks
              </Text>
            </View>
          }
        />
      </View>

      {/* Valet Booking Flow Modal */}
      {showValetFlow && (
        <ValetFlow
          onComplete={handleValetBookingComplete}
          onCancel={() => setShowValetFlow(false)}
        />
      )}
    </SafeAreaView>
  );
}

