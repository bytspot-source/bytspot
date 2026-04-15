const DEFAULT_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost',
  'http://127.0.0.1',
  'capacitor://localhost',
  'ionic://localhost',
];

export function parseCorsOrigins(rawOrigins: string, frontendUrl?: string): string[] {
  return Array.from(new Set([
    ...DEFAULT_CORS_ORIGINS,
    ...(frontendUrl ? [frontendUrl.trim()] : []),
    ...rawOrigins.split(',').map((origin) => origin.trim()).filter(Boolean),
  ]));
}

export function isAllowedCorsOrigin(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}
