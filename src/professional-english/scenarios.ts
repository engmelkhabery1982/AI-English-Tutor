/**
 * Professional English Core — scenario catalog.
 *
 * Each entry is pure data describing a professional speaking scenario.
 * The catalog is intentionally general-purpose: it must remain useful for
 * any profession or industry, with fallbacks rather than hard-coded
 * construction/engineering assumptions.
 *
 * Difficulty is qualitative (`simple` / `moderate` / `complex`) plus a short
 * reasoning string. There are no numeric skill scores anywhere.
 */

import type {
  ChallengeEvent,
  LanguageGoal,
  ScenarioCategory,
  ScenarioDefinition,
  SpeakingGoal,
} from './types';

type RankedChallenge = ChallengeEvent;

/** Small helper so scenario literals stay readable and satisfaction is checked. */
const speaking = (id: string, description: string): SpeakingGoal => ({ id, description });
const language = (id: string, description: string): LanguageGoal => ({ id, description });
const challenge = (
  id: string,
  minComplexityRank: number,
  description: string,
): RankedChallenge => ({ id, minComplexityRank, description });

/** A generic opening challenge every scenario can fall back on. */
export const BASELINE_CHALLENGE: RankedChallenge = challenge(
  'clarify-and-confirm',
  'simple' as unknown as number,
  'Ask a clarifying question and confirm understanding before continuing.',
);

/** Ordered scenario catalog, keyed by category. */
export const SCENARIOS: readonly ScenarioDefinition[] = [
  {
    id: 'meeting',
    category: 'meeting',
    title: 'Contributing in a team meeting',
    situation:
      'A recurring team meeting where the learner needs to contribute updates, raise a point, and agree next steps with colleagues.',
    learnerRole: 'Team member contributing to the discussion',
    counterpartyRole: 'Team lead or facilitator running the meeting',
    objective:
      'Contribute clearly to the meeting, make at least one point, and leave with agreed actions.',
    speakingGoals: [
      speaking('state-a-point', 'State a point of view clearly and briefly.'),
      speaking('agree-disagree', 'Agree or disagree politely with reasoning.'),
      speaking('summarise-actions', 'Summarise the agreed actions at the end.'),
    ],
    languageGoals: [
      language('turn-taking', 'Take and hold a turn with natural openers.'),
      language('hedging', 'Hedge claims appropriately ("I would suggest", "it seems").'),
    ],
    targetExpressions: [
      'Could I add one point here?',
      'I see it slightly differently because...',
      'Shall we capture that as an action?',
      'To summarise where we landed...',
    ],
    challengeEvents: [
      challenge('interruption', 1, 'A colleague interrupts before the point is finished.'),
      challenge('disagree-with-role', 2, 'The facilitator pushes back and asks you to justify.'),
    ],
    practiceType: 'structured_exchange',
    difficulty: {
      band: 'simple',
      reasoning: 'Everyday workplace exchange with familiar vocabulary and a supportive frame.',
    },
    coachingNotes: 'Keep turns short; praise clarity before fluency. Recast errors gently.',
  },
  {
    id: 'project_update',
    category: 'project_update',
    title: 'Giving a project status update',
    situation:
      'A short scheduled update in which the learner reports progress, blockers, and the plan for the coming period.',
    learnerRole: 'Project contributor delivering the update',
    counterpartyRole: 'Manager or project lead receiving the update',
    objective:
      'Report progress, one blocker, and the next step in a clear and confident structure.',
    speakingGoals: [
      speaking('structured-update', 'Deliver an update with a clear beginning, middle, and end.'),
      speaking('report-blocker', 'Report a blocker without sounding defensive.'),
      speaking('propose-next-step', 'Propose a concrete next step and timeline.'),
    ],
    languageGoals: [
      language('progress-tenses', 'Use present perfect and present continuous accurately.'),
      language('softening', 'Soften problems using "slightly behind", "we may need to".'),
    ],
    targetExpressions: [
      'On track for the end of the month.',
      'We are slightly behind on the second milestone.',
      'The main blocker is...',
      'My proposed next step is...',
    ],
    challengeEvents: [
      challenge('scope-question', 1, 'The manager asks whether scope has changed.'),
      challenge('timeline-pressure', 2, 'The manager pushes for an earlier delivery date.'),
    ],
    practiceType: 'guided_dialogue',
    difficulty: {
      band: 'moderate',
      reasoning: 'Requires sequencing and accurate tense use under light pressure.',
    },
    coachingNotes: 'Model the update skeleton first, then let the learner run it unaided.',
  },
  {
    id: 'presentation',
    category: 'presentation',
    title: 'Delivering a short presentation',
    situation:
      'The learner presents a topic to an audience and responds to questions afterwards.',
    learnerRole: 'Presenter',
    counterpartyRole: 'Audience member who asks questions',
    objective:
      'Present the main ideas in a logical order, signpost clearly, and handle one question.',
    speakingGoals: [
      speaking('signpost', 'Signpost the structure of the talk.'),
      speaking('explain-idea', 'Explain an idea so a non-expert can follow it.'),
      speaking('handle-question', 'Respond to an audience question confidently.'),
    ],
    languageGoals: [
      language('discourse-markers', 'Use signposting language ("firstly", "moving on").'),
      language('emphasis', 'Emphasise key points with stress and repetition.'),
    ],
    targetExpressions: [
      "I'll begin with the background, then move to the results.",
      'What this really comes down to is...',
      'That is a fair question — let me address it directly.',
      'To wrap up, the key takeaway is...',
    ],
    challengeEvents: [
      challenge('audience-question', 1, 'An audience member asks an unclear question.'),
      challenge('time-cut', 2, 'The learner is told to cut the talk short mid-way.'),
    ],
    practiceType: 'prepared_monologue',
    difficulty: {
      band: 'moderate',
      reasoning: 'Monologic fluency plus spontaneous question handling.',
    },
    coachingNotes: 'Work on signposting and pacing; interrupt only to sharpen structure.',
  },
  {
    id: 'interview',
    category: 'interview',
    title: 'Answering interview questions',
    situation:
      'A job or project interview in which the learner answers experience and motivation questions.',
    learnerRole: 'Candidate',
    counterpartyRole: 'Interviewer',
    objective:
      'Answer questions using concrete examples and ask one thoughtful question back.',
    speakingGoals: [
      speaking('star-answer', 'Structure an answer with situation, action, and result.'),
      speaking('describe-strength', 'Describe a relevant strength with evidence.'),
      speaking('ask-question', 'Ask a thoughtful question about the role.'),
    ],
    languageGoals: [
      language('past-narrative', 'Narrate past experience fluently.'),
      language('professional-register', 'Maintain a confident professional register.'),
    ],
    targetExpressions: [
      'In a previous role, I was responsible for...',
      'One example that comes to mind is...',
      'What I took away from that was...',
      'Could you tell me more about how success is measured?',
    ],
    challengeEvents: [
      challenge('weakness-question', 1, 'The interviewer asks about a weakness.'),
      challenge('pressure-question', 2, 'The interviewer challenges a claim made earlier.'),
    ],
    practiceType: 'question_and_answer',
    difficulty: {
      band: 'moderate',
      reasoning: 'High-stakes register with spontaneous, evidence-based answers.',
    },
    coachingNotes: 'Push for concrete evidence; rehearse the STAR shape without scripting it.',
  },
  {
    id: 'negotiation',
    category: 'negotiation',
    title: 'Negotiating terms',
    situation:
      'The learner negotiates a price, deadline, or scope with a counterparty who has different priorities.',
    learnerRole: 'Negotiator representing their side',
    counterpartyRole: 'Counterparty with an opposing interest',
    objective:
      'State a position, respond to a counter-offer, and reach a workable compromise.',
    speakingGoals: [
      speaking('state-position', 'State a position clearly and calmly.'),
      speaking('counter-offer', 'Respond to a counter-offer without conceding everything.'),
      speaking('close-agreement', 'Confirm the agreed terms precisely.'),
    ],
    languageGoals: [
      language('conditionals', 'Use conditional offers ("if you could..., we would...").'),
      language('polite-firmness', 'Stay polite while holding a position.'),
    ],
    targetExpressions: [
      'I understand your position, however...',
      'If you could meet us on timing, we could move on price.',
      'That is workable, provided that...',
      'Just so we are clear, we have agreed that...',
    ],
    challengeEvents: [
      challenge('lowball-offer', 1, 'The counterparty makes an unreasonably low offer.'),
      challenge('deadlock', 2, 'Negotiation reaches an apparent deadlock.'),
    ],
    practiceType: 'role_play',
    difficulty: {
      band: 'complex',
      reasoning: 'Requires conditionals, tact, and strategy under direct pressure.',
    },
    coachingNotes: 'Let tension build before coaching; debrief strategy after the exchange.',
  },
  {
    id: 'client_discussion',
    category: 'client_discussion',
    title: 'Discussing needs with a client',
    situation:
      'A conversation with a client to understand their needs, clarify expectations, and agree how to proceed.',
    learnerRole: 'Service provider talking with the client',
    counterpartyRole: 'Client with expectations to clarify',
    objective:
      'Uncover the client’s real need, clarify expectations, and agree a next step.',
    speakingGoals: [
      speaking('ask-needs', 'Ask open questions to uncover the client’s need.'),
      speaking('clarify-expectations', 'Clarify expectations without over-promising.'),
      speaking('confirm-next-step', 'Confirm the next step with the client.'),
    ],
    languageGoals: [
      language('open-questions', 'Use open questions to explore needs.'),
      language('positive-tone', 'Maintain a warm, positive, professional tone.'),
    ],
    targetExpressions: [
      'What would a good outcome look like for you?',
      'Just to make sure I understand...',
      'What we can commit to at this stage is...',
      "I'll follow up with that by Friday.",
    ],
    challengeEvents: [
      challenge('changed-request', 1, 'The client changes a requirement mid-conversation.'),
      challenge('unrealistic-deadline', 2, 'The client demands an unrealistic deadline.'),
    ],
    practiceType: 'simulated_call',
    difficulty: {
      band: 'moderate',
      reasoning: 'Relationship management plus clear expectation setting.',
    },
    coachingNotes: 'Reward active listening; flag any moment the learner over-promises.',
  },
  {
    id: 'stakeholder_discussion',
    category: 'stakeholder_discussion',
    title: 'Aligning with stakeholders',
    situation:
      'A discussion with stakeholders who have competing priorities that the learner must balance.',
    learnerRole: 'Project or product owner facilitating alignment',
    counterpartyRole: 'Stakeholder advocating a competing priority',
    objective:
      'Acknowledge competing priorities, explain a trade-off, and steer towards alignment.',
    speakingGoals: [
      speaking('acknowledge-priority', 'Acknowledge another party’s priority sincerely.'),
      speaking('explain-tradeoff', 'Explain a trade-off plainly and diplomatically.'),
      speaking('build-alignment', 'Move the group towards a shared decision.'),
    ],
    languageGoals: [
      language('balancing', 'Balance viewpoints with contrastive structures.'),
      language('diplomatic-language', 'Use diplomatic language for disagreement.'),
    ],
    targetExpressions: [
      'I can see why that matters to your team.',
      'The trade-off here is between...',
      'Could we find a way to do both, even partially?',
      'Let us agree on the priority for this cycle.',
    ],
    challengeEvents: [
      challenge('conflicting-goal', 1, 'A stakeholder argues for a conflicting goal.'),
      challenge('escalation-threat', 2, 'A stakeholder threatens to escalate the issue.'),
    ],
    practiceType: 'structured_exchange',
    difficulty: {
      band: 'complex',
      reasoning: 'Multiple interests, diplomatic register, and visible conflict.',
    },
    coachingNotes: 'Focus on tone and diplomatic framing; debrief the trade-off logic.',
  },
  {
    id: 'problem_solving',
    category: 'problem_solving',
    title: 'Working through a problem',
    situation:
      'The learner and a colleague diagnose an unexpected problem and agree a solution.',
    learnerRole: 'Colleague diagnosing the problem',
    counterpartyRole: 'Colleague proposing hypotheses',
    objective:
      'Describe the problem, weigh options with a colleague, and agree a solution.',
    speakingGoals: [
      speaking('describe-problem', 'Describe a problem precisely and factually.'),
      speaking('weigh-options', 'Weigh two or three options aloud.'),
      speaking('agree-solution', 'Agree a solution and who will do what.'),
    ],
    languageGoals: [
      language('cause-effect', 'Express cause and effect clearly.'),
      language('hypothesising', 'Hypothesise ("it might be because...").'),
    ],
    targetExpressions: [
      'What seems to be happening is...',
      'One possibility is that...',
      'If we rule that out, we are left with...',
      'So the plan is X, and you will handle Y.',
    ],
    challengeEvents: [
      challenge('wrong-hypothesis', 1, 'The colleague’s first hypothesis is wrong.'),
      challenge('new-symptom', 2, 'A new symptom appears that changes the diagnosis.'),
    ],
    practiceType: 'open_discussion',
    difficulty: {
      band: 'moderate',
      reasoning: 'Analytical language with a collaborative, spontaneous structure.',
    },
    coachingNotes: 'Encourage precise hypotheses; correct vague cause-effect language.',
  },
  {
    id: 'reporting',
    category: 'reporting',
    title: 'Reporting findings',
    situation:
      'The learner reports findings or results to colleagues, summarising evidence and implications.',
    learnerRole: 'Analyst or specialist reporting findings',
    counterpartyRole: 'Colleague asking for the headline and implications',
    objective:
      'Report findings objectively, highlight the key implication, and answer one follow-up.',
    speakingGoals: [
      speaking('headline', 'Lead with the headline finding.'),
      speaking('report-evidence', 'Report evidence neutrally and accurately.'),
      speaking('state-implication', 'State the implication for the team.'),
    ],
    languageGoals: [
      language('reporting-verbs', 'Use reporting verbs ("shows", "suggests", "indicates").'),
      language('degree', 'Express degree of certainty precisely.'),
    ],
    targetExpressions: [
      'The headline is that...',
      'The data suggests, though it does not prove...',
      'What this means for us is...',
      'That is a reasonable question — the short answer is...',
    ],
    challengeEvents: [
      challenge('challenge-data', 1, 'The colleague questions the reliability of the data.'),
      challenge('ask-more-detail', 2, 'The colleague asks for detail beyond the summary.'),
    ],
    practiceType: 'guided_dialogue',
    difficulty: {
      band: 'moderate',
      reasoning: 'Objective reporting with precision and hedging language.',
    },
    coachingNotes: 'Insist on neutral wording; discourage overclaiming.',
  },
  {
    id: 'email_discussion',
    category: 'email_discussion',
    title: 'Following up on an email thread',
    situation:
      'The learner turns a written email thread into a spoken follow-up, clarifying what was discussed.',
    learnerRole: 'Sender following up in conversation',
    counterpartyRole: 'Recipient who sent the replies',
    objective:
      'Summarise the email thread aloud, clarify one point, and agree what happens next.',
    speakingGoals: [
      speaking('summarise-thread', 'Summarise a written thread orally.'),
      speaking('clarify-point', 'Clarify one ambiguous point from the thread.'),
      speaking('confirm-next', 'Confirm in speech what was agreed in writing.'),
    ],
    languageGoals: [
      language('reported-speech', 'Report what was written using reported speech.'),
      language('paraphrase', 'Paraphrase formal written language into speech.'),
    ],
    targetExpressions: [
      'In your email you mentioned that...',
      'If I understood your note correctly...',
      'To avoid any misunderstanding...',
      'So, to confirm in person, we agreed that...',
    ],
    challengeEvents: [
      challenge('contradiction', 1, 'The counterparty recalls the thread differently.'),
      challenge('new-ask', 2, 'The counterparty adds a new request from the thread.'),
    ],
    practiceType: 'structured_exchange',
    difficulty: {
      band: 'moderate',
      reasoning: 'Shifts register between written and spoken forms.',
    },
    coachingNotes: 'Practise converting formal writing into natural speech.',
  },
  {
    id: 'site_discussion',
    category: 'site_discussion',
    title: 'Discussing work on site',
    situation:
      'A general on-site style discussion where the learner coordinates practical work with a counterparty. '
      + 'The scenario is deliberately field-agnostic and works for any hands-on or operational setting.',
    learnerRole: 'Person coordinating the work in the field',
    counterpartyRole: 'Counterparty carrying out or supervising the work',
    objective:
      'Explain the requirement clearly, check understanding, and agree how to proceed safely and practically.',
    speakingGoals: [
      speaking('explain-requirement', 'Explain a practical requirement clearly.'),
      speaking('check-understanding', 'Check that the other person understood.'),
      speaking('agree-practical-plan', 'Agree a practical plan of action on the spot.'),
    ],
    languageGoals: [
      language('instructions', 'Give clear, sequenced instructions.'),
      language('confirmation-checks', 'Use confirmation checks ("does that make sense?").'),
    ],
    targetExpressions: [
      'What I need is for us to start with...',
      'Let me show you what I mean.',
      'Does that make sense so far?',
      'So the practical plan is...',
    ],
    challengeEvents: [
      challenge('misunderstanding', 1, 'The counterparty misunderstands the instruction.'),
      challenge('obstacle-onsite', 2, 'An unexpected obstacle changes the plan.'),
    ],
    practiceType: 'role_play',
    difficulty: {
      band: 'moderate',
      reasoning: 'Practical coordination with clear, sequenced language.',
    },
    coachingNotes: 'Prioritise clarity and confirmation checks over fluency.',
  },
  {
    id: 'claim_discussion',
    category: 'claim_discussion',
    title: 'Handling a claim or complaint',
    situation:
      'The learner responds to a claim or complaint, gathering facts and proposing a resolution.',
    learnerRole: 'Person handling the claim',
    counterpartyRole: 'Person raising the claim',
    objective:
      'Hear the complaint fairly, ask for the facts, and propose a reasonable resolution.',
    speakingGoals: [
      speaking('acknowledge-concern', 'Acknowledge the complaint without admitting fault.'),
      speaking('gather-facts', 'Ask precise questions to gather the facts.'),
      speaking('propose-resolution', 'Propose a resolution that is realistic.'),
    ],
    languageGoals: [
      language('empathetic-language', 'Use empathetic, calm language.'),
      language('neutral-framing', 'Frame the issue neutrally, without blame.'),
    ],
    targetExpressions: [
      'I am sorry to hear that — let me understand what happened.',
      'Could you walk me through the sequence of events?',
      'What I can do for you is...',
      'Let me confirm what we have agreed today.',
    ],
    challengeEvents: [
      challenge('escalating-tone', 1, 'The claimant’s tone becomes more heated.'),
      challenge('demand-compensation', 2, 'The claimant demands more than you can offer.'),
    ],
    practiceType: 'simulated_call',
    difficulty: {
      band: 'complex',
      reasoning: 'Emotionally charged, tactful, and resolution-focused.',
    },
    coachingNotes: 'Model calm empathetic openings; debrief the wording of refusals.',
  },
  {
    id: 'contract_discussion',
    category: 'contract_discussion',
    title: 'Clarifying terms of an agreement',
    situation:
      'A discussion in which the learner and a counterparty clarify obligations and terms of an agreement.',
    learnerRole: 'Person responsible for their side of the agreement',
    counterpartyRole: 'Counterparty clarifying obligations',
    objective:
      'Clarify two terms precisely, confirm obligations, and note anything still open.',
    speakingGoals: [
      speaking('clarify-term', 'Clarify a specific term or clause.'),
      speaking('confirm-obligation', 'Confirm an obligation clearly.'),
      speaking('flag-open-item', 'Flag an item that remains open.'),
    ],
    languageGoals: [
      language('modal-obligation', 'Express obligation and permission exactly.'),
      language('precision', 'Use precise, unambiguous wording.'),
    ],
    targetExpressions: [
      'Just so we are both clear on the wording...',
      'Who is responsible for that, in practice?',
      'That is still open from my side.',
      'Let us note that as an outstanding item.',
    ],
    challengeEvents: [
      challenge('ambiguous-clause', 1, 'A clause is ambiguous and needs interpretation.'),
      challenge('disputed-obligation', 2, 'The counterparty disputes who owns an obligation.'),
    ],
    practiceType: 'structured_exchange',
    difficulty: {
      band: 'complex',
      reasoning: 'Precise legal-adjacent language and careful framing.',
    },
    coachingNotes: 'Stress accuracy over speed; flag ambiguity in the learner’s wording.',
  },
  {
    id: 'technical_explanation',
    category: 'technical_explanation',
    title: 'Explaining something technical',
    situation:
      'The learner explains a technical topic to a non-expert, adapting the level of detail.',
    learnerRole: 'Specialist explaining the topic',
    counterpartyRole: 'Non-expert asking for a simpler explanation',
    objective:
      'Explain the concept clearly for a non-expert, then check understanding and adjust.',
    speakingGoals: [
      speaking('simplify', 'Simplify a technical idea without distorting it.'),
      speaking('analogy', 'Use an analogy or example to aid understanding.'),
      speaking('adapt-level', 'Adjust the level of detail based on the listener.'),
    ],
    languageGoals: [
      language('defining', 'Define terms in plain language.'),
      language('clause-connections', 'Connect ideas with clear cause and contrast.'),
    ],
    targetExpressions: [
      'In simple terms, what happens is...',
      'Think of it a bit like...',
      'I am glossing over some detail there — shall I go deeper?',
      'Does that picture make sense to you?',
    ],
    challengeEvents: [
      challenge('confused-listener', 1, 'The listener says the explanation is too complex.'),
      challenge('skeptical-question', 2, 'The listener challenges the technical claim.'),
    ],
    practiceType: 'open_discussion',
    difficulty: {
      band: 'moderate',
      reasoning: 'Register adjustment and plain-language explanation.',
    },
    coachingNotes: 'Reward genuine simplification; push back on jargon dumping.',
  },
  {
    id: 'leadership_conversation',
    category: 'leadership_conversation',
    title: 'Leading a conversation',
    situation:
      'The learner, as a lead, holds a conversation that guides a team member or sets direction.',
    learnerRole: 'Lead or manager setting direction',
    counterpartyRole: 'Team member seeking clarity and support',
    objective:
      'Set a clear direction, acknowledge the other person’s view, and agree a commitment.',
    speakingGoals: [
      speaking('set-direction', 'Set direction clearly and decisively.'),
      speaking('acknowledge-view', 'Acknowledge the other person’s perspective.'),
      speaking('secure-commitment', 'Secure a clear commitment to the next step.'),
    ],
    languageGoals: [
      language('decisive-language', 'Use decisive, confident language.'),
      language('inclusive-framing', 'Use inclusive framing ("what we can achieve together").'),
    ],
    targetExpressions: [
      'Here is where I would like us to focus.',
      'How does that land with you?',
      'What would help you to make that happen?',
      'So we are both committing to that by next week.',
    ],
    challengeEvents: [
      challenge('pushback', 1, 'The team member pushes back on the direction.'),
      challenge('morale-issue', 2, 'The team member raises low morale or overload.'),
    ],
    practiceType: 'open_discussion',
    difficulty: {
      band: 'complex',
      reasoning: 'Balances authority, empathy, and clarity of commitment.',
    },
    coachingNotes: 'Watch the balance of authority and empathy; debrief the commitment step.',
  },
];

/** Look up a scenario definition by id. */
export function getScenario(category: ScenarioCategory): ScenarioDefinition | undefined {
  return SCENARIOS.find((scenario) => scenario.id === category);
}

/**
 * A general-purpose fallback used when no scenario matches the requested
 * category. It keeps the architecture general instead of assuming any
 * particular profession or industry.
 */
export const GENERAL_SCENARIO: ScenarioDefinition = {
  id: 'meeting',
  category: 'meeting',
  title: 'General professional conversation',
  situation:
    'A general professional conversation in which the learner practises clear, confident communication.',
  learnerRole: 'Professional communicating with a counterparty',
  counterpartyRole: 'Professional counterparty',
  objective:
    'Communicate a message clearly, respond to the counterparty, and confirm understanding.',
  speakingGoals: [
    speaking('communicate-clearly', 'Communicate a message clearly and concisely.'),
    speaking('respond', 'Respond appropriately to a counterparty.'),
    speaking('confirm', 'Confirm understanding at the end.'),
  ],
  languageGoals: [
    language('functional-range', 'Use a range of functional language.'),
    language('polite-register', 'Maintain an appropriate professional register.'),
  ],
  targetExpressions: [
    'What I would like to discuss today is...',
    'Just to make sure, what I understand is...',
    'Could you clarify that point?',
    'Does that work for you?',
  ],
  challengeEvents: [
    challenge('clarify-and-confirm', 0, 'Ask a clarifying question and confirm understanding.'),
    challenge('unexpected-change', 1, 'The counterparty changes a detail unexpectedly.'),
  ],
  practiceType: 'guided_dialogue',
  difficulty: {
    band: 'simple',
    reasoning: 'General professional framing that can be adapted to many fields.',
  },
  coachingNotes: 'Keep it general; let the learner choose the topic and build confidence.',
};

/** Difficulty ranking, exported for reuse by the planner and tests. */
export const DIFFICULTY_RANK: Record<'simple' | 'moderate' | 'complex', number> = {
  simple: 0,
  moderate: 1,
  complex: 2,
};
