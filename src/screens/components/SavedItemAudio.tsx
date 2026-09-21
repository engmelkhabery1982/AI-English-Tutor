import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { createExpoTTSProvider } from '../../providers/tts';
import { TTSController } from '../../voice/tts-controller';
import { useVoiceAppStateGuard } from '../../voice/use-app-state-guard';
import LearnerButton from './LearnerButton';

/** Playback only: no workspace/review/evidence service is imported or called. */
export default function SavedItemAudio({ text }: { readonly text: string }) {
  const controller = useRef<TTSController | null>(null);
  const generation = useRef(0);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState(false);
  const stop = useCallback(() => {
    generation.current += 1;
    controller.current?.invalidate();
    setSpeaking(false);
  }, []);
  useVoiceAppStateGuard({ invalidate: stop });
  useFocusEffect(useCallback(() => () => stop(), [stop]));
  useEffect(() => {
    const owned = new TTSController(createExpoTTSProvider());
    controller.current = owned;
    return () => {
      generation.current += 1;
      controller.current = null;
      void owned.dispose();
    };
  }, [text]);

  const play = async () => {
    if (!controller.current || speaking) return;
    const token = ++generation.current;
    setError(false);
    setSpeaking(true);
    await controller.current.speak(text, { language: 'en', onError: () => {
      if (generation.current === token) setError(true);
    } });
    if (generation.current === token) setSpeaking(false);
  };
  return <View style={{ marginVertical: 8 }}>
    <LearnerButton accessibilityLabel={speaking ? 'Stop pronunciation playback' : `Hear ${text}`}
      accessibilityHint="Audio replay only; does not record practice or change review progress"
      onPress={speaking ? stop : () => void play()}>
      <Text style={{ color: '#2563EB', fontSize: 16 }}>{speaking ? 'Stop audio' : 'Hear pronunciation'}</Text>
    </LearnerButton>
    <Text accessibilityLiveRegion="polite">{error ? 'Audio is unavailable. You can try again; your saved item is unchanged.' : speaking ? 'Playing audio…' : 'Listening only — this does not count as practice.'}</Text>
  </View>;
}
