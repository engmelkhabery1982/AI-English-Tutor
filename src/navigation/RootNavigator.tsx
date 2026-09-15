import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';

import HomeScreen from '../screens/HomeScreen';
import TalkScreen from '../screens/TalkScreen';
import VocabularyScreen from '../screens/VocabularyScreen';
import ReviewScreen from '../screens/ReviewScreen';
import ProgressScreen from '../screens/ProgressScreen';
import SettingsScreen from '../screens/SettingsScreen';

/**
 * RootNavigator
 *
 * STRUCTURAL PLACEHOLDER ONLY.
 *
 * Tab layout:
 *   Home | Talk | Vocabulary | Review | Progress | Settings
 *
 * The Talk tab will eventually host the full Conversation Engine stack.
 * No deep navigation or feature routing is implemented yet.
 */
const Tab = createBottomTabNavigator();

export default function RootNavigator() {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          tabBarIcon: () => <Text>{route.name.charAt(0)}</Text>,
          tabBarActiveTintColor: '#007AFF',
          tabBarInactiveTintColor: '#8e8e93',
        })}
      >
        <Tab.Screen name="Home" component={HomeScreen} />
        <Tab.Screen name="Talk" component={TalkScreen} />
        <Tab.Screen name="Vocabulary" component={VocabularyScreen} />
        <Tab.Screen name="Review" component={ReviewScreen} />
        <Tab.Screen name="Progress" component={ProgressScreen} />
        <Tab.Screen name="Settings" component={SettingsScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}