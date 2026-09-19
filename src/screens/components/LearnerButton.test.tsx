import { describe, expect, it, vi } from 'vitest';
import React from 'react';
vi.mock('react-native', () => ({ TouchableOpacity: 'NativeTouchable' }));
import LearnerButton from './LearnerButton';

describe('LearnerButton native presentation contract', () => {
  it('preserves the actual handler and accessible name/hint', () => {
    const press = vi.fn();
    const rendered = LearnerButton({ onPress: press, accessibilityLabel: 'Record your answer', accessibilityHint: 'Requires microphone permission', children: React.createElement('text') });
    expect(rendered.props.onPress).toBe(press);
    expect(rendered.props.accessibilityRole).toBe('button');
    expect(rendered.props.accessibilityLabel).toBe('Record your answer');
    expect(rendered.props.accessibilityHint).toBe('Requires microphone permission');
    expect(press).not.toHaveBeenCalled();
  });
  it('exposes disabled and busy independently to native controls and assistive technology', () => {
    const rendered = LearnerButton({ disabled: true, accessibilityState: { busy: true }, children: 'Processing' });
    expect(rendered.props.disabled).toBe(true);
    expect(rendered.props.accessibilityState).toEqual({ busy: true, disabled: true });
    expect(rendered.props.style[0]).toMatchObject({ minHeight: 48, minWidth: 48, opacity: 0.5 });
  });
  it('keeps caller styles and selection metadata without a fixed size', () => {
    const style = { padding: 12 };
    const rendered = LearnerButton({ style, accessibilityState: { selected: true } });
    expect(rendered.props.style[1]).toBe(style);
    expect(rendered.props.style[0]).not.toHaveProperty('height');
    expect(rendered.props.accessibilityState).toEqual({ selected: true, disabled: false });
  });
});
