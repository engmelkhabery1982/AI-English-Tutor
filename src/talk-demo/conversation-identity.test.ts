/**
 * src/talk-demo/conversation-identity.test.ts
 *
 * Lifecycle tests for the Talk conversation identity rules (Work Order 1, item 5).
 *
 * The device bug this pins shut: the Talk screen composed a fresh conversation
 * from an effect that depended on the topic TEXT FIELD, so — while the tutor's
 * opening turn was still in flight and the conversation was still empty — every
 * keystroke replaced the session. The in-flight turn then failed with
 * "This conversation was replaced before the turn finished, so the turn was
 * discarded."
 *
 * The rules under test: a typed topic is a DRAFT, identity is stable while a turn
 * is unresolved, a live conversation is replaced only explicitly, and a fresh
 * identity is composed only when nothing else owns the surface.
 */

import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_IDENTITY_SEPARATOR,
  conversationIdentity,
  hasUnappliedTopicDraft,
  isConversationReusable,
  normalizeTopicDraft,
  resolveConversationIdentity,
  TALK_CONVERSATION_RESTARTED_MESSAGE,
  TALK_CONVERSATION_RESTARTED_MIC_MESSAGE,
  type ConversationIdentityInput,
} from './conversation-identity';
import { isLearnerSafeMessage } from '../providers/failures';

const BASE: ConversationIdentityInput = {
  mode: 'natural',
  appliedTopic: '',
  composedIdentity: null,
  historyLength: 0,
  turnInFlight: false,
  coachingResolved: true,
};

describe('conversation identity — topic drafts never replace a conversation', () => {
  it('composes nothing while the learner is still typing the same applied topic', () => {
    const decision = resolveConversationIdentity({
      ...BASE,
      appliedTopic: 'Travel',
      composedIdentity: conversationIdentity('natural', 'Travel'),
    });

    expect(decision.action).toBe('none');
    expect(decision).toMatchObject({ reason: 'already-composed' });
  });

  it('treats whitespace-only edits as the same topic', () => {
    expect(normalizeTopicDraft('  Job   Interview ')).toBe('Job Interview');
    expect(normalizeTopicDraft('\nTravel\n')).toBe('Travel');
    expect(hasUnappliedTopicDraft('Travel  ', 'Travel')).toBe(false);
    expect(hasUnappliedTopicDraft('', '   ')).toBe(false);
    expect(hasUnappliedTopicDraft('Job Interview', 'Travel')).toBe(true);
  });

  it('reports an unapplied draft so the surface can offer an explicit Apply', () => {
    expect(hasUnappliedTopicDraft('Travel', '')).toBe(true);
    expect(hasUnappliedTopicDraft('', '')).toBe(false);
  });

  it('uses one stable identity format for mode + topic', () => {
    expect(conversationIdentity('coach', 'Travel')).toBe(
      `coach${CONVERSATION_IDENTITY_SEPARATOR}Travel`,
    );
    expect(conversationIdentity('coach', '  Travel  ')).toBe(conversationIdentity('coach', 'Travel'));
    expect(conversationIdentity('natural', '')).not.toBe(conversationIdentity('coach', ''));
  });
});

describe('conversation identity — stability while a turn is unresolved', () => {
  it('defers composition while the tutor opening is in flight', () => {
    const decision = resolveConversationIdentity({
      ...BASE,
      appliedTopic: 'Travel',
      composedIdentity: conversationIdentity('natural', ''),
      turnInFlight: true,
    });

    expect(decision.action).toBe('none');
    expect(decision).toMatchObject({ reason: 'turn-in-flight' });
  });

  it('reproduces the device bug: keystrokes during an in-flight opening compose nothing', () => {
    // The learner opens Talk (empty conversation), the tutor opening starts, and
    // the learner types a topic. Each keystroke used to replace the session.
    const keystrokes = ['T', 'Tr', 'Tra', 'Trav', 'Trave', 'Travel'];
    const decisions = keystrokes.map((draft) => ({
      draft,
      // The DRAFT is what the learner typed; the applied topic is unchanged, so
      // the identity the decision sees never moves while they type.
      decision: resolveConversationIdentity({
        ...BASE,
        appliedTopic: '',
        composedIdentity: conversationIdentity('natural', ''),
        historyLength: 0,
        turnInFlight: true, // the tutor opening is unresolved
      }),
    }));

    expect(decisions.every((entry) => entry.decision.action === 'none')).toBe(true);
    // The draft is still visible to the learner as something they can apply.
    expect(decisions.map((entry) => hasUnappliedTopicDraft(entry.draft, ''))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('composes exactly once after the turn settles and the learner applies the topic', () => {
    // The learner taps "Start with this topic": the draft becomes the applied topic.
    const whileSending = resolveConversationIdentity({
      ...BASE,
      appliedTopic: 'Travel',
      composedIdentity: conversationIdentity('natural', ''),
      turnInFlight: true,
    });
    expect(whileSending.action).toBe('none');

    const settled = resolveConversationIdentity({
      ...BASE,
      appliedTopic: 'Travel',
      composedIdentity: conversationIdentity('natural', ''),
      turnInFlight: false,
    });
    expect(settled).toEqual({
      action: 'compose',
      identity: conversationIdentity('natural', 'Travel'),
    });

    // …and never again for the same identity.
    const after = resolveConversationIdentity({
      ...BASE,
      appliedTopic: 'Travel',
      composedIdentity: settled.action === 'compose' ? settled.identity : null,
      turnInFlight: false,
    });
    expect(after.action).toBe('none');
  });

  it('never replaces a live conversation implicitly', () => {
    const decision = resolveConversationIdentity({
      ...BASE,
      mode: 'coach',
      appliedTopic: 'Travel',
      composedIdentity: conversationIdentity('natural', ''),
      historyLength: 4,
      turnInFlight: false,
    });

    expect(decision.action).toBe('none');
    expect(decision).toMatchObject({ reason: 'live-conversation' });
  });

  it('waits for the real coaching context before composing anything', () => {
    const decision = resolveConversationIdentity({ ...BASE, coachingResolved: false });

    expect(decision.action).toBe('none');
    expect(decision).toMatchObject({ reason: 'coaching-unresolved' });
  });

  it('composes the first conversation when nothing else owns the surface', () => {
    expect(resolveConversationIdentity(BASE)).toEqual({
      action: 'compose',
      identity: conversationIdentity('natural', ''),
    });
  });
});

describe('conversation identity — dead-session detection', () => {
  it('refuses to reuse a session that was closed underneath the surface', () => {
    expect(isConversationReusable(null)).toBe(false);
    expect(isConversationReusable({ isAbandoned: () => true })).toBe(false);
    expect(isConversationReusable({ isAbandoned: () => false })).toBe(true);
    // Sessions without the optional probe stay reusable (backwards compatible).
    expect(isConversationReusable({})).toBe(true);
  });

  it('keeps the restart notices calm, honest and learner-safe', () => {
    for (const message of [TALK_CONVERSATION_RESTARTED_MESSAGE, TALK_CONVERSATION_RESTARTED_MIC_MESSAGE]) {
      expect(isLearnerSafeMessage(message)).toBe(true);
      expect(message.toLowerCase()).not.toContain('error');
      expect(message.toLowerCase()).not.toContain('discarded');
      expect(message.toLowerCase()).not.toContain('replaced');
      expect(message).toContain('fresh one');
    }
    expect(TALK_CONVERSATION_RESTARTED_MIC_MESSAGE).toContain('microphone');
  });
});
