import React from 'react';
import ListeningScreen from './ListeningScreen';

// Two discoverable entrances into ONE existing repeat/compare implementation.
export function PronunciationScreen() {
  return <ListeningScreen initialPractice="pronunciation" />;
}
export function ShadowingScreen() {
  return <ListeningScreen initialPractice="shadowing" />;
}
