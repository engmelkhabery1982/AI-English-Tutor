import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

/**
 * ReviewScreen
 *
 * STRUCTURAL PLACEHOLDER ONLY.
 * No features are implemented yet.
 *
 * The real Review screen will surface:
 * - recurring grammar mistakes
 * - pronunciation weaknesses
 * - vocabulary due for review
 * - fluency / hesitation observations
 */
export default function ReviewScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Review</Text>
      <Text style={styles.subtitle}>Weaknesses and spaced repetition</Text>
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