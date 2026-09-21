import { SafeAreaView } from 'react-native-safe-area-context';
import { describeSaveSource } from '../learner-agency';
import SavedItemAudio from './components/SavedItemAudio';
import TouchableOpacity from './components/LearnerButton';
/**
 * src/screens/VocabularyScreen.tsx
 *
 * Vocabulary & Expressions Workspace.
 *
 * A real, user-visible workspace over the existing SQLite repositories:
 * browse every saved word and expression, see review state derived from
 * the authoritative `meaning.review`, search locally, inspect details,
 * edit user-maintainable content, delete with confirmation, and start
 * practice through the EXISTING Adaptive Review flow (Review tab).
 *
 * Real mode only: the screen shows the learner's actual persisted data
 * and never falls back to fabricated demo items.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ViewStyle } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';

import type { Meaning } from '../domain/shared/types';
import {
  createDefaultVocabularyWorkspaceService,
  EMPTY_WORKSPACE_SUMMARY,
  filterWorkspaceEntries,
  resolvePracticeAction,
  type PracticeDecision,
  type ReviewStateFilter,
  type VocabularyCategoryFilter,
  type WorkspaceEntry,
  type WorkspaceSnapshot,
  type WorkspaceSummary,
  type VocabularyWorkspaceService,
} from '../vocabulary-workspace';

interface VocabularyScreenProps {
  /** Injectable composition (defaults to the real SQLite composition). */
  readonly service?: VocabularyWorkspaceService;
}

const TYPE_LABELS: Record<string, string> = {
  word: 'Word',
  phrase: 'Phrase',
  phrasal_verb: 'Phrasal Verb',
  idiom: 'Idiom',
  common_expression: 'Common Expression',
  collocation: 'Collocation',
  linking_expression: 'Linking Expression',
  professional_expression: 'Professional Expression',
};

const CATEGORY_FILTERS: readonly { key: VocabularyCategoryFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'word', label: 'Words' },
  { key: 'phrase', label: 'Phrases' },
  { key: 'phrasal_verb', label: 'Phrasal Verbs' },
  { key: 'idiom', label: 'Idioms' },
  { key: 'common_expression', label: 'Common Expressions' },
  { key: 'collocation', label: 'Collocations' },
  { key: 'linking_expression', label: 'Linking Expressions' },
  { key: 'professional_expression', label: 'Professional Expressions' },
];

const REVIEW_STATE_FILTERS: readonly { key: ReviewStateFilter; label: string }[] = [
  { key: 'all', label: 'All states' },
  { key: 'due', label: 'Due' },
  { key: 'learning', label: 'Learning' },
  { key: 'familiar', label: 'Familiar' },
  { key: 'mastered', label: 'Mastered' },
];

const BUCKET_LABELS: Record<string, string> = {
  due: 'Due now',
  learning: 'Learning',
  familiar: 'Familiar',
  mastered: 'Mastered',
};

// Typed badge style lookup for review buckets (safe to read during render;
// assigned right after the StyleSheet below, before any render happens).
const BUCKET_BADGE_STYLES: Record<string, ViewStyle> = {};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function VocabularyScreen(props?: VocabularyScreenProps) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();

  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasNoProfile, setHasNoProfile] = useState<boolean>(false);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [practice, setPractice] = useState<PracticeDecision | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [category, setCategory] = useState<VocabularyCategoryFilter>('all');
  const [reviewState, setReviewState] = useState<ReviewStateFilter>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Details modal + edit state
  const [selectedEntry, setSelectedEntry] = useState<WorkspaceEntry | null>(null);
  const [pronunciationNotes, setPronunciationNotes] = useState<readonly string[]>([]);
  const [editMeaningIndex, setEditMeaningIndex] = useState<number | null>(null);
  const [newMeaningDefinition, setNewMeaningDefinition] = useState<string>('');
  const [isAddingMeaning, setIsAddingMeaning] = useState<boolean>(false);
  const [editDefinition, setEditDefinition] = useState<string>('');
  const [editExamples, setEditExamples] = useState<string[]>([]);
  const [isSavingEdit, setIsSavingEdit] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const serviceRef = useRef<VocabularyWorkspaceService | null>(props?.service ?? null);

  // Linked pronunciation notes (from the existing learner weaknesses) for
  // the details view. Read-only; never blocks the workspace.
  useEffect(() => {
    if (!selectedEntry) {
      setPronunciationNotes([]);
      return;
    }
    let active = true;
    serviceRef.current
      ?.getPronunciationNotes(selectedEntry)
      .then((notes) => {
        if (active) setPronunciationNotes(notes);
      })
      .catch(() => {
        if (active) setPronunciationNotes([]);
      });
    return () => {
      active = false;
    };
  }, [selectedEntry]);
  const initialLoadDoneRef = useRef<boolean>(false);

  useEffect(() => {
    let active = true;

    async function init() {
      if (serviceRef.current) {
        await loadWorkspace(false);
        return;
      }
      try {
        // Composition (adapter bootstrap, repositories, learner resolution)
        // lives behind the workspace factory — the screen owns no DB state.
        const service = await createDefaultVocabularyWorkspaceService();
        if (!active) return;
        serviceRef.current = service;

        if (active) {
          await loadWorkspace(false);
        }
      } catch (err) {
        console.error('Failed to initialize Vocabulary workspace:', err);
        if (active) {
          setLoadError('Local storage unavailable. Could not open your vocabulary workspace.');
          setLoading(false);
        }
      }
    }

    init();

    return () => {
      active = false;
    };
  }, []);

  // Refresh whenever the tab gains focus so items saved from Talk or
  // updated by the Review flow appear without any manual sync.
  useFocusEffect(
    useCallback(() => {
      if (initialLoadDoneRef.current && serviceRef.current) {
        loadWorkspace(true);
      }
    }, []),
  );

  const loadWorkspace = async (quiet: boolean) => {
    try {
      if (!serviceRef.current) serviceRef.current = await createDefaultVocabularyWorkspaceService();
      const service = serviceRef.current;
      if (quiet) {
        initialLoadDoneRef.current = true;
      } else {
        setLoading(true);
      }
      setLoadError(null);

      // Learner resolution goes through the service (existing profile
      // repository behind it) — never fabricated, null when no profile.
      const learnerId = await service.getActiveLearnerId();

      if (!learnerId) {
        setHasNoProfile(true);
        setSnapshot(null);
        setPractice(null);
        setLoading(false);
        initialLoadDoneRef.current = true;
        return;
      }
      setHasNoProfile(false);

      const nextSnapshot = await service.loadWorkspace(learnerId);
      const nextPractice = await service.getPracticeDecision(learnerId);

      setSnapshot(nextSnapshot);
      setPractice(nextPractice);
      setSelectedEntry((current) => {
        if (!current) return current;
        return nextSnapshot.entries.find((e) => e.id === current.id) ?? null;
      });
    } catch (err) {
      console.error('Error loading vocabulary workspace:', err);
      setLoadError('Could not load your vocabulary. Nothing was changed.');
    } finally {
      setLoading(false);
      initialLoadDoneRef.current = true;
    }
  };

  const filteredEntries = snapshot
    ? filterWorkspaceEntries(snapshot.entries, {
        category,
        reviewState,
        searchQuery,
      })
    : [];

  const summary: WorkspaceSummary = snapshot?.summary ?? EMPTY_WORKSPACE_SUMMARY;

  const handleRetry = () => {
    loadWorkspace(false);
  };

  const handleStartPractice = async () => {
    if (!practice || practice.status !== 'items-available') return;
    try {
      setActionError(null);
      // Reuse the EXISTING Adaptive Review flow (Review tab). Nothing is
      // marked reviewed by opening it; the Review screen owns that flow.
      navigation.navigate('Review');
    } catch (err) {
      console.error('Error opening Review tab:', err);
      setActionError('Could not open the Review screen. Nothing was marked as reviewed.');
    }
  };

  const openEditForMeaning = (meaningIndex: number, meaning: Meaning) => {
    setActionError(null);
    setEditMeaningIndex(meaningIndex);
    setEditDefinition(meaning.definition);
    setEditExamples((meaning.examples ?? []).map((example) => example.text));
  };

  const cancelEdit = () => {
    setEditMeaningIndex(null);
    setEditDefinition('');
    setEditExamples([]);
  };

  const handleSaveEdit = async () => {
    const service = serviceRef.current;
    const entry = selectedEntry;
    if (!service || !entry || editMeaningIndex === null || isSavingEdit) return;
    if (editDefinition.trim().length === 0) {
      setActionError('Definition cannot be empty.');
      return;
    }

    try {
      setIsSavingEdit(true);
      setActionError(null);
      await service.updateMeaningContent({
        entryId: entry.id,
        kind: entry.kind,
        meaningIndex: editMeaningIndex,
        definition: editDefinition,
        exampleTexts: editExamples,
      });
      cancelEdit();
      await loadWorkspace(true);
    } catch (err) {
      console.error('Error saving meaning edit:', err);
      // Keep edit mode open with the user's values; do not fake success.
      setActionError('Could not save your changes. Please try again.');
    } finally {
      setIsSavingEdit(false);
    }
  };

  /**
   * Add the FIRST meaning to an item saved without one (e.g. from
   * listening practice) through the existing workspace service — the item
   * id and all other data are preserved; review data starts cleanly.
   */
  const handleAddFirstMeaning = async () => {
    const service = serviceRef.current;
    const entry = selectedEntry;
    if (!service || !entry || isAddingMeaning) return;
    if (newMeaningDefinition.trim().length === 0) {
      setActionError('Definition cannot be empty.');
      return;
    }
    try {
      setIsAddingMeaning(true);
      setActionError(null);
      const updatedEntry = await service.addFirstMeaning({
        entryId: entry.id,
        kind: entry.kind,
        definition: newMeaningDefinition,
      });
      setNewMeaningDefinition('');
      setSelectedEntry(updatedEntry);
      await loadWorkspace(true);
    } catch {
      setActionError('Could not add the meaning. Please try again.');
    } finally {
      setIsAddingMeaning(false);
    }
  };

  const confirmDeleteEntry = () => {
    const entry = selectedEntry;
    if (!entry) return;
    Alert.alert(
      `Delete "${entry.title}"?`,
      'This permanently removes the item and its review history.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            handleDeleteEntry();
          },
        },
      ],
    );
  };

  const handleDeleteEntry = async () => {
    const service = serviceRef.current;
    const entry = selectedEntry;
    if (!service || !entry || isDeleting) return;
    try {
      setIsDeleting(true);
      setActionError(null);
      await service.deleteEntry({ entryId: entry.id, kind: entry.kind });
      setSelectedEntry(null);
      await loadWorkspace(true);
    } catch (err) {
      console.error('Error deleting vocabulary item:', err);
      setActionError('Could not delete this item. It is still saved.');
      await loadWorkspace(true);
    } finally {
      setIsDeleting(false);
    }
  };

  // ---------- RENDER HELPERS ----------

  const renderSummaryCard = () => (
    <View style={styles.summaryCard}>
      <View style={styles.summaryRow}>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{summary.totalSaved}</Text>
          <Text style={styles.statLabel}>Saved</Text>
        </View>
        <View style={[styles.statBox, styles.statBoxDue]}>
          <Text style={styles.statValue}>{summary.dueNow}</Text>
          <Text style={styles.statLabel}>Due now</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{summary.learning}</Text>
          <Text style={styles.statLabel}>Learning</Text>
        </View>
        <View style={[styles.statBox, styles.statBoxGood]}>
          <Text style={styles.statValue}>{summary.familiar}</Text>
          <Text style={styles.statLabel}>Familiar</Text>
        </View>
        <View style={[styles.statBox, styles.statBoxGood]}>
          <Text style={styles.statValue}>{summary.mastered}</Text>
          <Text style={styles.statLabel}>Mastered</Text>
        </View>
      </View>

      {practice &&
        resolvePracticeAction(practice) === 'navigate-review' &&
        practice.status === 'items-available' && (
        <TouchableOpacity
          style={styles.practiceButton}
          onPress={handleStartPractice}
          accessibilityRole="button"
          id="practice_due_items_button"
        >
          <Text style={styles.practiceButtonText}>
            ▶ Practice Now ({practice.itemCount} {practice.itemCount === 1 ? 'item' : 'items'})
          </Text>
        </TouchableOpacity>
      )}
      {practice && resolvePracticeAction(practice) === 'show-caught-up' && (
        <View style={styles.caughtUpCard} id="caught_up_card">
          <Text style={styles.caughtUpText}>🎉 You're caught up. Nothing to practice right now.</Text>
        </View>
      )}
      {actionError && (
        <View style={styles.actionErrorBanner} id="action_error_banner">
          <Text style={styles.actionErrorText}>⚠️ {actionError}</Text>
        </View>
      )}
    </View>
  );

  const renderFilters = () => (
    <View>
      <View style={styles.searchWrapper}>
        <TextInput
          style={styles.searchInput}
          accessibilityLabel="Search saved words, expressions, meanings and examples"
          placeholder="Search words, meanings, examples..."
          placeholderTextColor="#9CA3AF"
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCorrect={false}
          autoCapitalize="none"
          id="vocabulary_search_input"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity
            style={styles.searchClearButton}
            onPress={() => setSearchQuery('')}
            accessibilityRole="button"
            id="clear_search_button"
          >
            <Text style={styles.searchClearText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.filterSectionLabel}>Category</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
        {CATEGORY_FILTERS.map((filter) => (
          <TouchableOpacity
            key={filter.key}
            style={[styles.chip, category === filter.key && styles.chipActive]}
            onPress={() => setCategory(filter.key)}
            accessibilityRole="button"
          >
            <Text style={[styles.chipText, category === filter.key && styles.chipTextActive]}>
              {filter.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <Text style={styles.filterSectionLabel}>Review state</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
        {REVIEW_STATE_FILTERS.map((filter) => (
          <TouchableOpacity
            key={filter.key}
            style={[styles.chip, reviewState === filter.key && styles.chipActive]}
            onPress={() => setReviewState(filter.key)}
            accessibilityRole="button"
          >
            <Text style={[styles.chipText, reviewState === filter.key && styles.chipTextActive]}>
              {filter.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );

  const renderEmptyState = () => {
    if (hasNoProfile) {
      return (
        <View style={styles.emptyCard} id="no_profile_state">
          <Text style={styles.emptyCardEmoji}>👤</Text>
          <Text style={styles.emptyCardTitle}>No learner profile yet</Text>
          <Text style={styles.emptyCardText}>
            Save vocabulary from a Talk session first — words and expressions you pick up in
            conversation will appear here automatically.
          </Text>
        </View>
      );
    }
    if (!snapshot || snapshot.entries.length === 0) {
      return (
        <View style={styles.emptyCard} id="empty_workspace_state">
          <Text style={styles.emptyCardEmoji}>📚</Text>
          <Text style={styles.emptyCardTitle}>No vocabulary saved yet</Text>
          <Text style={styles.emptyCardText}>
            Words and expressions you save from conversations and review practice will appear here.
          </Text>
        </View>
      );
    }
    if (searchQuery.trim().length > 0) {
      return (
        <View style={styles.emptyCard} id="no_search_results_state">
          <Text style={styles.emptyCardEmoji}>🔍</Text>
          <Text style={styles.emptyCardTitle}>No matches</Text>
          <Text style={styles.emptyCardText}>Nothing matches "{searchQuery.trim()}".</Text>
        </View>
      );
    }
    return (
      <View style={styles.emptyCard} id="no_filtered_items_state">
        <Text style={styles.emptyCardEmoji}>🗂️</Text>
        <Text style={styles.emptyCardTitle}>Nothing here</Text>
        <Text style={styles.emptyCardText}>No items match the selected category and review state.</Text>
      </View>
    );
  };

  const renderItem = ({ item }: { item: WorkspaceEntry }) => (
    <TouchableOpacity
      style={styles.itemCard}
      onPress={() => {
        setActionError(null);
        setSelectedEntry(item);
      }}
      accessibilityRole="button"
      id={`vocab_item_${item.id}`}
    >
      <View style={styles.itemCardHeader}>
        <Text style={styles.itemTitle}>{item.title}</Text>
        <View style={[styles.bucketBadge, BUCKET_BADGE_STYLES[item.reviewBucket] ?? styles.bucketBadge_learning]}>
          <Text style={styles.bucketBadgeText}>{BUCKET_LABELS[item.reviewBucket] ?? item.reviewBucket}</Text>
        </View>
      </View>
      <Text style={styles.itemTypeLabel}>{TYPE_LABELS[item.type] ?? item.type}</Text>
      {!!item.primaryMeaning && <Text style={styles.itemMeaning} numberOfLines={2}>{item.primaryMeaning}</Text>}
      <Text style={styles.itemMeta}>
        {item.nextReviewAt
          ? item.reviewBucket === 'due'
            ? 'Review was due ' + formatDate(item.nextReviewAt)
            : 'Next review: ' + formatDate(item.nextReviewAt)
          : 'Not scheduled for review yet'}
        {item.meaningCount > 1 ? ` • ${item.meaningCount} meanings` : ''}
      </Text>
    </TouchableOpacity>
  );

  const renderMeaningBlock = (meaning: Meaning, index: number) => {
    const isEditing = editMeaningIndex === index;
    return (
      <View key={index} style={styles.meaningBlock}>
        <View style={styles.meaningHeader}>
          {meaning.partOfSpeech && (
            <View style={styles.posBadge}>
              <Text style={styles.posBadgeText}>{meaning.partOfSpeech}</Text>
            </View>
          )}
          {!isEditing && (
            <TouchableOpacity
              style={styles.editMeaningButton}
              onPress={() => openEditForMeaning(index, meaning)}
              accessibilityRole="button"
              id={`edit_meaning_button_${index}`}
            >
              <Text style={styles.editMeaningButtonText}>Edit</Text>
            </TouchableOpacity>
          )}
        </View>

        {isEditing ? (
          <View style={styles.editBlock}>
            <Text style={styles.editFieldLabel}>Definition</Text>
            <TextInput accessibilityLabel="Saved definition"
              style={styles.editInput}
              value={editDefinition}
              onChangeText={setEditDefinition}
              multiline
              id="edit_definition_input"
            />
            <Text style={styles.editFieldLabel}>Examples</Text>
            {editExamples.map((exampleText, exampleIndex) => (
              <View key={exampleIndex} style={styles.editExampleRow}>
                <TextInput accessibilityLabel="Saved example"
                  style={[styles.editInput, styles.editExampleInput]}
                  value={exampleText}
                  onChangeText={(text) => {
                    setEditExamples((prev) => prev.map((t, i) => (i === exampleIndex ? text : t)));
                  }}
                  multiline
                  id={`edit_example_input_${exampleIndex}`}
                />
                <TouchableOpacity
                  style={styles.removeExampleButton}
                  onPress={() => {
                    setEditExamples((prev) => prev.filter((_, i) => i !== exampleIndex));
                  }}
                  accessibilityRole="button"
                >
                  <Text style={styles.removeExampleText}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity
              style={styles.addExampleButton}
              onPress={() => setEditExamples((prev) => [...prev, ''])}
              accessibilityRole="button"
              id="add_example_button"
            >
              <Text style={styles.addExampleText}>+ Add example</Text>
            </TouchableOpacity>

            <View style={styles.editActionsRow}>
              <TouchableOpacity
                style={[styles.editActionButton, styles.editSaveButton]}
                onPress={handleSaveEdit}
                disabled={isSavingEdit}
                accessibilityRole="button"
                id="save_edit_button"
              >
                {isSavingEdit ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.editSaveButtonText}>Save</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.editActionButton, styles.editCancelButton]}
                onPress={cancelEdit}
                accessibilityRole="button"
                id="cancel_edit_button"
              >
                <Text style={styles.editCancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View>
            <Text style={styles.meaningDefinition}>{meaning.definition}</Text>
            {(meaning.examples ?? []).map((example, exampleIndex) => (
              <View key={exampleIndex} style={styles.exampleRow}>
                <Text style={styles.exampleText}>“{example.text}”</Text>
                <Text style={styles.exampleSource}>
                  {example.source === 'original-conversation'
                    ? 'from your conversation'
                    : example.source === 'learner-created'
                      ? 'added by you'
                      : example.source.replace(/-/g, ' ')}
                </Text>
              </View>
            ))}
            <View style={styles.reviewDataBox}>
              {meaning.review ? (
                <Text style={styles.reviewDataText}>
                  {meaningStateLabel(meaning.review.state)} · Reviews:{' '}
                  {meaning.review.reviewCount} · Streak: {meaning.review.consecutiveCorrect}
                  {meaning.review.nextReviewAt
                    ? ` · Next: ${formatDate(meaning.review.nextReviewAt)}`
                    : ''}
                </Text>
              ) : (
                <Text style={styles.reviewDataText}>Not scheduled for review yet</Text>
              )}
            </View>
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title} id="vocabulary_title">
          Vocabulary &amp; Expressions
        </Text>
        <Text style={styles.subtitle}>Everything you've saved, in one place</Text>
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#2563EB" />
          <Text style={styles.loadingText}>Loading your vocabulary...</Text>
        </View>
      ) : loadError ? (
        <View style={styles.errorContainer} id="load_error_state">
          <Text style={styles.errorText}>⚠️ {loadError}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={handleRetry} accessibilityRole="button" id="retry_load_button">
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          style={styles.list}
          contentContainerStyle={styles.listContent}
          data={filteredEntries}
          keyExtractor={(entry) => entry.id}
          ListHeaderComponent={
            <>
              {renderSummaryCard()}
              {renderFilters()}
              {!hasNoProfile && snapshot && snapshot.entries.length > 0 && (
                <Text style={styles.resultCountText}>
                  {filteredEntries.length} of {snapshot.entries.length}{' '}
                  {snapshot.entries.length === 1 ? 'item' : 'items'}
                </Text>
              )}
            </>
          }
          renderItem={renderItem}
          ListEmptyComponent={renderEmptyState()}
        />
      )}

      {/* ---------- ITEM DETAILS MODAL ---------- */}
      <Modal
        visible={selectedEntry !== null}
        animationType="slide"
        onRequestClose={() => {
          setSelectedEntry(null);
          cancelEdit();
        }}
      >
        {selectedEntry && (
          <SafeAreaView style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <TouchableOpacity
                style={styles.modalCloseButton}
                onPress={() => {
                  setSelectedEntry(null);
                  cancelEdit();
                }}
                accessibilityRole="button"
                id="close_details_button"
              >
                <Text style={styles.modalCloseText}>✕ Close</Text>
              </TouchableOpacity>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={styles.modalContent}>
              <Text style={styles.detailTitle}>{selectedEntry.title}</Text>
              <SavedItemAudio key={selectedEntry.id} text={selectedEntry.title} />
              <View style={styles.detailBadgesRow}>
                <View style={styles.typeBadge}>
                  <Text style={styles.typeBadgeText}>
                    {TYPE_LABELS[selectedEntry.type] ?? selectedEntry.type}
                  </Text>
                </View>
                <View style={[styles.bucketBadge, BUCKET_BADGE_STYLES[selectedEntry.reviewBucket] ?? styles.bucketBadge_learning]}>
                  <Text style={styles.bucketBadgeText}>
                    {BUCKET_LABELS[selectedEntry.reviewBucket] ?? selectedEntry.reviewBucket}
                  </Text>
                </View>
              </View>

              <Text style={styles.detailMeta}>
                Added {formatDate(selectedEntry.createdAt)} ·{' '}
                {describeSaveSource(selectedEntry.saveSource).label}
                {selectedEntry.saveOrigin ? ` (${selectedEntry.saveOrigin.replace(/_/g, ' ')})` : ''}
                {selectedEntry.containsGeneratedText ? ' · includes AI-generated text' : ''}
                {selectedEntry.nextReviewAt
                  ? ` · Next review: ${formatDate(selectedEntry.nextReviewAt)}`
                  : ''}
              </Text>
              {selectedEntry.contextSentence ? (
                <Text style={styles.detailMeta}>In context: “{selectedEntry.contextSentence}”</Text>
              ) : null}

              {pronunciationNotes.length > 0 && (
                <View style={styles.pronunciationNotesBox}>
                  <Text style={styles.detailSectionLabel}>Pronunciation notes</Text>
                  {pronunciationNotes.map((note, index) => (
                    <Text key={index} style={styles.pronunciationNoteLine}>
                      • {note}
                    </Text>
                  ))}
                </View>
              )}

              <Text style={styles.detailSectionLabel}>
                Meanings ({selectedEntry.meaningCount})
              </Text>
              {selectedEntry.meaningCount === 0 ? (
                <View style={styles.addMeaningBlock}>
                  <Text style={styles.addMeaningHint}>
                    This item has no definition yet (saved without one). Add the first real
                    meaning — review tracking starts fresh once you do.
                  </Text>
                  <TextInput accessibilityLabel="New meaning definition"
                    style={styles.editInput}
                    placeholder="Type a definition…"
                    placeholderTextColor="#9CA3AF"
                    value={newMeaningDefinition}
                    onChangeText={setNewMeaningDefinition}
                    multiline
                    testID="add_first_meaning_input"
                  />
                  <TouchableOpacity
                    style={[
                      styles.editActionButton,
                      styles.editSaveButton,
                      newMeaningDefinition.trim().length === 0 && styles.editSaveDisabled,
                    ]}
                    onPress={handleAddFirstMeaning}
                    disabled={newMeaningDefinition.trim().length === 0 || isAddingMeaning}
                    testID="add_first_meaning_button"
                    accessibilityRole="button"
                    accessibilityLabel="Add first meaning"
                  >
                    <Text style={styles.editSaveButtonText}>
                      {isAddingMeaning ? 'Saving…' : 'Add meaning'}
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : (
                (selectedEntry.item.meanings ?? []).map((meaning, index) =>
                  renderMeaningBlock(meaning, index),
                )
              )}

              <TouchableOpacity
                style={styles.deleteButton}
                onPress={confirmDeleteEntry}
                disabled={isDeleting}
                accessibilityRole="button"
                id="delete_item_button"
              >
                {isDeleting ? (
                  <ActivityIndicator size="small" color="#DC2626" />
                ) : (
                  <Text style={styles.deleteButtonText}>Delete this item</Text>
                )}
              </TouchableOpacity>
            </ScrollView>
          </SafeAreaView>
        )}
      </Modal>
    </View>
  );
}

/** Map persisted MeaningReview.state to an honest display label. */
function meaningStateLabel(state: string): string {
  const labels: Record<string, string> = {
    new: 'New',
    learning: 'Learning',
    familiar: 'Familiar',
    mastered: 'Mastered',
    struggling: 'Struggling',
    retired: 'Retired',
  };
  return labels[state] ?? state;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F7F8FA',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#111827',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 13,
    color: '#6B7280',
    marginTop: 2,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#6B7280',
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  errorText: {
    fontSize: 14,
    color: '#DC2626',
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 20,
    paddingBottom: 40,
  },
  summaryCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#F3F4F6',
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  summaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 6,
  },
  statBox: {
    flexGrow: 1,
    minWidth: 60,
    backgroundColor: '#F3F4F6',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 6,
    alignItems: 'center',
  },
  statBoxDue: {
    backgroundColor: '#FEF2F2',
  },
  statBoxGood: {
    backgroundColor: '#ECFDF5',
  },
  statValue: {
    fontSize: 18,
    fontWeight: '800',
    color: '#111827',
  },
  statLabel: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
    fontWeight: '600',
  },
  practiceButton: {
    marginTop: 12,
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 3,
  },
  practiceButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  caughtUpCard: {
    marginTop: 12,
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#A7F3D0',
    borderRadius: 12,
    padding: 12,
  },
  caughtUpText: {
    color: '#065F46',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  actionErrorBanner: {
    marginTop: 12,
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 12,
    padding: 12,
  },
  actionErrorText: {
    color: '#DC2626',
    fontSize: 13,
  },
  searchWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    paddingHorizontal: 10,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 10,
    fontSize: 14,
    color: '#111827',
  },
  searchClearButton: {
    padding: 6,
  },
  searchClearText: {
    color: '#6B7280',
    fontSize: 14,
    fontWeight: '700',
  },
  filterSectionLabel: {
    marginTop: 14,
    marginBottom: 6,
    fontSize: 12,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  chipRow: {
    flexGrow: 0,
  },
  chip: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
  },
  chipActive: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
  },
  chipTextActive: {
    color: '#FFFFFF',
  },
  resultCountText: {
    marginTop: 14,
    marginBottom: 6,
    fontSize: 12,
    color: '#6B7280',
  },
  itemCard: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#F3F4F6',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  itemCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  itemTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    flexShrink: 1,
  },
  bucketBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 8,
  },
  bucketBadge_due: {
    backgroundColor: '#FEE2E2',
  },
  bucketBadge_learning: {
    backgroundColor: '#EFF6FF',
  },
  bucketBadge_familiar: {
    backgroundColor: '#FEF3C7',
  },
  bucketBadge_mastered: {
    backgroundColor: '#D1FAE5',
  },
  bucketBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#374151',
    textTransform: 'uppercase',
  },
  itemTypeLabel: {
    marginTop: 3,
    fontSize: 12,
    fontWeight: '600',
    color: '#2563EB',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  itemMeaning: {
    marginTop: 6,
    fontSize: 13,
    color: '#374151',
    lineHeight: 18,
  },
  itemMeta: {
    marginTop: 6,
    fontSize: 12,
    color: '#9CA3AF',
  },
  emptyCard: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#F3F4F6',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
    marginTop: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  emptyCardEmoji: {
    fontSize: 28,
    marginBottom: 8,
  },
  emptyCardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 6,
  },
  emptyCardText: {
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 18,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  modalCloseButton: {
    padding: 6,
  },
  modalCloseText: {
    color: '#2563EB',
    fontSize: 14,
    fontWeight: '700',
  },
  modalContent: {
    padding: 20,
    paddingBottom: 60,
  },
  detailTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#111827',
  },
  detailBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 8,
  },
  typeBadge: {
    backgroundColor: '#EEF2FF',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  typeBadgeText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#3730A3',
    textTransform: 'uppercase',
  },
  detailMeta: {
    marginTop: 10,
    fontSize: 12,
    color: '#6B7280',
  },
  pronunciationNotesBox: {
    backgroundColor: '#EFF6FF',
    borderRadius: 12,
    padding: 10,
    marginTop: 10,
  },
  pronunciationNoteLine: {
    fontSize: 13,
    color: '#1F2937',
    lineHeight: 18,
    marginTop: 2,
  },
  addMeaningBlock: {
    backgroundColor: '#FFFDF2',
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: '#FDE68A',
    gap: 8,
  },
  addMeaningHint: {
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 18,
  },
  editSaveDisabled: {
    opacity: 0.5,
  },

  detailSectionLabel: {
    marginTop: 20,
    marginBottom: 8,
    fontSize: 13,
    fontWeight: '700',
    color: '#111827',
  },
  meaningBlock: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  meaningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  posBadge: {
    backgroundColor: '#F3F4F6',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  posBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#374151',
    fontStyle: 'italic',
  },
  editMeaningButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  editMeaningButtonText: {
    color: '#2563EB',
    fontSize: 13,
    fontWeight: '700',
  },
  meaningDefinition: {
    fontSize: 14,
    color: '#111827',
    lineHeight: 20,
  },
  exampleRow: {
    marginTop: 8,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: '#BFDBFE',
  },
  exampleText: {
    fontSize: 13,
    color: '#1F2937',
    fontStyle: 'italic',
    lineHeight: 18,
  },
  exampleSource: {
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 2,
  },
  reviewDataBox: {
    marginTop: 10,
    backgroundColor: '#F9FAFB',
    borderRadius: 8,
    padding: 8,
  },
  reviewDataText: {
    fontSize: 12,
    color: '#6B7280',
    fontWeight: '600',
  },
  editBlock: {
    marginTop: 4,
  },
  editFieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    marginBottom: 4,
    marginTop: 8,
  },
  editInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: '#111827',
    minHeight: 40,
    textAlignVertical: 'top',
  },
  editExampleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  editExampleInput: {
    flex: 1,
  },
  removeExampleButton: {
    padding: 8,
  },
  removeExampleText: {
    color: '#DC2626',
    fontWeight: '700',
  },
  addExampleButton: {
    marginTop: 2,
    paddingVertical: 6,
  },
  addExampleText: {
    color: '#2563EB',
    fontSize: 13,
    fontWeight: '700',
  },
  editActionsRow: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 10,
  },
  editActionButton: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  editSaveButton: {
    backgroundColor: '#2563EB',
  },
  editSaveButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  editCancelButton: {
    backgroundColor: '#F3F4F6',
  },
  editCancelButtonText: {
    color: '#374151',
    fontWeight: '700',
    fontSize: 14,
  },
  deleteButton: {
    marginTop: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  deleteButtonText: {
    color: '#DC2626',
    fontWeight: '700',
    fontSize: 14,
  },
});

// Typed badge style lookup for review buckets (styles must exist first).
BUCKET_BADGE_STYLES.due = styles.bucketBadge_due;
BUCKET_BADGE_STYLES.learning = styles.bucketBadge_learning;
BUCKET_BADGE_STYLES.familiar = styles.bucketBadge_familiar;
BUCKET_BADGE_STYLES.mastered = styles.bucketBadge_mastered;
