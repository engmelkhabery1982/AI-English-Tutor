import React from 'react';
import { TouchableOpacity, type TouchableOpacityProps } from 'react-native';

/** Small presentation wrapper: keep native handlers, expose disabled state and a 48dp target. */
export default function LearnerButton({ style, disabled, accessibilityState, ...props }: TouchableOpacityProps) {
  return <TouchableOpacity {...props} accessibilityRole={props.accessibilityRole ?? 'button'}
    disabled={disabled} accessibilityState={{ ...accessibilityState, disabled: Boolean(disabled) }}
    style={[{ minHeight: 48, minWidth: 48, justifyContent: 'center', opacity: disabled ? 0.5 : 1 }, style]} />;
}
