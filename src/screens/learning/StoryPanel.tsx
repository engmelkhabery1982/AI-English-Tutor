import { useFocusEffect } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { View, Text, Button, TextInput, AppState } from 'react-native';
import type { LearningTools } from '../../lessons/composition';
import type { StoryLesson, LessonMode } from '../../lessons/types';
import type { InspectionInput } from '../../dictionary/inspector';
import { READ_ALOUD_LIMITATION } from '../../lessons/read-aloud';

export default function StoryPanel({ tools, lesson, mode, inspect }: { tools: LearningTools; lesson: StoryLesson; mode: LessonMode; inspect: (input: InspectionInput) => void }) {
  const [, redraw] = useReducer(n => n + 1, 0);
  const session = useMemo(() => tools.openLesson(lesson, mode, redraw), [tools, lesson, mode]);
  const readAloud = useMemo(() => tools.readAloud(lesson), [tools, lesson]);
  const [selected, setSelected] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => { if (state !== 'active') { session.stop(); readAloud.reset(); redraw(); } });
    return () => { session.dispose(); readAloud.dispose(); sub.remove(); };
  }, [session, readAloud]);
  useFocusEffect(useCallback(() => () => { session.stop(); readAloud.reset(); }, [session, readAloud]));
  const state = session.snapshot(), voice = readAloud.voice.getStatus();
  return <View style={{ gap: 10 }}>
    <Text>{lesson.title} · {mode}</Text><Text>{lesson.difficultyIntent}</Text>
    <Text>{lesson.provenance.kind === 'curated' ? 'Built-in authored starter' : `Provider-generated lesson · ${lesson.provenance.providerId}`}</Text>
    {mode === 'listening' && <>
      <Button title={state.assistance.plays ? 'Replay' : 'Play listening passage'} onPress={() => void session.play()} />
      <Button title="Play slower / repeat" disabled={!session.supportsSlower} onPress={() => void session.play(true)} />
      {!session.supportsSlower && <Text>This voice does not support slower playback.</Text>}
      <Button title="Stop audio" onPress={() => session.stop()} /><Text>Playback: {state.playback}</Text>
      <Button title={state.transcriptVisible ? 'Hide transcript' : 'Reveal transcript (assistance)'} onPress={() => session.reveal(!state.transcriptVisible)} />
    </>}
    {state.transcriptVisible && <Text selectable>{lesson.passage}</Text>}
    {mode === 'reading' && <Button title="I have read the passage" onPress={() => void session.expose().then(() => setNote('Reading interaction saved — not a comprehension result.')).catch(() => setNote('Could not save reading activity. Retry.'))} />}
    {state.pendingAnswer && <Text>Pending answer: {state.pendingAnswer.answer}. Retry this same choice to save safely.</Text>}
    <Text>Assistance never counts as comprehension. Only submitted answers are evidence.</Text>
    {lesson.questions.map(question => {
      const answer = state.answers.find(a => a.questionId === question.id);
      return <View key={question.id} style={{ gap: 6 }}><Text>{question.prompt}</Text>
        {answer ? <><Text>{answer.evaluation.feedbackLines.join('\n')}</Text><Text>{answer.assisted ? 'Answered with assistance' : 'Answer recorded'}</Text></> : question.options.map(option => <Button key={option} title={option} disabled={busy || Boolean(state.pendingAnswer && (state.pendingAnswer.questionId !== question.id || state.pendingAnswer.answer !== option))} onPress={() => { setBusy(true); void session.answer(question.id, option).finally(() => setBusy(false)); }} />)}
      </View>;
    })}
    <Button title={state.completed ? 'Lesson completed' : 'Complete lesson'} disabled={state.completed || state.answers.length !== lesson.questions.length || busy} onPress={() => { setBusy(true); void session.complete().finally(() => setBusy(false)); }} />
    {state.error && <Text accessibilityRole="alert">{state.error}</Text>}
    <Button title={state.languageVisible ? "Hide contextual language" : "Show contextual language (assistance)"} onPress={() => session.revealLanguage(!state.languageVisible)} />
    {state.languageVisible && lesson.language.map((item, index) => <View key={item.text} style={{ gap: 4 }}><Text>{item.text} — {item.meaning}</Text>
      <Button title={`Inspect “${item.text}”`} onPress={() => inspect(session.inspection(item.text, tools.profile?.nativeLanguage ?? 'Arabic'))} />
      <Button title={`Save “${item.text}” to Review`} onPress={() => void session.saveLanguage(index).then(result => setNote(result.ok ? result.duplicate ? 'Already saved; existing review unchanged.' : 'Saved for review, not learned.' : 'Could not save. Retry.'))} />
    </View>)}
    <TextInput accessibilityLabel="Unknown language from passage" placeholder="Type/paste unknown words from this passage" value={selected} onChangeText={setSelected} style={{ borderWidth: 1, padding: 8 }} />
    <Button title="Inspect / translate selected language" disabled={!selected.trim() || !lesson.passage.includes(selected)} onPress={() => inspect(session.inspection(selected, tools.profile?.nativeLanguage ?? 'Arabic'))} />
    {mode === 'reading' && <View style={{ gap: 8 }}>
      <Text>Read aloud</Text><Text>{READ_ALOUD_LIMITATION}</Text>
      <Button title={voice.isRecording ? 'Stop and transcribe' : 'Record this passage'} disabled={voiceBusy || voice.isBusy || !voice.isAvailable} onPress={() => { session.stop(); setVoiceBusy(true); void readAloud.toggleRecording().finally(() => { setVoiceBusy(false); redraw(); }); }} />
      {!voice.isAvailable && <Text>Speech recognition needs a provider configured in Settings. No scripted transcript is used.</Text>}
      {!!voice.transcript && <Text>Recognized transcript: {voice.transcript}</Text>}
      <Button title="Compare transcript with target" disabled={voiceBusy || !voice.transcript || voice.isRecording} onPress={() => { setVoiceBusy(true); void readAloud.compare().finally(() => { setVoiceBusy(false); redraw(); }); }} />
      {readAloud.feedback?.lines.map(line => <Text key={line}>{line}</Text>)}
      {readAloud.error && <Text accessibilityRole="alert">{readAloud.error}</Text>}
      <Button title="Retry read-aloud" onPress={() => { readAloud.reset(); redraw(); }} />
    </View>}
    {!!note && <Text accessibilityLiveRegion="polite">{note}</Text>}
  </View>;
}
