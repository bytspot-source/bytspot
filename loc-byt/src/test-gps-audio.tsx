import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { MapPin, Volume2, VolumeX, Satellite } from 'lucide-react';

/**
 * Test component to demonstrate GPS and Audio integration
 * Features:
 * - Real GPS geolocation with fallback
 * - Web Audio API synthetic sounds
 * - Location-based spot generation
 * - Audio feedback for discovery events
 */

interface GPSLocation {
  latitude: number;
  longitude: number;
  accuracy: number;
  city?: string;
}

export function TestGPSAudio() {
  const [gpsLocation, setGpsLocation] = useState<GPSLocation | null>(null);
  const [locationStatus, setLocationStatus] = useState<'requesting' | 'granted' | 'denied'>('requesting');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [discoveredSpots, setDiscoveredSpots] = useState<any[]>([]);
  const [isScanning, setIsScanning] = useState(false);

  // Initialize GPS
  useEffect(() => {
    const requestLocation = async () => {
      if (!navigator.geolocation) {
        setLocationStatus('denied');
        return;
      }

      try {
        console.log('Requesting GPS location...');
        
        const position = await new Promise<GeolocationPosition>((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new Error('Geolocation request timed out'));
          }, 10000);

          navigator.geolocation.getCurrentPosition(
            (pos) => {
              clearTimeout(timeoutId);
              resolve(pos);
            },
            (err) => {
              clearTimeout(timeoutId);
              reject(err);
            },
            {
              enableHighAccuracy: true,
              timeout: 8000,
              maximumAge: 300000,
            }
          );
        });

        const { latitude, longitude, accuracy } = position.coords;
        console.log(`GPS location: ${latitude}, ${longitude} (±${accuracy}m)`);
        
        // Mock geocoding
        const cities = [
          { name: 'San Francisco', lat: 37.7749, lng: -122.4194 },
          { name: 'New York', lat: 40.7128, lng: -74.0060 },
          { name: 'Los Angeles', lat: 34.0522, lng: -118.2437 },
          { name: 'Chicago', lat: 41.8781, lng: -87.6298 },
          { name: 'Seattle', lat: 47.6062, lng: -122.3321 },
        ];
        
        const nearestCity = cities.reduce((prev, curr) => {
          const prevDistance = Math.abs(prev.lat - latitude) + Math.abs(prev.lng - longitude);
          const currDistance = Math.abs(curr.lat - latitude) + Math.abs(curr.lng - longitude);
          return currDistance < prevDistance ? curr : prev;
        });
        
        setGpsLocation({
          latitude,
          longitude,
          accuracy,
          city: nearestCity.name
        });
        
        setLocationStatus('granted');
        generateSpots(latitude, longitude);
        
      } catch (error) {
        let errorMessage = 'Unknown GPS error';
        
        if (error instanceof GeolocationPositionError) {
          switch (error.code) {
            case GeolocationPositionError.PERMISSION_DENIED:
              errorMessage = 'User denied geolocation permission';
              break;
            case GeolocationPositionError.POSITION_UNAVAILABLE:
              errorMessage = 'Location information unavailable';
              break;
            case GeolocationPositionError.TIMEOUT:
              errorMessage = 'Geolocation request timed out';
              break;
          }
        } else if (error instanceof Error) {
          errorMessage = error.message;
        }
        
        console.error('GPS Error:', errorMessage, error);
        setLocationStatus('denied');
        
        // Fallback location
        setGpsLocation({
          latitude: 37.7749,
          longitude: -122.4194,
          accuracy: 100,
          city: 'San Francisco'
        });
        
        generateSpots(37.7749, -122.4194);
      }
    };

    requestLocation();
  }, []);

  // Generate location-based spots
  const generateSpots = (lat: number, lng: number) => {
    const spots = [];
    for (let i = 0; i < 10; i++) {
      const offsetLat = (Math.random() - 0.5) * 0.01;
      const offsetLng = (Math.random() - 0.5) * 0.01;
      const distance = Math.sqrt(offsetLat ** 2 + offsetLng ** 2) * 111;
      
      spots.push({
        id: `spot-${i}`,
        name: `Location ${i + 1}`,
        lat: lat + offsetLat,
        lng: lng + offsetLng,
        distance: Math.round(distance * 1000) / 1000,
        type: ['parking', 'venue', 'valet'][Math.floor(Math.random() * 3)]
      });
    }
    
    setDiscoveredSpots(spots);
  };

  // Web Audio API sounds
  const playSound = async (type: 'scan' | 'found' | 'complete') => {
    if (!soundEnabled) return;
    
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        console.warn('Web Audio API not supported');
        return;
      }

      const audioContext = new AudioContextClass();
      
      // Resume audio context if suspended
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      if (type === 'scan') {
        oscillator.frequency.setValueAtTime(300, audioContext.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(150, audioContext.currentTime + 0.5);
        gainNode.gain.setValueAtTime(0, audioContext.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.1, audioContext.currentTime + 0.1);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.5);
      } else if (type === 'found') {
        oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
        oscillator.frequency.linearRampToValueAtTime(1200, audioContext.currentTime + 0.1);
        gainNode.gain.setValueAtTime(0, audioContext.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.2, audioContext.currentTime + 0.05);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.2);
      } else if (type === 'complete') {
        const frequencies = [523, 659, 783];
        frequencies.forEach((freq, index) => {
          setTimeout(() => {
            try {
              const osc = audioContext.createOscillator();
              const gain = audioContext.createGain();
              osc.connect(gain);
              gain.connect(audioContext.destination);
              osc.frequency.setValueAtTime(freq, audioContext.currentTime);
              gain.gain.setValueAtTime(0, audioContext.currentTime);
              gain.gain.linearRampToValueAtTime(0.1, audioContext.currentTime + 0.05);
              gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
              osc.start(audioContext.currentTime);
              osc.stop(audioContext.currentTime + 0.3);
            } catch (error) {
              console.warn(`Completion sound note ${index} failed:`, error);
            }
          }, index * 100);
        });
      }
    } catch (error) {
      console.log('Audio playback failed:', error);
    }
  };

  const startScan = () => {
    setIsScanning(true);
    playSound('scan');
    
    setTimeout(() => {
      playSound('found');
      setTimeout(() => {
        playSound('complete');
        setIsScanning(false);
      }, 1000);
    }, 2000);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-pink-900 p-6 flex flex-col items-center justify-center">
      <div className="max-w-md w-full space-y-6">
        <div className="text-center">
          <h1 className="text-3xl text-white mb-2">GPS & Audio Test</h1>
          <p className="text-white/70">Testing real GPS data integration with sound effects</p>
        </div>

        {/* GPS Status */}
        <motion.div 
          className="glass-effect rounded-2xl p-4"
          animate={{
            borderColor: locationStatus === 'granted' ? 'rgba(34, 197, 94, 0.5)' : 
                        locationStatus === 'denied' ? 'rgba(239, 68, 68, 0.5)' : 
                        'rgba(59, 130, 246, 0.5)'
          }}
        >
          <div className="flex items-center space-x-3">
            <motion.div
              animate={{ 
                rotate: locationStatus === 'requesting' ? 360 : 0,
                scale: [1, 1.1, 1]
              }}
              transition={{ 
                rotate: { duration: 2, repeat: Infinity, ease: 'linear' },
                scale: { duration: 1.5, repeat: Infinity }
              }}
            >
              <Satellite className={`w-6 h-6 ${
                locationStatus === 'granted' ? 'text-green-400' : 
                locationStatus === 'denied' ? 'text-red-400' : 
                'text-blue-400'
              }`} />
            </motion.div>
            <div className="flex-1">
              <div className={`text-sm font-medium ${
                locationStatus === 'granted' ? 'text-green-400' : 
                locationStatus === 'denied' ? 'text-red-400' : 
                'text-blue-400'
              }`}>
                {locationStatus === 'granted' ? 'GPS Active' : 
                 locationStatus === 'denied' ? 'GPS Unavailable' : 
                 'GPS Connecting...'}
              </div>
              {gpsLocation && (
                <div className="text-white/60 text-xs mt-1">
                  {gpsLocation.city} • {gpsLocation.latitude.toFixed(4)}, {gpsLocation.longitude.toFixed(4)}
                  <br />±{Math.round(gpsLocation.accuracy)}m accuracy
                </div>
              )}
            </div>
            <button
              onClick={() => setSoundEnabled(!soundEnabled)}
              className="p-2 rounded-full hover:bg-white/10 transition-colors"
            >
              {soundEnabled ? (
                <Volume2 className="w-5 h-5 text-white" />
              ) : (
                <VolumeX className="w-5 h-5 text-white/50" />
              )}
            </button>
          </div>
        </motion.div>

        {/* Discovered Spots */}
        <div className="glass-effect rounded-2xl p-4">
          <h3 className="text-white font-medium mb-3">Discovered Spots ({discoveredSpots.length})</h3>
          <div className="space-y-2 max-h-32 overflow-y-auto">
            {discoveredSpots.slice(0, 5).map((spot, index) => (
              <div key={spot.id} className="flex items-center justify-between text-sm">
                <div className="flex items-center space-x-2">
                  <MapPin className="w-3 h-3 text-cyan-400" />
                  <span className="text-white">{spot.name}</span>
                  <span className="text-white/50 capitalize">({spot.type})</span>
                </div>
                <span className="text-cyan-400 text-xs">{spot.distance}km</span>
              </div>
            ))}
          </div>
        </div>

        {/* Test Controls */}
        <div className="space-y-3">
          <button
            onClick={startScan}
            disabled={isScanning}
            className="w-full py-3 px-4 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-2xl text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:from-blue-600 hover:to-cyan-600 transition-all"
          >
            {isScanning ? 'Scanning...' : 'Start Location Scan'}
          </button>
          
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => playSound('scan')}
              className="py-2 px-3 bg-white/10 rounded-xl text-white text-sm hover:bg-white/20 transition-colors"
            >
              Scan Sound
            </button>
            <button
              onClick={() => playSound('found')}
              className="py-2 px-3 bg-white/10 rounded-xl text-white text-sm hover:bg-white/20 transition-colors"
            >
              Found Sound
            </button>
            <button
              onClick={() => playSound('complete')}
              className="py-2 px-3 bg-white/10 rounded-xl text-white text-sm hover:bg-white/20 transition-colors"
            >
              Complete Sound
            </button>
          </div>
        </div>

        {/* Instructions */}
        <div className="glass-effect rounded-2xl p-4">
          <h4 className="text-white font-medium mb-2">Features Demonstrated:</h4>
          <ul className="text-white/70 text-sm space-y-1">
            <li>• Real GPS geolocation with browser API</li>
            <li>• Fallback to mock location if denied</li>
            <li>• Location-based spot generation within 1km radius</li>
            <li>• Web Audio API synthetic sound effects</li>
            <li>• Distance calculation using coordinates</li>
            <li>• City detection via nearest major city</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default TestGPSAudio;