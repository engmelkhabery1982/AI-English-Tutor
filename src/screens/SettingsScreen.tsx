import TouchableOpacity from './components/LearnerButton';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';

import {
  createProviderDiagnostics,
  getProviderCredentialService,
  diagnosticCodeLabel,
  type ProviderConfigurationSnapshot,
  type ProviderCredentialService,
  type ProviderDiagnosticResult,
} from '../provider-config';

/**
 * SettingsScreen
 *
 * Two things only:
 * 1. Runtime provider configuration — the REAL production path for the API
 *    key, stored in secure device storage (never SQLite, never logged, never
 *    bundled into the JS bundle).
 * 2. The existing entry point for (re)running the diagnostic assessment.
 *
 * HONESTY:
 * - The stored key is never rendered, not even partially. The screen only ever
 *   says whether a key is held on this device.
 * - "Verified" is only ever claimed after a real provider round-trip.
 * - No key does NOT mean Demo Mode. Demo is chosen explicitly per practice
 *   surface and is always labelled as not-real-AI; it is never substituted for
 *   a missing credential here.
 */

interface SettingsScreenProps {
  /** Injected credential service (tests / embedding). */
  readonly credentialService?: ProviderCredentialService;
}

const STATUS_LABELS: Record<ProviderConfigurationSnapshot['status'], string> = {
  configured: 'Key stored and verified',
  unverified: 'Key stored — not verified yet',
  'development-fallback': 'Development environment key',
  'not-configured': 'No key configured',
  'invalid-credential': 'Key rejected by the provider',
  'temporarily-unavailable': 'Provider temporarily unavailable',
  'storage-unavailable': 'Secure storage unavailable',
};

const STATUS_TONES: Record<ProviderConfigurationSnapshot['status'], string> = {
  configured: '#0f7b3f',
  unverified: '#8a6d00',
  'development-fallback': '#8a6d00',
  'not-configured': '#8e8e93',
  'invalid-credential': '#b3261e',
  'temporarily-unavailable': '#8a6d00',
  'storage-unavailable': '#b3261e',
};

export default function SettingsScreen(props?: SettingsScreenProps) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();

  const service = useMemo(
    () => props?.credentialService ?? getProviderCredentialService(),
    [props?.credentialService]
  );

  const [snapshot, setSnapshot] = useState<ProviderConfigurationSnapshot>(() => service.snapshot());
  const [draftKey, setDraftKey] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<ProviderDiagnosticResult | null>(null);

  useEffect(() => {
    const unsubscribe = service.subscribe(() => {
      setSnapshot(service.snapshot());
    });
    setSnapshot(service.snapshot());
    return unsubscribe;
  }, [service]);

  const refreshSnapshot = useCallback(() => {
    setSnapshot(service.snapshot());
  }, [service]);

  const handleSave = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setDiagnostic(null);
    try {
      const result = await service.saveKey(draftKey);
      if (result.ok) {
        // The field is cleared: the secret is not kept in screen state.
        setDraftKey('');
        setFeedback(
          'Saved to secure storage on this device. Use “Test connection” to confirm the provider accepts it.'
        );
      } else {
        setFeedback(result.message);
      }
    } catch {
      setFeedback('Could not complete this provider action. Check your connection and secure storage, then try again. Your English progress is unaffected.');
    } finally {
      refreshSnapshot();
      setBusy(false);
    }
  }, [busy, draftKey, refreshSnapshot, service]);

  const handleRemove = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setDiagnostic(null);
    try {
      const result = await service.removeKey();
      if (result.ok) {
        setDraftKey('');
        setFeedback(
          result.removed
            ? 'The stored key was removed from this device.'
            : 'There was no stored key to remove on this device.'
        );
      } else {
        setFeedback(result.message);
      }
    } catch {
      setFeedback('Could not complete this provider action. Check your connection and secure storage, then try again. Your English progress is unaffected.');
    } finally {
      refreshSnapshot();
      setBusy(false);
    }
  }, [busy, refreshSnapshot, service]);

  const handleVerify = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setDiagnostic(null);
    const verifyingDraft = draftKey.trim().length > 0;
    try {
      const diagnostics = createProviderDiagnostics({ credentialService: service });
      const result = await diagnostics.verifyConnection(verifyingDraft ? draftKey : undefined);
      setDiagnostic(result);
      // Only a verification of the STORED credential may change stored status.
      if (!verifyingDraft) {
        service.recordDiagnostic(result);
      }
      setFeedback(null);
    } catch {
      setFeedback('Could not complete this provider action. Check your connection and secure storage, then try again. Your English progress is unaffected.');
    } finally {
      refreshSnapshot();
      setBusy(false);
    }
  }, [busy, draftKey, refreshSnapshot, service]);

  const hasStoredKey = snapshot.hasRuntimeCredential;

  return (
    <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.subtitle}>AI provider, learning profile and privacy</Text>

      {/* ------------------------- provider status ------------------------- */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>AI provider</Text>
          <View
            style={[
              styles.chip,
              { borderColor: STATUS_TONES[snapshot.status] },
            ]}
          >
            <Text accessibilityLiveRegion="polite" style={[styles.chipText, { color: STATUS_TONES[snapshot.status] }]}>
              {STATUS_LABELS[snapshot.status]}
            </Text>
          </View>
        </View>

        <Text style={styles.body}>{snapshot.summary}</Text>

        <Text style={styles.metaRow}>
          Credential source: <Text style={styles.metaValue}>{snapshot.source}</Text>
        </Text>
        <Text style={styles.metaRow}>
          Secure storage:{' '}
          <Text style={styles.metaValue}>
            {snapshot.secureStorageAvailable ? 'available' : 'unavailable'}
          </Text>
        </Text>
        {snapshot.isDevelopmentBuild ? (
          <Text style={styles.metaRow}>
            Build: <Text style={styles.metaValue}>development</Text>
          </Text>
        ) : (
          <Text style={styles.metaRow}>
            Build: <Text style={styles.metaValue}>release</Text>
          </Text>
        )}

        {snapshot.usingDevelopmentFallback ? (
          <Text style={styles.warning}>
            A development environment key is in effect. That key is compiled into the app bundle and
            is not appropriate for a release build — store a key here instead.
          </Text>
        ) : null}
      </View>

      {/* --------------------- configure / update key --------------------- */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>
          {hasStoredKey ? 'Replace your API key' : 'Add your API key'}
        </Text>
        <Text style={styles.body}>
          The key is stored in this device&apos;s secure storage (Android Keystore / iOS Keychain).
          The saved copy stays on this device, is never written to the app database, and is never shown again
          after you save it.
        </Text>
        {hasStoredKey ? (
          <Text style={styles.body}>
            A key is already saved on this device. The stored value is not displayed, not even
            partially. Saving a new key replaces it.
          </Text>
        ) : null}

        <TextInput
          testID="settings-api-key-input"
          style={styles.input}
          value={draftKey}
          onChangeText={setDraftKey}
          placeholder={hasStoredKey ? 'Enter a new key to replace it' : 'Paste your API key'}
          placeholderTextColor="#a4a4a8"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          editable={!busy}
          accessibilityLabel="Gemini API key"
        />

        <View style={styles.buttonRow}>
          <TouchableOpacity
            testID="settings-save"
            style={[styles.primaryButton, busy && styles.buttonDisabled]}
            onPress={handleSave}
            disabled={busy}
          >
            <Text style={styles.primaryButtonText}>{hasStoredKey ? 'Replace key' : 'Save key'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            testID="settings-verify"
            style={[styles.secondaryButton, busy && styles.buttonDisabled]}
            onPress={handleVerify}
            disabled={busy}
          >
            <Text style={styles.secondaryButtonText}>Test connection</Text>
          </TouchableOpacity>
        </View>

        {hasStoredKey ? (
          <TouchableOpacity
            testID="settings-remove"
            style={[styles.dangerButton, busy && styles.buttonDisabled]}
            onPress={handleRemove}
            disabled={busy}
          >
            <Text style={styles.dangerButtonText}>Remove key from this device</Text>
          </TouchableOpacity>
        ) : null}

        {busy ? (
          <View style={styles.busyRow}>
            <ActivityIndicator size="small" />
            <Text style={styles.busyText}>Working…</Text>
          </View>
        ) : null}

        {feedback ? (
          <Text testID="settings-feedback" style={styles.feedback}>
            {feedback}
          </Text>
        ) : null}

        {diagnostic ? (
          <Text testID="settings-diagnostic" style={styles.diagnostic}>
            {diagnosticCodeLabel(diagnostic.code)} — {diagnostic.message}
          </Text>
        ) : null}

        <Text style={styles.note}>
          “Test connection” makes one real request to the provider. It never records evidence about
          your English, and a network failure is not treated as a learning weakness.
        </Text>
        <Text style={styles.note}>
          A change applies to practice you start next. A practice screen that is already open keeps
          the provider it started with, so reopen it to use the new key.
        </Text>
      </View>

      {/* ------------------------------ demo ------------------------------ */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Demo mode</Text>
        <Text style={styles.body}>
          Demo mode is never switched on for you. It is chosen explicitly on the surfaces that offer
          it (for example Review&apos;s Demo Mode) and is always labelled as not real AI.
        </Text>
        <Text style={styles.body}>
          Local planning, saved vocabulary and built-in listening material do not require an AI key.
          Real AI conversations and speech recognition need a configured provider and a connection.
          Demo mode uses simulated content, not real AI or evidence of your English ability.
        </Text>
      </View>

      {/* ------------------------ existing entry point --------------------- */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Learning profile & assessment</Text>
        <Text style={styles.body}>New here? Set your goals and take your first English assessment.</Text>
        <TouchableOpacity
          testID="settings-assess"
          style={styles.primaryButton}
          onPress={() => navigation.navigate('Onboarding')}
        >
          <Text style={styles.primaryButtonText}>Assess my English</Text>
        </TouchableOpacity>
        <Text style={styles.note}>
          Set up or update your learning goals. An assessment suggests a level; you choose whether to use it.
        </Text>
        <TouchableOpacity testID="settings-reassess" style={styles.secondaryButton}
          onPress={() => navigation.navigate('Reassessment')} accessibilityHint="Compare a new English assessment with your previous learning">
          <Text style={styles.secondaryButtonText}>Check my English level again</Text>
        </TouchableOpacity>
        <Text style={styles.note}>After some practice, reassess to see what has changed. Your working level does not change continuously or without your acceptance.</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>About & privacy</Text>
        <Text style={styles.body}>AI English Tutor · English practice with your own learning history.</Text>
        <Text style={styles.body}>Learning records are stored locally. When you use a real provider, practice text or recorded audio needed for that request is sent to that provider. Your API key is sent to authenticate provider requests, but is never displayed here.</Text>
        <Text style={styles.note}>Audio replay is a listening aid, not proof of learner practice. Provider or microphone failures are not evidence of a weakness.</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#fff',
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 15,
    color: '#666',
    marginBottom: 18,
  },
  card: {
    backgroundColor: '#f7f8fa',
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e2e4e8',
  },
  cardHeader: {
    flexDirection: 'row', flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 6,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '700',
  },
  body: {
    fontSize: 14,
    color: '#3c3c43',
    lineHeight: 20,
    marginBottom: 8,
  },
  metaRow: {
    fontSize: 12,
    color: '#8e8e93',
    marginTop: 2,
  },
  metaValue: {
    color: '#3c3c43',
    fontWeight: '600',
  },
  warning: {
    fontSize: 12,
    color: '#8a6d00',
    marginTop: 8,
    lineHeight: 17,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d1d6',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    backgroundColor: '#fff',
    marginTop: 4,
  },
  buttonRow: {
    flexDirection: 'row', flexWrap: 'wrap',
    gap: 10,
    marginTop: 12,
  },
  primaryButton: {
    flex: 1,
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondaryButton: {
    flex: 1,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { color: '#007AFF', fontSize: 15, fontWeight: '700' },
  dangerButton: {
    marginTop: 10,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#b3261e',
    backgroundColor: '#fff',
  },
  dangerButtonText: { color: '#b3261e', fontSize: 14, fontWeight: '700' },
  buttonDisabled: { opacity: 0.5 },
  busyRow: {
    flexDirection: 'row', flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  busyText: { fontSize: 13, color: '#8e8e93' },
  feedback: {
    fontSize: 13,
    color: '#3c3c43',
    marginTop: 12,
    lineHeight: 19,
  },
  diagnostic: {
    fontSize: 13,
    color: '#3c3c43',
    marginTop: 10,
    lineHeight: 19,
    fontWeight: '600',
  },
  note: {
    fontSize: 12,
    color: '#8e8e93',
    marginTop: 12,
    lineHeight: 17,
  },
});
