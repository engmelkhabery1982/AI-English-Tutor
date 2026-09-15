import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

/**
 * ProgressScreen
 *
 * STRUCTURAL PLACEHOLDER ONLY.
 * No features are implemented yet.
 *
 * The real Progress screen will render ProgressRecord data over time:
 * - listening, speaking, fluency, confidence, pronunciation,
 *   grammar, vocabulary trends
 */
export default function ProgressScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Progress</Text>
      <Text style={styles.subtitle}>Your English growth over time</Text>
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