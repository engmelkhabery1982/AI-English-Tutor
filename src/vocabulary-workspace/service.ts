/**
 * src/vocabulary-workspace/service.ts
 *
 * VocabularyWorkspaceService: a read/edit/delete/practice facade over the
 * EXISTING vocabulary & expression repositories and the EXISTING Adaptive
 * Review system.
 *
 * - No new persistence, no duplicate review engine, no fabricated data.
 * - Review state is always derived from the authoritative `meaning.review`.
 * - Edits go through the repository `update` contract with per-meaning
 *   review data carried through untouched, preserving review history.
 * - Practice availability is decided by the existing ReviewService planner.
 */

import type { IsoDate, Meaning, MeaningReview, UsageExample } from '../domain/shared/types';
import type { ExpressionItem, VocabularyItem } from '../domain/models/vocabulary';
import type {
  ExpressionRepository,
  ReviewRepository,
  UserProfileRepository,
  VocabularyRepository,
} from '../repositories';
import type { ReviewItem } from '../domain/models/learning';
import type { ReviewService } from '../review/service';
import type {
  PracticeAction,
  PracticeDecision,
  WorkspaceEntry,
  WorkspaceFilters,
  WorkspaceItemKind,
  WorkspaceReviewBucket,
  WorkspaceSnapshot,
  WorkspaceSummary,
} from './types';

/** Normalize text for local search: lowercase, trimmed, collapsed whitespace. */
export function normalizeSearchText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Derive the workspace review bucket from the authoritative per-meaning
 * review state. Nothing is stored — this is computed at read time.
 */
export function deriveReviewBucket(
  meanings: readonly Meaning[],
  now: IsoDate,
): WorkspaceReviewBucket {
  const reviews: MeaningReview[] = [];
  for (const meaning of meanings) {
    if (meaning.review) reviews.push(meaning.review);
  }

  if (reviews.some((r) => r.nextReviewAt != null && r.nextReviewAt <= now)) {
    return 'due';
  }
  if (reviews.length === 0) return 'learning';
  if (reviews.every((r) => r.state === 'mastered' || r.state === 'retired')) {
    return 'mastered';
  }
  if (
    reviews.every((r) => r.state === 'familiar' || r.state === 'mastered' || r.state === 'retired')
  ) {
    return 'familiar';
  }
  return 'learning';
}

/** Earliest nextReviewAt across meanings, or null when none is scheduled. */
function earliestNextReviewAt(meanings: readonly Meaning[]): IsoDate | null {
  let earliest: IsoDate | null = null;
  for (const meaning of meanings) {
    const next = meaning.review?.nextReviewAt;
    if (next != null && (earliest === null || next < earliest)) {
      earliest = next;
    }
  }
  return earliest;
}

/** Build a listable workspace entry from a persisted domain item. */
export function toWorkspaceEntry(
  item: VocabularyItem | ExpressionItem,
  kind: WorkspaceItemKind,
  now: IsoDate,
): WorkspaceEntry {
  const meanings = item.meanings ?? [];
  const primary = meanings[0];

  return {
    id: item.id,
    kind,
    title: kind === 'expression' ? (item as ExpressionItem).expression : (item as VocabularyItem).headword,
    type: item.type,
    primaryMeaning: primary?.definition ?? '',
    meaningCount: meanings.length,
    reviewBucket: deriveReviewBucket(meanings, now),
    nextReviewAt: earliestNextReviewAt(meanings),
    reviewCount: meanings.reduce((sum, m) => sum + (m.review?.reviewCount ?? 0), 0),
    consecutiveCorrect: primary?.review?.consecutiveCorrect ?? 0,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    addedBy: item.source?.addedBy ?? 'system',
    item,
  };
}

/** Filter entries by category, review-state bucket, and local search text. */
export function filterWorkspaceEntries(
  entries: readonly WorkspaceEntry[],
  filters: WorkspaceFilters,
): readonly WorkspaceEntry[] {
  const category = filters.category ?? 'all';
  const reviewState = filters.reviewState ?? 'all';
  const query = normalizeSearchText(filters.searchQuery ?? '');

  return entries.filter((entry) => {
    if (category !== 'all' && entry.type !== category) return false;
    if (reviewState !== 'all' && entry.reviewBucket !== reviewState) return false;

    if (query.length > 0) {
      const haystackParts: string[] = [entry.title];
      for (const meaning of entry.item.meanings ?? []) {
        haystackParts.push(meaning.definition);
        for (const example of meaning.examples ?? []) {
          haystackParts.push(example.text);
        }
      }
      if (!normalizeSearchText(haystackParts.join('\n')).includes(query)) {
        return false;
      }
    }

    return true;
  });
}

/** Header summary counts derived from the full (unfiltered) entry list. */
export function summarizeWorkspace(entries: readonly WorkspaceEntry[]): WorkspaceSummary {
  const summary = {
    totalSaved: entries.length,
    dueNow: 0,
    learning: 0,
    familiar: 0,
    mastered: 0,
  };
  for (const entry of entries) {
    if (entry.reviewBucket === 'due') summary.dueNow += 1;
    else if (entry.reviewBucket === 'learning') summary.learning += 1;
    else if (entry.reviewBucket === 'familiar') summary.familiar += 1;
    else if (entry.reviewBucket === 'mastered') summary.mastered += 1;
  }
  return summary;
}

/** Map a practice decision to the action the UI should take. */
export function resolvePracticeAction(decision: PracticeDecision): PracticeAction {
  if (decision.status === 'items-available') return 'navigate-review';
  if (decision.status === 'caught-up') return 'show-caught-up';
  return 'none';
}

/** Editable content of one meaning (system-owned review data is never editable here). */
export interface MeaningContentEdit {
  readonly entryId: string;
  readonly kind: WorkspaceItemKind;
  readonly meaningIndex: number;
  readonly definition?: string;
  /**
   * Replacement example texts for the meaning. Existing examples keep their
   * provenance (source, origin conversation/turn, created date); additional
   * texts beyond the persisted list are recorded as learner-created.
   */
  readonly exampleTexts?: readonly string[];
}

export interface VocabularyWorkspaceRepositories {
  readonly vocabulary: VocabularyRepository;
  readonly expressions: ExpressionRepository;
}

export interface VocabularyWorkspaceServiceDeps extends VocabularyWorkspaceRepositories {
  /** The EXISTING Adaptive Review service, used for practice availability. */
  readonly review?: Pick<ReviewService, 'planSession'>;
  /**
   * The EXISTING profile repository, used to resolve the active learner.
   * Composition-owned so UI screens never need database access.
   */
  readonly profile?: Pick<UserProfileRepository, 'get'>;
  /**
   * The EXISTING review repository, used to remove review rows that point
   * at a lexical item when that item is deleted (non-atomic fallback path).
   */
  readonly reviewCleanup?: Pick<ReviewRepository, 'deleteByReference'>;
  /**
   * Atomic data-layer delete: removes the lexical item AND its matching
   * review rows (same referenceId + same kind) in ONE adapter transaction.
   * Provided by composition (see vocabulary-workspace/index.ts); when
   * absent, deleteEntry degrades to the non-atomic repository path.
   */
  readonly atomicDelete?: (
    lexicalItemId: string,
    kind: WorkspaceItemKind,
  ) => Promise<boolean>;
}

export class VocabularyWorkspaceService {
  constructor(private readonly deps: VocabularyWorkspaceServiceDeps) {}

  /**
   * Load every saved vocabulary item and expression for a learner and
   * derive the workspace view. Vocabulary and expressions share one
   * underlying table, so entries are merged by id — an item is listed
   * exactly once, with its kind taken from the owning repository.
   */
  async loadWorkspace(learnerId: string, now?: IsoDate): Promise<WorkspaceSnapshot> {
    const at = now ?? new Date().toISOString();
    const [vocabList, exprList] = await Promise.all([
      this.deps.vocabulary.list(learnerId),
      this.deps.expressions.list(learnerId),
    ]);

    const byId = new Map<string, WorkspaceEntry>();
    for (const expr of exprList) {
      byId.set(expr.id, toWorkspaceEntry(expr, 'expression', at));
    }
    for (const vocab of vocabList) {
      if (!byId.has(vocab.id)) {
        byId.set(vocab.id, toWorkspaceEntry(vocab, 'vocabulary', at));
      }
    }

    const entries = [...byId.values()].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.title.localeCompare(b.title);
    });

    return {
      entries,
      summary: summarizeWorkspace(entries),
      generatedAt: at,
    };
  }

  /**
   * Edit user-maintainable meaning content (definition and/or examples)
   * through the existing repository layer. Per-meaning review data is
   * carried through untouched, so reviewCount, consecutiveCorrect,
   * review state and nextReviewAt are preserved exactly.
   */
  async updateMeaningContent(edit: MeaningContentEdit, now?: IsoDate): Promise<WorkspaceEntry> {
    const at = now ?? new Date().toISOString();
    const repo = edit.kind === 'expression' ? this.deps.expressions : this.deps.vocabulary;

    const item = await repo.get(edit.entryId);
    if (!item) {
      throw new Error('Item not found. It may have been deleted already.');
    }
    if (edit.meaningIndex < 0 || edit.meaningIndex >= item.meanings.length) {
      throw new Error('Meaning not found for this item.');
    }

    if (edit.definition !== undefined && edit.definition.trim().length === 0) {
      throw new Error('Definition cannot be empty.');
    }

    const meanings = item.meanings.map((meaning, index) => {
      if (index !== edit.meaningIndex) return meaning;
      return applyMeaningContentEdit(meaning, edit.definition, edit.exampleTexts, at);
    });

    await repo.update(edit.entryId, { meanings });

    const updated = await repo.get(edit.entryId);
    if (!updated) {
      throw new Error('Item disappeared after update.');
    }
    return toWorkspaceEntry(updated, edit.kind, at);
  }

  /**
   * Resolve the active learner through the existing profile repository.
   * Returns null when no profile exists yet — the caller must show an
   * honest "no profile" state; learner IDs are never fabricated.
   */
  async getActiveLearnerId(): Promise<string | null> {
    if (!this.deps.profile) return null;
    try {
      const profile = await this.deps.profile.get();
      if (profile && profile.id) return profile.id;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Delete an item through the data layer. Preferred path: one atomic
   * adapter transaction removes the lexical item AND its matching review
   * rows (same referenceId, same kind) together — if any step fails,
   * everything rolls back and nothing is lost or half-deleted. Only when
   * no atomic delete is composed does this degrade to the non-atomic
   * repository path (review cleanup, then item delete).
   * Throws when deletion is not supported; callers must treat any error
   * as "item remains".
   */
  async deleteEntry(entry: { entryId: string; kind: WorkspaceItemKind }): Promise<boolean> {
    // Preferred: single atomic transaction in the data layer.
    if (this.deps.atomicDelete) {
      return this.deps.atomicDelete(entry.entryId, entry.kind);
    }

    // Fallback for compositions without transaction support (non-atomic).
    const repo = entry.kind === 'expression' ? this.deps.expressions : this.deps.vocabulary;
    if (!repo.delete) {
      throw new Error('Deleting is not supported by the current repository.');
    }

    // Clean dependent review rows before removing the item itself.
    if (this.deps.reviewCleanup?.deleteByReference) {
      await this.deps.reviewCleanup.deleteByReference(
        entry.entryId,
        entry.kind as ReviewItem['kind'],
      );
    }

    return repo.delete(entry.entryId);
  }

  /**
   * Ask the EXISTING Adaptive Review planner whether a practice session
   * would have items. This is the same planning path the Review tab uses,
   * so the workspace never invents its own due/scheduling rules.
   */
  async getPracticeDecision(learnerId: string): Promise<PracticeDecision> {
    if (!this.deps.review) return { status: 'unavailable' };
    const candidates = await this.deps.review.planSession(learnerId);
    if (candidates.length > 0) {
      return { status: 'items-available', itemCount: candidates.length };
    }
    return { status: 'caught-up' };
  }
}

/** Apply a definition/example edit to a single meaning, preserving review data. */
function applyMeaningContentEdit(
  meaning: Meaning,
  definition: string | undefined,
  exampleTexts: readonly string[] | undefined,
  now: IsoDate,
): Meaning {
  const nextDefinition =
    definition !== undefined ? definition.trim() : meaning.definition;

  let examples: UsageExample[] = meaning.examples ? [...meaning.examples] : [];
  if (exampleTexts !== undefined) {
    const trimmed = exampleTexts
      .map((text) => text.trim())
      .filter((text) => text.length > 0);
    examples = trimmed.map((text, index) => {
      const existing = meaning.examples?.[index];
      if (existing) {
        // Keep provenance of persisted examples; only the text changes.
        return { ...existing, text };
      }
      const created: UsageExample = {
        text,
        source: 'learner-created',
        createdAt: now,
      };
      return created;
    });
  }

  return {
    ...meaning,
    definition: nextDefinition,
    examples,
  };
}
