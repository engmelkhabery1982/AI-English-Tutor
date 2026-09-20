/** Minimal functional entry points. Bolt may replace presentation; domain services own rules. */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Button, TextInput, ScrollView, ActivityIndicator } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NavigationProp } from '@react-navigation/native';
import type { RootStackParamList } from '../navigation/routes';
import { createLearningTools, type LearningTools } from '../lessons/composition';
import { STARTER_LESSONS, starterForLevel } from '../lessons/catalogue';
import { generateStoryLesson } from '../lessons/generation';
import type { LessonLevel, LessonMode, StoryLesson } from '../lessons/types';
import type { InspectionInput } from '../dictionary/inspector';
import type { NextFocusSummary, NextPracticeType } from '../adaptive-lessons/next-focus';
import type { ProviderFailure } from '../providers/failures';
import { canLearnerRetry } from '../shared/safe-retry';
import InspectorPanel from './learning/InspectorPanel';
import StoryPanel from './learning/StoryPanel';

export default function LearningToolsScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const [tools, setTools] = useState<LearningTools | null>(null);
  const [error, setError] = useState('');
  const [section, setSection] = useState<'inspector' | LessonMode>('inspector');
  const [lesson, setLesson] = useState<StoryLesson | null>(null);
  const [inspection, setInspection] = useState<InspectionInput | undefined>();
  const [level, setLevel] = useState<LessonLevel>('A1');
  const [topic, setTopic] = useState('Everyday life');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ProviderFailure | null>(null);
  const [summary, setSummary] = useState<NextFocusSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const toolsReady = useRef(false);
  const generation = useRef(0), generating = useRef(false), mounted = useRef(true);
  const load = useCallback(async () => {
    const gen = ++generation.current; setLoading(true); setError('');
    try {
      const value = await createLearningTools();
      if (!mounted.current || gen !== generation.current) return;
      toolsReady.current = true; setTools(value); setLevel(starterForLevel(value.profile?.currentLevel ?? 'A1').level);
      if (value.profile) {
        const next = await value.nextFocus.load();
        if (mounted.current && gen === generation.current) setSummary(next);
      }
    } catch { if (mounted.current && gen === generation.current) setError('Could not load learning tools. Your stored learning data is unchanged. Retry loading.'); }
    finally { if (mounted.current && gen === generation.current) setLoading(false); }
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++generation.current; }; }, []);
  useFocusEffect(useCallback(() => {
    if (!toolsReady.current) void load();
    return () => { ++generation.current; generating.current = false; setBusy(false); setLoading(false); };
  }, [load]));
  const generate = async () => {
    if (!tools || generating.current) return;
    const gen = ++generation.current; generating.current = true; setBusy(true); setFailure(null);
    const result = await generateStoryLesson(tools.provider, { topic, level }, () => !mounted.current || gen !== generation.current);
    if (!mounted.current || gen !== generation.current) return;
    generating.current = false; setBusy(false);
    if (result.ok) { setLesson(result.value); setInspection(undefined); } else setFailure(result.failure);
  };
  const openRecommendation = (type: NextPracticeType) => {
    if (type === 'reading' || type === 'listening') { setSection(type); setLesson(starterForLevel(level)); }
    else if (type === 'read_aloud') { setSection('reading'); setLesson(starterForLevel(level)); }
    else if (type === 'shadowing') navigation.navigate('Shadowing');
    else if (type === 'conversation') navigation.navigate('MainTabs', { screen: 'Talk' });
    else navigation.navigate('MainTabs', { screen: 'Review' });
  };
  return <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
    <Text>Learning tools</Text>
    <Text>Functional learning workspace. Built-in stories work without AI; generated content and inspection require your configured provider.</Text>
    <Button title="Provider settings" onPress={() => navigation.navigate('MainTabs', { screen: 'Settings' })} />
    {loading && <ActivityIndicator />}
    {!!error && <Text accessibilityRole="alert">{error}</Text>}
    <Button title="Reload tools / refresh next focus" onPress={() => void load()} disabled={loading || busy} />
    {tools && <>
      {!tools.profile && <><Text>Create a learner profile to save language and lesson answers. Inspection is available without a profile.</Text><Button title="Create learner profile" onPress={() => navigation.navigate('Onboarding')} /></>}
      {summary && <View style={{ gap: 8 }}>
        <Text>Recommended next activity</Text>
        {summary.recommendations.map(item => <View key={item.type}><Text>{item.reason}</Text><Button title={`Start ${item.type.replace('_', ' ')}`} onPress={() => openRecommendation(item.type)} /></View>)}
        <Text>Due reviews: {summary.reviewBacklog} · Saved items awaiting practice: {summary.savedItemsAwaitingPractice}</Text>
        <Text>Needs more evidence: {summary.needsMoreEvidence.join(', ') || 'No limited-evidence flag in this recent window'}</Text>
        <Text>{summary.scope}</Text>
      </View>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{(['inspector','listening','reading'] as const).map(tab => <Button key={tab} title={tab === 'inspector' ? 'Inspector / translate / rephrase' : `${tab} lessons`} onPress={() => { ++generation.current; generating.current = false; setBusy(false); setSection(tab); setLesson(null); setInspection(undefined); setFailure(null); }} />)}</View>
      {section === 'inspector' ? <InspectorPanel tools={tools} /> : <>
        <Text>Content difficulty: {level}. This does not change your assessed level.</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{STARTER_LESSONS.map(item => <Button key={item.id} title={item.level} disabled={busy} onPress={() => setLevel(item.level)} />)}</View>
        <Button title="Load built-in starter lesson" disabled={!tools.profile || busy} onPress={() => { setLesson(starterForLevel(level)); setInspection(undefined); setFailure(null); }} />
        <TextInput accessibilityLabel="Lesson topic" value={topic} maxLength={200} editable={!busy} onChangeText={setTopic} style={{ borderWidth: 1, padding: 8 }} />
        <Button title={busy ? 'Generating…' : 'Generate a new lesson'} disabled={busy || !tools.profile} onPress={() => void generate()} />
        {failure && <Text accessibilityRole="alert">{failure.message} Your topic and current lesson are kept. No demo content was substituted.</Text>}
        {canLearnerRetry(failure) && <Button title="Retry lesson generation" disabled={busy} onPress={() => void generate()} />}
        {lesson && tools.profile && <StoryPanel key={`${lesson.id}:${section}`} tools={tools} lesson={lesson} mode={section} inspect={setInspection} />}
        {inspection && <InspectorPanel tools={tools} initial={inspection} />}
      </>}
    </>}
  </ScrollView>;
}
