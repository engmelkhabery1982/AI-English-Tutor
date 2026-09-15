import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

/**
 * VocabularyScreen
 *
 * STRUCTURAL PLACEHOLDER ONLY.
 * No features are implemented yet.
 *
 * The real Vocabulary screen will browse VocabularyItem and ExpressionItem
 * records from the Learner Model, supporting:
 * - multiple meanings per word
 * - usage contexts
 * - mastery state
 * - review scheduling
 */
export default function VocabularyScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Vocabulary</Text>
      <Text style={styles.subtitle}>Words, expressions, and phrases</Text>
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