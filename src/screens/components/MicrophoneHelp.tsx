import React, { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import LearnerButton from './LearnerButton';

/** Guidance only — never requests permission or starts a recorder. */
export default function MicrophoneHelp() {
  const [failed, setFailed] = useState(false);
  return <View style={{ marginVertical: 8 }}>
    <Text>Microphone access is needed to hear your spoken answer. If access was denied, allow Microphone in your device app settings, then return and try again. Nothing is recorded without permission.</Text>
    <LearnerButton accessibilityLabel="Open device app settings" onPress={() => {
      void Linking.openSettings().catch(() => setFailed(true));
    }}><Text style={{ color: '#2563EB' }}>Open microphone settings</Text></LearnerButton>
    {failed ? <Text accessibilityRole="alert">Could not open settings. Open your device settings manually and select this app.</Text> : null}
  </View>;
}
