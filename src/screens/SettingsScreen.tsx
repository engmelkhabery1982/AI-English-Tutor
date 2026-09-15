import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

/**
 * SettingsScreen
 *
 * STRUCTURAL PLACEHOLDER ONLY.
 * No features are implemented yet.
 *
 * The real Settings screen will manage:
 * - conversation mode (Natural / Coach / Intensive)
 * - provider selection (AI / STT / TTS / Pronunciation)
 * - privacy / data options
 * - notification / review preferences
 */
export default function SettingsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.subtitle}>Preferences and providers</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
  },
});