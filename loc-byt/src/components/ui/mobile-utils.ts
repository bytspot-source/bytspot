// Mobile detection and utilities for responsive design

export const isMobileDevice = () => {
  if (typeof window === 'undefined') return false;
  
  // Check user agent
  const userAgent = navigator.userAgent.toLowerCase();
  const isMobileUA = /mobile|android|iphone|ipad|phone|blackberry|opera mini|iemobile|wpdesktop|fennec|kindle|silk|maemo/i.test(userAgent);
  
  // Check screen size
  const isMobileScreen = window.innerWidth <= 640;
  
  // Check for touch capability
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  
  return isMobileUA || (isMobileScreen && isTouchDevice);
};

export const isIOSDevice = () => {
  if (typeof window === 'undefined') return false;
  
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || 
         (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

export const isAndroidDevice = () => {
  if (typeof window === 'undefined') return false;
  
  return /Android/.test(navigator.userAgent);
};

export const getViewportHeight = () => {
  if (typeof window === 'undefined') return 0;
  
  // Use dynamic viewport height if available, fallback to window.innerHeight
  const vh = window.visualViewport?.height || window.innerHeight;
  return vh;
};

export const getViewportWidth = () => {
  if (typeof window === 'undefined') return 0;
  
  const vw = window.visualViewport?.width || window.innerWidth;
  return vw;
};

export const getSafeAreaInsets = () => {
  if (typeof window === 'undefined') return { top: 0, bottom: 0, left: 0, right: 0 };
  
  const style = getComputedStyle(document.documentElement);
  
  return {
    top: parseInt(style.getPropertyValue('env(safe-area-inset-top)')) || 0,
    bottom: parseInt(style.getPropertyValue('env(safe-area-inset-bottom)')) || 0,
    left: parseInt(style.getPropertyValue('env(safe-area-inset-left)')) || 0,
    right: parseInt(style.getPropertyValue('env(safe-area-inset-right)')) || 0,
  };
};

// Mobile-optimized scroll utilities
export const enableMobileScroll = (element: HTMLElement) => {
  if (!element) return;
  
  element.style.overflowY = 'auto';
  element.style.overflowX = 'hidden';
  element.style.WebkitOverflowScrolling = 'touch';
  element.style.scrollBehavior = 'smooth';
  element.style.transform = 'translateZ(0)';
  
  // Prevent iOS bounce
  element.style.overscrollBehavior = 'contain';
  
  if (isIOSDevice()) {
    element.style.WebkitOverflowScrolling = 'touch';
  }
};

export const disableMobileScroll = (element: HTMLElement) => {
  if (!element) return;
  
  element.style.overflow = 'hidden';
  element.style.WebkitOverflowScrolling = 'auto';
  element.style.overscrollBehavior = 'none';
};

// Smooth scroll to top
export const scrollToTop = (element?: HTMLElement) => {
  const targetElement = element || document.documentElement;
  
  if (targetElement.scrollTo) {
    targetElement.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  } else {
    // Fallback for older browsers
    targetElement.scrollTop = 0;
  }
};

// Check if element is scrollable
export const isScrollable = (element: HTMLElement) => {
  if (!element) return false;
  
  const hasScrollableContent = element.scrollHeight > element.clientHeight;
  const overflowYStyle = getComputedStyle(element).overflowY;
  const isOverflowHidden = overflowYStyle.indexOf('hidden') !== -1;
  
  return hasScrollableContent && !isOverflowHidden;
};

// Mobile-friendly event listeners
export const addMobileEventListener = (
  element: HTMLElement,
  event: string,
  handler: EventListener,
  options: AddEventListenerOptions = {}
) => {
  const mobileOptions = {
    ...options,
    passive: true, // Better scroll performance
    capture: false,
  };
  
  element.addEventListener(event, handler, mobileOptions);
  
  return () => element.removeEventListener(event, handler, mobileOptions);
};

// Throttle function for scroll events
export const throttle = (func: Function, wait: number) => {
  let timeout: NodeJS.Timeout | null = null;
  let previous = 0;
  
  return function executedFunction(...args: any[]) {
    const now = Date.now();
    
    if (!previous) previous = now;
    
    const remaining = wait - (now - previous);
    
    if (remaining <= 0 || remaining > wait) {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      previous = now;
      func.apply(this, args);
    } else if (!timeout) {
      timeout = setTimeout(() => {
        previous = Date.now();
        timeout = null;
        func.apply(this, args);
      }, remaining);
    }
  };
};

// Debounce function for resize events
export const debounce = (func: Function, wait: number) => {
  let timeout: NodeJS.Timeout;
  
  return function executedFunction(...args: any[]) {
    const later = () => {
      clearTimeout(timeout);
      func.apply(this, args);
    };
    
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};