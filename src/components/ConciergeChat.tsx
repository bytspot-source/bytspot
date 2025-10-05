import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ArrowLeft, 
  Send, 
  Brain, 
  MapPin, 
  Clock, 
  Star,
  Car,
  UtensilsCrossed,
  Users,
  Calendar,
  DollarSign,
  Mic,
  Paperclip,
  MoreVertical,
  Phone,
  Video,
  Info,
  Smile,
  Image as ImageIcon,
  X,
  Check,
  CheckCheck,
  AlertCircle,
  RefreshCw
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { Card } from './ui/card';

interface ConciergeChatProps {
  onBack: () => void;
  venue?: any;
  userData?: any;
}

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'ai';
  timestamp: Date;
  suggestions?: string[];
  venue?: any;
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'error';
  type?: 'text' | 'card' | 'action';
  cardData?: {
    title: string;
    subtitle: string;
    image?: string;
    action?: string;
    price?: string;
    rating?: number;
  };
}

interface TypingUser {
  id: string;
  name: string;
  avatar?: string;
}

export function ConciergeChat({ onBack, venue, userData }: ConciergeChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const [isOnline, setIsOnline] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isScrolledToBottom, setIsScrolledToBottom] = useState(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'connecting' | 'disconnected'>('connected');
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);

  // Enhanced scroll to bottom with smooth animation
  const scrollToBottom = useCallback((force = false) => {
    if (force || isScrolledToBottom) {
      messagesEndRef.current?.scrollIntoView({ 
        behavior: 'smooth',
        block: 'end'
      });
    }
  }, [isScrolledToBottom]);

  // Handle scroll events to show/hide scroll to bottom button
  const handleScroll = useCallback(() => {
    if (messagesContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      setIsScrolledToBottom(isAtBottom);
      setShowScrollToBottom(!isAtBottom && messages.length > 5);
    }
  }, [messages.length]);

  // Auto-scroll when new messages arrive
  useEffect(() => {
    if (isScrolledToBottom) {
      scrollToBottom();
    }
  }, [messages, scrollToBottom, isScrolledToBottom]);

  // Simulate connection status changes
  useEffect(() => {
    const interval = setInterval(() => {
      if (Math.random() < 0.02) { // 2% chance to simulate connection issues
        setConnectionStatus('connecting');
        setTimeout(() => setConnectionStatus('connected'), 2000);
      }
    }, 10000);

    return () => clearInterval(interval);
  }, []);

  // Initialize chat with enhanced greeting
  useEffect(() => {
    const initialMessage: Message = {
      id: Date.now().toString(),
      text: venue 
        ? `Hi ${userData?.name || 'there'}! 👋 I see you're interested in ${venue.title}. I'm your Bytspot AI concierge and I'm here to help you plan the perfect experience. I have real-time access to availability, current vibes, and exclusive perks. What would you like to know?`
        : `Hello ${userData?.name || 'there'}! 👋 I'm your personal Bytspot AI concierge. I can help you discover the best spots, make reservations, find parking, and answer any questions about the nightlife scene. I'm connected to real-time data from hundreds of venues. How can I assist you today?`,
      sender: 'ai',
      timestamp: new Date(),
      status: 'delivered',
      suggestions: venue 
        ? ['What\'s the vibe like right now?', 'Can you get me a reservation?', 'What about parking nearby?', 'Any dress code?']
        : ['Find me a restaurant', 'Best clubs tonight', 'Parking options', 'VIP experiences']
    };
    setMessages([initialMessage]);

    // Simulate reading the message
    setTimeout(() => {
      setMessages(prev => prev.map(msg => 
        msg.id === initialMessage.id ? { ...msg, status: 'read' } : msg
      ));
    }, 1000);
  }, [venue, userData]);

  // Enhanced message sending with status updates
  const handleSend = async (text?: string) => {
    const messageText = text || inputText.trim();
    if (!messageText || isTyping) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      text: messageText,
      sender: 'user',
      timestamp: new Date(),
      status: 'sending'
    };

    setMessages(prev => [...prev, userMessage]);
    setInputText('');
    setIsTyping(true);

    // Simulate sending status updates
    setTimeout(() => {
      setMessages(prev => prev.map(msg => 
        msg.id === userMessage.id ? { ...msg, status: 'sent' } : msg
      ));
    }, 200);

    setTimeout(() => {
      setMessages(prev => prev.map(msg => 
        msg.id === userMessage.id ? { ...msg, status: 'delivered' } : msg
      ));
    }, 500);

    // Simulate AI typing indicator
    setTypingUsers([{ id: 'ai-concierge', name: 'Bytspot Concierge' }]);

    try {
      // Simulate network delay
      await new Promise(resolve => setTimeout(resolve, 1200 + Math.random() * 800));
      
      const aiResponse = generateEnhancedAIResponse(messageText);
      
      setMessages(prev => [
        ...prev.map(msg => 
          msg.id === userMessage.id ? { ...msg, status: 'read' } : msg
        ),
        aiResponse
      ]);
      
      setIsTyping(false);
      setTypingUsers([]);

      // Mark AI message as read after a delay
      setTimeout(() => {
        setMessages(prev => prev.map(msg => 
          msg.id === aiResponse.id ? { ...msg, status: 'read' } : msg
        ));
      }, 800);

    } catch (error) {
      setMessages(prev => prev.map(msg => 
        msg.id === userMessage.id ? { ...msg, status: 'error' } : msg
      ));
      setIsTyping(false);
      setTypingUsers([]);
    }
  };

  // Enhanced AI response generation with cards and actions
  const generateEnhancedAIResponse = (userText: string): Message => {
    const lowerText = userText.toLowerCase();
    
    if (lowerText.includes('vibe') || lowerText.includes('busy') || lowerText.includes('crowd')) {
      return {
        id: (Date.now() + 1).toString(),
        text: venue 
          ? `${venue.title} is absolutely buzzing right now! 🔥\n\nCurrent vibe score: ${Math.round(75 + Math.random() * 20)}%\nCrowd level: ${['Energetic', 'Sophisticated', 'Vibrant', 'Electric'][Math.floor(Math.random() * 4)]}\nPeak hours: 9-11 PM\n\nThe DJ is killing it tonight and the energy is incredible! Would you like me to check availability or suggest the best time to arrive?`
          : 'Based on real-time data, here are the hottest spots with incredible vibes right now! 🎵✨',
        sender: 'ai',
        timestamp: new Date(),
        status: 'delivered',
        type: venue ? 'text' : 'card',
        cardData: !venue ? {
          title: 'Top Trending Spots',
          subtitle: 'Live vibe scores updated every 5 minutes',
          action: 'View All Venues'
        } : undefined,
        suggestions: ['Check availability', 'Best time to arrive', 'Dress code info', 'Similar venues']
      };
    }
    
    if (lowerText.includes('reservation') || lowerText.includes('book') || lowerText.includes('table')) {
      return {
        id: (Date.now() + 1).toString(),
        text: venue 
          ? `Perfect! I can secure your spot at ${venue.title} right now! 🎯\n\n✅ Available tonight:\n• 8:00 PM - Premium table\n• 9:30 PM - VIP section\n• 10:15 PM - Rooftop area\n\nI can also add special perks like complimentary appetizers or priority service. What sounds good?`
          : '🍽️ I\'d love to help you make the perfect reservation!\n\nWhat type of dining experience are you looking for? I have exclusive access to tables at the city\'s most sought-after spots, plus I can often secure special perks for Bytspot users.',
        sender: 'ai',
        timestamp: new Date(),
        status: 'delivered',
        type: 'action',
        suggestions: venue 
          ? ['Book 8:00 PM table', 'Book 9:30 PM VIP', 'Add special perks', 'Show full menu']
          : ['Fine dining', 'Rooftop spots', 'Private dining', 'Show availability']
      };
    }
    
    if (lowerText.includes('parking') || lowerText.includes('valet')) {
      return {
        id: (Date.now() + 1).toString(),
        text: '🚗 I\'ve found the perfect parking solutions for you!\n\n🌟 **Elite Valet Service** - $25\n• White-glove service\n• Car detailing available\n• 2-minute pickup\n\n🏢 **Downtown Secure Garage** - $8/hr\n• Covered parking\n• 24/7 security\n• 0.3 miles walk\n\nBoth options have immediate availability. Elite Valet is perfect for special occasions!',
        sender: 'ai',
        timestamp: new Date(),
        status: 'delivered',
        type: 'card',
        cardData: {
          title: 'Parking Options',
          subtitle: 'Secure & convenient options near your destination',
          action: 'Book Parking'
        },
        suggestions: ['Book Elite Valet', 'Reserve garage spot', 'Compare all options', 'Get walking directions']
      };
    }
    
    if (lowerText.includes('dress code') || lowerText.includes('attire') || lowerText.includes('what to wear')) {
      return {
        id: (Date.now() + 1).toString(),
        text: venue?.price === '$$$' 
          ? `👔 ${venue.title} maintains an upscale dress code to preserve its sophisticated atmosphere.\n\n**Men:** Smart casual to formal\n• Dress shirts or button-downs\n• Blazers or sport coats\n• Dress pants (no jeans)\n• Dress shoes or loafers\n\n**Women:** Cocktail attire\n• Cocktail dresses or elegant separates\n• Heels or sophisticated flats\n• Tasteful accessories\n\n❌ **Not permitted:** Athletic wear, flip-flops, shorts, or overly casual attire\n\nWant style tips for tonight?`
          : '👗 Most upscale venues in the area prefer smart casual to formal attire. I can provide specific recommendations based on exactly where you\'re planning to go!\n\nWould you like personalized style suggestions?',
        sender: 'ai',
        timestamp: new Date(),
        status: 'delivered',
        suggestions: ['Style suggestions for tonight', 'Outfit inspiration', 'Shopping recommendations', 'Grooming tips']
      };
    }

    // Enhanced default responses with personality
    const responses = [
      {
        text: '✨ I\'d be happy to help you create an amazing experience! I have access to real-time data from hundreds of venues, exclusive partnerships, and insider knowledge of the city\'s best spots.\n\nWhat type of experience are you looking for tonight?',
        suggestions: ['Nightlife hotspots', 'Fine dining', 'VIP experiences', 'Something unique']
      },
      {
        text: '🎯 Great question! As your AI concierge, I can help you:\n\n• Discover hidden gems and trending spots\n• Skip lines and get priority access\n• Secure better tables and exclusive perks\n• Handle all the details so you can focus on having fun\n\nWhat sounds most interesting to you?',
        suggestions: ['Surprise me with something special!', 'Rooftop vibes', 'Dance clubs', 'Intimate dining']
      },
      {
        text: '🚀 Let me work my magic! I can check real-time availability, current wait times, and even arrange special perks at select venues. My network includes the city\'s most exclusive spots.\n\nWhat kind of vibe are you going for tonight?',
        suggestions: ['Something exclusive', 'Fun with friends', 'Romantic evening', 'Business entertainment']
      }
    ];

    const randomResponse = responses[Math.floor(Math.random() * responses.length)];
    return {
      id: (Date.now() + 1).toString(),
      text: randomResponse.text,
      sender: 'ai',
      timestamp: new Date(),
      status: 'delivered',
      suggestions: randomResponse.suggestions
    };
  };

  // Enhanced message status icons
  const getMessageStatusIcon = (status?: string) => {
    switch (status) {
      case 'sending':
        return <Clock className="w-3 h-3 opacity-60 animate-pulse" />;
      case 'sent':
        return <Check className="w-3 h-3 opacity-60" />;
      case 'delivered':
        return <CheckCheck className="w-3 h-3 opacity-60" />;
      case 'read':
        return <CheckCheck className="w-3 h-3 text-[#00BFFF]" />;
      case 'error':
        return <AlertCircle className="w-3 h-3 text-red-400" />;
      default:
        return null;
    }
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const handleRetryMessage = (messageId: string) => {
    const message = messages.find(m => m.id === messageId);
    if (message) {
      setMessages(prev => prev.filter(m => m.id !== messageId));
      handleSend(message.text);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 300 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 300 }}
      className="h-full bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#1a1a1a] flex flex-col relative"
      style={{ height: '100vh', height: '100dvh' }}
    >
      {/* Enhanced Header */}
      <motion.div 
        className="backdrop-blur-xl bg-gradient-to-r from-[#121212]/95 to-[#1a1a1a]/95 border-b border-white/10 safe-area-top sticky top-0 z-50"
        style={{
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
        }}
        initial={{ y: -50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1 }}
      >
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center space-x-3">
            <Button
              onClick={onBack}
              variant="ghost"
              size="sm"
              className="w-11 h-11 rounded-full text-white hover:bg-white/10 transition-all duration-200 touch-target"
              style={{ minWidth: '44px', minHeight: '44px' }}
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
            
            <div className="flex items-center space-x-3">
              <motion.div 
                className="relative"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
              >
                <div 
                  className="w-12 h-12 bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] rounded-full flex items-center justify-center"
                  style={{
                    boxShadow: '0 4px 15px rgba(0, 191, 255, 0.3)',
                  }}
                >
                  <Brain className="w-6 h-6 text-white" />
                </div>
                {connectionStatus === 'connected' && (
                  <motion.div
                    className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-400 rounded-full border-2 border-[#121212]"
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ duration: 2, repeat: Infinity }}
                  />
                )}
              </motion.div>
              
              <div>
                <h2 className="text-lg font-semibold text-white">Bytspot Concierge</h2>
                <div className="flex items-center space-x-2">
                  {connectionStatus === 'connected' && (
                    <>
                      <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                      <span className="text-sm text-white/70">Online • Typically replies in seconds</span>
                    </>
                  )}
                  {connectionStatus === 'connecting' && (
                    <>
                      <RefreshCw className="w-3 h-3 text-yellow-400 animate-spin" />
                      <span className="text-sm text-yellow-400">Reconnecting...</span>
                    </>
                  )}
                  {connectionStatus === 'disconnected' && (
                    <>
                      <div className="w-2 h-2 bg-red-400 rounded-full" />
                      <span className="text-sm text-red-400">Offline</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
          
          <div className="flex items-center space-x-2">
            <Badge 
              className="bg-[#00BFFF]/20 text-[#00BFFF] border-[#00BFFF]/30 font-medium"
              style={{
                boxShadow: '0 0 10px rgba(0, 191, 255, 0.2)',
              }}
            >
              AI Assistant
            </Badge>
            
            <Button
              variant="ghost"
              size="sm"
              className="w-10 h-10 rounded-full text-white hover:bg-white/10"
            >
              <MoreVertical className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </motion.div>

      {/* Enhanced Messages Container */}
      <div 
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4 mobile-scroll-container"
        onScroll={handleScroll}
        style={{
          scrollBehavior: 'smooth',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <AnimatePresence mode="popLayout">
          {messages.map((message, index) => (
            <motion.div
              key={message.id}
              ref={index === messages.length - 1 ? lastMessageRef : undefined}
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -20, scale: 0.95 }}
              transition={{ 
                type: "spring", 
                stiffness: 500, 
                damping: 30,
                delay: index * 0.05 
              }}
              className={`flex ${message.sender === 'user' ? 'justify-end' : 'justify-start'} group`}
            >
              <div className={`max-w-[85%] sm:max-w-[70%] ${message.sender === 'user' ? 'order-2' : 'order-1'}`}>
                {/* Message Bubble */}
                <motion.div
                  className={`relative p-4 rounded-2xl ${
                    message.sender === 'user'
                      ? 'bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] text-white ml-auto shadow-lg'
                      : 'bg-white/10 backdrop-blur-xl border border-white/20 text-white shadow-xl'
                  }`}
                  style={{
                    backdropFilter: message.sender === 'ai' ? 'blur(20px) saturate(180%)' : undefined,
                    boxShadow: message.sender === 'user' 
                      ? '0 8px 25px rgba(0, 191, 255, 0.3), 0 4px 15px rgba(255, 0, 255, 0.2)'
                      : '0 8px 25px rgba(255, 255, 255, 0.1)',
                  }}
                  whileHover={{ scale: 1.02 }}
                  transition={{ duration: 0.2 }}
                >
                  {/* Message Content */}
                  <div className="space-y-3">
                    <p className="whitespace-pre-wrap leading-relaxed text-sm sm:text-base">
                      {message.text}
                    </p>
                    
                    {/* Enhanced Card Data */}
                    {message.type === 'card' && message.cardData && (
                      <motion.div
                        className="mt-3 p-3 rounded-xl bg-white/10 border border-white/20"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2 }}
                      >
                        <h4 className="font-semibold text-sm">{message.cardData.title}</h4>
                        <p className="text-xs text-white/70 mt-1">{message.cardData.subtitle}</p>
                        {message.cardData.action && (
                          <Button
                            size="sm"
                            className="mt-2 bg-white/20 hover:bg-white/30 text-white border-0 rounded-lg"
                          >
                            {message.cardData.action}
                          </Button>
                        )}
                      </motion.div>
                    )}
                  </div>
                  
                  {/* Message Footer */}
                  <div className="flex justify-between items-center mt-3 pt-2 border-t border-white/10">
                    <span className="text-xs opacity-60 font-medium">
                      {formatTime(message.timestamp)}
                    </span>
                    
                    {message.sender === 'user' && (
                      <div className="flex items-center space-x-1">
                        {message.status === 'error' ? (
                          <Button
                            onClick={() => handleRetryMessage(message.id)}
                            variant="ghost"
                            size="sm"
                            className="h-auto p-1 text-red-400 hover:text-red-300"
                          >
                            <RefreshCw className="w-3 h-3" />
                          </Button>
                        ) : (
                          getMessageStatusIcon(message.status)
                        )}
                      </div>
                    )}
                  </div>
                </motion.div>
                
                {/* Enhanced AI Suggestions */}
                {message.sender === 'ai' && message.suggestions && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.4 }}
                    className="mt-3 flex flex-wrap gap-2"
                  >
                    {message.suggestions.map((suggestion, suggestionIndex) => (
                      <motion.div
                        key={suggestionIndex}
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: 0.5 + suggestionIndex * 0.1 }}
                      >
                        <Button
                          onClick={() => handleSend(suggestion)}
                          variant="outline"
                          size="sm"
                          className="border-white/30 text-white hover:bg-white/10 hover:border-white/50 rounded-full text-xs h-8 px-3 transition-all duration-200 touch-target"
                          style={{
                            backdropFilter: 'blur(10px)',
                            background: 'rgba(255, 255, 255, 0.05)',
                          }}
                        >
                          {suggestion}
                        </Button>
                      </motion.div>
                    ))}
                  </motion.div>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Enhanced Typing Indicator */}
        <AnimatePresence>
          {(isTyping || typingUsers.length > 0) && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex justify-start"
            >
              <motion.div 
                className="bg-white/10 backdrop-blur-xl border border-white/20 p-4 rounded-2xl shadow-xl"
                style={{
                  backdropFilter: 'blur(20px) saturate(180%)',
                }}
              >
                <div className="flex items-center space-x-3">
                  <motion.div className="flex space-x-1">
                    {[0, 1, 2].map((i) => (
                      <motion.div
                        key={i}
                        className="w-2 h-2 bg-[#00BFFF] rounded-full"
                        animate={{ 
                          scale: [1, 1.4, 1],
                          opacity: [0.5, 1, 0.5]
                        }}
                        transition={{ 
                          duration: 1.2, 
                          repeat: Infinity, 
                          delay: i * 0.2,
                          ease: "easeInOut"
                        }}
                      />
                    ))}
                  </motion.div>
                  <span className="text-white/70 text-sm font-medium">
                    Concierge is thinking...
                  </span>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <div ref={messagesEndRef} />
      </div>

      {/* Scroll to Bottom Button */}
      <AnimatePresence>
        {showScrollToBottom && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 20 }}
            onClick={() => scrollToBottom(true)}
            className="fixed bottom-24 right-4 w-12 h-12 bg-[#00BFFF] hover:bg-[#0088CC] text-white rounded-full shadow-lg z-40 flex items-center justify-center transition-all duration-200"
            style={{
              boxShadow: '0 8px 25px rgba(0, 191, 255, 0.4)',
            }}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
          >
            <ArrowLeft className="w-5 h-5 transform rotate-90" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Industry Standard Chat Input Area */}
      <motion.div 
        className="backdrop-blur-xl bg-gradient-to-r from-[#121212]/95 to-[#1a1a1a]/95 border-t border-white/10 safe-area-bottom sticky bottom-0 z-50"
        style={{
          boxShadow: '0 -4px 20px rgba(0, 0, 0, 0.3)',
        }}
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
      >
        <div className="px-4 py-3">
          {/* Main Input Row - Industry Standard Layout */}
          <div className="flex items-center space-x-3">
            {/* Attachment Button */}
            <Button
              variant="ghost"
              size="sm"
              className="w-10 h-10 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-all duration-200 touch-target flex-shrink-0"
              style={{ minWidth: '40px', minHeight: '40px' }}
            >
              <Paperclip className="w-5 h-5" />
            </Button>
            
            {/* Input Container with Voice Button */}
            <div className="flex-1 relative">
              <div className="flex items-center bg-white/10 border border-white/20 rounded-3xl transition-all duration-200 hover:bg-white/15 focus-within:bg-white/15 focus-within:border-[#00BFFF]/50">
                <Input
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  onFocus={() => setIsInputFocused(true)}
                  onBlur={() => setIsInputFocused(false)}
                  placeholder="Ask about venues, parking, or services..."
                  className="bg-transparent border-0 text-white placeholder-white/50 px-4 py-3 text-base focus:outline-none focus:ring-0 flex-1 min-h-0"
                  style={{
                    fontSize: '16px', // Prevent zoom on iOS
                    boxShadow: 'none',
                  }}
                  disabled={connectionStatus === 'disconnected'}
                />
                
                {/* Voice Input Button - Inside Input */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-8 h-8 rounded-full text-white/60 hover:text-white hover:bg-white/10 transition-all duration-200 mr-2 flex-shrink-0"
                >
                  <Mic className="w-4 h-4" />
                </Button>
              </div>
            </div>
            
            {/* Send Button - Properly Aligned */}
            <motion.div
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="flex-shrink-0"
            >
              <Button
                onClick={() => handleSend()}
                disabled={!inputText.trim() || isTyping || connectionStatus === 'disconnected'}
                className="w-10 h-10 rounded-full bg-gradient-to-r from-[#00BFFF] to-[#FF00FF] hover:from-[#0088CC] hover:to-[#CC00CC] text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg flex items-center justify-center"
                style={{
                  minWidth: '40px',
                  minHeight: '40px',
                  boxShadow: !inputText.trim() ? '0 2px 8px rgba(255, 255, 255, 0.1)' : '0 4px 15px rgba(0, 191, 255, 0.4)',
                }}
              >
                <Send className="w-4 h-4" />
              </Button>
            </motion.div>
          </div>
          
          {/* Enhanced Quick Actions - Better Spacing */}
          <motion.div 
            className="flex space-x-2 mt-3 overflow-x-auto scrollbar-hide pb-1"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            {[
              { icon: MapPin, label: 'Find spots', action: 'Show me popular venues nearby' },
              { icon: Car, label: 'Parking', action: 'Help me find secure parking' },
              { icon: Calendar, label: 'Book', action: 'I need to make a reservation' },
              { icon: Star, label: 'Premium', action: 'What premium services are available?' }
            ].map((item, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.4 + index * 0.1 }}
                className="flex-shrink-0"
              >
                <Button
                  onClick={() => handleSend(item.action)}
                  variant="outline"
                  size="sm"
                  className="border-white/30 text-white hover:bg-white/10 hover:border-white/50 rounded-full whitespace-nowrap h-8 px-3 touch-target transition-all duration-200 flex items-center space-x-2"
                  style={{
                    backdropFilter: 'blur(10px)',
                    background: 'rgba(255, 255, 255, 0.05)',
                  }}
                >
                  <item.icon className="w-3 h-3" />
                  <span className="text-xs font-medium">{item.label}</span>
                </Button>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </motion.div>
    </motion.div>
  );
}