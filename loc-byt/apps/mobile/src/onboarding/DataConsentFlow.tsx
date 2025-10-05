import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, SafeAreaView, Alert } from 'react-native';
import * as Location from 'expo-location';
import { Camera } from 'expo-camera';
import * as Contacts from 'expo-contacts';
import { useTheme } from '../theme';
import { track } from '../analytics';

interface Permission {
  id: string;
  title: string;
  description: string;
  icon: string;
  required: boolean;
  granted: boolean;
  explanation: string;
}

interface DataConsentFlowProps {
  onComplete: (permissions: { [key: string]: boolean }) => void;
}

export default function DataConsentFlow({ onComplete }: DataConsentFlowProps) {
  const theme = useTheme();
  const [permissions, setPermissions] = useState<Permission[]>([
    {
      id: 'location',
      title: 'Location Services',
      description: 'Find nearby venues, parking, and valet services',
      icon: '📍',
      required: true,
      granted: false,
      explanation: 'We use your location to show you relevant venues and services nearby. This is essential for the core functionality of Bytspot.'
    },
    {
      id: 'camera',
      title: 'Camera Access',
      description: 'Scan QR codes for parking and venue access',
      icon: '📷',
      required: false,
      granted: false,
      explanation: 'Camera access allows you to quickly scan QR codes for parking reservations and venue check-ins.'
    },
    {
      id: 'contacts',
      title: 'Contacts Access',
      description: 'Find friends and enable social features',
      icon: '👥',
      required: false,
      granted: false,
      explanation: 'We use contact matching to help you find friends on Bytspot and enable social discovery features. Your contacts are never uploaded to our servers.'
    }
  ]);

  const [currentStep, setCurrentStep] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);

  const requestLocationPermission = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      return status === 'granted';
    } catch (error) {
      console.error('Location permission error:', error);
      return false;
    }
  };

  const requestCameraPermission = async () => {
    try {
      const { status } = await Camera.requestCameraPermissionsAsync();
      return status === 'granted';
    } catch (error) {
      console.error('Camera permission error:', error);
      return false;
    }
  };

  const requestContactsPermission = async () => {
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      return status === 'granted';
    } catch (error) {
      console.error('Contacts permission error:', error);
      return false;
    }
  };

  const handlePermissionRequest = async (permission: Permission) => {
    setIsProcessing(true);
    track('permission_requested', { permission: permission.id });

    let granted = false;

    try {
      switch (permission.id) {
        case 'location':
          granted = await requestLocationPermission();
          break;
        case 'camera':
          granted = await requestCameraPermission();
          break;
        case 'contacts':
          granted = await requestContactsPermission();
          break;
      }

      setPermissions(prev => prev.map(p => 
        p.id === permission.id ? { ...p, granted } : p
      ));

      track('permission_result', { 
        permission: permission.id, 
        granted,
        required: permission.required 
      });

      if (!granted && permission.required) {
        Alert.alert(
          'Permission Required',
          `${permission.title} is required for Bytspot to work properly. Please enable it in your device settings.`,
          [{ text: 'OK' }]
        );
      }
    } catch (error) {
      console.error('Permission request error:', error);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSkipOptional = (permission: Permission) => {
    track('permission_skipped', { permission: permission.id });
    setPermissions(prev => prev.map(p => 
      p.id === permission.id ? { ...p, granted: false } : p
    ));
  };

  const canProceed = () => {
    const requiredPermissions = permissions.filter(p => p.required);
    return requiredPermissions.every(p => p.granted);
  };

  const handleComplete = () => {
    const permissionResults = permissions.reduce((acc, p) => {
      acc[p.id] = p.granted;
      return acc;
    }, {} as { [key: string]: boolean });

    track('onboarding_permissions_completed', { 
      permissions: permissionResults,
      requiredGranted: permissions.filter(p => p.required && p.granted).length,
      optionalGranted: permissions.filter(p => !p.required && p.granted).length
    });

    onComplete(permissionResults);
  };

  const renderPermissionCard = (permission: Permission) => (
    <View key={permission.id} style={{
      backgroundColor: theme.color?.border || '#333',
      borderRadius: theme.radius?.md || 8,
      padding: 20,
      marginBottom: 16,
      borderWidth: permission.granted ? 2 : 0,
      borderColor: permission.granted ? (theme.color?.accent || '#22c55e') : 'transparent'
    }}>
      <View style={{
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12
      }}>
        <Text style={{ fontSize: 24, marginRight: 12 }}>
          {permission.icon}
        </Text>
        <View style={{ flex: 1 }}>
          <Text style={{
            color: theme.color?.text || '#fff',
            fontSize: 18,
            fontWeight: '700'
          }}>
            {permission.title}
            {permission.required && (
              <Text style={{ color: theme.color?.danger || '#fda4af' }}> *</Text>
            )}
          </Text>
          <Text style={{
            color: theme.color?.muted || '#bbb',
            fontSize: 14,
            marginTop: 2
          }}>
            {permission.description}
          </Text>
        </View>
        {permission.granted && (
          <Text style={{
            color: theme.color?.accent || '#22c55e',
            fontSize: 20
          }}>
            ✓
          </Text>
        )}
      </View>

      <Text style={{
        color: theme.color?.muted || '#bbb',
        fontSize: 12,
        marginBottom: 16,
        lineHeight: 16
      }}>
        {permission.explanation}
      </Text>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TouchableOpacity
          style={{
            backgroundColor: theme.color?.accent || '#22c55e',
            paddingHorizontal: 20,
            paddingVertical: 12,
            borderRadius: 8,
            flex: 1,
            alignItems: 'center'
          }}
          onPress={() => handlePermissionRequest(permission)}
          disabled={isProcessing || permission.granted}
        >
          <Text style={{
            color: '#000',
            fontSize: 14,
            fontWeight: '600'
          }}>
            {permission.granted ? 'Granted' : 'Allow'}
          </Text>
        </TouchableOpacity>

        {!permission.required && !permission.granted && (
          <TouchableOpacity
            style={{
              backgroundColor: 'transparent',
              borderWidth: 1,
              borderColor: theme.color?.border || '#333',
              paddingHorizontal: 20,
              paddingVertical: 12,
              borderRadius: 8,
              flex: 1,
              alignItems: 'center'
            }}
            onPress={() => handleSkipOptional(permission)}
            disabled={isProcessing}
          >
            <Text style={{
              color: theme.color?.muted || '#bbb',
              fontSize: 14,
              fontWeight: '600'
            }}>
              Skip
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  return (
    <SafeAreaView style={{
      flex: 1,
      backgroundColor: theme.color?.bg || '#0b0b0b'
    }}>
      <ScrollView style={{ flex: 1, padding: 20 }}>
        <Text style={{
          color: theme.color?.text || '#fff',
          fontSize: 28,
          fontWeight: '700',
          textAlign: 'center',
          marginBottom: 8
        }}>
          Welcome to Bytspot
        </Text>

        <Text style={{
          color: theme.color?.muted || '#bbb',
          fontSize: 16,
          textAlign: 'center',
          marginBottom: 32,
          lineHeight: 22
        }}>
          To provide you with the best experience, we need a few permissions. 
          Your privacy is our priority.
        </Text>

        {permissions.map(renderPermissionCard)}

        <View style={{
          backgroundColor: theme.color?.border || '#333',
          padding: 16,
          borderRadius: 8,
          marginBottom: 24
        }}>
          <Text style={{
            color: theme.color?.text || '#fff',
            fontSize: 14,
            fontWeight: '600',
            marginBottom: 8
          }}>
            Privacy Promise
          </Text>
          <Text style={{
            color: theme.color?.muted || '#bbb',
            fontSize: 12,
            lineHeight: 16
          }}>
            • Your location data is only used to show nearby services{'\n'}
            • Contact matching happens on-device, never uploaded{'\n'}
            • Camera is only used when you actively scan QR codes{'\n'}
            • You can change these permissions anytime in Settings
          </Text>
        </View>
      </ScrollView>

      <View style={{
        padding: 20,
        borderTopWidth: 1,
        borderTopColor: theme.color?.border || '#333'
      }}>
        <TouchableOpacity
          style={{
            backgroundColor: canProceed() 
              ? (theme.color?.accent || '#22c55e')
              : (theme.color?.border || '#333'),
            paddingVertical: 16,
            borderRadius: 12,
            alignItems: 'center'
          }}
          onPress={handleComplete}
          disabled={!canProceed() || isProcessing}
        >
          <Text style={{
            color: canProceed() ? '#000' : (theme.color?.muted || '#bbb'),
            fontSize: 16,
            fontWeight: '700'
          }}>
            {canProceed() ? 'Continue to Preferences' : 'Grant Required Permissions'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
