# MatchSpot Mobile (Expo)

Quickstart
- npm install -g expo-cli (or use npx)
- cd apps/mobile && npm install
- Update BFF URL in app.json extra.BFF_URL if needed
- Start: npm run start
- iOS: npm run ios (requires Xcode)
- Android: npm run android (requires Android Studio/SDKs)

Auth + API
- Uses expo-secure-store for JWT access_token
- Talks to your local BFF (default http://localhost:3001)
- Screens: SignIn, Discover, HostOnboarding

Next
- Add background geofencing scaffold behind a feature flag
- Polish UI, add Venue Details and Likes
- Wire real analytics and error reporting

