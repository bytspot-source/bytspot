import React from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './ui/sheet'
import {
  Flame, ActivitySquare, Car, Bot, Radar, TrafficCone,
  LocateFixed, Search, Layers, Route
} from 'lucide-react'
import BytspotColors from './BytspotColors'

export type MapPrimaryAction =
  | 'trending_hotspots'
  | 'live_venue_data'
  | 'smart_parking'
  | 'ai_navigation'
  | 'spot_radar'
  | 'traffic_intelligence'

export interface MapMenuSlideUpProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect?: (action: MapPrimaryAction) => void
}

const tileClasses =
  'flex items-start gap-3 rounded-xl p-3 bg-white/5 hover:bg-white/10 transition-colors cursor-pointer'

const chip = (text: string, tone: 'pro' | 'new' | 'live') => (
  <span
    className={
      'ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded ' +
      (tone === 'pro'
        ? 'bg-purple-500/20 text-purple-300'
        : tone === 'new'
        ? 'bg-emerald-500/20 text-emerald-300'
        : 'bg-red-500/20 text-red-300')
    }
  >
    {tone === 'pro' ? 'PRO' : tone === 'new' ? 'NEW' : 'LIVE'}
  </span>
)

export function MapMenuSlideUp({ open, onOpenChange, onSelect }: MapMenuSlideUpProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="border-t border-white/10 bg-[rgba(12,12,12,0.9)] backdrop-blur-2xl !p-0">
        <div className="pt-3" />
        <SheetHeader className="px-4 pb-0">
          <SheetTitle className="text-white flex items-center">
            Map Intelligence
            <span className="ml-2 text-xs text-white/60">Quick Actions</span>
          </SheetTitle>
          <SheetDescription className="text-white/60">
            Explore live data layers and navigate with AI assistance
          </SheetDescription>
        </SheetHeader>

        {/* Quick row */}
        <div className="px-4 py-3 grid grid-cols-4 gap-2">
          <button className="flex flex-col items-center gap-1 rounded-xl p-2 bg-white/5 hover:bg-white/10 transition">
            <LocateFixed className="w-5 h-5 text-white" />
            <span className="text-[10px] text-white/70">My Location</span>
          </button>
          <button className="flex flex-col items-center gap-1 rounded-xl p-2 bg-white/5 hover:bg-white/10 transition">
            <Search className="w-5 h-5 text-white" />
            <span className="text-[10px] text-white/70">Search</span>
          </button>
          <button className="flex flex-col items-center gap-1 rounded-xl p-2 bg-white/5 hover:bg-white/10 transition">
            <Layers className="w-5 h-5 text-white" />
            <span className="text-[10px] text-white/70">Layers</span>
          </button>
          <button className="flex flex-col items-center gap-1 rounded-xl p-2 bg-white/5 hover:bg-white/10 transition">
            <Route className="w-5 h-5 text-white" />
            <span className="text-[10px] text-white/70">Routes</span>
          </button>
        </div>

        {/* Primary actions */}
        <div className="px-4 pb-4 space-y-2">
          <div
            className={tileClasses}
            onClick={() => onSelect?.('trending_hotspots')}
            aria-label="Trending Hotspots"
          >
            <div className="mt-0.5 rounded-md p-1.5" style={{
              background: 'linear-gradient(135deg, rgba(255,69,0,0.2), rgba(255,0,255,0.15))',
            }}>
              <Flame className="w-5 h-5 text-orange-300" />
            </div>
            <div className="flex-1">
              <div className="text-white text-sm font-semibold">
                Trending Hotspots {chip('LIVE','live')}
              </div>
              <div className="text-white/60 text-xs">Real-time popular areas and peaks</div>
            </div>
          </div>

          <div className={tileClasses} onClick={() => onSelect?.('live_venue_data')} aria-label="Live Venue Data">
            <div className="mt-0.5 rounded-md p-1.5" style={{
              background: 'linear-gradient(135deg, rgba(0,191,255,0.2), rgba(255,0,255,0.15))',
            }}>
              <ActivitySquare className="w-5 h-5 text-cyan-300" />
            </div>
            <div className="flex-1">
              <div className="text-white text-sm font-semibold">Live Venue Data</div>
              <div className="text-white/60 text-xs">Crowd levels, wait times, sentiment</div>
            </div>
          </div>

          <div className={tileClasses} onClick={() => onSelect?.('smart_parking')} aria-label="Smart Parking">
            <div className="mt-0.5 rounded-md p-1.5" style={{
              background: 'linear-gradient(135deg, rgba(0,191,255,0.2), rgba(0,128,128,0.2))',
            }}>
              <Car className="w-5 h-5 text-sky-300" />
            </div>
            <div className="flex-1">
              <div className="text-white text-sm font-semibold">Smart Parking</div>
              <div className="text-white/60 text-xs">Live availability, pricing, hours</div>
            </div>
          </div>

          <div className={tileClasses} onClick={() => onSelect?.('ai_navigation')} aria-label="AI Navigation">
            <div className="mt-0.5 rounded-md p-1.5" style={{
              background: 'linear-gradient(135deg, rgba(138,43,226,0.25), rgba(255,0,255,0.2))',
            }}>
              <Bot className="w-5 h-5 text-purple-300" />
            </div>
            <div className="flex-1">
              <div className="text-white text-sm font-semibold">AI Navigation {chip('PRO','pro')}</div>
              <div className="text-white/60 text-xs">Optimized routes and timing</div>
            </div>
          </div>

          <div className={tileClasses} onClick={() => onSelect?.('spot_radar')} aria-label="Spot Radar">
            <div className="mt-0.5 rounded-md p-1.5" style={{
              background: 'linear-gradient(135deg, rgba(0,191,255,0.2), rgba(255,0,255,0.15))',
            }}>
              <Radar className="w-5 h-5 text-pink-300" />
            </div>
            <div className="flex-1">
              <div className="text-white text-sm font-semibold">Spot Radar</div>
              <div className="text-white/60 text-xs">Hidden gems & new openings</div>
            </div>
          </div>

          <div className={tileClasses} onClick={() => onSelect?.('traffic_intelligence')} aria-label="Traffic Intelligence">
            <div className="mt-0.5 rounded-md p-1.5" style={{
              background: 'linear-gradient(135deg, rgba(255,69,0,0.2), rgba(0,191,255,0.15))',
            }}>
              <TrafficCone className="w-5 h-5 text-orange-300" />
            </div>
            <div className="flex-1">
              <div className="text-white text-sm font-semibold">Traffic Intelligence</div>
              <div className="text-white/60 text-xs">Live traffic & incident overlays</div>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export default MapMenuSlideUp

/*
Usage example:

const [mapMenuOpen, setMapMenuOpen] = useState(false)
<EnhancedFooter
  showFooter
  onBack={() => setSection('discover')}
  onOpenMap={() => setMapMenuOpen(true)}
  onOpenInsider={() => setSection('insider')}
  onOpenConcierge={() => setSection('concierge')}
  onOpenProfile={() => setSection('profile')}
  ...
/>
<MapMenuSlideUp open={mapMenuOpen} onOpenChange={setMapMenuOpen} onSelect={(a) => {
  // optional: toast action
  setMapMenuOpen(false)
  if(a==='smart_parking') setSection('map')
}} />
*/

