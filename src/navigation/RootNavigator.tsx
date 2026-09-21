import LearningToolsScreen from '../screens/LearningToolsScreen';
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import type { StackNavigationOptions } from '@react-navigation/stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PronunciationScreen, ShadowingScreen } from '../screens/SpeechPracticeScreen';
import { Text } from 'react-native';

import {
  MAIN_TAB_ROUTES,
  ROOT_STACK_ROUTES,
} from './routes';
import type {
  MainTabParamList,
  MainTabRouteName,
  RootStackParamList,
  RootStackRouteName,
} from './routes';
import HomeScreen from '../screens/HomeScreen';
import DailyTutorScreen from '../screens/DailyTutorScreen';
import DeepSpeakingScreen from '../screens/DeepSpeakingScreen';
import ProfessionalEnglishScreen from '../screens/ProfessionalEnglishScreen';
import TalkScreen from '../screens/TalkScreen';
import VocabularyScreen from '../screens/VocabularyScreen';
import ReviewScreen from '../screens/ReviewScreen';
import ProgressScreen from '../screens/ProgressScreen';
import ListeningScreen from '../screens/ListeningScreen';
import SettingsScreen from '../screens/SettingsScreen';
import AdaptiveLessonScreen from '../screens/AdaptiveLessonScreen';
import OnboardingScreen from '../screens/OnboardingScreen';
import ReassessmentScreen from '../screens/ReassessmentScreen';
import FluencyPracticeScreen from '../screens/FluencyPracticeScreen';

// Re-exported for callers that import the param list types from the
// navigator module (the definitions live in ./routes, the single source).
export type { RootStackParamList, MainTabParamList } from './routes';

/**
 * RootNavigator
 *
 * Structure:
 *   NavigationContainer
 *   └── Root stack (routes from ./routes — the single source of truth)
 *       ├── MainTabs (the EXISTING bottom-tab layout, tab routes from ./routes)
 *       │     Home | Talk | Listening | Vocabulary | Review | Progress | Settings
 *       ├── DailyTutor      ← pushed from Home → "Today's Practice" (the Daily
 *       │                      Tutor hub; launches existing activities and
 *       │                      applies their real completion handshake)
 *       ├── AdaptiveLesson  ← pushed from Home → "Adaptive lesson"
 *       │                      (and from the Daily Tutor with a completion ref)
 *       ├── DeepSpeaking    ← pushed from Home → "Speaking practice"
 *       │                      (and optionally from a speaking lesson step or
 *       │                      the Daily Tutor with a completion ref)
 *       ├── ProfessionalEnglish
 *       └── Onboarding      ← pushed from Home/Settings → diagnostic assessment
 *
 * NAVIGATION CONTRACT (see ./routes): Review and Listening are TAB routes
 * inside MainTabs, NOT root-stack routes. A root-stack screen (such as the
 * Daily Tutor hub) reaches them ONLY through the nested MainTabs envelope
 * ({ routeName: 'MainTabs', params: { screen: 'Review', params: … } }) —
 * navigating to 'Review'/'Listening' directly from the root stack would be
 * invalid and is exactly what ./routes + the Daily Tutor routing prevent.
 *
 * The stack exists so these are pushed destinations (with a real back
 * action) rather than extra tabs. It uses @react-navigation/stack, which is
 * ALREADY a declared dependency of this project — no new package is
 * introduced, and no existing tab, screen or route is changed.
 *
 * The Talk tab hosts the full Conversation Engine stack; the Daily Tutor and
 * the adaptive lesson screen orchestrate the existing systems and never
 * duplicate them.
 */
const Tab = createBottomTabNavigator<MainTabParamList>();
const Stack = createStackNavigator<RootStackParamList>();

/** Screen components for the REAL bottom tabs (exhaustive by type). */
const TAB_COMPONENTS: Record<MainTabRouteName, React.ComponentType<{}>> = {
  Home: HomeScreen,
  Talk: TalkScreen,
  Listening: ListeningScreen,
  Vocabulary: VocabularyScreen,
  Review: ReviewScreen,
  Progress: ProgressScreen,
  Settings: SettingsScreen,
};

/** The existing bottom-tab layout: tab names AND order come from ./routes. */
function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarItemStyle: route.name === 'Listening' || route.name === 'Vocabulary' ? { display: 'none' } : undefined,
        tabBarButton: route.name === 'Listening' || route.name === 'Vocabulary' ? () => null : undefined,
        tabBarLabelStyle: { fontSize: 12 },
        tabBarIcon: () => <Text>{route.name.charAt(0)}</Text>,
        tabBarActiveTintColor: '#2563EB',
        tabBarInactiveTintColor: '#9CA3AF',
      })}
    >
      {MAIN_TAB_ROUTES.map((name) => (
        <Tab.Screen key={name} name={name} component={TAB_COMPONENTS[name]} />
      ))}
    </Tab.Navigator>
  );
}

/** One root-stack screen: name, component and (unchanged) options. */
interface RootScreenDef {
  readonly name: RootStackRouteName;
  readonly component: React.ComponentType<{}>;
  readonly options?: StackNavigationOptions;
}

const ROOT_SCREENS: readonly RootScreenDef[] = [
  { name: 'MainTabs', component: MainTabs, options: { headerShown: false } },
  {
    name: 'DailyTutor',
    component: DailyTutorScreen,
    options: { title: 'Daily Tutor', headerBackTitle: 'Home' },
  },
  {
    name: 'AdaptiveLesson',
    component: AdaptiveLessonScreen,
    options: { title: 'Adaptive lesson', headerBackTitle: 'Home' },
  },
  {
    name: 'DeepSpeaking',
    component: DeepSpeakingScreen,
    options: { title: 'Speaking practice', headerBackTitle: 'Home' },
  },
  {
    name: 'FluencyPractice',
    component: FluencyPracticeScreen,
    options: { title: 'Fluency Practice', headerBackTitle: 'Home' },
  },
  {
    name: 'ProfessionalEnglish',
    component: ProfessionalEnglishScreen,
    options: { title: 'Professional English', headerBackTitle: 'Home' },
  },
  {
    name: 'Onboarding',
    component: OnboardingScreen,
    options: { title: 'Assess my English', headerBackTitle: 'Back' },
  },
  {
    name: 'Reassessment',
    component: ReassessmentScreen,
    options: { title: 'Check my English level', headerBackTitle: 'Back' },
  },
  { name: 'Pronunciation', component: PronunciationScreen, options: { title: 'Pronunciation', headerBackTitle: 'Back' } },
  { name: 'Shadowing', component: ShadowingScreen, options: { title: 'Shadowing', headerBackTitle: 'Back' } },
  { name: 'LearningTools', component: LearningToolsScreen, options: { title: 'Learning tools', headerBackTitle: 'Back' } },
];

// Single-source-of-truth check: the rendered root screens must be EXACTLY
// ROOT_STACK_ROUTES from ./routes, in order. A mismatch is a programmer
// error — fail fast instead of navigating to a route that does not exist.
if (ROOT_SCREENS.map((screen) => screen.name).join(',') !== ROOT_STACK_ROUTES.join(',')) {
  throw new Error('RootNavigator screens are out of sync with src/navigation/routes.ts');
}

export default function RootNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        screenLayout={({ children, route }) => (
          <SafeAreaView style={{ flex: 1 }} edges={route.name === 'MainTabs' ? ['left', 'right'] : ['left', 'right', 'bottom']}>
            {children}
          </SafeAreaView>
        )}
        screenOptions={{
          headerTintColor: '#2563EB',
          headerTitleStyle: { color: '#111827', fontWeight: '700' },
          headerStyle: { backgroundColor: '#FFFFFF', shadowOpacity: 0, elevation: 0, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
          cardStyle: { backgroundColor: '#F7F8FA' },
        }}
      >
        {ROOT_SCREENS.map((screen) => (
          <Stack.Screen
            key={screen.name}
            name={screen.name}
            component={screen.component}
            options={screen.options}
          />
        ))}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
