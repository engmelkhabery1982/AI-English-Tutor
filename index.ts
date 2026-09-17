/**
 * App entry point.
 *
 * `react-native-gesture-handler` must be imported before anything else: the
 * root navigator now uses @react-navigation/stack (an already-declared
 * dependency) so Home → "Today's Practice" can push the adaptive lesson
 * screen with a real back action. Both packages were already installed;
 * no new dependency is introduced.
 */
import 'react-native-gesture-handler';

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
