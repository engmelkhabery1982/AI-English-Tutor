import type { MainTabRouteName, RootStackRouteName } from './routes';

/** Rendered by Home; destinations are checked against the real navigator in regression tests. */
export const PRACTICE_LINKS: readonly {
  route: MainTabRouteName | RootStackRouteName; title: string; description: string;
}[] = [
  { route: 'Listening', title: 'Listening', description: 'Listen to a passage and check what you understood.' },
  { route: 'Pronunciation', title: 'Pronunciation', description: 'Repeat target words in a short phrase; compare what speech recognition heard.' },
  { route: 'Shadowing', title: 'Shadowing · Listen and imitate', description: 'Follow a short audio model, repeat it, then compare your spoken words.' },
  { route: 'FluencyPractice', title: 'Fluency practice', description: 'Repeat speaking tasks with gradually less support to practise responding more easily.' },
  { route: 'Vocabulary', title: 'Saved words & expressions', description: 'Revisit meanings, examples and due practice.' },
  { route: 'DeepSpeaking', title: 'Speaking coach', description: 'A longer guided conversation based on your practice history.' },
  { route: 'ProfessionalEnglish', title: 'English for work', description: 'Practise meetings, interviews and workplace conversations.' },
];
