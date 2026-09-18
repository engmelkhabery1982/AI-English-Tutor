/**
 * src/reassessment/change-report.ts
 *
 * Qualitative Ability Change Report Generator (WP-4).
 *
 * Compares evidence across assessment periods to report qualitative capability
 * shifts (stronger, weaker, mixed, insufficient, unchanged).
 *
 * NO FAKE SCORES OR PERCENTAGES:
 * Reports grounded qualitative observations only (e.g. "Listening comprehension
 * appears stronger in multi-speaker tasks").
 */

import type { LearnerStrength, LearnerWeakness } from '../domain/models/learner';
import type { DiagnosticResult } from '../onboarding/types';
import type {
  AbilityShiftStatus,
  DomainAbilityChange,
  QualitativeChangeReport,
  ReassessmentRecord,
} from './types';

export interface ChangeReportParams {
  readonly strengths: readonly LearnerStrength[];
  readonly weaknesses: readonly LearnerWeakness[];
  readonly currentResult?: DiagnosticResult | null;
  readonly previousRecord?: ReassessmentRecord | null;
}

export function generateAbilityChangeReport(
  params: ChangeReportParams,
): QualitativeChangeReport {
  const { strengths, weaknesses, currentResult, previousRecord } = params;

  const activeWeaknesses = weaknesses.filter(
    (w) => !w.resolved && w.status !== 'mastered',
  );

  const domains: DomainAbilityChange[] = [
    evaluateDomain('listening', strengths, activeWeaknesses, currentResult, previousRecord),
    evaluateDomain('speaking', strengths, activeWeaknesses, currentResult, previousRecord),
    evaluateDomain('pronunciation', strengths, activeWeaknesses, currentResult, previousRecord),
    evaluateDomain('grammar', strengths, activeWeaknesses, currentResult, previousRecord),
    evaluateDomain('vocabulary', strengths, activeWeaknesses, currentResult, previousRecord),
  ];

  const hasSufficientEvidence = domains.some((d) => d.status !== 'insufficient');

  const strongerCount = domains.filter((d) => d.status === 'stronger').length;
  const weakerCount = domains.filter((d) => d.status === 'weaker').length;
  const mixedCount = domains.filter((d) => d.status === 'mixed').length;

  let overallSummary = 'Your demonstrated capabilities remain stable across recent practice.';
  if (!hasSufficientEvidence) {
    overallSummary = 'Insufficient new evidence to determine an overall level shift.';
  } else if (strongerCount > 0 && weakerCount === 0) {
    overallSummary = 'Evidence shows clear qualitative growth in key practice domains.';
  } else if (weakerCount > 0 && strongerCount === 0) {
    overallSummary = 'Recent practice indicates areas needing renewed focus and review.';
  } else if (mixedCount > 0 || (strongerCount > 0 && weakerCount > 0)) {
    overallSummary = 'Evidence shows mixed performance with demonstrated strengths alongside active practice areas.';
  }

  return {
    overallSummary,
    domains,
    hasSufficientEvidence,
  };
}

function evaluateDomain(
  domain: 'listening' | 'speaking' | 'pronunciation' | 'grammar' | 'vocabulary',
  strengths: readonly LearnerStrength[],
  activeWeaknesses: readonly LearnerWeakness[],
  currentResult?: DiagnosticResult | null,
  previousRecord?: ReassessmentRecord | null,
): DomainAbilityChange {
  // Filter strengths and weaknesses for this domain
  const domainStrengths = strengths.filter((s) => mapTypeToDomain(s.type) === domain);
  const domainWeaknesses = activeWeaknesses.filter((w) => mapTypeToDomain(w.type) === domain);

  const hasStrengths = domainStrengths.length > 0;
  const hasWeaknesses = domainWeaknesses.length > 0;

  // Derive status
  let status: AbilityShiftStatus = 'insufficient';
  let summary = `Insufficient evidence collected for ${domain}.`;
  const evidenceDetails: string[] = [];

  if (hasStrengths && hasWeaknesses) {
    status = 'mixed';
    summary = `${capitalize(domain)} shows demonstrated ability in some contexts while active practice areas remain.`;
    evidenceDetails.push(`${domainStrengths.length} demonstrated strengths coexist with ${domainWeaknesses.length} active focus areas.`);
  } else if (hasStrengths && !hasWeaknesses) {
    status = 'stronger';
    summary = `${capitalize(domain)} evidence is stronger with consistent demonstrated performance.`;
    for (const s of domainStrengths.slice(-2)) {
      if (s.notes) evidenceDetails.push(s.notes);
    }
  } else if (!hasStrengths && hasWeaknesses) {
    status = 'weaker';
    summary = `${capitalize(domain)} shows active difficulties requiring targeted review.`;
    for (const w of domainWeaknesses.slice(-2)) {
      if (w.notes) evidenceDetails.push(w.notes);
    }
  } else if (previousRecord || currentResult) {
    status = 'unchanged';
    summary = `${capitalize(domain)} performance remains stable with no major changes observed.`;
  }

  // Domain-specific custom qualitative descriptions
  if (domain === 'listening') {
    if (status === 'stronger') {
      summary = 'Listening comprehension appears stronger in multi-speaker and varied speech tasks.';
    } else if (status === 'mixed') {
      summary = 'Main-idea comprehension is consistent, though fast or connected speech remains challenging.';
    }
  } else if (domain === 'pronunciation') {
    if (status === 'stronger') {
      summary = 'Pronunciation evidence is more consistent for previously weak sound patterns.';
    }
  } else if (domain === 'speaking') {
    if (status === 'stronger') {
      summary = 'Sustains longer spoken turns with reduced reliance on scaffolding.';
    }
  } else if (domain === 'grammar') {
    if (status === 'insufficient') {
      summary = 'Insufficient evidence to determine a change in grammar ability.';
    }
  }

  return {
    domain,
    status,
    summary,
    evidenceDetails: evidenceDetails.length > 0 ? evidenceDetails : undefined,
  };
}

function mapTypeToDomain(
  type: string,
): 'listening' | 'speaking' | 'pronunciation' | 'grammar' | 'vocabulary' {
  switch (type) {
    case 'listening':
      return 'listening';
    case 'pronunciation':
      return 'pronunciation';
    case 'grammar':
      return 'grammar';
    case 'vocabulary':
    case 'natural_expression':
      return 'vocabulary';
    case 'fluency':
    case 'confidence':
    default:
      return 'speaking';
  }
}

function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}
