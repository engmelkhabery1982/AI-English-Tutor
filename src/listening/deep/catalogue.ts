/**
 * src/listening/deep/catalogue.ts
 *
 * WP-2 — the DETERMINISTIC deep-listening catalogue.
 *
 * This is the honest fallback material the engine serves when generated
 * material is unavailable, invalid or declined: real, bounded discourse, real
 * connected-speech pairs and real shadowing chunks, all clearly labelled
 * GENERAL (never presented as personalized).
 *
 * Every entry is authored so it satisfies EXACTLY the same strict contract the
 * deterministic validator applies to model output (length bounds, answers
 * really present in the passage, evidence ids that exist, options that contain
 * the answer, unambiguous speaker attribution). The test suite proves that by
 * running each entry back through the validator.
 *
 * Authoring rules kept deliberately:
 * - answers are short phrases that really occur in the cited evidence;
 * - questions never contain their own answer;
 * - a `speaker_intention` answer occurs only in the referenced speaker's own
 *   segments, so attribution is never ambiguous;
 * - connected-speech realizations are ordinary-letter respellings of natural
 *   speech, never phonetic notation, and the CANONICAL written form is always
 *   the answer;
 * - nothing here claims ability, level, score or speed in words per minute.
 */

import type {
  ComprehensionQuestion,
  ConnectedSpeechItem,
  DiscourseKind,
  DiscourseSegment,
  DiscourseSpeaker,
} from './types';
import type { DeepListeningRequest } from './request';
import type {
  ValidatedConnectedSpeechMaterial,
  ValidatedDiscourseMaterial,
  ValidatedShadowingMaterial,
} from './validation';

/* ------------------------------------------------------------------ *
 * Discourse
 * ------------------------------------------------------------------ */

/** The authored shape of one discourse entry. */
export interface DiscourseCatalogueEntry {
  readonly id: string;
  readonly discourseKind: DiscourseKind;
  /** True when the entry really contains 2+ speakers with content. */
  readonly multiSpeaker: boolean;
  readonly speakers: readonly DiscourseSpeaker[];
  readonly segments: readonly DiscourseSegment[];
  readonly questions: readonly ComprehensionQuestion[];
  readonly explanation: string;
  readonly keyItems: readonly string[];
}

const SHORT_STORY: DiscourseCatalogueEntry = {
  id: 'discourse.short_story',
  discourseKind: 'short_story',
  multiSpeaker: false,
  speakers: [{ id: 'narrator', label: 'Narrator' }],
  segments: [
    {
      id: 't1',
      speakerId: 'narrator',
      text: 'Last Saturday Emma walked to the market to buy bread for her sister.',
    },
    {
      id: 't2',
      speakerId: 'narrator',
      text: 'On the way she found a small brown dog sitting beside the bus stop.',
    },
    {
      id: 't3',
      speakerId: 'narrator',
      text: 'The dog followed her for two streets, so she decided to take it home.',
    },
    {
      id: 't4',
      speakerId: 'narrator',
      text: 'Her sister named it Biscuit, and the family came to see it that evening.',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'main_idea',
      prompt: 'What is this story mainly about?',
      expectedAnswer: 'she found a small brown dog',
      options: [
        'she found a small brown dog',
        'she bought bread for her sister',
        'she missed the bus home',
      ],
      evidenceSegmentIds: ['t2'],
      explanation: 'Tip: the main idea is usually the event that starts the rest of the story.',
    },
    {
      id: 'q2',
      kind: 'detail',
      prompt: 'Why did Emma walk to the market?',
      expectedAnswer: 'to buy bread for her sister',
      evidenceSegmentIds: ['t1'],
      explanation: 'Tip: listen for the reason at the end of the first sentence.',
    },
    {
      id: 'q3',
      kind: 'sequencing',
      prompt: 'What happened right after the dog followed her for two streets?',
      expectedAnswer: 'she decided to take it home',
      evidenceSegmentIds: ['t3'],
      explanation: 'Tip: listen for the word that links one action to the next.',
    },
  ],
  explanation: 'Tip: a short story keeps its main events in order — listen for what happens next.',
  keyItems: ['market', 'bread', 'dog'],
};

const TRAVEL_SITUATION: DiscourseCatalogueEntry = {
  id: 'discourse.travel_situation',
  discourseKind: 'travel_situation',
  multiSpeaker: true,
  speakers: [
    { id: 'traveller', label: 'Traveller' },
    { id: 'agent', label: 'Agent' },
  ],
  segments: [
    {
      id: 't1',
      speakerId: 'traveller',
      text: 'Hello, my flight to Lisbon was cancelled this morning.',
    },
    {
      id: 't2',
      speakerId: 'agent',
      text: 'I can see that here. The next free seat is on tomorrow\u2019s early flight.',
    },
    {
      id: 't3',
      speakerId: 'traveller',
      text: 'Tomorrow is too late. I have a meeting in the afternoon.',
    },
    {
      id: 't4',
      speakerId: 'agent',
      text: 'Then let me check another airline for you before we rebook anything.',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'main_idea',
      prompt: 'What is the traveller\u2019s problem?',
      expectedAnswer: 'flight to Lisbon was cancelled',
      options: [
        'flight to Lisbon was cancelled',
        'tomorrow is too late',
        'the hotel lost the booking',
      ],
      evidenceSegmentIds: ['t1'],
      explanation: 'Tip: the first speaker usually states the problem they came to solve.',
    },
    {
      id: 'q2',
      kind: 'detail',
      prompt: 'What does the agent offer first?',
      expectedAnswer: 'tomorrow\u2019s early flight',
      evidenceSegmentIds: ['t2'],
      explanation: 'Tip: listen for the option that is offered before any question is asked.',
    },
    {
      id: 'q3',
      kind: 'speaker_intention',
      prompt: 'What does the traveller say is too late for him?',
      expectedAnswer: 'a meeting in the afternoon',
      speakerId: 'traveller',
      evidenceSegmentIds: ['t3'],
      explanation: 'Tip: the reason a speaker refuses something shows what really matters to them.',
    },
  ],
  explanation:
    'Tip: in a service conversation, the first speaker states the problem and the second offers options.',
  keyItems: ['cancelled', 'flight', 'meeting'],
};

const WORKPLACE_EXPLANATION: DiscourseCatalogueEntry = {
  id: 'discourse.workplace_explanation',
  discourseKind: 'workplace_explanation',
  multiSpeaker: true,
  speakers: [
    { id: 'manager', label: 'Manager' },
    { id: 'developer', label: 'Developer' },
  ],
  segments: [
    {
      id: 't1',
      speakerId: 'manager',
      text: 'The client asked us to move the launch to the end of the month.',
    },
    {
      id: 't2',
      speakerId: 'developer',
      text: 'That gives us three extra weeks to finish the reporting screens.',
    },
    {
      id: 't3',
      speakerId: 'manager',
      text: 'Please send the new dates to support so they can update the help pages.',
    },
    {
      id: 't4',
      speakerId: 'developer',
      text: 'I will do that today, right after I check the payment fixes.',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'main_idea',
      prompt: 'What are the two speakers discussing?',
      expectedAnswer: 'move the launch to the end of the month',
      options: [
        'move the launch to the end of the month',
        'hire another developer',
        'cancel the reporting screens',
      ],
      evidenceSegmentIds: ['t1'],
      explanation: 'Tip: the first sentence usually names the change being discussed.',
    },
    {
      id: 'q2',
      kind: 'detail',
      prompt: 'What does the developer still need to finish?',
      expectedAnswer: 'the reporting screens',
      evidenceSegmentIds: ['t2'],
      explanation: 'Tip: listen for what the extra time will be used for.',
    },
    {
      id: 'q3',
      kind: 'speaker_intention',
      prompt: 'What does the manager ask the developer to do?',
      expectedAnswer: 'send the new dates to support',
      speakerId: 'manager',
      evidenceSegmentIds: ['t3'],
      explanation: 'Tip: when someone says "please", the next words are the request.',
    },
  ],
  explanation: 'Tip: in workplace conversations, the request usually comes from the more senior speaker.',
  keyItems: ['launch', 'reporting screens', 'dates'],
};

const MEETING_EXCERPT: DiscourseCatalogueEntry = {
  id: 'discourse.meeting_excerpt',
  discourseKind: 'meeting_excerpt',
  multiSpeaker: true,
  speakers: [
    { id: 'chair', label: 'Chair' },
    { id: 'designer', label: 'Designer' },
  ],
  segments: [
    {
      id: 't1',
      speakerId: 'chair',
      text: 'Before we finish, who can own the customer survey next week?',
    },
    {
      id: 't2',
      speakerId: 'designer',
      text: 'I can take it, but I would need the results by Thursday.',
    },
    {
      id: 't3',
      speakerId: 'chair',
      text: 'Fair point. Let us agree that the survey closes on Wednesday.',
    },
    {
      id: 't4',
      speakerId: 'designer',
      text: 'Then I will bring a short summary to the next meeting.',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'main_idea',
      prompt: 'What are the speakers deciding?',
      expectedAnswer: 'who can own the customer survey',
      options: [
        'who can own the customer survey',
        'when the office will close',
        'which designer will leave the team',
      ],
      evidenceSegmentIds: ['t1'],
      explanation: 'Tip: a meeting excerpt usually opens with the decision at hand.',
    },
    {
      id: 'q2',
      kind: 'detail',
      prompt: 'By which day will the survey close?',
      expectedAnswer: 'Wednesday',
      evidenceSegmentIds: ['t3'],
      explanation: 'Tip: listen for the day the speakers finally agree on.',
    },
    {
      id: 'q3',
      kind: 'speaker_intention',
      prompt: 'What does the designer say she would need first?',
      expectedAnswer: 'the results by Thursday',
      speakerId: 'designer',
      evidenceSegmentIds: ['t2'],
      explanation: 'Tip: "but" usually introduces the condition a speaker needs.',
    },
  ],
  explanation: 'Tip: in meetings, agreement is often marked by "let us agree" or "fair point".',
  keyItems: ['survey', 'Thursday', 'summary'],
};

const PROCESS_EXPLANATION: DiscourseCatalogueEntry = {
  id: 'discourse.process_explanation',
  discourseKind: 'process_explanation',
  multiSpeaker: false,
  speakers: [{ id: 'narrator', label: 'Presenter' }],
  segments: [
    {
      id: 't1',
      speakerId: 'narrator',
      text: 'First wash the beans and leave them to dry in the shade.',
    },
    {
      id: 't2',
      speakerId: 'narrator',
      text: 'Next weigh them and write the weight on the paper bag.',
    },
    {
      id: 't3',
      speakerId: 'narrator',
      text: 'After that store the bags somewhere cool and dry for two weeks.',
    },
    {
      id: 't4',
      speakerId: 'narrator',
      text: 'Finally check every bag for damp before you send them out.',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'main_idea',
      prompt: 'What is this explanation about?',
      expectedAnswer: 'wash the beans and leave them to dry',
      options: [
        'wash the beans and leave them to dry',
        'sell coffee in a local market',
        'repair broken paper bags',
      ],
      evidenceSegmentIds: ['t1'],
      explanation: 'Tip: a process explanation starts with its first step.',
    },
    {
      id: 'q2',
      kind: 'detail',
      prompt: 'Where should the bags be stored?',
      expectedAnswer: 'somewhere cool and dry',
      evidenceSegmentIds: ['t3'],
      explanation: 'Tip: listen for the place words in the middle steps.',
    },
    {
      id: 'q3',
      kind: 'sequencing',
      prompt: 'What is the last check before the bags are sent out?',
      expectedAnswer: 'check every bag for damp',
      evidenceSegmentIds: ['t4'],
      explanation: 'Tip: "finally" marks the last step of a process.',
    },
  ],
  explanation: 'Tip: process words such as first, next and finally show the order of the steps.',
  keyItems: ['beans', 'weight', 'damp'],
};

const OPINION_NARRATIVE: DiscourseCatalogueEntry = {
  id: 'discourse.opinion_narrative',
  discourseKind: 'opinion_narrative',
  multiSpeaker: false,
  speakers: [{ id: 'narrator', label: 'Speaker' }],
  segments: [
    {
      id: 't1',
      speakerId: 'narrator',
      text: 'I used to think working from home was quieter in every way.',
    },
    {
      id: 't2',
      speakerId: 'narrator',
      text: 'Then I noticed that I missed hearing what my colleagues were doing.',
    },
    {
      id: 't3',
      speakerId: 'narrator',
      text: 'Now I go to the office twice a week and work from home on other days.',
    },
    {
      id: 't4',
      speakerId: 'narrator',
      text: 'That balance finally taught me that neither way is simply better.',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'main_idea',
      prompt: 'What does the speaker believe now?',
      expectedAnswer: 'neither way is simply better',
      options: [
        'neither way is simply better',
        'working from home is always quieter',
        'the office is always too noisy',
      ],
      evidenceSegmentIds: ['t4'],
      explanation: 'Tip: an opinion speaker usually states the changed view at the end.',
    },
    {
      id: 'q2',
      kind: 'inference',
      prompt: 'What made the speaker change their routine?',
      expectedAnswer: 'I missed hearing what my colleagues were doing',
      evidenceSegmentIds: ['t2'],
      explanation: 'Tip: the reason for a change often follows "then I noticed".',
    },
    {
      id: 'q3',
      kind: 'vocabulary_in_context',
      prompt: 'What does "balance" describe here?',
      expectedAnswer: 'go to the office twice a week',
      acceptableAnswers: ['go to the office twice a week and work from home on other days'],
      options: [
        'go to the office twice a week',
        'work only from home',
        'stop working in an office',
      ],
      evidenceSegmentIds: ['t3'],
      explanation: 'Tip: "balance" means taking some of each option, not only one.',
    },
  ],
  explanation: 'Tip: in an opinion narrative, the position often changes between the start and the end.',
  keyItems: ['quieter', 'colleagues', 'balance'],
};

const PROFESSIONAL_BRIEFING: DiscourseCatalogueEntry = {
  id: 'discourse.professional_briefing',
  discourseKind: 'professional_briefing',
  multiSpeaker: true,
  speakers: [
    { id: 'lead', label: 'Project lead' },
    { id: 'analyst', label: 'Analyst' },
  ],
  segments: [
    {
      id: 't1',
      speakerId: 'lead',
      text: 'The pilot finished last week and the numbers are ready for review.',
    },
    {
      id: 't2',
      speakerId: 'analyst',
      text: 'Support tickets dropped by a third once the new form went live.',
    },
    {
      id: 't3',
      speakerId: 'lead',
      text: 'Good. Then we should propose rolling it out to the other regions.',
    },
    {
      id: 't4',
      speakerId: 'analyst',
      text: 'I would wait one more month, because two regions report differently.',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'main_idea',
      prompt: 'What is being reviewed in this briefing?',
      expectedAnswer: 'the numbers are ready for review',
      options: [
        'the numbers are ready for review',
        'the price of the new form',
        'who will lead the pilot',
      ],
      evidenceSegmentIds: ['t1'],
      explanation: 'Tip: a briefing opens by naming what has been measured.',
    },
    {
      id: 'q2',
      kind: 'detail',
      prompt: 'What happened when the new form went live?',
      expectedAnswer: 'Support tickets dropped by a third',
      evidenceSegmentIds: ['t2'],
      explanation: 'Tip: listen for the measurable change the analyst reports.',
    },
    {
      id: 'q3',
      kind: 'speaker_intention',
      prompt: 'Why does the analyst suggest waiting?',
      expectedAnswer: 'two regions report differently',
      speakerId: 'analyst',
      evidenceSegmentIds: ['t4'],
      explanation: 'Tip: the reason after "because" is the speaker\u2019s real concern.',
    },
  ],
  explanation: 'Tip: in briefings, one speaker proposes and another adds the condition.',
  keyItems: ['pilot', 'Support tickets', 'regions'],
};

/** Every authored discourse entry, in stable order. */
export const DISCOURSE_CATALOGUE: readonly DiscourseCatalogueEntry[] = [
  SHORT_STORY,
  TRAVEL_SITUATION,
  WORKPLACE_EXPLANATION,
  MEETING_EXCERPT,
  PROCESS_EXPLANATION,
  OPINION_NARRATIVE,
  PROFESSIONAL_BRIEFING,
] as const;

/** Discourse kinds that really have 2+ speakers (usable for multi-speaker work). */
export const MULTI_SPEAKER_DISCOURSE_KINDS: readonly DiscourseKind[] =
  DISCOURSE_CATALOGUE.filter((entry) => entry.multiSpeaker).map((entry) => entry.discourseKind);

/** Discourse kinds that are served by one speaker. */
export const SOLO_DISCOURSE_KINDS: readonly DiscourseKind[] = DISCOURSE_CATALOGUE.filter(
  (entry) => !entry.multiSpeaker,
).map((entry) => entry.discourseKind);

/** Look up one authored entry by kind (deterministic). */
export function discourseEntryFor(kind: DiscourseKind): DiscourseCatalogueEntry | null {
  return DISCOURSE_CATALOGUE.find((entry) => entry.discourseKind === kind) ?? null;
}

/**
 * Build validated discourse material from the authored entry, bounded by the
 * request: questions are sliced to the request's maximum (importance order is
 * the authored order) and key items to the request's maximum. Segments are
 * NEVER truncated, because truncating discourse would risk phantom evidence.
 */
export function catalogueDiscourseMaterial(
  entry: DiscourseCatalogueEntry,
  request: DeepListeningRequest,
): ValidatedDiscourseMaterial {
  return {
    taskType: request.taskType === 'multi_speaker_dialogue' ? 'multi_speaker_dialogue' : 'long_discourse',
    discourseKind: entry.discourseKind,
    ...(request.context.topic !== undefined ? { contextTopic: request.context.topic } : {}),
    explanation: entry.explanation,
    speakers: entry.speakers,
    segments: entry.segments,
    questions: entry.questions.slice(0, request.bounds.maxQuestions),
    keyItems: entry.keyItems.slice(0, request.bounds.maxKeyItems),
  };
}

/* ------------------------------------------------------------------ *
 * Connected speech
 * ------------------------------------------------------------------ */

/**
 * Authored connected-speech items: ordinary-letter respellings only, the
 * CANONICAL written form is always the answer, and informal realizations are
 * labelled informal rather than taught as universally correct.
 */
export const CONNECTED_SPEECH_CATALOGUE: readonly ConnectedSpeechItem[] = [
  {
    id: 'cs.contraction.i_am',
    category: 'contraction',
    writtenForm: 'I am',
    spokenRealization: "I'm",
    register: 'neutral',
    form: 'contracted_form',
    prompt: 'Which standard written form matches what you heard?',
    expectedAnswer: 'I am',
    options: ['I am', 'I have', 'I will'],
    explanation: "In normal speech 'I am' is usually contracted to \"I'm\"; the standard written form stays 'I am'.",
  },
  {
    id: 'cs.reduction.going_to',
    category: 'reduction',
    writtenForm: 'going to',
    spokenRealization: 'gonna',
    register: 'informal',
    form: 'reduced_form',
    prompt: 'Which standard written form matches what you heard?',
    expectedAnswer: 'going to',
    options: ['going to', 'gone to', 'go to'],
    explanation:
      "In fast, relaxed speech 'going to' is often reduced to 'gonna'. It is informal, so the standard written form is 'going to'.",
  },
  {
    id: 'cs.weak_form.have_to',
    category: 'weak_form',
    writtenForm: 'have to',
    spokenRealization: 'hafta',
    register: 'informal',
    form: 'reduced_form',
    prompt: 'Which standard written form matches what you heard?',
    expectedAnswer: 'have to',
    options: ['have to', 'has to', 'had to'],
    explanation:
      "Relaxed speech often squeezes 'have to' into 'hafta'. It is informal, so the standard written form is 'have to'.",
  },
  {
    id: 'cs.elision.what_do_you',
    category: 'elision',
    writtenForm: 'what do you',
    spokenRealization: 'whaddaya',
    register: 'informal',
    form: 'reduced_form',
    prompt: 'Which standard written form matches what you heard?',
    expectedAnswer: 'what do you',
    options: ['what do you', 'what did you', 'where do you'],
    explanation:
      "In quick speech 'what do you' becomes 'whaddaya' because the middle sounds run together. The standard written form is 'what do you'.",
  },
  {
    id: 'cs.linking.get_out_of_here',
    category: 'linking',
    writtenForm: 'get out of here',
    spokenRealization: 'geddoutta here',
    register: 'informal',
    form: 'reduced_form',
    prompt: 'Which standard written form matches what you heard?',
    expectedAnswer: 'get out of here',
    options: ['get out of here', 'get out of there', 'go out of here'],
    explanation:
      "The words run together with no pause, so 'get out of here' sounds like 'geddoutta here'. The standard written form does not change.",
  },
];

/**
 * Build validated connected-speech material for the request: items are
 * filtered to the request's allowed categories and sliced to its maximum, in
 * the catalogue's stable order.
 */
export function catalogueConnectedSpeechMaterial(
  request: DeepListeningRequest,
): ValidatedConnectedSpeechMaterial {
  const allowed = CONNECTED_SPEECH_CATALOGUE.filter((item) =>
    request.connectedSpeechCategories.includes(item.category),
  );
  const items = allowed.slice(0, request.bounds.maxConnectedSpeechItems);
  return {
    taskType: 'connected_speech',
    ...(request.context.topic !== undefined ? { contextTopic: request.context.topic } : {}),
    explanation:
      'Tip: spoken English compresses words in normal speech. The standard written form keeps the full meaning.',
    items,
    keyItems: items
      .map((item) => item.spokenRealization)
      .slice(0, request.bounds.maxKeyItems),
  };
}

/* ------------------------------------------------------------------ *
 * Shadowing
 * ------------------------------------------------------------------ */

/** One authored shadowing chunk. */
export interface ShadowingCatalogueEntry {
  readonly id: string;
  readonly chunk: string;
  readonly canonicalWrittenForm: string;
  readonly keyItems: readonly string[];
}

/**
 * Authored chunks of increasing length. The canonical written form is the
 * same meaning in standard written English (identical where the chunk is
 * already standard).
 */
export const SHADOWING_CATALOGUE: readonly ShadowingCatalogueEntry[] = [
  {
    id: 'shadowing.short.send_file',
    chunk: "I'll send it over this afternoon.",
    canonicalWrittenForm: 'I will send it over this afternoon.',
    keyItems: ['send', 'afternoon'],
  },
  {
    id: 'shadowing.medium.look_at_this',
    chunk: 'Could you take a look at this when you have a minute?',
    canonicalWrittenForm: 'Could you look at this when you have a moment?',
    keyItems: ['take a look', 'minute'],
  },
  {
    id: 'shadowing.long.power_went_out',
    chunk: 'We were about to start the meeting when the power went out.',
    canonicalWrittenForm: 'We were about to start the meeting when the power went out.',
    keyItems: ['about to start', 'power'],
  },
  {
    id: 'shadowing.extended.never_noticed',
    chunk: 'If you had not told me, I would never have noticed the difference.',
    canonicalWrittenForm: 'If you had not told me, I would never have noticed the difference.',
    keyItems: ['told me', 'noticed'],
  },
];

/**
 * Build validated shadowing material: the LONGEST authored chunk that fits the
 * request's word bounds is chosen, so a more advanced plan really gets a
 * longer chunk. Never an empty chunk, never an invented one.
 */
export function catalogueShadowingMaterial(
  request: DeepListeningRequest,
): ValidatedShadowingMaterial {
  const fits = SHADOWING_CATALOGUE.filter((entry) => {
    const words = entry.chunk.trim().split(/\s+/).filter(Boolean).length;
    return (
      words >= request.bounds.minShadowingChunkWords &&
      words <= request.bounds.maxShadowingChunkWords
    );
  });
  const chosen = fits[fits.length - 1] ?? SHADOWING_CATALOGUE[0];
  return {
    taskType: 'shadowing',
    ...(request.context.topic !== undefined ? { contextTopic: request.context.topic } : {}),
    explanation:
      'Tip: repeat the chunk in one breath and keep the rhythm of the original. Repetition is practice, not a measurement.',
    chunk: chosen.chunk,
    canonicalWrittenForm: chosen.canonicalWrittenForm,
    support: request.shadowingSupport,
    keyItems: chosen.keyItems.slice(0, request.bounds.maxKeyItems),
  };
}
