/**
 * src/shared/id.ts
 *
 * Minimal ID generation helper for React Native / Expo.
 *
 * Uses crypto.randomUUID() which is available in:
 * - Modern browsers
 * - React Native 0.72+ (via JSI polyfill)
 * - Expo SDK 50+
 *
 * No heavy dependencies. No Node-only crypto APIs.
 */

export function generateId(): string {
  // crypto.randomUUID() is the standard Web Crypto API
  // Available in React Native via global crypto polyfill
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Fallback for extremely old environments (should not happen in Expo 57)
  // RFC4122 v4 compliant random UUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function isValidUuid(id: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}