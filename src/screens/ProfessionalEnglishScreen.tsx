import TouchableOpacity from './components/LearnerButton';
/**
 * src/screens/ProfessionalEnglishScreen.tsx
 *
 * Professional English — scenario/content entry point.
 *
 * This screen is a CONTENT LAYER only:
 * - The learner picks a category and reads the deterministic scenario plan.
 * - "Start professional practice" navigates into the EXISTING Deep Speaking
 *   experience. There is no chat, microphone or voice UI here.
 *
 * Personalization uses REAL learner context through the existing learner
 * model. Profession is never invented. The "Personalized" label appears only
 * when planner notes describe a material plan change.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';

import { resolveTalkCoaching } from '../talk-demo';
import {
  SCENARIO_CATEGORIES,
  planProfessionalScenario,
  toProfessionalLearnerContext,
  toSpeakingPlannerOptions,
  type ProfessionalLearnerContext,
  type ScenarioCategory,
  type ScenarioPlan,
} from '../professional-english';

export interface ProfessionalEnglishScreenProps {
  /** Injectable learner-context loader (tests). Defaults to persisted coaching. */
  readonly loadLearnerContext?: () => Promise<ProfessionalLearnerContext | null>;
}

const CATEGORY_LABELS: Readonly<Record<ScenarioCategory, string>> = {
  meeting: 'Meeting',
  project_update: 'Project update',
  presentation: 'Presentation',
  interview: 'Interview',
  negotiation: 'Negotiation',
  client_discussion: 'Client discussion',
  stakeholder_discussion: 'Stakeholder discussion',
  problem_solving: 'Problem solving',
  reporting: 'Reporting',
  email_discussion: 'Email discussion',
  site_discussion: 'Site discussion',
  claim_discussion: 'Claim discussion',
  contract_discussion: 'Contract discussion',
  technical_explanation: 'Technical explanation',
  leadership_conversation: 'Leadership conversation',
};

const PRACTICE_TYPE_LABELS: Readonly<Record<ScenarioPlan['practiceType'], string>> = {
  guided_dialogue: 'Guided dialogue',
  role_play: 'Role play',
  structured_exchange: 'Structured exchange',
  open_discussion: 'Open discussion',
  simulated_call: 'Simulated call',
  prepared_monologue: 'Prepared monologue',
  question_and_answer: 'Question and answer',
};

async function loadPersistedLearnerContext(): Promise<ProfessionalLearnerContext | null> {
  try {
    const resolved = await resolveTalkCoaching();
    if (resolved.source !== 'persisted' || !resolved.learnerModel) return null;
    const coaching = resolved.learnerModel.getCoachingContext();
    return toProfessionalLearnerContext(coaching);
  } catch {
    return null;
  }
}

function notesShowMaterialPersonalization(notes: readonly string[]): boolean {
  return notes.some(
    (note) =>
      /difficulty set/i.test(note) ||
      /reordered/i.test(note) ||
      /coaching mode/i.test(note) ||
      /prioritised/i.test(note) ||
      /prioritized/i.test(note),
  );
}

export default function ProfessionalEnglishScreen(props?: ProfessionalEnglishScreenProps) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const loadLearnerContext = props?.loadLearnerContext ?? loadPersistedLearnerContext;

  const [selectedCategory, setSelectedCategory] = useState<ScenarioCategory>('meeting');
  const [learnerContext, setLearnerContext] = useState<ProfessionalLearnerContext | null>(null);
  const [contextLoading, setContextLoading] = useState<boolean>(true);

  const startingRef = useRef<boolean>(false);
  const selectedCategoryRef = useRef<ScenarioCategory>(selectedCategory);
  const unmountedRef = useRef<boolean>(false);
  const loadTokenRef = useRef<number>(0);

  selectedCategoryRef.current = selectedCategory;

  useFocusEffect(
    useCallback(() => {
      startingRef.current = false;
      const token = (loadTokenRef.current += 1);
      unmountedRef.current = false;
      setContextLoading(true);
      void (async () => {
        const context = await loadLearnerContext();
        if (unmountedRef.current || loadTokenRef.current !== token) return;
        setLearnerContext(context);
        setContextLoading(false);
      })();
      return () => {
        startingRef.current = false;
        loadTokenRef.current += 1;
      };
    }, [loadLearnerContext]),
  );

  const plan = useMemo(
    () => planProfessionalScenario(selectedCategory, learnerContext),
    [selectedCategory, learnerContext],
  );

  const showPersonalized = notesShowMaterialPersonalization(plan.personalizationNotes);

  const handleSelectCategory = (category: ScenarioCategory): void => {
    selectedCategoryRef.current = category;
    setSelectedCategory(category);
  };

  const handleStart = (): void => {
    // Synchronous double-tap / stale-start guards. Navigation is sync, so
    // the focus-cleanup of startingRef is enough to allow a later return.
    if (startingRef.current) return;
    const categoryAtPress = selectedCategoryRef.current;
    if (categoryAtPress !== selectedCategory) return;
    startingRef.current = true;
    const options = toSpeakingPlannerOptions(plan);
    navigation.navigate('DeepSpeaking', {
      practiceType: options.practiceType,
      professionalScenario: options.professionalScenario,
    });
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Professional English</Text>
      <Text style={styles.subtitle}>
        Choose a workplace scenario. Practice runs in the existing speaking coach — this
        screen does not start a second conversation.
      </Text>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Category</Text>
        <View style={styles.chipWrap}>
          {SCENARIO_CATEGORIES.map((category) => {
            const selected = category === selectedCategory;
            return (
              <TouchableOpacity
                key={category}
                style={[styles.chip, selected ? styles.chipSelected : null]}
                onPress={() => handleSelectCategory(category)}
              >
                <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>
                  {CATEGORY_LABELS[category]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{plan.title}</Text>
          {showPersonalized ? (
            <View style={styles.pillPersonal}>
              <Text style={styles.pillText}>Personalized</Text>
            </View>
          ) : (
            <View style={styles.pill}>
              <Text style={styles.pillText}>General practice</Text>
            </View>
          )}
        </View>
        <Text style={styles.body}>{plan.situation}</Text>
        <Text style={styles.listLine}>Your role: {plan.learnerRole}</Text>
        <Text style={styles.listLine}>Tutor role: {plan.counterpartyRole}</Text>
        <Text style={styles.listLine}>Objective: {plan.objective}</Text>
        <Text style={styles.listLine}>
          Difficulty: {plan.difficulty} — {plan.difficultyDescriptor.reasoning}
        </Text>
        <Text style={styles.listLine}>Practice type: {PRACTICE_TYPE_LABELS[plan.practiceType]}</Text>
      </View>

      {plan.speakingGoals.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Speaking goals</Text>
          {plan.speakingGoals.map((goal) => (
            <Text key={goal.id} style={styles.listLine}>
              • {goal.description}
            </Text>
          ))}
        </View>
      ) : null}

      {plan.targetExpressions.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Target expressions</Text>
          {plan.targetExpressions.map((expression) => (
            <Text key={expression} style={styles.listLine}>
              • {expression}
            </Text>
          ))}
          <Text style={styles.sizeNote}>
            Scenario practice language — not saved to your vocabulary.
          </Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Practice context</Text>
        {contextLoading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator />
            <Text style={styles.body}>Loading your learning context…</Text>
          </View>
        ) : learnerContext ? (
          <Text style={styles.body}>
            Using your stored learning goals and active difficulties when they change this
            scenario. Profession is not assumed.
          </Text>
        ) : (
          <Text style={styles.body}>
            General professional practice — no stored learner context is available.
          </Text>
        )}
        {plan.professionalContext ? (
          <Text style={styles.listLine}>Professional background: {plan.professionalContext}</Text>
        ) : null}
        <Text style={styles.listLine}>Coaching posture: {plan.coachingMode}</Text>
        {plan.personalizationNotes.map((note) => (
          <Text key={note} style={styles.sizeNote}>
            {note}
          </Text>
        ))}
      </View>

      <TouchableOpacity style={styles.primaryButton} onPress={handleStart}>
        <Text style={styles.primaryButtonText}>Start professional practice</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F7F8FA' },
  content: { padding: 16, paddingBottom: 32 },
  title: { fontSize: 24, fontWeight: '800', color: '#111827', letterSpacing: -0.5, marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#6B7280', marginBottom: 16 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
        borderWidth: 1,
    borderColor: '#F3F4F6',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 8,
  },
  cardTitle: { fontSize: 18, fontWeight: '700', color: '#111827', flex: 1 },
  sectionTitle: { fontSize: 12, fontWeight: '700', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  body: { fontSize: 14, color: '#374151', marginBottom: 8 },
  listLine: { fontSize: 14, color: '#374151', marginBottom: 4 },
  sizeNote: { fontSize: 12, color: '#9CA3AF', marginTop: 4 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#F9FAFB',
  },
  chipSelected: { backgroundColor: '#2563EB', borderColor: '#2563EB' },
  chipText: { fontSize: 13, color: '#374151', fontWeight: '600' },
  chipTextSelected: { color: '#fff' },
  pill: {
    backgroundColor: '#F3F4F6',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillPersonal: {
    backgroundColor: '#D1FAE5',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillText: { fontSize: 12, color: '#374151', fontWeight: '600' },
  primaryButton: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 5,
  },
  primaryButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
