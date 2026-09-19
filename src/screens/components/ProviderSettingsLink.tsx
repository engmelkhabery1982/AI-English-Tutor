import React from 'react';
import { Text } from 'react-native';
import { useNavigation, type NavigationProp, type ParamListBase } from '@react-navigation/native';
import LearnerButton from './LearnerButton';

export default function ProviderSettingsLink() {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  return <LearnerButton accessibilityLabel="Open AI provider settings"
    onPress={() => navigation.navigate('MainTabs', { screen: 'Settings' })}>
    <Text style={{ color: '#0066CC', fontSize: 16 }}>Open AI provider settings</Text>
  </LearnerButton>;
}
