/**
 * src/listening/deep/index.ts
 *
 * WP-2 — LISTENING DEPTH public surface.
 *
 * Additive module inside the EXISTING listening engine: long discourse,
 * multi-speaker material, honest variable speech rate, connected-speech
 * awareness and shadowing. It owns no second engine, no second evaluator, no
 * second persistence path and no scores.
 */

export * from './types';
export * from './speech-rate';
export * from './speakers';
export * from './request';
export * from './validation';
export * from './prompt';
export * from './generation';
export * from './catalogue';
export * from './planner';
export * from './shadowing';
// Work Order 2: learner-controlled shadowing assistance (reveal / meaning /
// replay-friendly state). Pure presentation state — it can never create or
// change practice evidence.
export * from './shadowing-assist';
export * from './evaluation';
