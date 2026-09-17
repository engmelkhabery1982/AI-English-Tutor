import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';

/**
 * SettingsScreen
 *
 * STRUCTURAL PLACEHOLDER for preferences plus the ONE implemented entry point:
 * starting (or repeating) the personalized onboarding / diagnostic assessment.
 * The diagnostic itself lives in src/onboarding — this screen only routes to it.
 */
export default function SettingsScreen() {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.subtitle}>Preferences and providers</Text>

      <TouchableOpacity
        style={styles.button}
        onPress={() => navigation.navigate('Onboarding')}
      >
        <Text style={styles.buttonText}>Assess my English</Text>
      </TouchableOpacity>
      <Text style={styles.note}>
        Re-runs the diagnostic and updates your working level only if you accept it. Your existing
        evidence is kept.
      </Text>
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
    marginBottom: 24,
  },
  button: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  note: { fontSize: 12, color: '#8e8e93', marginTop: 12, textAlign: 'center' },
});
