/**
 * src/reassessment/history-repository.ts
 *
 * SQLite Reassessment History Repository (WP-4).
 *
 * EXACTLY-ONCE PERSISTENCE & TERMINAL DECISIONS:
 * - Deterministic record identity prevents duplicate rows upon retry/double finish.
 * - Decisions ('accepted' or 'kept') are terminal and mutually exclusive:
 *   once 'accepted', a decision cannot flip to 'kept', and vice versa.
 * - Decision updates are atomic across history + profile using database transactions.
 */

import type { DatabaseAdapter, SqlStep } from '../data/local/sqlite/DatabaseAdapter';
import type { CefrLevelInput } from '../domain/shared/types';
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
  acceptAndApplyLevel(
    id: string,
    proposedLevel: CefrLevelInput,
  ): Promise<{ readonly record: ReassessmentRecord | null; readonly updated: boolean }>;
  keepCurrentLevel(
    id: string,
  ): Promise<{ readonly record: ReassessmentRecord | null; readonly updated: boolean }>;
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

  async acceptAndApplyLevel(
    id: string,
    proposedLevel: CefrLevelInput,
  ): Promise<{ readonly record: ReassessmentRecord | null; readonly updated: boolean }> {
    const existing = await this.getById(id);
    if (!existing) {
      return { record: null, updated: false };
    }

    if (existing.decision === 'accepted' || existing.decision === 'kept') {
      return { record: existing, updated: false };
    }

    const now = nowIso();
    const steps: SqlStep[] = [
      {
        sql: `UPDATE reassessment_history SET decision = 'accepted', accepted_level = ?, updated_at = ? WHERE id = ? AND decision = 'pending'`,
        params: [proposedLevel, now, id],
      },
      {
        sql: `UPDATE learner_profile SET current_level = ?, updated_at = ? WHERE id = (SELECT learner_id FROM reassessment_history WHERE id = ? AND decision = 'accepted' AND updated_at = ?)`,
        params: [proposedLevel, now, id, now],
      },
    ];

    const results = await this.adapter.transaction(steps);
    const updated = results[0].rowsAffected === 1;
    const updatedRecord = await this.getById(id);
    return { record: updatedRecord, updated };
  }

  async keepCurrentLevel(
    id: string,
  ): Promise<{ readonly record: ReassessmentRecord | null; readonly updated: boolean }> {
    const existing = await this.getById(id);
    if (!existing) {
      return { record: null, updated: false };
    }

    if (existing.decision === 'accepted' || existing.decision === 'kept') {
      return { record: existing, updated: false };
    }

    const now = nowIso();
    const steps: SqlStep[] = [
      {
        sql: `UPDATE reassessment_history SET decision = 'kept', accepted_level = ?, updated_at = ? WHERE id = ? AND decision = 'pending'`,
        params: [existing.previousLevel, now, id],
      },
    ];

    const results = await this.adapter.transaction(steps);
    const updated = results[0].rowsAffected === 1;
    const updatedRecord = await this.getById(id);
    return { record: updatedRecord, updated };
  }

  async updateDecision(
    id: string,
    decision: ReassessmentDecision,
    acceptedLevel?: CefrLevelInput | null,
  ): Promise<{ readonly record: ReassessmentRecord | null; readonly updated: boolean }> {
    if (decision === 'accepted' && acceptedLevel) {
      return this.acceptAndApplyLevel(id, acceptedLevel);
    }
    return this.keepCurrentLevel(id);
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
