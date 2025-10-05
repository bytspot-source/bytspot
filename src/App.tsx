import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  ErrorBoundary,
} from "react";
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useSpring,
} from "motion/react";
import {
  MapPin,
  Search,
  Heart,
  Zap,
  Users,
  Car,
  UtensilsCrossed,
  Camera,
  Bell,
  Activity,
  Award,
  Star,
  Trophy,
  Crown,
  Gift,
  Sparkles,
  Sun,
  CloudRain,
  Cloud,
  CloudSnow,
  Navigation,
  Shield,
  DollarSign,
  X,
  AlertTriangle,
  RefreshCw,
  Wifi,
  WifiOff,
} from "lucide-react";
import { HomePage } from "./components/HomePage";
import { RegistrationFlow } from "./components/RegistrationFlow";
import { DiscoverySearch } from "./components/DiscoverySearch";
import { SwipeInterface } from "./components/SwipeInterface";
import { SwipeInterfaceFixed } from "./components/SwipeInterfaceFixedComplete";
import { AuthModal } from "./components/AuthModal";
import { HostOnboarding } from "./components/HostOnboarding";
import { GroupDecisionNotification } from "./components/GroupDecisionNotification";
import MapInterface from "./components/MapInterface";
import { VibePreferences } from "./components/VibePreferences";
import { Button } from "./components/ui/button";
import { toast } from "sonner@2.0.3";
import { Toaster } from "./components/ui/sonner";

type AppState =
  | "home"
  | "auth"
  | "registration"
  | "discovery"
  | "swipe"
  | "map"
  | "host-onboarding"
  | "profile"
  | "settings"
  | "vibe-preferences"
  | "error";

interface UserData {
  id?: string;
  name?: string;
  email?: string;
  address?: string;
  phone?: string;
  avatar?: string;
  permissions?: {
    location: boolean;
    notifications: boolean;
    camera: boolean;
    sensors?: boolean;
    microphone?: boolean;
    contacts?: boolean;
  };
  preferences?: string[];
  favoriteSpots?: string[];
  recentSearches?: string[];
  achievements?: string[];
  membershipLevel?: "bronze" | "silver" | "gold" | "platinum";
  bytspotPoints?: number;
  createdAt?: Date;
  lastLoginAt?: Date;
  isVerified?: boolean;
  settings?: {
    theme: "auto" | "light" | "dark";
    language: string;
    currency: string;
    notifications: {
      push: boolean;
      email: boolean;
      sms: boolean;
      marketing: boolean;
    };
    privacy: {
      shareLocation: boolean;
      shareActivity: boolean;
      publicProfile: boolean;
    };
  };
}

interface AppError {
  type:
    | "network"
    | "auth"
    | "permission"
    | "system"
    | "validation";
  message: string;
  code?: string;
  timestamp: Date;
  recoverable: boolean;
  action?: string;
}

interface LoadingState {
  isLoading: boolean;
  message?: string;
  progress?: number;
}

// Time-based theme types
type TimeTheme =
  | "dawn"
  | "morning"
  | "afternoon"
  | "evening"
  | "night";
type WeatherTheme =
  | "sunny"
  | "rainy"
  | "cloudy"
  | "stormy"
  | "snowy"
  | "foggy";
type LocationTheme =
  | "beach"
  | "city"
  | "mountain"
  | "forest"
  | "desert"
  | "suburban";

interface ParticleTrail {
  id: string;
  x: number;
  y: number;
  opacity: number;
  size: number;
  color: string;
}

interface GroupMember {
  id: string;
  name: string;
  avatar: string;
  status: "pending" | "approved" | "declined" | "viewing";
  joinedAt: Date;
}

interface VenueDetails {
  name: string;
  category: "parking" | "venue" | "valet";
  location: string;
  distance: string;
  price?: string;
  rating?: number;
  features: string[];
  availability: "available" | "limited" | "unavailable";
  image?: string;
}

interface SmartRecommendation {
  id: string;
  title: string;
  description: string;
  type:
    | "discovery"
    | "suggestion"
    | "tip"
    | "alert"
    | "recommendation"
    | "group_decision";
  icon: React.ReactNode;
  priority: "low" | "medium" | "high";
  timestamp: Date;
  progress?: number;
  maxProgress?: number;
  groupData?: {
    groupId: string;
    groupName: string;
    initiator: string;
    venue: VenueDetails;
    members: GroupMember[];
    deadline: Date;
    totalVotes: number;
    approvedVotes: number;
    declinedVotes: number;
  };
}

interface ActivityIndicator {
  id: string;
  x: number;
  y: number;
  opacity: number;
  size: number;
  color: string;
}

// Error Boundary Component
class AppErrorBoundary extends React.Component<
  {
    children: React.ReactNode;
    onError: (error: AppError) => void;
  },
  { hasError: boolean; error?: Error }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    const appError: AppError = {
      type: "system",
      message: error.message,
      code: error.name,
      timestamp: new Date(),
      recoverable: true,
      action: "Retry",
    };
    this.props.onError(appError);

    // Log to analytics/monitoring service
    console.error("App Error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] flex items-center justify-center p-4">
          <motion.div
            className="glass-effect p-8 rounded-2xl text-center max-w-md w-full"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
          >
            <AlertTriangle className="w-16 h-16 text-red-400 mx-auto mb-4" />
            <h2 className="text-white text-xl font-semibold mb-2">
              Something went wrong
            </h2>
            <p className="text-white/70 mb-6">
              We're experiencing a technical issue. Please try
              again.
            </p>
            <Button
              onClick={() => window.location.reload()}
              className="w-full bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] hover:opacity-90"
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh App
            </Button>
          </motion.div>
        </div>
      );
    }

    return this.props.children;
  }
}

function App() {
  // Core State Management
  const [currentState, setCurrentState] =
    useState<AppState>("home");
  const [userData, setUserData] = useState<UserData>({});
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [smartSuggestion, setSmartSuggestion] =
    useState<string>("");
  const [currentTheme, setCurrentTheme] =
    useState<TimeTheme>("morning");
  const [weatherTheme, setWeatherTheme] =
    useState<WeatherTheme>("sunny");
  const [locationTheme, setLocationTheme] =
    useState<LocationTheme>("city");

  // Enhanced State Management
  const [appError, setAppError] = useState<AppError | null>(
    null,
  );
  const [loadingState, setLoadingState] =
    useState<LoadingState>({ isLoading: false });

  const [particles, setParticles] = useState<ParticleTrail[]>(
    [],
  );
  const [indicators, setIndicators] = useState<
    ActivityIndicator[]
  >([]);
  const [recommendations, setRecommendations] = useState<
    SmartRecommendation[]
  >([]);
  const [activeUsers, setActiveUsers] = useState(847);
  const [showRecommendation, setShowRecommendation] =
    useState<SmartRecommendation | null>(null);
  const [notificationTimeoutId, setNotificationTimeoutId] =
    useState<NodeJS.Timeout | null>(null);
  const [isNotificationHovered, setIsNotificationHovered] =
    useState(false);
  const [locationContext, setLocationContext] = useState<{
    city?: string;
  } | null>({ city: "Downtown" });
  const [currentTemperature, setCurrentTemperature] =
    useState(72);
  const [weatherCondition, setWeatherCondition] =
    useState("Clear");
  const [showSystemNotification, setShowSystemNotification] =
    useState<{
      id: string;
      type:
        | "weather"
        | "traffic"
        | "parking"
        | "venue"
        | "system";
      title: string;
      message: string;
      action?: string;
      priority: "low" | "medium" | "high";
      timestamp: Date;
    } | null>(null);
  const [systemNotifications, setSystemNotifications] =
    useState<
      Array<{
        id: string;
        type:
          | "weather"
          | "traffic"
          | "parking"
          | "venue"
          | "system";
        title: string;
        message: string;
        action?: string;
        priority: "low" | "medium" | "high";
        timestamp: Date;
        read: boolean;
      }>
    >([]);

  // Mouse tracking for particle trails
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const springX = useSpring(mouseX, {
    stiffness: 400,
    damping: 40,
  });
  const springY = useSpring(mouseY, {
    stiffness: 400,
    damping: 40,
  });
  const containerRef = useRef<HTMLDivElement>(null);

  // Dynamic theme based on time of day
  const getTimeTheme = (): TimeTheme => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 8) return "dawn";
    if (hour >= 8 && hour < 12) return "morning";
    if (hour >= 12 && hour < 17) return "afternoon";
    if (hour >= 17 && hour < 21) return "evening";
    return "night";
  };

  // Enhanced theme system with weather and location integration
  const getWeatherColors = (weather: WeatherTheme) => {
    const weatherThemes = {
      sunny: {
        primary: "from-yellow-400 via-orange-400 to-amber-400",
        secondary: "from-orange-300 to-yellow-500",
        accent: "from-amber-400 to-orange-500",
        bg: "from-yellow-800 via-orange-800 to-amber-900",
        particles: "#fbbf24",
      },
      rainy: {
        primary: "from-blue-400 via-slate-400 to-gray-400",
        secondary: "from-slate-400 to-blue-500",
        accent: "from-gray-400 to-slate-500",
        bg: "from-slate-800 via-gray-800 to-blue-900",
        particles: "#64748b",
      },
      cloudy: {
        primary: "from-gray-300 via-slate-400 to-zinc-400",
        secondary: "from-zinc-400 to-gray-500",
        accent: "from-slate-400 to-zinc-500",
        bg: "from-gray-700 via-slate-800 to-zinc-900",
        particles: "#71717a",
      },
      stormy: {
        primary: "from-purple-500 via-indigo-600 to-gray-600",
        secondary: "from-indigo-500 to-purple-600",
        accent: "from-violet-500 to-indigo-600",
        bg: "from-purple-900 via-indigo-900 to-gray-900",
        particles: "#6366f1",
      },
      snowy: {
        primary: "from-blue-200 via-cyan-200 to-white",
        secondary: "from-cyan-200 to-blue-300",
        accent: "from-blue-300 to-cyan-400",
        bg: "from-blue-900 via-cyan-900 to-slate-800",
        particles: "#e0f2fe",
      },
      foggy: {
        primary: "from-gray-400 via-zinc-300 to-slate-400",
        secondary: "from-slate-300 to-gray-400",
        accent: "from-zinc-400 to-slate-500",
        bg: "from-gray-800 via-zinc-800 to-slate-900",
        particles: "#94a3b8",
      },
    };
    return weatherThemes[weather];
  };

  const getLocationColors = (location: LocationTheme) => {
    const locationThemes = {
      beach: {
        primary: "from-cyan-400 via-blue-400 to-teal-400",
        secondary: "from-teal-300 to-cyan-500",
        accent: "from-blue-400 to-teal-500",
        bg: "from-cyan-800 via-blue-800 to-teal-900",
        particles: "#22d3ee",
      },
      city: {
        primary: "from-gray-400 via-zinc-400 to-slate-400",
        secondary: "from-slate-400 to-gray-500",
        accent: "from-zinc-400 to-slate-500",
        bg: "from-gray-800 via-zinc-800 to-slate-900",
        particles: "#64748b",
      },
      mountain: {
        primary: "from-stone-400 via-emerald-400 to-green-400",
        secondary: "from-green-400 to-emerald-500",
        accent: "from-emerald-400 to-green-500",
        bg: "from-stone-800 via-emerald-800 to-green-900",
        particles: "#10b981",
      },
      forest: {
        primary: "from-green-500 via-emerald-500 to-teal-500",
        secondary: "from-emerald-400 to-green-600",
        accent: "from-teal-400 to-emerald-600",
        bg: "from-green-900 via-emerald-900 to-teal-900",
        particles: "#059669",
      },
      desert: {
        primary: "from-orange-400 via-amber-400 to-yellow-400",
        secondary: "from-yellow-400 to-orange-500",
        accent: "from-amber-400 to-orange-500",
        bg: "from-orange-800 via-amber-800 to-yellow-800",
        particles: "#f59e0b",
      },
      suburban: {
        primary: "from-green-400 via-lime-400 to-emerald-400",
        secondary: "from-lime-400 to-green-500",
        accent: "from-emerald-400 to-lime-500",
        bg: "from-green-800 via-lime-800 to-emerald-900",
        particles: "#22c55e",
      },
    };
    return locationThemes[location];
  };

  const getTimeColors = (theme: TimeTheme) => {
    const timeThemes = {
      dawn: {
        primary: "from-rose-400 via-pink-400 to-orange-300",
        secondary: "from-amber-300 to-rose-400",
        accent: "from-pink-300 to-orange-400",
        bg: "from-rose-900 via-pink-900 to-orange-800",
        particles: "#fb7185",
      },
      morning: {
        primary: "from-blue-400 via-cyan-400 to-teal-400",
        secondary: "from-emerald-400 to-cyan-400",
        accent: "from-sky-400 to-blue-500",
        bg: "from-blue-900 via-cyan-900 to-teal-800",
        particles: "#22d3ee",
      },
      afternoon: {
        primary: "from-yellow-400 via-orange-400 to-red-400",
        secondary: "from-orange-400 to-pink-400",
        accent: "from-amber-400 to-orange-500",
        bg: "from-yellow-900 via-orange-900 to-red-800",
        particles: "#f59e0b",
      },
      evening: {
        primary: "from-purple-400 via-pink-400 to-indigo-400",
        secondary: "from-violet-400 to-purple-500",
        accent: "from-fuchsia-400 to-pink-500",
        bg: "from-purple-900 via-pink-900 to-indigo-900",
        particles: "#a855f7",
      },
      night: {
        primary: "from-indigo-400 via-purple-400 to-pink-400",
        secondary: "from-blue-500 to-indigo-500",
        accent: "from-violet-400 to-purple-500",
        bg: "from-indigo-900 via-purple-900 to-pink-900",
        particles: "#8b5cf6",
      },
    };
    return timeThemes[theme];
  };

  // Blend multiple theme sources for unique combinations with Bytspot colors
  const getBlendedThemeColors = (
    time: TimeTheme,
    weather: WeatherTheme,
    location: LocationTheme,
  ) => {
    // Use Bytspot color palette as base with subtle variations
    return {
      primary: "from-[#121212] via-[#00BFFF] to-[#FF00FF]",
      secondary: "from-[#008080] to-[#00BFFF]",
      accent: "from-[#FF00FF] to-[#FF4500]",
      bg: "from-[#0a0a0a] via-[#121212] to-[#1a1a1a]",
      particles: "#00BFFF",
    };
  };

  // Enhanced weather detection with temperature (mock)
  const getWeatherCondition = (): WeatherTheme => {
    const conditions: WeatherTheme[] = [
      "sunny",
      "rainy",
      "cloudy",
      "stormy",
      "snowy",
      "foggy",
    ];
    const selected =
      conditions[Math.floor(Math.random() * conditions.length)];

    // Update temperature based on weather
    const tempRanges = {
      sunny: [75, 85],
      rainy: [55, 70],
      cloudy: [60, 75],
      stormy: [50, 65],
      snowy: [25, 40],
      foggy: [45, 60],
    };

    const [min, max] = tempRanges[selected];
    setCurrentTemperature(
      Math.round(min + Math.random() * (max - min)),
    );

    // Update weather condition text
    const conditionTexts = {
      sunny: "Clear",
      rainy: "Light Rain",
      cloudy: "Partly Cloudy",
      stormy: "Thunderstorm",
      snowy: "Snow",
      foggy: "Fog",
    };
    setWeatherCondition(conditionTexts[selected]);

    // In real app, this would be from weather API
    return selected;
  };

  // Simplified Error Handling
  const handleError = useCallback((error: AppError) => {
    setAppError(error);

    // User feedback
    toast.error(error.message, {
      action:
        error.recoverable && error.action
          ? {
              label: error.action,
              onClick: () => handleErrorRecovery(error),
            }
          : undefined,
    });
  }, []);

  const handleErrorRecovery = useCallback((error: AppError) => {
    setAppError(null);

    switch (error.type) {
      case "network":
        // Retry network operations
        window.location.reload();
        break;
      case "auth":
        // Re-authenticate
        setIsAuthenticated(false);
        setCurrentState("auth");
        break;
      case "permission":
        // Re-request permissions
        setCurrentState("registration");
        break;
      default:
        // General recovery
        setCurrentState("home");
    }
  }, []);

  // Simplified State Persistence
  useEffect(() => {
    // Load persisted user data
    try {
      const savedUserData = localStorage.getItem(
        "bytspot_user_data",
      );
      const savedAuthState = localStorage.getItem(
        "bytspot_auth_state",
      );

      if (savedUserData) {
        const parsedUserData = JSON.parse(savedUserData);
        setUserData(parsedUserData);
      }

      if (savedAuthState === "true") {
        setIsAuthenticated(true);
      }
    } catch (error) {
      console.warn("Failed to load persisted data:", error);
    }
  }, []);

  // Auto-save user data
  useEffect(() => {
    if (Object.keys(userData).length > 0) {
      localStorage.setItem(
        "bytspot_user_data",
        JSON.stringify(userData),
      );
      localStorage.setItem(
        "bytspot_auth_state",
        isAuthenticated.toString(),
      );
    }
  }, [userData, isAuthenticated]);

  // Enhanced intelligent notification system - Performance optimized
  const generateSystemNotification = useCallback(() => {
    const currentTime = new Date().getHours();
    const isWeekend =
      new Date().getDay() === 0 || new Date().getDay() === 6;
    const isEvening = currentTime >= 17 && currentTime <= 22;
    const isMorning = currentTime >= 6 && currentTime <= 11;

    // Context-aware notification types based on time, weather, and location
    const getContextualNotifications = () => {
      const baseNotifications = [];

      // Weather-contextual notifications
      if (weatherTheme === "sunny" && currentTemperature > 70) {
        baseNotifications.push({
          type: "weather" as const,
          title: "Perfect Weather Alert",
          message: `Sunny ${currentTemperature}°F - Ideal conditions for rooftop venues and outdoor dining!`,
          action: "Find Outdoor Spots",
          priority: "medium" as const,
        });
      } else if (weatherTheme === "rainy") {
        baseNotifications.push({
          type: "weather" as const,
          title: "Rain Advisory",
          message: `Light rain detected - covered parking and indoor venues recommended`,
          action: "Find Covered Options",
          priority: "medium" as const,
        });
      } else if (currentTemperature < 40) {
        baseNotifications.push({
          type: "weather" as const,
          title: "Cold Weather Alert",
          message: `Chilly ${currentTemperature}°F - Heated venues and garage parking available`,
          action: "Find Warm Spots",
          priority: "medium" as const,
        });
      }

      // Time-based parking notifications
      if (isMorning && !isWeekend) {
        baseNotifications.push({
          type: "parking" as const,
          title: "Morning Commuter Special",
          message:
            "Early bird parking rates - Save up to 50% on all-day spots",
          action: "Book Early Bird",
          priority: "high" as const,
        });
      } else if (isEvening && isWeekend) {
        baseNotifications.push({
          type: "parking" as const,
          title: "Weekend Night Special",
          message:
            "Premium valet service available - Skip the parking hassle tonight",
          action: "Book Valet",
          priority: "high" as const,
        });
      } else {
        baseNotifications.push({
          type: "parking" as const,
          title: "Smart Parking Match",
          message: `Secure spot found in ${locationContext?.city} - 2 min walk, great reviews`,
          action: "Reserve Now",
          priority: "high" as const,
        });
      }

      // Dynamic traffic notifications
      const trafficConditions = ["light", "moderate", "heavy"];
      const currentTraffic =
        trafficConditions[
          Math.floor(Math.random() * trafficConditions.length)
        ];

      if (currentTraffic === "light") {
        baseNotifications.push({
          type: "traffic" as const,
          title: "Clear Roads Ahead",
          message:
            "Unusually light traffic detected - Perfect time for that downtown trip!",
          action: "Get Directions",
          priority: "low" as const,
        });
      } else if (currentTraffic === "heavy") {
        baseNotifications.push({
          type: "traffic" as const,
          title: "Traffic Advisory",
          message:
            "Heavy traffic on main routes - Consider alternative transport or wait 30 mins",
          action: "View Alternatives",
          priority: "medium" as const,
        });
      }

      // Evening venue recommendations
      if (isEvening) {
        baseNotifications.push({
          type: "venue" as const,
          title: "Evening Hotspot Alert",
          message: `Trending: New cocktail lounge in ${locationContext?.city} - Live jazz tonight!`,
          action: "Check It Out",
          priority: "medium" as const,
        });
      } else {
        baseNotifications.push({
          type: "venue" as const,
          title: "Local Discovery",
          message:
            "Hidden gem café just rated 4.9★ by the community - Limited time grand opening specials",
          action: "Discover Now",
          priority: "medium" as const,
        });
      }

      // Smart system notifications
      if (Math.random() < 0.3) {
        baseNotifications.push({
          type: "system" as const,
          title: "Bytspot Intelligence",
          message:
            "Your preference learning is 85% complete - More personalized recommendations coming!",
          action: "View Progress",
          priority: "low" as const,
        });
      }

      return baseNotifications;
    };

    const contextualNotifications =
      getContextualNotifications();
    const selected =
      contextualNotifications[
        Math.floor(
          Math.random() * contextualNotifications.length,
        )
      ];

    const notification = {
      id: `notif-${Date.now()}`,
      ...selected,
      timestamp: new Date(),
    };

    setShowSystemNotification(notification);
    setSystemNotifications((prev) => [
      { ...notification, read: false },
      ...prev.slice(0, 9),
    ]);

    // Enhanced auto-dismiss timing based on content relevance
    const getDismissTime = () => {
      if (notification.priority === "high") return 10000; // 10s for high priority
      if (notification.priority === "medium") return 7000; // 7s for medium priority
      return 5000; // 5s for low priority
    };

    setTimeout(() => {
      setShowSystemNotification(null);
    }, getDismissTime());
  }, [weatherTheme, currentTemperature, locationContext?.city]);

  // Enhanced location detection with city context (mock)
  const getLocationContext = (): LocationTheme => {
    const locations: LocationTheme[] = [
      "beach",
      "city",
      "mountain",
      "forest",
      "desert",
      "suburban",
    ];
    const cities = [
      "Downtown",
      "Midtown",
      "Financial District",
      "Arts District",
      "Harbor Area",
      "Tech Hub",
    ];

    const selectedLocation =
      locations[Math.floor(Math.random() * locations.length)];
    const selectedCity =
      cities[Math.floor(Math.random() * cities.length)];

    // Update location context with city info
    setLocationContext({ city: selectedCity });

    // In real app, this would be from GPS + location services
    return selectedLocation;
  };

  // Manual theme changes for demo
  const handleWeatherChange = (weather: string) => {
    setWeatherTheme(weather as WeatherTheme);
  };

  const handleLocationChange = (location: string) => {
    setLocationTheme(location as LocationTheme);
  };

  const handleTriggerRecommendation = () => {
    const newRecommendation = generateSmartRecommendation();
    setRecommendations((prev) => [
      newRecommendation,
      ...prev.slice(0, 9),
    ]);
    setShowRecommendation(newRecommendation);

    // Clear any existing timeout
    if (notificationTimeoutId) {
      clearTimeout(notificationTimeoutId);
    }

    // More intuitive timing based on priority and type
    const getDisplayTime = () => {
      if (newRecommendation.type === "group_decision")
        return 12000; // 12s for group decisions
      if (newRecommendation.priority === "high") return 5000; // 5s for high priority
      if (newRecommendation.priority === "medium") return 4000; // 4s for medium priority
      return 3000; // 3s for low priority
    };

    const displayTime = getDisplayTime();
    const timeoutId = setTimeout(() => {
      if (!isNotificationHovered) {
        setShowRecommendation(null);
      }
    }, displayTime);

    setNotificationTimeoutId(timeoutId);
  };

  const handleTriggerSystemNotification = () => {
    generateSystemNotification();
  };

  // Generate helpful user recommendations including group decisions - Memoized for performance
  const generateSmartRecommendation =
    useCallback((): SmartRecommendation => {
      const shouldShowGroupDecision = Math.random() < 0.4; // 40% chance for group decision

      if (shouldShowGroupDecision) {
        return generateGroupDecisionNotification();
      }

      const insightTypes = [
        {
          id: "parking_spot_found",
          title: "Secure Parking Available!",
          description:
            "Found covered parking with EV charging just 1 block away",
          type: "discovery" as const,
          icon: <Car className="w-6 h-6" />,
          priority: "high" as const,
        },
        {
          id: "parking_price_alert",
          title: "Great Parking Deal",
          description:
            "Premium parking spot 40% cheaper than average in this area",
          type: "discovery" as const,
          icon: <DollarSign className="w-6 h-6" />,
          priority: "medium" as const,
        },
        {
          id: "parking_navigation_ready",
          title: "Navigation Ready",
          description:
            "Turn-by-turn directions to your reserved parking spot",
          type: "discovery" as const,
          icon: <Navigation className="w-6 h-6" />,
          priority: "high" as const,
        },
        {
          id: "parking_security_verified",
          title: "Security Verified",
          description:
            "This parking spot has 24/7 security and camera monitoring",
          type: "discovery" as const,
          icon: <Shield className="w-6 h-6" />,
          priority: "medium" as const,
        },
        {
          id: "venue_recommendation",
          title: "New Restaurant Recommendation",
          description:
            "Highly rated Italian restaurant just opened nearby",
          type: "discovery" as const,
          icon: <Activity className="w-6 h-6" />,
          priority: "medium" as const,
        },
        {
          id: "valet_available",
          title: "Valet Service Available",
          description:
            "Premium valet service is available at your destination",
          type: "discovery" as const,
          icon: <Zap className="w-6 h-6" />,
          priority: "high" as const,
        },
      ];

      const insight =
        insightTypes[
          Math.floor(Math.random() * insightTypes.length)
        ];
      return {
        ...insight,
        timestamp: new Date(),
      };
    }, []);

  // Generate group decision notification - Memoized for performance
  const generateGroupDecisionNotification =
    useCallback((): SmartRecommendation => {
      const venues = [
        {
          name: "Premium Garage Spot",
          category: "parking" as const,
          location: "Downtown Financial District",
          distance: "2 min walk",
          price: "$12/hour",
          rating: 4.8,
          features: [
            "Covered Parking",
            "Security Cameras",
            "EV Charging Stations",
            "Keycard Access",
          ],
          availability: "available" as const,
        },
        {
          name: "Secure Street Parking",
          category: "parking" as const,
          location: "Business District",
          distance: "1 min walk",
          price: "$6/hour",
          rating: 4.5,
          features: [
            "Well-lit Area",
            "Mobile Payment",
            "2-hour Maximum",
            "Nearby Security",
          ],
          availability: "limited" as const,
        },
        {
          name: "Executive Parking Tower",
          category: "parking" as const,
          location: "Corporate Center",
          distance: "3 min walk",
          price: "$15/hour",
          rating: 4.9,
          features: [
            "Valet Service",
            "Car Wash Available",
            "Reserved Spots",
            "Climate Controlled",
          ],
          availability: "available" as const,
        },
        {
          name: "Skyline Rooftop",
          category: "venue" as const,
          location: "Arts District",
          distance: "5 min walk",
          price: "$35/person",
          rating: 4.9,
          features: [
            "City Views",
            "Live Music",
            "Craft Cocktails",
          ],
          availability: "limited" as const,
        },
        {
          name: "Elite Valet Service",
          category: "valet" as const,
          location: "Entertainment District",
          distance: "On-site",
          price: "$25/hour",
          rating: 4.7,
          features: ["White Glove", "24/7 Service", "Car Care"],
          availability: "available" as const,
        },
      ];

      const groupNames = [
        "Weekend Squad",
        "Team Dinner",
        "Friends Night Out",
        "Date Night Crew",
        "Business Partners",
      ];
      const memberNames = [
        "Alex",
        "Jordan",
        "Morgan",
        "Casey",
        "Riley",
        "Avery",
        "Quinn",
        "Blake",
      ];

      const selectedVenue =
        venues[Math.floor(Math.random() * venues.length)];
      const selectedGroup =
        groupNames[
          Math.floor(Math.random() * groupNames.length)
        ];

      // Generate random group members
      const numMembers = Math.floor(Math.random() * 4) + 3; // 3-6 members
      const shuffledNames = [...memberNames].sort(
        () => Math.random() - 0.5,
      );
      const members: GroupMember[] = shuffledNames
        .slice(0, numMembers)
        .map((name, index) => ({
          id: `member-${index}`,
          name,
          avatar: `https://images.unsplash.com/photo-${1500000000000 + Math.floor(Math.random() * 100000000)}?w=32&h=32&fit=crop&crop=face`,
          status:
            index === 0
              ? "viewing"
              : (["pending", "approved", "declined"][
                  Math.floor(Math.random() * 3)
                ] as any),
          joinedAt: new Date(
            Date.now() - Math.random() * 3600000,
          ), // Random time in last hour
        }));

      const approvedVotes = members.filter(
        (m) => m.status === "approved",
      ).length;
      const declinedVotes = members.filter(
        (m) => m.status === "declined",
      ).length;

      return {
        id: `group-decision-${Date.now()}`,
        title: "Group Decision Needed",
        description: `${selectedGroup} wants to decide on ${selectedVenue.name}`,
        type: "group_decision",
        icon: <Users className="w-6 h-6" />,
        priority: "high",
        timestamp: new Date(),
        groupData: {
          groupId: `group-${Date.now()}`,
          groupName: selectedGroup,
          initiator: members[0].name,
          venue: selectedVenue,
          members,
          deadline: new Date(Date.now() + 1800000), // 30 minutes from now
          totalVotes: members.length,
          approvedVotes,
          declinedVotes,
        },
      };
    }, []);

  // Create subtle activity indicators with Bytspot colors - Optimized
  const createActivityIndicator = useCallback(
    (
      x: number,
      y: number,
      priority: SmartRecommendation["priority"],
    ) => {
      const indicatorCount =
        priority === "high" ? 3 : priority === "medium" ? 2 : 1;
      const colors = {
        low: "#008080", // Chill Teal
        medium: "#00BFFF", // Electric Blue
        high: "#FF00FF", // Vibrant Magenta
      };

      const newIndicators: ActivityIndicator[] = [];

      for (let i = 0; i < indicatorCount; i++) {
        const angle = (Math.PI * 2 * i) / indicatorCount;
        const radius = 20 + Math.random() * 15;

        newIndicators.push({
          id: `${Date.now()}-${i}`,
          x: x + Math.cos(angle) * radius,
          y: y + Math.sin(angle) * radius,
          opacity: 0.6,
          size: priority === "high" ? 2 : 1,
          color: colors[priority],
        });
      }

      setIndicators((prev) => {
        const updated = [...prev.slice(-10), ...newIndicators];
        return updated;
      });
    },
    [],
  );

  // Subtle mouse interaction for professional interface
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    mouseX.set(x);
    mouseY.set(y);

    if (Math.random() < 0.02) {
      const bytspotColors = [
        "#00BFFF",
        "#FF00FF",
        "#008080",
        "#FF4500",
      ];
      const randomColor =
        bytspotColors[
          Math.floor(Math.random() * bytspotColors.length)
        ];

      const newParticle: ParticleTrail = {
        id: Date.now().toString() + Math.random(),
        x,
        y,
        opacity: 0.2,
        size: 1,
        color: randomColor,
      };

      setParticles((prev) => {
        const updated = [...prev.slice(-3), newParticle];
        return updated;
      });
    }
  };

  // Update activity indicators and cleanup particles
  useEffect(() => {
    const interval = setInterval(() => {
      setIndicators((prev) => {
        const updated = prev
          .map((indicator) => {
            const newOpacity = indicator.opacity - 0.01;
            if (newOpacity <= 0) return null;

            return {
              ...indicator,
              opacity: newOpacity,
              y: indicator.y - 0.3,
            };
          })
          .filter(Boolean) as ActivityIndicator[];

        return updated;
      });

      setParticles((prev) =>
        prev.filter((p) => Date.now() - parseInt(p.id) < 3000),
      );
    }, 200);

    return () => clearInterval(interval);
  }, []);

  // Enhanced theme, weather, and achievement system
  useEffect(() => {
    setCurrentTheme(getTimeTheme());
    setWeatherTheme(getWeatherCondition());
    setLocationTheme(getLocationContext());

    let isActive = true;

    const themeInterval = setInterval(() => {
      if (isActive) {
        setCurrentTheme(getTimeTheme());
      }
    }, 60000);

    const weatherInterval = setInterval(() => {
      if (isActive) {
        setWeatherTheme(getWeatherCondition());
      }
    }, 300000);

    const locationInterval = setInterval(() => {
      if (isActive) {
        setLocationTheme(getLocationContext());
      }
    }, 600000);

    const activityInterval = setInterval(() => {
      if (isActive) {
        setActiveUsers((prev) =>
          Math.max(
            800,
            Math.min(
              900,
              prev + Math.floor(Math.random() * 3) - 1,
            ),
          ),
        );
      }
    }, 30000);

    const recommendationInterval = setInterval(() => {
      if (isActive && currentState === "swipe") {
        // Only show during swipe interface
        // Less frequent, more contextual recommendations
        const shouldShow = Math.random() < 0.7; // 70% chance to show
        if (shouldShow) {
          const newRecommendation =
            generateSmartRecommendation();
          setRecommendations((prev) => [
            newRecommendation,
            ...prev.slice(0, 4),
          ]);
          setShowRecommendation(newRecommendation);

          if (containerRef.current) {
            const rect =
              containerRef.current.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              createActivityIndicator(
                rect.width / 2,
                rect.height / 2,
                newRecommendation.priority,
              );
            }
          }

          // Clear any existing timeout
          if (notificationTimeoutId) {
            clearTimeout(notificationTimeoutId);
          }

          // More intuitive timing
          const getDisplayTime = () => {
            if (newRecommendation.type === "group_decision")
              return 12000;
            if (newRecommendation.priority === "high")
              return 5000;
            if (newRecommendation.priority === "medium")
              return 4000;
            return 3000;
          };

          const displayTime = getDisplayTime();
          const timeoutId = setTimeout(() => {
            if (isActive && !isNotificationHovered) {
              setShowRecommendation(null);
            }
          }, displayTime);

          setNotificationTimeoutId(timeoutId);
        }
      }
    }, 35000); // Reduced frequency: every 35 seconds

    // System notification interval - weather, traffic, parking alerts
    const systemNotificationInterval = setInterval(() => {
      if (
        isActive &&
        (currentState === "swipe" ||
          currentState === "discovery")
      ) {
        const shouldShow = Math.random() < 0.4; // 40% chance to show system notifications
        if (shouldShow && !showSystemNotification) {
          generateSystemNotification();
        }
      }
    }, 45000); // Every 45 seconds for system notifications

    return () => {
      isActive = false;
      clearInterval(themeInterval);
      clearInterval(weatherInterval);
      clearInterval(locationInterval);
      clearInterval(activityInterval);
      clearInterval(recommendationInterval);
      clearInterval(systemNotificationInterval);
      if (notificationTimeoutId) {
        clearTimeout(notificationTimeoutId);
      }
    };
  }, []);

  // Simplified State Management
  const handleStateChange = useCallback(
    async (
      newState: AppState,
      options?: { skipValidation?: boolean },
    ) => {
      try {
        setLoadingState({
          isLoading: true,
          message: "Loading...",
        });

        // Pre-state change logic
        if (
          newState === "swipe" &&
          !userData.preferences?.length
        ) {
          toast.warning(
            "Please complete your preferences first",
          );
          setCurrentState("discovery");
          return;
        }

        if (
          newState === "map" &&
          !userData.permissions?.location
        ) {
          toast.warning(
            "Location permission required for map view",
          );
          setCurrentState("registration");
          return;
        }

        setCurrentState(newState);

        // Post-state change logic
        await new Promise((resolve) =>
          setTimeout(resolve, 300),
        ); // Smooth transition
      } catch (error) {
        handleError({
          type: "system",
          message:
            error instanceof Error
              ? error.message
              : "Failed to change state",
          timestamp: new Date(),
          recoverable: true,
          action: "Retry",
        });
      } finally {
        setLoadingState({ isLoading: false });
      }
    },
    [currentState, userData, handleError],
  );

  const handleUserDataUpdate = useCallback(
    (
      data: Partial<UserData>,
      options?: { validate?: boolean },
    ) => {
      try {
        if (options?.validate) {
          // Validate user data
          if (data.email && !isValidEmail(data.email)) {
            throw new Error("Invalid email format");
          }
          if (data.phone && !isValidPhone(data.phone)) {
            throw new Error("Invalid phone number format");
          }
        }

        const updatedData = {
          ...userData,
          ...data,
          lastLoginAt: new Date(),
          ...(data.name && {
            id: data.id || `user_${Date.now()}`,
          }),
        };

        setUserData(updatedData);

        toast.success("Profile updated successfully");
      } catch (error) {
        handleError({
          type: "validation",
          message:
            error instanceof Error
              ? error.message
              : "Invalid user data",
          timestamp: new Date(),
          recoverable: true,
          action: "Fix",
        });
      }
    },
    [userData, handleError],
  );

  const handleAuth = useCallback(
    async (authData: {
      email: string;
      name: string;
      password?: string;
    }) => {
      try {
        setLoadingState({
          isLoading: true,
          message: "Authenticating...",
        });

        // Simulate API call
        await new Promise((resolve) =>
          setTimeout(resolve, 1500),
        );

        const newUserData: UserData = {
          id: `user_${Date.now()}`,
          name: authData.name,
          email: authData.email,
          createdAt: new Date(),
          lastLoginAt: new Date(),
          isVerified: false,
          bytspotPoints: 100, // Welcome bonus
          membershipLevel: "bronze",
          settings: {
            theme: "auto",
            language: "en",
            currency: "USD",
            notifications: {
              push: true,
              email: true,
              sms: false,
              marketing: false,
            },
            privacy: {
              shareLocation: true,
              shareActivity: false,
              publicProfile: false,
            },
          },
        };

        setIsAuthenticated(true);
        setUserData(newUserData);

        toast.success(`Welcome to Bytspot, ${authData.name}!`);

        await handleStateChange("registration");
      } catch (error) {
        handleError({
          type: "auth",
          message: "Authentication failed. Please try again.",
          timestamp: new Date(),
          recoverable: true,
          action: "Retry",
        });
      } finally {
        setLoadingState({ isLoading: false });
      }
    },
    [handleStateChange, handleError],
  );

  const handleLogout = useCallback(async () => {
    try {
      setLoadingState({
        isLoading: true,
        message: "Signing out...",
      });

      // Clear local storage
      localStorage.removeItem("bytspot_user_data");
      localStorage.removeItem("bytspot_auth_state");

      setIsAuthenticated(false);
      setUserData({});

      await handleStateChange("home", { skipValidation: true });

      toast.success("Signed out successfully");
    } catch (error) {
      handleError({
        type: "system",
        message: "Failed to sign out properly",
        timestamp: new Date(),
        recoverable: true,
      });
    } finally {
      setLoadingState({ isLoading: false });
    }
  }, [userData, handleStateChange, handleError]);

  const handleSmartSuggestion = useCallback(
    (suggestion: string) => {
      setSmartSuggestion(suggestion);
      handleUserDataUpdate({ address: suggestion });

      handleStateChange("auth");
    },
    [handleUserDataUpdate, handleStateChange, userData.id],
  );

  const handleHostOnboarding = useCallback(() => {
    handleStateChange("host-onboarding");
  }, [handleStateChange]);

  const handleHostComplete = useCallback(
    async (hostData: any) => {
      try {
        setLoadingState({
          isLoading: true,
          message: "Setting up your host profile...",
        });

        // Simulate API call
        await new Promise((resolve) =>
          setTimeout(resolve, 2000),
        );

        handleUserDataUpdate({
          ...hostData,
          membershipLevel: "gold", // Upgrade hosts
          bytspotPoints: (userData.bytspotPoints || 0) + 500, // Host bonus
        });

        toast.success(
          "Host profile created successfully! Welcome to the Bytspot host community.",
        );

        await handleStateChange("home");
      } catch (error) {
        handleError({
          type: "system",
          message: "Failed to complete host onboarding",
          timestamp: new Date(),
          recoverable: true,
          action: "Retry",
        });
      } finally {
        setLoadingState({ isLoading: false });
      }
    },
    [
      handleUserDataUpdate,
      handleStateChange,
      handleError,
      userData,
    ],
  );

  // Utility Functions
  const isValidEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const isValidPhone = (phone: string): boolean => {
    const phoneRegex = /^\+?[\d\s-()]+$/;
    return (
      phoneRegex.test(phone) &&
      phone.replace(/\D/g, "").length >= 10
    );
  };

  const themeColors = getBlendedThemeColors(
    currentTheme,
    weatherTheme,
    locationTheme,
  );

  return (
    <AppErrorBoundary onError={handleError}>
      <div
        ref={containerRef}
        onMouseMove={handleMouseMove}
        className="min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] relative dark transition-all duration-1000 ease-in-out"
        style={{
          minHeight: "100dvh", // Use dynamic viewport height
          height: "auto", // Allow content to determine height
          overflowX: "hidden", // Prevent horizontal scroll
          position: "relative",
        }}
        role="application"
        aria-label="Bytspot Urban Discovery App"
      >
        {/* Accessibility Skip Link */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 z-[9999] bg-white text-black px-4 py-2 rounded"
        >
          Skip to main content
        </a>

        {/* Loading Overlay */}
        <AnimatePresence>
          {loadingState.isLoading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[9998] flex items-center justify-center"
            >
              <motion.div
                className="glass-effect p-8 rounded-2xl text-center"
                initial={{ scale: 0.9 }}
                animate={{ scale: 1 }}
              >
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{
                    duration: 1,
                    repeat: Infinity,
                    ease: "linear",
                  }}
                  className="w-8 h-8 border-2 border-[#00BFFF] border-t-transparent rounded-full mx-auto mb-4"
                />
                <p className="text-white font-medium">
                  {loadingState.message}
                </p>
                {loadingState.progress && (
                  <div className="w-full bg-white/20 rounded-full h-2 mt-4">
                    <motion.div
                      className="bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] h-2 rounded-full"
                      initial={{ width: 0 }}
                      animate={{
                        width: `${loadingState.progress}%`,
                      }}
                    />
                  </div>
                )}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Error Banner */}
        <AnimatePresence>
          {appError && (
            <motion.div
              initial={{ y: -100, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -100, opacity: 0 }}
              className="fixed top-0 left-0 right-0 z-[9997] bg-red-500/90 backdrop-blur-sm border-b border-red-400/30 p-4"
            >
              <div className="flex items-center justify-between max-w-4xl mx-auto">
                <div className="flex items-center space-x-3">
                  <AlertTriangle className="w-5 h-5 text-white" />
                  <div>
                    <p className="text-white font-medium">
                      {appError.message}
                    </p>
                    <p className="text-white/80 text-sm">
                      {appError.type} error{" "}
                      {appError.code && `(${appError.code})`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  {appError.recoverable && appError.action && (
                    <Button
                      onClick={() =>
                        handleErrorRecovery(appError)
                      }
                      variant="outline"
                      size="sm"
                      className="text-white border-white/50 hover:bg-white/10"
                    >
                      {appError.action}
                    </Button>
                  )}
                  <Button
                    onClick={() => setAppError(null)}
                    variant="ghost"
                    size="sm"
                    className="text-white hover:bg-white/10"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Dynamic Time-based Background Elements */}
        <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10">
          {/* Bytspot-themed colorful orbs */}
          <motion.div
            className="absolute top-1/4 left-1/4 w-48 h-48 sm:w-96 sm:h-96 bg-gradient-to-r from-[#00BFFF]/30 via-[#FF00FF]/25 to-[#008080]/20 rounded-full blur-3xl"
            animate={{
              x: [0, 50, 0],
              y: [0, -25, 0],
              scale: [1, 1.3, 1],
            }}
            transition={{
              duration: 18,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
          <motion.div
            className="absolute bottom-1/4 right-1/4 w-40 h-40 sm:w-80 sm:h-80 bg-gradient-to-r from-[#FF00FF]/25 via-[#00BFFF]/20 to-[#FF4500]/15 rounded-full blur-3xl"
            animate={{
              x: [0, -40, 0],
              y: [0, 30, 0],
              scale: [1.1, 1, 1.1],
            }}
            transition={{
              duration: 15,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />

          {/* Additional Bytspot-themed elements */}
          <motion.div
            className="absolute top-1/2 right-1/3 w-32 h-32 sm:w-64 sm:h-64 bg-gradient-to-r from-[#008080]/20 via-[#00BFFF]/15 to-[#FF00FF]/10 rounded-full blur-2xl"
            animate={{
              x: [0, 30, -10, 0],
              y: [0, -20, 15, 0],
              scale: [0.8, 1.4, 0.9, 0.8],
            }}
            transition={{
              duration: 25,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
          <motion.div
            className="absolute bottom-1/3 left-1/5 w-36 h-36 sm:w-72 sm:h-72 bg-gradient-to-r from-[#FF4500]/25 via-[#FF00FF]/20 to-[#00BFFF]/15 rounded-full blur-2xl"
            animate={{
              x: [0, -25, 35, 0],
              y: [0, 20, -15, 0],
              scale: [1, 0.7, 1.5, 1],
            }}
            transition={{
              duration: 22,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />

          {/* Enhanced Floating particles with Bytspot colors */}
          {[...Array(8)].map((_, i) => (
            <motion.div
              key={i}
              className={`absolute w-2 h-2 sm:w-3 sm:h-3 rounded-full bg-gradient-to-r ${
                i % 4 === 0
                  ? "from-[#00BFFF] to-[#008080]"
                  : i % 4 === 1
                    ? "from-[#FF00FF] to-[#00BFFF]"
                    : i % 4 === 2
                      ? "from-[#008080] to-[#FF00FF]"
                      : "from-[#FF4500] to-[#FF00FF]"
              }/70`}
              style={{
                left: `${10 + i * 12}%`,
                top: `${15 + i * 8}%`,
              }}
              animate={{
                y: [0, -25, 0],
                x: [0, Math.sin(i) * 10, 0],
                opacity: [0.4, 1, 0.4],
                scale: [1, 1.6, 1],
                rotate: [0, 180, 360],
              }}
              transition={{
                duration: 4 + i * 0.3,
                repeat: Infinity,
                ease: "easeInOut",
                delay: i * 0.5,
              }}
            />
          ))}

          {/* Dynamic pulsing rings with Bytspot colors */}
          <motion.div
            className="absolute top-3/4 left-1/2 w-20 h-20 sm:w-40 sm:h-40 border-2 border-[#00BFFF]/30 bg-gradient-to-r from-[#00BFFF]/20 to-[#FF00FF]/15 rounded-full opacity-30"
            animate={{
              scale: [1, 2.2, 1],
              opacity: [0.3, 0, 0.3],
              rotate: [0, 180, 360],
            }}
            transition={{
              duration: 6,
              repeat: Infinity,
              ease: "easeOut",
            }}
          />
          <motion.div
            className="absolute top-1/6 right-1/6 w-16 h-16 sm:w-32 sm:h-32 border-2 border-[#FF00FF]/30 bg-gradient-to-r from-[#008080]/20 to-[#00BFFF]/15 rounded-full opacity-40"
            animate={{
              scale: [1, 1.9, 1],
              opacity: [0.4, 0, 0.4],
              rotate: [360, 0, 360],
            }}
            transition={{
              duration: 8,
              repeat: Infinity,
              ease: "easeOut",
              delay: 2,
            }}
          />

          {/* Bytspot Particle Trails - Hidden on mobile for better performance */}
          {particles.map((particle, index) => (
            <motion.div
              key={particle.id}
              className="absolute w-1 h-1 rounded-full pointer-events-none hidden sm:block"
              style={{
                backgroundColor: "#00BFFF",
                boxShadow: "0 0 4px #00BFFF, 0 0 8px #FF00FF30",
                left: particle.x,
                top: particle.y,
              }}
              initial={{ opacity: 1, scale: 1 }}
              animate={{
                opacity: 0,
                scale: 0.5,
                y: particle.y - 20,
              }}
              transition={{ duration: 2, ease: "easeOut" }}
            />
          ))}
        </div>

        {/* Premium Live Weather & Intelligence Header */}
        <motion.div
          className="fixed top-4 left-1/2 transform -translate-x-1/2 flex items-center space-x-3 px-5 py-3 rounded-2xl live-indicator z-50 safe-area-top backdrop-blur-enhanced"
          style={{
            backdropFilter: "blur(24px) saturate(200%)",
            background:
              "linear-gradient(135deg, rgba(18, 18, 18, 0.92) 0%, rgba(0, 191, 255, 0.15) 40%, rgba(255, 0, 255, 0.12) 70%, rgba(0, 128, 128, 0.08) 100%)",
            border: "1px solid rgba(0, 191, 255, 0.35)",
            boxShadow:
              "0 8px 32px rgba(0, 191, 255, 0.25), 0 4px 16px rgba(255, 0, 255, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.1)",
          }}
          initial={{ opacity: 0, y: -25, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{
            delay: 0.8,
            type: "spring",
            stiffness: 400,
            damping: 25,
          }}
          whileHover={{
            scale: 1.02,
            boxShadow:
              "0 12px 40px rgba(0, 191, 255, 0.3), 0 6px 20px rgba(255, 0, 255, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.15)",
          }}
        >
          {/* Live Indicator */}
          <div className="flex items-center space-x-1.5">
            <motion.div
              className="w-2 h-2 rounded-full bg-gradient-to-r from-[#00BFFF] to-[#FF00FF]"
              animate={{
                scale: [1, 1.4, 1],
                opacity: [1, 0.6, 1],
              }}
              transition={{
                duration: 2.5,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />
            <span className="text-white text-xs font-semibold">
              LIVE
            </span>
          </div>

          <span className="text-white/40 text-xs">|</span>

          {/* Enhanced Weather Intelligence Display */}
          <motion.div
            className="flex items-center space-x-3"
            animate={{ rotate: [0, 1.5, -1.5, 0] }}
            transition={{ duration: 8, repeat: Infinity }}
          >
            {/* Weather Icon with Glow Effect */}
            <motion.div
              className="relative"
              whileHover={{ scale: 1.1 }}
              transition={{ type: "spring", stiffness: 400 }}
            >
              <motion.div
                className="absolute inset-0 rounded-full blur-sm"
                style={{
                  background:
                    weatherTheme === "sunny"
                      ? "rgba(251, 191, 36, 0.4)"
                      : weatherTheme === "rainy"
                        ? "rgba(59, 130, 246, 0.4)"
                        : weatherTheme === "cloudy"
                          ? "rgba(156, 163, 175, 0.4)"
                          : weatherTheme === "snowy"
                            ? "rgba(34, 211, 238, 0.4)"
                            : weatherTheme === "stormy"
                              ? "rgba(147, 51, 234, 0.4)"
                              : "rgba(107, 114, 128, 0.4)",
                }}
                animate={{
                  scale: [1, 1.2, 1],
                  opacity: [0.4, 0.6, 0.4],
                }}
                transition={{ duration: 3, repeat: Infinity }}
              />
              {weatherTheme === "sunny" && (
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{
                    duration: 20,
                    repeat: Infinity,
                    ease: "linear",
                  }}
                >
                  <Sun className="w-4 h-4 text-yellow-400 relative z-10" />
                </motion.div>
              )}
              {weatherTheme === "rainy" && (
                <CloudRain className="w-4 h-4 text-blue-400 relative z-10" />
              )}
              {weatherTheme === "cloudy" && (
                <Cloud className="w-4 h-4 text-gray-400 relative z-10" />
              )}
              {weatherTheme === "snowy" && (
                <CloudSnow className="w-4 h-4 text-cyan-300 relative z-10" />
              )}
              {weatherTheme === "stormy" && (
                <motion.div
                  animate={{ scale: [1, 1.1, 1] }}
                  transition={{ duration: 1, repeat: Infinity }}
                >
                  <CloudRain className="w-4 h-4 text-purple-400 relative z-10" />
                </motion.div>
              )}
              {weatherTheme === "foggy" && (
                <Cloud className="w-4 h-4 text-gray-500 relative z-10" />
              )}
            </motion.div>

            {/* Temperature with Smart Formatting */}
            <motion.div
              className="flex items-center space-x-1"
              whileHover={{ scale: 1.05 }}
            >
              <motion.span
                className="text-white font-semibold text-sm tracking-tight"
                animate={{
                  opacity: [0.9, 1, 0.9],
                  textShadow: [
                    "0 0 4px rgba(0, 191, 255, 0.3)",
                    "0 0 8px rgba(0, 191, 255, 0.5)",
                    "0 0 4px rgba(0, 191, 255, 0.3)",
                  ],
                }}
                transition={{ duration: 4, repeat: Infinity }}
                style={{
                  color:
                    currentTemperature > 75
                      ? "#fbbf24"
                      : currentTemperature > 60
                        ? "#22d3ee"
                        : currentTemperature > 40
                          ? "#60a5fa"
                          : "#a855f7",
                }}
              >
                {currentTemperature}°
              </motion.span>

              {/* Feels Like Indicator */}
              <motion.span
                className="text-white/60 text-xs hidden md:inline"
                animate={{ opacity: [0.6, 0.8, 0.6] }}
                transition={{
                  duration: 5,
                  repeat: Infinity,
                  delay: 1,
                }}
              >
                feels{" "}
                {currentTemperature +
                  Math.floor(Math.random() * 6) -
                  3}
                °
              </motion.span>
            </motion.div>

            {/* Enhanced Weather Condition with Context */}
            <motion.div className="hidden sm:flex items-center space-x-1">
              <motion.span
                className="text-white/75 text-xs font-medium"
                animate={{ opacity: [0.75, 0.95, 0.75] }}
                transition={{
                  duration: 6,
                  repeat: Infinity,
                  delay: 1.5,
                }}
              >
                {weatherCondition}
              </motion.span>

              {/* Weather Quality Indicator */}
              <motion.div
                className="w-1.5 h-1.5 rounded-full"
                style={{
                  background:
                    weatherTheme === "sunny"
                      ? "#22c55e"
                      : weatherTheme === "cloudy"
                        ? "#f59e0b"
                        : weatherTheme === "rainy"
                          ? "#3b82f6"
                          : "#ef4444",
                }}
                animate={{
                  scale: [1, 1.3, 1],
                  opacity: [0.7, 1, 0.7],
                }}
                transition={{ duration: 2, repeat: Infinity }}
              />
            </motion.div>
          </motion.div>

          <span className="text-white/40 text-xs">|</span>

          {/* Enhanced Active Users Display */}
          <motion.div
            className="flex items-center space-x-2"
            whileHover={{ scale: 1.05 }}
            transition={{ type: "spring", stiffness: 400 }}
          >
            <motion.div
              className="relative"
              animate={{
                scale: [1, 1.1, 1],
                rotate: [0, 5, -5, 0],
              }}
              transition={{ duration: 4, repeat: Infinity }}
            >
              <Users className="w-3.5 h-3.5 text-[#00BFFF] relative z-10" />
              <motion.div
                className="absolute inset-0 rounded-full blur-sm bg-[#00BFFF]/30"
                animate={{
                  scale: [1, 1.3, 1],
                  opacity: [0.3, 0.6, 0.3],
                }}
                transition={{ duration: 2, repeat: Infinity }}
              />
            </motion.div>

            <motion.div className="flex items-center space-x-1">
              <motion.span
                className="text-white/95 text-sm font-semibold"
                animate={{ opacity: [0.9, 1, 0.9] }}
                transition={{ duration: 3, repeat: Infinity }}
              >
                {activeUsers.toLocaleString()}
              </motion.span>

              {/* Activity Trend Indicator */}
              <motion.div
                className="flex items-center"
                animate={{ x: [0, 2, 0] }}
                transition={{ duration: 2, repeat: Infinity }}
              >
                <motion.div
                  className="w-1 h-1 rounded-full bg-green-400 mx-0.5"
                  animate={{
                    scale: [1, 1.5, 1],
                    opacity: [0.5, 1, 0.5],
                  }}
                  transition={{
                    duration: 1,
                    repeat: Infinity,
                    delay: 0,
                  }}
                />
                <motion.div
                  className="w-1 h-1 rounded-full bg-green-400 mx-0.5"
                  animate={{
                    scale: [1, 1.5, 1],
                    opacity: [0.5, 1, 0.5],
                  }}
                  transition={{
                    duration: 1,
                    repeat: Infinity,
                    delay: 0.2,
                  }}
                />
                <motion.div
                  className="w-1 h-1 rounded-full bg-green-400 mx-0.5"
                  animate={{
                    scale: [1, 1.5, 1],
                    opacity: [0.5, 1, 0.5],
                  }}
                  transition={{
                    duration: 1,
                    repeat: Infinity,
                    delay: 0.4,
                  }}
                />
              </motion.div>
            </motion.div>
          </motion.div>

          {/* Enhanced Location Context */}
          <motion.div
            className="flex items-center space-x-2 hidden sm:flex"
            whileHover={{ scale: 1.05 }}
            transition={{ type: "spring", stiffness: 400 }}
          >
            <motion.div
              className="relative"
              animate={{
                scale: [1, 1.05, 1],
                y: [0, -1, 0],
              }}
              transition={{ duration: 5, repeat: Infinity }}
            >
              <MapPin className="w-3.5 h-3.5 text-[#FF00FF] relative z-10" />
              <motion.div
                className="absolute inset-0 rounded-full blur-sm bg-[#FF00FF]/30"
                animate={{
                  scale: [1, 1.4, 1],
                  opacity: [0.3, 0.5, 0.3],
                }}
                transition={{ duration: 3, repeat: Infinity }}
              />
            </motion.div>

            <motion.span
              className="text-white/80 text-xs font-medium capitalize tracking-wide"
              animate={{ opacity: [0.8, 0.95, 0.8] }}
              transition={{
                duration: 4,
                repeat: Infinity,
                delay: 1,
              }}
            >
              {locationContext?.city || locationTheme}
            </motion.span>

            {/* Location Quality Indicator */}
            <motion.div
              className="w-1.5 h-1.5 rounded-full bg-emerald-400"
              animate={{
                scale: [1, 1.4, 1],
                opacity: [0.6, 1, 0.6],
              }}
              transition={{ duration: 2.5, repeat: Infinity }}
            />
          </motion.div>

          {/* Advanced Activity Intelligence Pulse */}
          <motion.div
            className="relative"
            whileHover={{ scale: 1.1 }}
            transition={{ type: "spring", stiffness: 400 }}
          >
            <motion.div
              animate={{ rotate: 360 }}
              transition={{
                duration: 20,
                repeat: Infinity,
                ease: "linear",
              }}
              className="relative z-10"
            >
              <Activity className="w-3.5 h-3.5 text-white/70" />
            </motion.div>

            {/* Activity Rings */}
            <motion.div
              className="absolute inset-0 rounded-full border border-white/20"
              animate={{
                scale: [1, 1.5, 1],
                opacity: [0.2, 0, 0.2],
              }}
              transition={{ duration: 3, repeat: Infinity }}
            />
            <motion.div
              className="absolute inset-0 rounded-full border border-[#00BFFF]/30"
              animate={{
                scale: [1, 1.3, 1],
                opacity: [0.3, 0, 0.3],
              }}
              transition={{
                duration: 2,
                repeat: Infinity,
                delay: 0.5,
              }}
            />

            {/* Real-time Activity Dots */}
            <motion.div
              className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-emerald-400"
              animate={{
                scale: [1, 1.2, 1],
                opacity: [1, 0.6, 1],
              }}
              transition={{ duration: 1.5, repeat: Infinity }}
            />
          </motion.div>
        </motion.div>

        {/* Enhanced System Intelligence Notifications */}
        <AnimatePresence>
          {showSystemNotification && (
            <motion.div
              initial={{
                opacity: 0,
                scale: 0.9,
                y: -30,
                rotateX: -15,
              }}
              animate={{
                opacity: 1,
                scale: 1,
                y: 0,
                rotateX: 0,
              }}
              exit={{
                opacity: 0,
                scale: 0.85,
                y: -25,
                rotateX: 10,
              }}
              transition={{
                type: "spring",
                stiffness: 500,
                damping: 35,
                duration: 0.6,
              }}
              className="fixed top-24 left-1/2 transform -translate-x-1/2 z-40 max-w-sm mx-4"
              style={{ perspective: "1000px" }}
            >
              <motion.div
                className={`rounded-2xl p-5 shadow-2xl border backdrop-blur-enhanced ${
                  showSystemNotification.priority === "high"
                    ? "border-red-400/40"
                    : showSystemNotification.priority ===
                        "medium"
                      ? "border-[#00BFFF]/40"
                      : "border-emerald-400/40"
                }`}
                style={{
                  backdropFilter: "blur(24px) saturate(180%)",
                  background:
                    showSystemNotification.priority === "high"
                      ? "linear-gradient(135deg, rgba(18, 18, 18, 0.94) 0%, rgba(239, 68, 68, 0.15) 50%, rgba(220, 38, 38, 0.08) 100%)"
                      : showSystemNotification.priority ===
                          "medium"
                        ? "linear-gradient(135deg, rgba(18, 18, 18, 0.94) 0%, rgba(0, 191, 255, 0.15) 50%, rgba(0, 128, 128, 0.08) 100%)"
                        : "linear-gradient(135deg, rgba(18, 18, 18, 0.94) 0%, rgba(34, 197, 94, 0.15) 50%, rgba(16, 185, 129, 0.08) 100%)",
                  boxShadow:
                    showSystemNotification.priority === "high"
                      ? "0 12px 35px rgba(239, 68, 68, 0.25), 0 6px 18px rgba(220, 38, 38, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.1)"
                      : showSystemNotification.priority ===
                          "medium"
                        ? "0 12px 35px rgba(0, 191, 255, 0.25), 0 6px 18px rgba(0, 128, 128, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.1)"
                        : "0 12px 35px rgba(34, 197, 94, 0.25), 0 6px 18px rgba(16, 185, 129, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.1)",
                }}
                whileHover={{
                  scale: 1.03,
                  y: -2,
                  boxShadow:
                    showSystemNotification.priority === "high"
                      ? "0 16px 45px rgba(239, 68, 68, 0.35), 0 8px 25px rgba(220, 38, 38, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.15)"
                      : showSystemNotification.priority ===
                          "medium"
                        ? "0 16px 45px rgba(0, 191, 255, 0.35), 0 8px 25px rgba(0, 128, 128, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.15)"
                        : "0 16px 45px rgba(34, 197, 94, 0.35), 0 8px 25px rgba(16, 185, 129, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.15)",
                }}
                whileTap={{ scale: 0.98 }}
                transition={{
                  type: "spring",
                  stiffness: 400,
                  damping: 25,
                }}
              >
                <div className="flex items-start space-x-3">
                  {/* Enhanced Notification Icon */}
                  <motion.div
                    className="flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center relative overflow-hidden"
                    style={{
                      background:
                        showSystemNotification.priority ===
                        "high"
                          ? "linear-gradient(135deg, #ef4444, #dc2626, #b91c1c)"
                          : showSystemNotification.priority ===
                              "medium"
                            ? "linear-gradient(135deg, #00BFFF, #0ea5e9, #0284c7)"
                            : "linear-gradient(135deg, #22c55e, #16a34a, #15803d)",
                      boxShadow:
                        showSystemNotification.priority ===
                        "high"
                          ? "0 4px 15px rgba(239, 68, 68, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.2)"
                          : showSystemNotification.priority ===
                              "medium"
                            ? "0 4px 15px rgba(0, 191, 255, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.2)"
                            : "0 4px 15px rgba(34, 197, 94, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.2)",
                    }}
                    initial={{ scale: 0, rotate: -180 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{
                      delay: 0.1,
                      type: "spring",
                      stiffness: 500,
                      damping: 25,
                    }}
                    whileHover={{
                      scale: 1.1,
                      rotate: 5,
                      boxShadow:
                        showSystemNotification.priority ===
                        "high"
                          ? "0 6px 20px rgba(239, 68, 68, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.3)"
                          : showSystemNotification.priority ===
                              "medium"
                            ? "0 6px 20px rgba(0, 191, 255, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.3)"
                            : "0 6px 20px rgba(34, 197, 94, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.3)",
                    }}
                  >
                    {/* Animated Background Glow */}
                    <motion.div
                      className="absolute inset-0 rounded-xl"
                      style={{
                        background:
                          showSystemNotification.priority ===
                          "high"
                            ? "radial-gradient(circle at center, rgba(239, 68, 68, 0.3), transparent)"
                            : showSystemNotification.priority ===
                                "medium"
                              ? "radial-gradient(circle at center, rgba(0, 191, 255, 0.3), transparent)"
                              : "radial-gradient(circle at center, rgba(34, 197, 94, 0.3), transparent)",
                      }}
                      animate={{
                        scale: [1, 1.2, 1],
                        opacity: [0.3, 0.6, 0.3],
                      }}
                      transition={{
                        duration: 2,
                        repeat: Infinity,
                      }}
                    />

                    {/* Icon Container */}
                    <motion.div
                      className="relative z-10"
                      animate={{
                        scale: [1, 1.05, 1],
                      }}
                      transition={{
                        duration: 3,
                        repeat: Infinity,
                      }}
                    >
                      {showSystemNotification.type ===
                        "weather" && (
                        <motion.div
                          animate={{
                            rotate:
                              showSystemNotification.type ===
                              "weather"
                                ? 360
                                : 0,
                          }}
                          transition={{
                            duration: 8,
                            repeat: Infinity,
                            ease: "linear",
                          }}
                        >
                          <Sun className="w-5 h-5 text-white drop-shadow-lg" />
                        </motion.div>
                      )}
                      {showSystemNotification.type ===
                        "parking" && (
                        <motion.div
                          animate={{ x: [0, 2, 0] }}
                          transition={{
                            duration: 2,
                            repeat: Infinity,
                          }}
                        >
                          <Car className="w-5 h-5 text-white drop-shadow-lg" />
                        </motion.div>
                      )}
                      {showSystemNotification.type ===
                        "traffic" && (
                        <motion.div
                          animate={{ rotate: [0, 15, -15, 0] }}
                          transition={{
                            duration: 3,
                            repeat: Infinity,
                          }}
                        >
                          <Navigation className="w-5 h-5 text-white drop-shadow-lg" />
                        </motion.div>
                      )}
                      {showSystemNotification.type ===
                        "venue" && (
                        <motion.div
                          animate={{ scale: [1, 1.1, 1] }}
                          transition={{
                            duration: 2,
                            repeat: Infinity,
                          }}
                        >
                          <UtensilsCrossed className="w-5 h-5 text-white drop-shadow-lg" />
                        </motion.div>
                      )}
                      {showSystemNotification.type ===
                        "system" && (
                        <motion.div
                          animate={{
                            rotate: [0, 10, -10, 0],
                            scale: [1, 1.05, 1],
                          }}
                          transition={{
                            duration: 4,
                            repeat: Infinity,
                          }}
                        >
                          <Bell className="w-5 h-5 text-white drop-shadow-lg" />
                        </motion.div>
                      )}
                    </motion.div>
                  </motion.div>

                  {/* Notification Content */}
                  <div className="flex-1 min-w-0">
                    <motion.h4
                      className="text-white font-semibold text-sm mb-1"
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.15 }}
                    >
                      {showSystemNotification.title}
                    </motion.h4>

                    <motion.p
                      className="text-white/80 text-xs mb-3 line-clamp-2"
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.2 }}
                    >
                      {showSystemNotification.message}
                    </motion.p>

                    {/* Enhanced Action Button */}
                    {showSystemNotification.action && (
                      <motion.button
                        className="inline-flex items-center px-4 py-2 rounded-xl text-xs font-semibold transition-all duration-300 backdrop-blur-sm"
                        style={{
                          backgroundColor:
                            showSystemNotification.priority ===
                            "high"
                              ? "rgba(239, 68, 68, 0.25)"
                              : showSystemNotification.priority ===
                                  "medium"
                                ? "rgba(0, 191, 255, 0.25)"
                                : "rgba(34, 197, 94, 0.25)",
                          color:
                            showSystemNotification.priority ===
                            "high"
                              ? "#fca5a5"
                              : showSystemNotification.priority ===
                                  "medium"
                                ? "#7dd3fc"
                                : "#86efac",
                          border:
                            showSystemNotification.priority ===
                            "high"
                              ? "1px solid rgba(239, 68, 68, 0.4)"
                              : showSystemNotification.priority ===
                                  "medium"
                                ? "1px solid rgba(0, 191, 255, 0.4)"
                                : "1px solid rgba(34, 197, 94, 0.4)",
                          boxShadow:
                            showSystemNotification.priority ===
                            "high"
                              ? "0 4px 12px rgba(239, 68, 68, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.1)"
                              : showSystemNotification.priority ===
                                  "medium"
                                ? "0 4px 12px rgba(0, 191, 255, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.1)"
                                : "0 4px 12px rgba(34, 197, 94, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.1)",
                        }}
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{
                          delay: 0.25,
                          type: "spring",
                          stiffness: 400,
                        }}
                        whileHover={{
                          scale: 1.05,
                          y: -1,
                          boxShadow:
                            showSystemNotification.priority ===
                            "high"
                              ? "0 6px 18px rgba(239, 68, 68, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.15)"
                              : showSystemNotification.priority ===
                                  "medium"
                                ? "0 6px 18px rgba(0, 191, 255, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.15)"
                                : "0 6px 18px rgba(34, 197, 94, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.15)",
                        }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => {
                          // Handle action click with haptic feedback simulation
                          console.log(
                            "Notification action clicked:",
                            showSystemNotification.action,
                          );
                          setShowSystemNotification(null);
                        }}
                      >
                        <motion.div
                          animate={{
                            scale: [1, 1.1, 1],
                            rotate: [0, 5, -5, 0],
                          }}
                          transition={{
                            duration: 2,
                            repeat: Infinity,
                          }}
                        >
                          <Zap className="w-3.5 h-3.5 mr-1.5" />
                        </motion.div>
                        {showSystemNotification.action}
                      </motion.button>
                    )}
                  </div>

                  {/* Enhanced Close Button */}
                  <motion.button
                    className="flex-shrink-0 w-8 h-8 rounded-full bg-white/5 hover:bg-white/15 flex items-center justify-center transition-all duration-300 backdrop-blur-sm border border-white/10"
                    onClick={() =>
                      setShowSystemNotification(null)
                    }
                    initial={{
                      opacity: 0,
                      scale: 0.8,
                      rotate: -90,
                    }}
                    animate={{
                      opacity: 1,
                      scale: 1,
                      rotate: 0,
                    }}
                    transition={{
                      delay: 0.3,
                      type: "spring",
                      stiffness: 400,
                    }}
                    whileHover={{
                      scale: 1.15,
                      backgroundColor:
                        "rgba(255, 255, 255, 0.2)",
                      borderColor: "rgba(255, 255, 255, 0.3)",
                    }}
                    whileTap={{ scale: 0.9 }}
                  >
                    <motion.div
                      whileHover={{ rotate: 90 }}
                      transition={{ duration: 0.2 }}
                    >
                      <X className="w-3.5 h-3.5 text-white/80" />
                    </motion.div>
                  </motion.button>
                </div>

                {/* Auto-dismiss Progress Indicator */}
                <motion.div
                  className="absolute bottom-0 left-0 h-1 rounded-b-2xl"
                  style={{
                    background:
                      showSystemNotification.priority === "high"
                        ? "linear-gradient(90deg, #ef4444, #dc2626)"
                        : showSystemNotification.priority ===
                            "medium"
                          ? "linear-gradient(90deg, #00BFFF, #0ea5e9)"
                          : "linear-gradient(90deg, #22c55e, #16a34a)",
                  }}
                  initial={{ width: "100%" }}
                  animate={{ width: "0%" }}
                  transition={{
                    duration:
                      showSystemNotification.priority === "high"
                        ? 10
                        : showSystemNotification.priority ===
                            "medium"
                          ? 7
                          : 5,
                    ease: "linear",
                  }}
                />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Refined Smart Recommendation Notification - More Intuitive */}
        <AnimatePresence>
          {showRecommendation && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -15 }}
              transition={{
                type: "spring",
                stiffness: 350,
                damping: 35,
              }}
              className="fixed bottom-20 right-4 z-50 max-w-xs sm:max-w-sm"
              onMouseEnter={() => {
                setIsNotificationHovered(true);
                if (notificationTimeoutId) {
                  clearTimeout(notificationTimeoutId);
                }
              }}
              onMouseLeave={() => {
                setIsNotificationHovered(false);
                // Shorter timeout when mouse leaves - more responsive
                const displayTime =
                  showRecommendation.type === "group_decision"
                    ? 8000
                    : 3000;
                const timeoutId = setTimeout(() => {
                  setShowRecommendation(null);
                }, displayTime);
                setNotificationTimeoutId(timeoutId);
              }}
              onTouchStart={() => {
                // Pause auto-dismiss on mobile touch
                setIsNotificationHovered(true);
                if (notificationTimeoutId) {
                  clearTimeout(notificationTimeoutId);
                }
              }}
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              {showRecommendation.type === "group_decision" ? (
                <GroupDecisionNotification
                  recommendation={showRecommendation}
                  onInteraction={() => {
                    setIsNotificationHovered(true);
                    if (notificationTimeoutId) {
                      clearTimeout(notificationTimeoutId);
                    }
                  }}
                  onClose={() => {
                    setShowRecommendation(null);
                    if (notificationTimeoutId) {
                      clearTimeout(notificationTimeoutId);
                    }
                  }}
                />
              ) : (
                <motion.div
                  className={`rounded-xl p-4 shadow-lg border ${
                    showRecommendation.priority === "high"
                      ? "border-[#FF00FF]/25"
                      : "border-[#00BFFF]/25"
                  }`}
                  style={{
                    backdropFilter: "blur(12px) saturate(140%)",
                    background:
                      showRecommendation.priority === "high"
                        ? "linear-gradient(135deg, rgba(18, 18, 18, 0.92) 0%, rgba(255, 0, 255, 0.08) 100%)"
                        : "linear-gradient(135deg, rgba(18, 18, 18, 0.92) 0%, rgba(0, 191, 255, 0.08) 100%)",
                    boxShadow:
                      showRecommendation.priority === "high"
                        ? "0 8px 25px rgba(255, 0, 255, 0.15), 0 4px 12px rgba(255, 69, 0, 0.08)"
                        : "0 8px 25px rgba(0, 191, 255, 0.15), 0 4px 12px rgba(0, 128, 128, 0.08)",
                  }}
                  whileHover={{ scale: 1.02 }}
                  transition={{ duration: 0.2 }}
                >
                  {/* Compact notification design */}
                  <div className="flex items-start space-x-3">
                    <motion.div
                      className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{
                        background:
                          showRecommendation.priority === "high"
                            ? "linear-gradient(135deg, #FF00FF, #FF4500)"
                            : "linear-gradient(135deg, #00BFFF, #008080)",
                      }}
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{
                        delay: 0.1,
                        type: "spring",
                        stiffness: 400,
                      }}
                    >
                      <div className="w-4 h-4 text-white">
                        {showRecommendation.icon}
                      </div>
                    </motion.div>

                    <div className="flex-1 min-w-0">
                      <motion.h4
                        className="text-white text-sm font-medium mb-1 line-clamp-1"
                        initial={{ opacity: 0, x: 10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.15 }}
                      >
                        {showRecommendation.title}
                      </motion.h4>

                      <motion.p
                        className="text-white/70 text-xs mb-2 line-clamp-2"
                        initial={{ opacity: 0, x: 10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.2 }}
                      >
                        {showRecommendation.description}
                      </motion.p>

                      <motion.div
                        className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
                        style={{
                          backgroundColor:
                            showRecommendation.priority ===
                            "high"
                              ? "rgba(255, 0, 255, 0.15)"
                              : "rgba(0, 191, 255, 0.15)",
                          color:
                            showRecommendation.priority ===
                            "high"
                              ? "#FF00FF"
                              : "#00BFFF",
                          border:
                            showRecommendation.priority ===
                            "high"
                              ? "1px solid rgba(255, 0, 255, 0.25)"
                              : "1px solid rgba(0, 191, 255, 0.25)",
                        }}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.25 }}
                      >
                        <Sparkles className="w-2.5 h-2.5 mr-1" />
                        Smart Tip
                      </motion.div>
                    </div>

                    {/* Subtle close button */}
                    <motion.button
                      className="flex-shrink-0 w-5 h-5 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
                      onClick={() => {
                        setShowRecommendation(null);
                        if (notificationTimeoutId) {
                          clearTimeout(notificationTimeoutId);
                        }
                      }}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.3 }}
                      whileHover={{ scale: 1.1 }}
                      whileTap={{ scale: 0.95 }}
                    >
                      <X className="w-2.5 h-2.5 text-white/60" />
                    </motion.button>
                  </div>

                  {/* Progress indicator for auto-dismiss */}
                  <motion.div
                    className="absolute bottom-0 left-0 h-0.5 rounded-b-xl"
                    style={{
                      background:
                        showRecommendation.priority === "high"
                          ? "linear-gradient(90deg, #FF00FF, #FF4500)"
                          : "linear-gradient(90deg, #00BFFF, #008080)",
                    }}
                    initial={{ width: "100%" }}
                    animate={{ width: "0%" }}
                    transition={{
                      duration:
                        showRecommendation.type ===
                        "group_decision"
                          ? 8
                          : 3,
                      ease: "linear",
                    }}
                  />
                </motion.div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Enhanced Activity Indicators - Optimized for Performance */}
        {indicators.map((indicator, index) => (
          <motion.div
            key={indicator.id}
            className="fixed pointer-events-none z-40 hidden lg:block"
            style={{
              left: indicator.x,
              top: indicator.y,
              width: indicator.size * 4,
              height: indicator.size * 4,
              willChange: "transform, opacity",
            }}
            initial={{ opacity: 0, scale: 0 }}
            animate={{
              opacity: indicator.opacity,
              scale: [0.8, 1.2, 0.6],
              rotate: [0, 180, 360],
            }}
            transition={{
              scale: {
                duration: 3,
                repeat: Infinity,
                ease: "easeInOut",
              },
              rotate: {
                duration: 8,
                repeat: Infinity,
                ease: "linear",
              },
              opacity: { duration: 1 },
            }}
          >
            {/* Core Indicator */}
            <motion.div
              className="w-full h-full rounded-full relative"
              style={{
                background: `radial-gradient(circle at center, ${indicator.color}80, ${indicator.color}40, transparent 70%)`,
                boxShadow: `0 0 ${indicator.size * 3}px ${indicator.color}60, 0 0 ${indicator.size * 6}px ${indicator.color}30`,
              }}
            >
              {/* Inner Pulse */}
              <motion.div
                className="absolute inset-2 rounded-full"
                style={{
                  background: `radial-gradient(circle at center, ${indicator.color}ff, ${indicator.color}80, transparent)`,
                }}
                animate={{
                  scale: [0.6, 1, 0.6],
                  opacity: [0.8, 0.4, 0.8],
                }}
                transition={{
                  duration: 2,
                  repeat: Infinity,
                  delay: index * 0.2,
                }}
              />

              {/* Outer Ring */}
              <motion.div
                className="absolute inset-0 rounded-full border"
                style={{
                  borderColor: `${indicator.color}40`,
                  borderWidth: "1px",
                }}
                animate={{
                  scale: [1, 1.4, 1],
                  opacity: [0.6, 0, 0.6],
                }}
                transition={{
                  duration: 3,
                  repeat: Infinity,
                  delay: index * 0.1,
                }}
              />
            </motion.div>
          </motion.div>
        ))}

        {/* Mobile-Optimized Particle Trails */}
        <div className="fixed inset-0 pointer-events-none z-30 hidden md:block">
          {particles.slice(0, 3).map((particle, index) => (
            <motion.div
              key={particle.id}
              className="absolute rounded-full"
              style={{
                left: particle.x,
                top: particle.y,
                width: particle.size * 2,
                height: particle.size * 2,
                background: `radial-gradient(circle, ${particle.color}ff, ${particle.color}80, transparent)`,
                boxShadow: `0 0 8px ${particle.color}80, 0 0 16px ${particle.color}40`,
                willChange: "transform, opacity",
              }}
              initial={{
                opacity: 1,
                scale: 1,
                filter: "blur(0px)",
              }}
              animate={{
                opacity: 0,
                scale: 0.3,
                y: particle.y - 30,
                filter: "blur(2px)",
              }}
              transition={{
                duration: 3,
                ease: "easeOut",
              }}
            />
          ))}
        </div>

        {/* Main Content */}
        <main id="main-content" className="relative z-10">
          <AnimatePresence mode="wait">
            {currentState === "home" && (
              <HomePage
                key="home"
                onGetStarted={() => handleStateChange("auth")}
                onAddressSubmit={handleSmartSuggestion}
                onHostOnboarding={handleHostOnboarding}
                currentTheme={currentTheme}
                weatherTheme={weatherTheme}
                locationTheme={locationTheme}
                themeColors={themeColors}
              />
            )}

            {currentState === "auth" && (
              <AuthModal
                key="auth"
                isOpen={true}
                onClose={() => handleStateChange("home")}
                onAuth={handleAuth}
                smartSuggestion={smartSuggestion}
              />
            )}

            {currentState === "registration" && (
              <RegistrationFlow
                key="registration"
                userData={userData}
                onDataUpdate={handleUserDataUpdate}
                onComplete={() =>
                  handleStateChange("discovery")
                }
                onBack={() => handleStateChange("home")}
                onError={handleError}
              />
            )}

            {currentState === "discovery" && (
              <DiscoverySearch
                key="discovery"
                userData={userData}
                onComplete={() => {
                  const newRecommendation = {
                    id: `discovery-complete-${Date.now()}`,
                    title: "Spot Discovery Complete!",
                    description:
                      "Successfully found personalized spots for you",
                    type: "discovery" as const,
                    icon: <MapPin className="w-6 h-6" />,
                    priority: "high" as const,
                    timestamp: new Date(),
                  };

                  setRecommendations((prev) => [
                    newRecommendation,
                    ...prev.slice(0, 9),
                  ]);
                  setShowRecommendation(newRecommendation);
                  setTimeout(
                    () => setShowRecommendation(null),
                    4000,
                  );

                  handleStateChange("swipe");
                }}
                onError={handleError}
              />
            )}

            {currentState === "swipe" && (
              <SwipeInterfaceFixed
                key="swipe"
                userData={userData}
                onBack={() => handleStateChange("discovery")}
                onLogout={handleLogout}
                currentTheme={currentTheme}
                weatherTheme={weatherTheme}
                locationTheme={locationTheme}
                onWeatherChange={handleWeatherChange}
                onLocationChange={handleLocationChange}
                onTriggerAchievement={
                  handleTriggerRecommendation
                }
                onOpenMap={() => handleStateChange("map")}
                onTriggerSystemNotification={
                  handleTriggerSystemNotification
                }
                onTriggerRecommendation={
                  handleTriggerRecommendation
                }
                onOpenProfile={() =>
                  handleStateChange("profile")
                }
                onOpenSettings={() =>
                  handleStateChange("settings")
                }
                onStartPremiumPreferences={() =>
                  handleStateChange("vibe-preferences")
                }
                onError={handleError}
              />
            )}

            {currentState === "map" && (
              <MapInterface
                key="map"
                userData={userData}
                onBack={() => handleStateChange("swipe")}
                currentTheme={currentTheme}
                weatherTheme={weatherTheme}
                locationTheme={locationTheme}
                onError={handleError}
              />
            )}

            {currentState === "profile" && (
              <div className="min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] p-4">
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="max-w-2xl mx-auto"
                >
                  <div className="flex items-center justify-between mb-6">
                    <Button
                      onClick={() => handleStateChange("swipe")}
                      variant="ghost"
                      className="text-white hover:bg-white/10"
                    >
                      ← Back to Spots
                    </Button>
                    <h1 className="text-white text-xl font-semibold">
                      My Profile
                    </h1>
                    <div className="w-16" />
                  </div>

                  <motion.div className="glass-effect p-6 rounded-2xl">
                    <div className="text-center mb-6">
                      <div className="w-24 h-24 bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] rounded-full mx-auto mb-4 flex items-center justify-center">
                        <span className="text-white text-2xl font-bold">
                          {userData.name?.charAt(0) || "U"}
                        </span>
                      </div>
                      <h2 className="text-white text-xl font-semibold">
                        {userData.name || "User"}
                      </h2>
                      <p className="text-white/70">
                        {userData.email}
                      </p>
                      <div className="flex items-center justify-center space-x-2 mt-2">
                        <Crown className="w-4 h-4 text-yellow-400" />
                        <span className="text-yellow-400 capitalize">
                          {userData.membershipLevel || "Bronze"}{" "}
                          Member
                        </span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 mb-6">
                      <div className="text-center">
                        <p className="text-2xl font-bold text-[#00BFFF]">
                          {userData.bytspotPoints || 0}
                        </p>
                        <p className="text-white/70 text-sm">
                          Bytspot Points
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-2xl font-bold text-[#FF00FF]">
                          {userData.favoriteSpots?.length || 0}
                        </p>
                        <p className="text-white/70 text-sm">
                          Favorite Spots
                        </p>
                      </div>
                    </div>

                    <Button
                      onClick={() =>
                        handleStateChange("settings")
                      }
                      className="w-full bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] hover:opacity-90"
                    >
                      Open Settings
                    </Button>
                  </motion.div>
                </motion.div>
              </div>
            )}

            {currentState === "settings" && (
              <div className="min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] p-4">
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="max-w-2xl mx-auto"
                >
                  <div className="flex items-center justify-between mb-6">
                    <Button
                      onClick={() => handleStateChange("swipe")}
                      variant="ghost"
                      className="text-white hover:bg-white/10"
                    >
                      ← Back to Spots
                    </Button>
                    <h1 className="text-white text-xl font-semibold">
                      Settings
                    </h1>
                    <div className="w-16" />
                  </div>

                  <div className="space-y-4">
                    <motion.div className="glass-effect p-4 rounded-xl">
                      <h3 className="text-white font-medium mb-2">
                        Account
                      </h3>
                      <Button
                        onClick={() =>
                          handleStateChange("profile")
                        }
                        variant="ghost"
                        className="w-full justify-start text-white hover:bg-white/10"
                      >
                        View Profile
                      </Button>
                    </motion.div>

                    <motion.div className="glass-effect p-4 rounded-xl">
                      <h3 className="text-white font-medium mb-2">
                        App
                      </h3>
                      <p className="text-white/70 text-sm">
                        Version 2.1.0
                      </p>
                    </motion.div>

                    <motion.div className="glass-effect p-4 rounded-xl">
                      <Button
                        onClick={handleLogout}
                        variant="destructive"
                        className="w-full"
                      >
                        Sign Out
                      </Button>
                    </motion.div>
                  </div>
                </motion.div>
              </div>
            )}

            {currentState === "vibe-preferences" && (
              <VibePreferences
                key="vibe-preferences"
                userData={userData}
                onComplete={() => {
                  const newRecommendation = {
                    id: `vibe-preferences-complete-${Date.now()}`,
                    title: "Vibe Profile Complete!",
                    description:
                      "Your personalized discovery profile is ready for premium matching",
                    type: "discovery" as const,
                    icon: <Sparkles className="w-6 h-6" />,
                    priority: "high" as const,
                    timestamp: new Date(),
                  };

                  setRecommendations((prev) => [
                    newRecommendation,
                    ...prev.slice(0, 9),
                  ]);
                  setShowRecommendation(newRecommendation);
                  setTimeout(
                    () => setShowRecommendation(null),
                    4000,
                  );

                  handleStateChange("swipe");
                }}
                onBack={() => handleStateChange("swipe")}
                isOnboarding={true}
              />
            )}

            {currentState === "host-onboarding" && (
              <HostOnboarding
                key="host-onboarding"
                onBack={() => handleStateChange("home")}
                onComplete={handleHostComplete}
                onError={handleError}
              />
            )}

            {currentState === "error" && (
              <div className="min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] flex items-center justify-center p-4">
                <motion.div
                  className="glass-effect p-8 rounded-2xl text-center max-w-md w-full"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                >
                  <AlertTriangle className="w-16 h-16 text-red-400 mx-auto mb-4" />
                  <h2 className="text-white text-xl font-semibold mb-2">
                    Something went wrong
                  </h2>
                  <p className="text-white/70 mb-6">
                    We're experiencing a technical issue. Please
                    try again.
                  </p>
                  <div className="space-y-2">
                    <Button
                      onClick={() =>
                        handleStateChange("home", {
                          skipValidation: true,
                        })
                      }
                      className="w-full bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] hover:opacity-90"
                    >
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Return Home
                    </Button>
                    <Button
                      onClick={() => window.location.reload()}
                      variant="outline"
                      className="w-full text-white border-white/20 hover:bg-white/10"
                    >
                      Refresh App
                    </Button>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>
        </main>
      </div>
    </AppErrorBoundary>
  );
}

export default App;