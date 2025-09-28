# Capacitor Setup Guide (React/Vite)

This guide describes how to wrap the existing React app with Capacitor for iOS/Android.

## Install
```bash
npm install @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android \
  @capacitor/geolocation @capacitor/push-notifications @capacitor/camera \
  @capacitor/haptics @capacitor/status-bar @capacitor/keyboard @capacitor/device
```

## Initialize
```bash
npx cap init bytspot com.bytspot.app
```

## Configure
- Ensure `capacitor.config.ts` exists with `webDir: "dist"`
- Vite build output must point to `dist` (default)

## Build & Sync
```bash
npm run build
npx cap add ios
npx cap add android
npx cap sync
```

## Run
- Open iOS: `npx cap open ios`
- Open Android: `npx cap open android`

## Minimal Usage Examples
```ts
import { Geolocation } from '@capacitor/geolocation';
const pos = await Geolocation.getCurrentPosition();

import { PushNotifications } from '@capacitor/push-notifications';
await PushNotifications.requestPermissions();
await PushNotifications.register();
```

## Notes
- On-device only permissions: explain benefits inline (privacy-first)
- Use battery-aware patterns for background usage (Mobile BMS)

