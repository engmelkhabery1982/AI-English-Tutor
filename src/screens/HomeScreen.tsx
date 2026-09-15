import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

/**
 * HomeScreen
 *
 * STRUCTURAL PLACEHOLDER ONLY.
 * No features are implemented yet.
 *
 * The real Home screen will surface:
 * - suggested conversation topics
 * - quick actions (free conversation, listening, professional English)
 * - recent progress summary
 * - weakness retraining prompts
 */
export default function HomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>AI English Tutor</Text>
      <Text style={styles.subtitle}>Home</Text>
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