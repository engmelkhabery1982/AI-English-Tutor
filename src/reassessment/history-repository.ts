/**
 * src/reassessment/history-repository.ts
 *
 * SQLite Reassessment History Repository (WP-4).
 *
 * EXACTLY-ONCE PERSISTENCE & TERMINAL DECISIONS:
 * - Deterministic record identity prevents duplicate rows upon retry/double finish.
 * - Decisions ('accepted' or 'kept') are terminal and mutually exclusive:
 *   once 'accepted', a decision cannot flip to 'kept', and vice versa.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import type { CefrLevelInput } from '../domain/shared/types';
import { generateId } from '../shared/id';
import { nowIso } from '../shared/time';
import type {
  QualitativeChangeReport,
  ReassessmentDecision,
  ReassessmentRecord,
} from './types';

export interface ReassessmentHistoryRepository {
  saveRecord(
    record: Partial<ReassessmentRecord> & Omit<ReassessmentRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<ReassessmentRecord>;
  updateDecision(
    id: string,
    decision: ReassessmentDecision,
    acceptedLevel?: CefrLevelInput | null,
  ): Promise<{ readonly record: ReassessmentRecord | null; readonly updated: boolean }>;
  listHistory(learnerId: string, limit?: number): Promise<readonly ReassessmentRecord[]>;
  getLatest(learnerId: string): Promise<ReassessmentRecord | null>;
  getById(id: string): Promise<ReassessmentRecord | null>;
}

function rowToRecord(row: Record<string, unknown>): ReassessmentRecord {
  let basis: string[] = [];
  try {
    basis = JSON.parse((row.basis as string) || '[]');
  } catch {
    basis = [];
  }

  let qualitativeSummary: QualitativeChangeReport = {
    overallSummary: '',
    domains: [],
    hasSufficientEvidence: false,
  };
  try {
    qualitativeSummary = JSON.parse((row.qualitative_summary as string) || '{}');
  } catch {
    // fallback
  }

  return {
    id: String(row.id),
    learnerId: String(row.learner_id),
    assessmentKind: 'reassessment',
    status: (row.status as any) ?? 'insufficient',
    proposedLevel: (row.proposed_level as any) ?? 'unknown',
    previousLevel: (row.previous_level as any) ?? 'unknown',
    confidence: (row.confidence as any) ?? 'limited',
    decision: (row.decision as any) ?? 'pending',
    acceptedLevel: row.accepted_level ? (row.accepted_level as any) : null,
    basis,
    qualitativeSummary,
    generatedAt: String(row.generated_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SQLiteReassessmentHistoryRepository implements ReassessmentHistoryRepository {
  private inFlightUpdates = new Set<string>();

  constructor(private readonly adapter: DatabaseAdapter) {}

  async saveRecord(
    record: Partial<ReassessmentRecord> & Omit<ReassessmentRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<ReassessmentRecord> {
    const id = record.id || `reassess_${record.learnerId}_${record.generatedAt || nowIso()}`;
    const now = nowIso();

    const existing = await this.getById(id);
    if (existing) {
      return existing;
    }

    await this.adapter.execute(
      `INSERT INTO reassessment_history (
        id, learner_id, assessment_kind, status, proposed_level, previous_level,
        confidence, decision, accepted_level, basis, qualitative_summary,
        generated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`,
      [
        id,
        record.learnerId,
        record.assessmentKind ?? 'reassessment',
        record.status,
        record.proposedLevel,
        record.previousLevel,
        record.confidence,
        record.decision,
        record.acceptedLevel ?? null,
        JSON.stringify(record.basis ?? []),
        JSON.stringify(record.qualitativeSummary ?? {}),
        record.generatedAt ?? now,
        now,
        now,
      ],
    );

    const saved = await this.getById(id);
    if (!saved) {
      throw new Error('Failed to retrieve newly saved reassessment record');
    }
    return saved;
  }

  async updateDecision(
    id: string,
    decision: ReassessmentDecision,
    acceptedLevel?: CefrLevelInput | null,
  ): Promise<{ readonly record: ReassessmentRecord | null; readonly updated: boolean }> {
    const existing = await this.getById(id);
    if (!existing) {
      return { record: null, updated: false };
    }

    // TERMINAL DECISION GUARD:
    // Once 'accepted' or 'kept', decision is terminal and mutually exclusive. It CANNOT flip!
    if (existing.decision === 'accepted' || existing.decision === 'kept') {
      return { record: existing, updated: false };
    }

    if (this.inFlightUpdates.has(id)) {
      const after = await this.getById(id);
      return { record: after, updated: false };
    }

    this.inFlightUpdates.add(id);
    try {
      const now = nowIso();
      await this.adapter.execute(
        `UPDATE reassessment_history SET decision = ?, accepted_level = ?, updated_at = ? WHERE id = ? AND decision = 'pending'`,
        [decision, acceptedLevel ?? null, now, id],
      );

      const updatedRecord = await this.getById(id);
      const updated = existing.decision === 'pending' && updatedRecord?.decision === decision;
      return { record: updatedRecord, updated };
    } finally {
      this.inFlightUpdates.delete(id);
    }
  }

  async getById(id: string): Promise<ReassessmentRecord | null> {
    const rows = await this.adapter.query(
      `SELECT * FROM reassessment_history WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToRecord(rows[0]);
  }

  async getLatest(learnerId: string): Promise<ReassessmentRecord | null> {
    const rows = await this.adapter.query(
      `SELECT * FROM reassessment_history WHERE learner_id = ? ORDER BY created_at DESC LIMIT 1`,
      [learnerId],
    );
    if (rows.length === 0) return null;
    return rowToRecord(rows[0]);
  }

  async listHistory(
    learnerId: string,
    limit = 20,
  ): Promise<readonly ReassessmentRecord[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM reassessment_history WHERE learner_id = ? ORDER BY created_at DESC LIMIT ?`,
      [learnerId, limit],
    );
    return rows.map(rowToRecord);
  }
}
