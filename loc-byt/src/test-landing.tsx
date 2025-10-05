import React from 'react';
import { createRoot } from 'react-dom/client';
import { LandingPage } from './components/LandingPage';
import './index.css';

// Simple test component to verify LandingPage works
function TestLandingPage() {
  const handleGetStarted = () => {
    console.log('Get Started clicked');
    alert('Get Started clicked - would navigate to auth');
  };

  const handleBecomeHost = () => {
    console.log('Become Host clicked');
    alert('Become Host clicked - would navigate to host onboarding');
  };

  const handleSignIn = () => {
    console.log('Sign In clicked');
    alert('Sign In clicked - would navigate to auth');
  };

  return (
    <LandingPage
      onGetStarted={handleGetStarted}
      onBecomeHost={handleBecomeHost}
      onSignIn={handleSignIn}
    />
  );
}

// Only render if this file is accessed directly
if (window.location.pathname === '/test-landing') {
  const root = createRoot(document.getElementById('root')!);
  root.render(<TestLandingPage />);
}

export default TestLandingPage;
