import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Users, MapPin, Clock, ThumbsUp, ThumbsDown, Star, Car, UtensilsCrossed, Shield, CheckCircle, XCircle, Eye, X } from 'lucide-react';
import { Button } from './ui/button';

interface GroupMember {
  id: string;
  name: string;
  avatar: string;
  status: 'pending' | 'approved' | 'declined' | 'viewing';
  joinedAt: Date;
}

interface VenueDetails {
  name: string;
  category: 'parking' | 'venue' | 'valet';
  location: string;
  distance: string;
  price?: string;
  rating?: number;
  features: string[];
  availability: 'available' | 'limited' | 'unavailable';
  image?: string;
}

interface GroupDecisionProps {
  recommendation: {
    id: string;
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
  };
  onInteraction?: () => void;
  onClose?: () => void;
}

export function GroupDecisionNotification({ recommendation, onInteraction, onClose }: GroupDecisionProps) {
  const [timeLeft, setTimeLeft] = useState('');
  const [userVote, setUserVote] = useState<'approved' | 'declined' | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const groupData = recommendation.groupData;
  if (!groupData) return null;

  const { venue, members, deadline, groupName, initiator, approvedVotes, declinedVotes, totalVotes } = groupData;

  // Calculate time remaining
  useEffect(() => {
    const updateTimeLeft = () => {
      const now = new Date().getTime();
      const deadlineTime = deadline.getTime();
      const difference = deadlineTime - now;

      if (difference > 0) {
        const minutes = Math.floor((difference % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((difference % (1000 * 60)) / 1000);
        setTimeLeft(`${minutes}m ${seconds}s`);
      } else {
        setTimeLeft('Expired');
      }
    };

    updateTimeLeft();
    const interval = setInterval(updateTimeLeft, 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'parking': return <Car className="w-4 h-4" />;
      case 'venue': return <UtensilsCrossed className="w-4 h-4" />;
      case 'valet': return <Shield className="w-4 h-4" />;
      default: return <MapPin className="w-4 h-4" />;
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'approved': return <CheckCircle className="w-3 h-3 text-green-400" />;
      case 'declined': return <XCircle className="w-3 h-3 text-red-400" />;
      case 'viewing': return <Eye className="w-3 h-3 text-blue-400" />;
      default: return <Clock className="w-3 h-3 text-yellow-400" />;
    }
  };

  const getAvailabilityColor = (availability: string) => {
    switch (availability) {
      case 'available': return 'text-green-400';
      case 'limited': return 'text-yellow-400';
      case 'unavailable': return 'text-red-400';
      default: return 'text-gray-400';
    }
  };

  const handleVote = (vote: 'approved' | 'declined') => {
    if (onInteraction) onInteraction();
    setUserVote(vote);
    // In a real app, this would send the vote to the backend
    console.log(`Voted ${vote} for ${venue.name}`);
  };

  const progressPercentage = Math.round((approvedVotes / totalVotes) * 100);

  return (
    <motion.div
      className="glass-card rounded-2xl p-6 max-w-md border border-purple-400/30 bg-gradient-to-br from-purple-500/10 via-pink-500/5 to-blue-500/10 cursor-pointer relative"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ scale: 1.02 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      onMouseEnter={() => {
        if (onInteraction) onInteraction();
      }}
    >
      {/* Interaction Hint */}
      <div className="absolute -top-2 -right-2">
        <motion.div
          className="w-3 h-3 bg-green-400 rounded-full"
          animate={{ scale: [1, 1.2, 1], opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 2, repeat: Infinity }}
          title="Interactive notification"
        />
      </div>
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center space-x-3">
          <motion.div
            className="flex items-center justify-center w-10 h-10 bg-gradient-to-r from-purple-500 to-pink-500 rounded-xl"
            whileHover={{ scale: 1.05, rotate: 5 }}
            transition={{ duration: 0.2 }}
          >
            <Users className="w-5 h-5 text-white" />
          </motion.div>
          <div>
            <h3 className="text-white font-semibold text-sm">Group Decision</h3>
            <p className="text-white/60 text-xs">{groupName}</p>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <motion.div
            className="flex items-center space-x-1 px-2 py-1 bg-orange-500/20 border border-orange-400/30 rounded-full"
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          >
            <Clock className="w-3 h-3 text-orange-400" />
            <span className="text-orange-300 text-xs font-medium">{timeLeft}</span>
          </motion.div>
          {onClose && (
            <motion.button
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="flex items-center justify-center w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              title="Close notification"
            >
              <X className="w-3 h-3 text-white/60" />
            </motion.button>
          )}
        </div>
      </div>

      {/* Venue Card */}
      <motion.div
        className="bg-white/5 border border-white/10 rounded-xl p-4 mb-4 cursor-pointer"
        whileHover={{ scale: 1.02, backgroundColor: "rgba(255,255,255,0.08)" }}
        onClick={(e) => {
          e.stopPropagation();
          if (onInteraction) onInteraction();
          setShowDetails(!showDetails);
        }}
      >
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center space-x-2">
            <div className={`flex items-center justify-center w-6 h-6 rounded-lg ${
              venue.category === 'parking' ? 'bg-green-500/20' :
              venue.category === 'venue' ? 'bg-purple-500/20' : 'bg-yellow-500/20'
            }`}>
              {getCategoryIcon(venue.category)}
            </div>
            <div>
              <h4 className="text-white font-medium text-sm">{venue.name}</h4>
              <p className="text-white/50 text-xs">{venue.location}</p>
            </div>
          </div>
          <div className="text-right">
            {venue.rating && (
              <div className="flex items-center space-x-1 mb-1">
                <Star className="w-3 h-3 text-yellow-400 fill-current" />
                <span className="text-yellow-400 text-xs font-medium">{venue.rating}</span>
              </div>
            )}
            <span className={`text-xs font-medium ${getAvailabilityColor(venue.availability)}`}>
              {venue.availability}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-1">
              <MapPin className="w-3 h-3 text-white/40" />
              <span className="text-white/60">{venue.distance}</span>
            </div>
            {venue.price && (
              <div className="text-white/60 font-medium">{venue.price}</div>
            )}
          </div>
        </div>

        {/* Features */}
        <div className="flex flex-wrap gap-1 mt-2">
          {venue.features.slice(0, 3).map((feature, index) => (
            <span
              key={index}
              className="px-2 py-1 bg-white/10 text-white/70 rounded text-xs"
            >
              {feature}
            </span>
          ))}
          {venue.features.length > 3 && (
            <span className="px-2 py-1 bg-white/10 text-white/70 rounded text-xs">
              +{venue.features.length - 3} more
            </span>
          )}
        </div>
      </motion.div>

      {/* Voting Progress */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-white/60 text-xs">Group Progress</span>
          <span className="text-white/60 text-xs">{approvedVotes}/{totalVotes} approved</span>
        </div>
        <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
          <motion.div
            className="h-full bg-gradient-to-r from-green-400 to-emerald-500"
            initial={{ width: 0 }}
            animate={{ width: `${progressPercentage}%` }}
            transition={{ duration: 1, ease: "easeOut" }}
          />
        </div>
        {declinedVotes > 0 && (
          <div className="mt-1 text-right">
            <span className="text-red-400 text-xs">{declinedVotes} declined</span>
          </div>
        )}
      </div>

      {/* Member Avatars */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex -space-x-2">
          {members.slice(0, 5).map((member, index) => (
            <motion.div
              key={member.id}
              className="relative"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.1 }}
            >
              <div className={`w-6 h-6 rounded-full border-2 bg-gradient-to-br from-purple-400 to-pink-400 flex items-center justify-center text-xs text-white font-medium ${
                member.status === 'approved' ? 'border-green-400' :
                member.status === 'declined' ? 'border-red-400' :
                member.status === 'viewing' ? 'border-blue-400' : 'border-yellow-400'
              }`}>
                {member.name.charAt(0)}
              </div>
              <div className="absolute -bottom-1 -right-1">
                {getStatusIcon(member.status)}
              </div>
            </motion.div>
          ))}
          {members.length > 5 && (
            <div className="w-6 h-6 rounded-full border-2 border-white/30 bg-white/10 flex items-center justify-center text-xs text-white/60">
              +{members.length - 5}
            </div>
          )}
        </div>
        <span className="text-white/60 text-xs">
          by <span className="text-white/80 font-medium">{initiator}</span>
        </span>
      </div>

      {/* Action Buttons */}
      <AnimatePresence>
        {!userVote && (
          <motion.div
            className="flex space-x-2"
            initial={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Button
              onClick={(e) => {
                e.stopPropagation();
                handleVote('approved');
              }}
              className="flex-1 bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white text-sm py-2 transition-all duration-200"
            >
              <ThumbsUp className="w-4 h-4 mr-1" />
              Approve
            </Button>
            <Button
              onClick={(e) => {
                e.stopPropagation();
                handleVote('declined');
              }}
              className="flex-1 bg-gradient-to-r from-red-500 to-rose-500 hover:from-red-600 hover:to-rose-600 text-white text-sm py-2 transition-all duration-200"
            >
              <ThumbsDown className="w-4 h-4 mr-1" />
              Decline
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Vote Confirmation */}
      <AnimatePresence>
        {userVote && (
          <motion.div
            className={`flex items-center justify-center space-x-2 p-3 rounded-lg ${
              userVote === 'approved' ? 'bg-green-500/20 border border-green-400/30' : 'bg-red-500/20 border border-red-400/30'
            }`}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
          >
            {userVote === 'approved' ? (
              <>
                <CheckCircle className="w-5 h-5 text-green-400" />
                <span className="text-green-300 font-medium text-sm">You approved this venue!</span>
              </>
            ) : (
              <>
                <XCircle className="w-5 h-5 text-red-400" />
                <span className="text-red-300 font-medium text-sm">You declined this venue</span>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Additional Details */}
      <AnimatePresence>
        {showDetails && (
          <motion.div
            className="mt-4 p-3 bg-white/5 border border-white/10 rounded-lg"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
          >
            <h5 className="text-white font-medium text-xs mb-2">All Features:</h5>
            <div className="flex flex-wrap gap-1">
              {venue.features.map((feature, index) => (
                <span
                  key={index}
                  className="px-2 py-1 bg-white/10 text-white/70 rounded text-xs"
                >
                  {feature}
                </span>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}