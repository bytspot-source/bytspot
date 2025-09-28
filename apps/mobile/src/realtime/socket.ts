import { io, Socket } from 'socket.io-client';
import Constants from 'expo-constants';

const BFF_URL = (Constants.expoConfig?.extra as any)?.BFF_URL || 'http://localhost:3001';
let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(BFF_URL, { transports: ['websocket'] });
  }
  return socket;
}

export function subscribeInsider(params: { interests?: string[]; lifestyles?: string[]; onUpdate?: (u: any) => void }) {
  const s = getSocket();
  const { interests = [], lifestyles = [], onUpdate } = params || {};
  const handler = (u: any) => { onUpdate && onUpdate(u); };
  s.on('vibe:update', handler);
  s.emit('subscribe:insider', { interests, lifestyles });
  return () => {
    s.off('vibe:update', handler);
  };
}

