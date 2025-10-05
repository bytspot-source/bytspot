import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import Constants from 'expo-constants';

const FLAG = (Constants.expoConfig?.extra as any)?.GEOfence_ENABLED ?? false;
const TASK_NAME = 'ms-geofence-task';

export function geofenceEnabled() {
  return !!FLAG;
}

export async function ensurePermissions() {
  if (!FLAG) return false;
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return false;
  const bg = await Location.requestBackgroundPermissionsAsync();
  return bg.status === 'granted';
}

export async function startGeofencing(regions: Location.LocationRegion[]) {
  if (!FLAG) return;
  await ensurePermissions();
  await Location.startGeofencingAsync(TASK_NAME, regions);
}

export async function stopGeofencing() {
  if (!FLAG) return;
  const registered = await TaskManager.isTaskRegisteredAsync(TASK_NAME);
  if (registered) await Location.stopGeofencingAsync(TASK_NAME);
}

TaskManager.defineTask(TASK_NAME, ({ data, error }) => {
  if (!FLAG) return;
  if (error) {
    console.warn('Geofence task error', error);
    return;
  }
  const { eventType, region } = (data || {}) as any;
  console.log('Geofence event', eventType, region);
  // TODO: queue locally and batch via BFF when online
});

