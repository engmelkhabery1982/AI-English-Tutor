import TouchableOpacity from './components/LearnerButton';
/**
 * src/screens/LearningToolsScreen.tsx
 *
 * Learning tools hub — language inspector + shared reading/listening lessons.
 * Visual redesign on top of the WO3 functional entry points.
 *
 * DOMAIN OWNERSHIP UNCHANGED:
 * - `createLearningTools` owns composition (profile, providers, save, next focus).
 * - `generateStoryLesson` owns provider generation + failure classification.
 * - `starterForLevel` / `STARTER_LESSONS` own the built-in catalogue.
 * - This screen only presents; it never evaluates, persists or invents content.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
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
import { theme } from './components/ui/theme';
import { AppHeader } from './components/ui/AppHeader';
import { SectionHeader } from './components/ui/SectionHeader';
import { SegmentedControl } from './components/ui/Pill';
import { ErrorState, LoadingState } from './components/ui/States';

const LOAD_ERROR =
  'Could not load learning tools. Your stored learning data is unchanged. Retry loading.';

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
    } catch { if (mounted.current && gen === generation.current) setError(LOAD_ERROR); }
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
  const switchSection = (key: string) => {
    ++generation.current; generating.current = false; setBusy(false);
    setSection(key as 'inspector' | LessonMode);
    setLesson(null); setInspection(undefined); setFailure(null);
  };
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      <AppHeader title="Learning tools" subtitle="Dictionary & Translate · Listening · Reading — look up a word, phrase, expression, or sentence in context" />

      {loading ? (
        <LoadingState message="Preparing your learning tools…" />
      ) : !!error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : tools ? (
        <View style={styles.body}>
          <TouchableOpacity style={styles.linkRow} onPress={() => navigation.navigate('MainTabs', { screen: 'Settings' })} accessibilityRole="button" accessibilityLabel="Open provider settings">
            <Text style={styles.linkText}>Provider settings</Text>
          </TouchableOpacity>

          {!tools.profile && (
            <View style={styles.noticeCard}>
              <Text style={styles.noticeText}>
                Create a learner profile to save language and lesson answers. Inspection is available without a profile.
              </Text>
              <TouchableOpacity style={styles.primaryButton} onPress={() => navigation.navigate('Onboarding')} accessibilityRole="button">
                <Text style={styles.primaryButtonText}>Create learner profile</Text>
              </TouchableOpacity>
            </View>
          )}

          {summary && (
            <View>
              <SectionHeader title="Recommended next activity" />
              <View style={styles.card}>
                {summary.recommendations.map((item, index) => (
                  <View key={item.type}>
                    <TouchableOpacity
                      style={styles.recoRow}
                      onPress={() => openRecommendation(item.type)}
                      accessibilityRole="button"
                      accessibilityLabel={`Start ${item.type.replace(/_/g, ' ')}`}
                      accessibilityHint={item.reason}
                    >
                      <View style={styles.recoBody}>
                        <Text style={styles.recoType}>{item.type.replace(/_/g, ' ')}</Text>
                        <Text style={styles.recoReason}>{item.reason}</Text>
                      </View>
                      <Text style={styles.chevron}>›</Text>
                    </TouchableOpacity>
                    {index < summary.recommendations.length - 1 ? <View style={styles.divider} /> : null}
                  </View>
                ))}
                {summary.recommendations.length > 0 ? <View style={styles.divider} /> : null}
                <View style={styles.metaRow}>
                  <Text style={styles.metaLine}>Due reviews: {summary.reviewBacklog}</Text>
                  <Text style={styles.metaLine}>Awaiting practice: {summary.savedItemsAwaitingPractice}</Text>
                </View>
                <Text style={styles.metaLine}>
                  Needs more evidence: {summary.needsMoreEvidence.join(', ') || 'No limited-evidence flag in this recent window'}
                </Text>
                <Text style={styles.metaMuted}>{summary.scope}</Text>
              </View>
            </View>
          )}

          <SectionHeader title="Work area" subtitle="Built-in stories work without AI. Dictionary & Translate lookups and generated lessons use your configured provider (provider-generated explanations, not authoritative dictionary truth)." />
          <SegmentedControl
            options={[
              // Learner-facing name is "Dictionary & Translate"; the internal
              // section key stays 'inspector' (the domain module is unchanged).
              { key: 'inspector', label: 'Dictionary & Translate' },
              { key: 'listening', label: 'Listening' },
              { key: 'reading', label: 'Reading' },
            ]}
            selectedKey={section}
            onSelect={switchSection}
          />

          <View style={styles.sectionBody}>
            {section === 'inspector' ? (
              <InspectorPanel tools={tools} />
            ) : (
              <>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Content difficulty</Text>
                <Text style={styles.bodyText}>
                  {level} · This does not change your assessed level.
                </Text>
                <View style={styles.chipRow}>
                  {STARTER_LESSONS.map(item => {
                    const active = item.level === level;
                    return (
                      <TouchableOpacity
                        key={item.id}
                        style={[styles.chip, active && styles.chipActive]}
                        disabled={busy}
                        onPress={() => setLevel(item.level)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                      >
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>{item.level}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <TouchableOpacity
                  style={styles.secondaryButton}
                  disabled={!tools.profile || busy}
                  onPress={() => { setLesson(starterForLevel(level)); setInspection(undefined); setFailure(null); }}
                  accessibilityRole="button"
                >
                  <Text style={styles.secondaryButtonText}>Load built-in starter lesson</Text>
                </TouchableOpacity>
                <TextInput
                  accessibilityLabel="Lesson topic"
                  placeholder="Lesson topic"
                  value={topic}
                  maxLength={200}
                  editable={!busy}
                  onChangeText={setTopic}
                  style={styles.input}
                  placeholderTextColor={theme.colors.textTertiary}
                />
                <TouchableOpacity
                  style={styles.primaryButton}
                  disabled={busy || !tools.profile}
                  onPress={() => void generate()}
                  accessibilityRole="button"
                >
                  <Text style={styles.primaryButtonText}>{busy ? 'Generating…' : 'Generate a new lesson'}</Text>
                </TouchableOpacity>
                {failure && (
                  <Text style={styles.alertText} accessibilityRole="alert">
                    {failure.message} Your topic and current lesson are kept. No demo content was substituted.
                  </Text>
                )}
                {canLearnerRetry(failure) && (
                  <TouchableOpacity style={styles.secondaryButton} disabled={busy} onPress={() => void generate()} accessibilityRole="button">
                    <Text style={styles.secondaryButtonText}>Retry lesson generation</Text>
                  </TouchableOpacity>
                )}
              </View>

              {lesson && tools.profile && (
                <StoryPanel key={`${lesson.id}:${section}`} tools={tools} lesson={lesson} mode={section} inspect={setInspection} />
              )}
              {inspection && <InspectorPanel tools={tools} initial={inspection} />}
              </>
            )}

            <TouchableOpacity style={styles.ghostRow} onPress={() => void load()} accessibilityRole="button" accessibilityLabel="Reload tools and refresh next focus">
              <Text style={styles.linkText}>Reload tools / refresh next focus</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    paddingBottom: theme.spacing.xxxl,
  },
  body: {
    paddingHorizontal: theme.spacing.lg,
  },
  linkRow: {
    paddingVertical: theme.spacing.sm,
  },
  linkText: {
    fontSize: 13,
    color: theme.colors.primary,
    fontWeight: '600',
  },
  ghostRow: {
    alignItems: 'center',
    paddingVertical: theme.spacing.md,
  },
  noticeCard: {
    backgroundColor: theme.colors.primarySoft,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.primaryLight,
  },
  noticeText: {
    fontSize: 14,
    color: theme.colors.neutral[700],
    lineHeight: 21,
    marginBottom: theme.spacing.sm,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    ...theme.shadows.card,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: 4,
  },
  bodyText: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    lineHeight: 21,
    marginBottom: theme.spacing.md,
  },
  sectionBody: {
    marginTop: theme.spacing.md,
  },
  recoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
  },
  recoBody: {
    flex: 1,
  },
  recoType: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: 2,
  },
  recoReason: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    lineHeight: 19,
  },
  chevron: {
    fontSize: 22,
    color: theme.colors.neutral[300],
    marginLeft: theme.spacing.sm,
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.borderLight,
    marginVertical: 2,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.md,
    marginTop: theme.spacing.sm,
  },
  metaLine: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    marginTop: 4,
  },
  metaMuted: {
    fontSize: 12,
    color: theme.colors.textTertiary,
    marginTop: theme.spacing.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  chip: {
    backgroundColor: theme.colors.neutral[100],
    borderRadius: theme.radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipActive: {
    backgroundColor: theme.colors.primary,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.neutral[600],
  },
  chipTextActive: {
    color: theme.colors.white,
  },
  input: {
    backgroundColor: theme.colors.neutral[50],
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    fontSize: 14,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.md,
  },
  alertText: {
    fontSize: 13,
    color: theme.colors.error,
    lineHeight: 19,
    marginBottom: theme.spacing.md,
  },
  primaryButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: theme.spacing.xs,
    ...theme.shadows.primary,
  },
  primaryButtonText: {
    color: theme.colors.white,
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: theme.colors.primary,
    marginTop: theme.spacing.sm,
  },
  secondaryButtonText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
});
