import React from 'react';
import { SwipeInterfaceFixed } from './components/SwipeInterfaceFixed';

// Simple test to check if SwipeInterfaceFixed loads without the hoisting error
export function TestSwipeInterface() {
  const mockUserData = {
    id: 'test-user',
    name: 'Test User',
    permissions: {
      location: true,
      notifications: true,
      camera: true
    }
  };

  const mockProps = {
    userData: mockUserData,
    onBack: () => console.log('Back clicked'),
    onLogout: () => console.log('Logout clicked'),
    onOpenProfile: () => console.log('Profile clicked'),
    onOpenSettings: () => console.log('Settings clicked'),
    onError: (error: any) => console.error('Error:', error),
    trackEvent: (event: string, properties?: Record<string, any>) => console.log('Event:', event, properties),
    connectivity: { isOnline: true, isSlowConnection: false }
  };

  return <SwipeInterfaceFixed {...mockProps} />;
}