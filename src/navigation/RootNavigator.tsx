import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { Text } from 'react-native';

import type { SpeakingPracticeSeed, SpeakingPracticeType, SpeakingProfessionalScenario } from '../deep-speaking';
import HomeScreen from '../screens/HomeScreen';
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

/**
 * RootNavigator
 *
 * Structure:
 *   NavigationContainer
 *   └── Root stack
 *       ├── MainTabs (the EXISTING bottom-tab layout, unchanged)
 *       │     Home | Talk | Listening | Vocabulary | Review | Progress | Settings
 *       ├── AdaptiveLesson  ← pushed from Home → "Today's Practice"
 *       ├── DeepSpeaking    ← pushed from Home → "Speaking practice"
 *       │                      (and optionally from a speaking lesson step)
 *       └── Onboarding      ← pushed from Home/Settings → diagnostic assessment
 *
 * The stack exists so an adaptive lesson is a pushed destination (with a real
 * back action) rather than an eighth tab. It uses @react-navigation/stack,
 * which is ALREADY a declared dependency of this project — no new package is
 * introduced, and no existing tab, screen or route is changed.
 *
 * The Talk tab hosts the full Conversation Engine stack; the adaptive lesson
 * screen orchestrates the existing systems and never duplicates them.
 */
const Tab = createBottomTabNavigator();
const Stack = createStackNavigator();

/** Routes of the root stack (typed for navigation.navigate calls). */
export type RootStackParamList = {
  MainTabs: undefined;
  AdaptiveLesson: undefined;
  /**
   * Deep Speaking Practice / Speaking Coach. The optional seed lets a speaking
   * lesson step start a full practice on the SAME material — the inline lesson
   * path stays available when Deep Speaking is not.
   */
  DeepSpeaking:
    | {
        readonly seed?: SpeakingPracticeSeed;
        readonly practiceType?: SpeakingPracticeType;
        readonly professionalScenario?: SpeakingProfessionalScenario;
      }
    | undefined;
  /** Professional English scenario picker (content layer; starts Deep Speaking). */
  ProfessionalEnglish: undefined;
  /** Personalized onboarding + diagnostic assessment (pushed from Home/Settings). */
  Onboarding: undefined;
};

/** The existing bottom-tab layout, now hosted inside the root stack. */
function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: () => <Text>{route.name.charAt(0)}</Text>,
        tabBarActiveTintColor: '#007AFF',
        tabBarInactiveTintColor: '#8e8e93',
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Talk" component={TalkScreen} />
      <Tab.Screen name="Listening" component={ListeningScreen} />
      <Tab.Screen name="Vocabulary" component={VocabularyScreen} />
      <Tab.Screen name="Review" component={ReviewScreen} />
      <Tab.Screen name="Progress" component={ProgressScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

export default function RootNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerTintColor: '#007AFF',
          headerTitleStyle: { color: '#1c1c1e', fontWeight: '600' },
          headerStyle: { backgroundColor: '#f5f7fa', shadowOpacity: 0, elevation: 0 },
          cardStyle: { backgroundColor: '#f5f7fa' },
        }}
      >
        <Stack.Screen name="MainTabs" component={MainTabs} options={{ headerShown: false }} />
        <Stack.Screen
          name="AdaptiveLesson"
          component={AdaptiveLessonScreen}
          options={{ title: "Today's Practice", headerBackTitle: 'Home' }}
        />
        <Stack.Screen
          name="DeepSpeaking"
          component={DeepSpeakingScreen}
          options={{ title: 'Speaking practice', headerBackTitle: 'Home' }}
        />
        <Stack.Screen
          name="ProfessionalEnglish"
          component={ProfessionalEnglishScreen}
          options={{ title: 'Professional English', headerBackTitle: 'Home' }}
        />
        <Stack.Screen
          name="Onboarding"
          component={OnboardingScreen}
          options={{ title: 'Assess my English', headerBackTitle: 'Back' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
