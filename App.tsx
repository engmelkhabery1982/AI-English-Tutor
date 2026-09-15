import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import RootNavigator from './src/navigation/RootNavigator';

/**
 * App entry point.
 *
 * Wires the structural RootNavigator (Home | Talk | Vocabulary |
 * Review | Progress | Settings) into the app root.
 *
 * No AI, speech, or learning logic is implemented yet.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <RootNavigator />
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}
