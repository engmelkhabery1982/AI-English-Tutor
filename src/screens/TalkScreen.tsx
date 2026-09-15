import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

/**
 * TalkScreen
 *
 * STRUCTURAL PLACEHOLDER ONLY.
 * No features are implemented yet.
 *
 * The real Talk screen will host the Conversation Engine:
 * - microphone input -> STT provider
 * - AI provider -> natural response
 * - TTS provider -> spoken reply
 * - correction / coaching overlay
 */
export default function TalkScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Talk</Text>
      <Text style={styles.subtitle}>Natural spoken conversation</Text>
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