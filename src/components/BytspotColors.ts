// Bytspot Color Palette
export const BytspotColors = {
  // Base Colors
  midnight: '#121212',
  lightCharcoal: '#1a1a1a',
  darkCharcoal: '#0a0a0a',
  
  // Primary & Secondary Accents
  electricBlue: '#00BFFF',
  vibrantMagenta: '#FF00FF',
  
  // Vibe Colors
  chillTeal: '#008080',
  moderateBlue: '#00BFFF', // Same as electric blue
  energeticMagenta: '#FF00FF', // Same as vibrant magenta
  highEnergyOrange: '#FF4500',
  
  // Text & UI
  pureWhite: '#FFFFFF',
  lightGray: '#C0C0C0',
  darkGray: '#404040',
  
  // Helper functions for consistent styling
  getServiceGradient: (serviceType: 'venue' | 'parking' | 'valet') => {
    switch (serviceType) {
      case 'venue':
        return `linear-gradient(135deg, #FF00FF, #00BFFF)`;
      case 'parking':
        return `linear-gradient(135deg, #00BFFF, #008080)`;
      case 'valet':
        return `linear-gradient(135deg, #008080, #FF00FF)`;
      default:
        return `linear-gradient(135deg, #00BFFF, #FF00FF)`;
    }
  },
  
  getVibeColor: (vibe: 'chill' | 'moderate' | 'energetic' | 'high-energy') => {
    switch (vibe) {
      case 'chill':
        return '#008080';
      case 'moderate':
        return '#00BFFF';
      case 'energetic':
        return '#FF00FF';
      case 'high-energy':
        return `linear-gradient(45deg, #FF00FF, #FF4500)`;
      default:
        return '#00BFFF';
    }
  },
  
  // Common style objects
  glassCard: {
    backgroundColor: 'rgba(18, 18, 18, 0.8)',
    borderColor: 'rgba(0, 191, 255, 0.2)',
    boxShadow: '0 8px 32px rgba(0, 191, 255, 0.1)',
  },
  
  primaryButton: {
    background: `linear-gradient(135deg, #00BFFF 0%, #FF00FF 100%)`,
    boxShadow: '0 4px 20px rgba(0, 191, 255, 0.4), 0 2px 10px rgba(255, 0, 255, 0.3)',
  },
  
  backgroundGradient: `linear-gradient(135deg, #121212 0%, #1a1a1a 25%, #121212 50%, #0a0a0a 75%, #121212 100%)`,
  
  progressBar: `linear-gradient(90deg, #00BFFF 0%, #FF00FF 100%)`,
};

export default BytspotColors;