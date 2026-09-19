import { vi } from 'vitest';

// Global mock for react-native to avoid Flow parsing in vitest
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => {} }),
  },
  Platform: { OS: 'ios', select: (obj: any) => obj.ios ?? obj.default },
}));

// Mock expo modules that are not needed in unit tests
vi.mock('expo-file-system', () => ({
  File: class {
    exists = false;
    delete() {}
  },
  deleteAsync: async () => {},
}));

vi.mock('expo-file-system/legacy', () => ({
  deleteAsync: async () => {},
  getInfoAsync: async () => ({ exists: false }),
}));

vi.mock('expo-audio', () => ({
  Audio: {},
}));

vi.mock('expo-speech', () => ({
  speak: async () => {},
  stop: async () => {},
  isSpeakingAsync: async () => false,
}));
