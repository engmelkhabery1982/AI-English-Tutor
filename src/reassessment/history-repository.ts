/**
 * src/reassessment/history-repository.ts
 *
 * SQLite repository for persistent, retry-safe reassessment estimate history.
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
    record: Omit<ReassessmentRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ReassessmentRecord>;
  updateDecision(
    id: string,
    decision: ReassessmentDecision,
    acceptedLevel?: CefrLevelInput | null,
  ): Promise<ReassessmentRecord | null>;
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
    // default
  }

  return {
    id: row.id as string,
    learnerId: row.learner_id as string,
    assessmentKind: row.assessment_kind as ReassessmentRecord['assessmentKind'],
    status: row.status as ReassessmentRecord['status'],
    proposedLevel: row.proposed_level as CefrLevelInput,
    previousLevel: row.previous_level as CefrLevelInput,
    confidence: row.confidence as ReassessmentRecord['confidence'],
    decision: row.decision as ReassessmentDecision,
    acceptedLevel: (row.accepted_level as CefrLevelInput) || null,
    basis,
    qualitativeSummary,
    generatedAt: row.generated_at as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class SQLiteReassessmentHistoryRepository implements ReassessmentHistoryRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async saveRecord(
    record: Omit<ReassessmentRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ReassessmentRecord> {
    const id = generateId();
    const now = nowIso();

    await this.adapter.execute(
      `INSERT INTO reassessment_history (
        id, learner_id, assessment_kind, status, proposed_level, previous_level,
        confidence, decision, accepted_level, basis, qualitative_summary,
        generated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        record.learnerId,
        record.assessmentKind,
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
  ): Promise<ReassessmentRecord | null> {
    const now = nowIso();
    await this.adapter.execute(
      `UPDATE reassessment_history SET decision = ?, accepted_level = ?, updated_at = ? WHERE id = ?`,
      [decision, acceptedLevel ?? null, now, id],
    );
    return this.getById(id);
  }

  async getById(id: string): Promise<ReassessmentRecord | null> {
    const rows = await this.adapter.query(
      `SELECT * FROM reassessment_history WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToRecord(rows[0]);
  }

  async listHistory(learnerId: string, limit = 10): Promise<readonly ReassessmentRecord[]> {
    const rows = await this.adapter.query(
      `SELECT * FROM reassessment_history WHERE learner_id = ? ORDER BY created_at DESC LIMIT ?`,
      [learnerId, limit],
    );
    return rows.map(rowToRecord);
  }

  async getLatest(learnerId: string): Promise<ReassessmentRecord | null> {
    const rows = await this.adapter.query(
      `SELECT * FROM reassessment_history WHERE learner_id = ? ORDER BY created_at DESC LIMIT 1`,
      [learnerId],
    );
    if (rows.length === 0) return null;
    return rowToRecord(rows[0]);
  }
}
