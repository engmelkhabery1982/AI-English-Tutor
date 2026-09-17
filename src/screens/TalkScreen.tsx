import React, { useEffect, useRef, useState } from 'react';
import type { PronunciationEngine } from '../pronunciation';
import { createDefaultPronunciationEngine } from '../pronunciation';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  createTalkSession,
  createTalkVoiceCoordinator,
  createLearningPersistenceService,
  type AudioRecorderService,
  type ConversationFeedback,
  type ConversationFeedbackVocabulary,
  type ConversationMode,
  type ConversationSession,
  type ConversationTurn,
  type SpeechToTextProvider,
  type TalkProviderKind,
  type TextToSpeechProvider,
  type VoiceSessionCoordinator,
  type VoiceStatus,
} from '../talk-demo';

const MODES: { readonly key: ConversationMode; readonly label: string }[] = [
  { key: 'natural', label: 'Natural' },
  { key: 'coach', label: 'Coach' },
  { key: 'intensive', label: 'Intensive' },
];

export interface TalkScreenProps {
  readonly recorder?: AudioRecorderService;
  readonly sttProvider?: SpeechToTextProvider;
  readonly ttsProvider?: TextToSpeechProvider;
  readonly initialMuted?: boolean;
  /** Injectable pronunciation engine (defaults to the real composition). */
  readonly pronunciationEngine?: PronunciationEngine;
}

export default function TalkScreen(props?: TalkScreenProps) {
  const [mode, setMode] = useState<ConversationMode>('natural');
  const [topic, setTopic] = useState<string>('');
  const [inputText, setInputText] = useState<string>('');
  const [history, setHistory] = useState<readonly ConversationTurn[]>([]);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [lastFeedback, setLastFeedback] = useState<ConversationFeedback | null>(null);
  const [savedWords, setSavedWords] = useState<Record<string, boolean>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [providerKind, setProviderKind] = useState<TalkProviderKind>('demo');

  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>({
    state: 'idle',
    elapsedSeconds: 0,
    recognizedTranscript: null,
    errorMessage: null,
    isMuted: props?.initialMuted ?? false,
    isSpeaking: false,
    canRecord: true,
    canStopRecording: false,
    canSendText: true,
  });

  const [pronunciationLines, setPronunciationLines] = useState<readonly string[] | null>(null);

  const sessionRef = useRef<ConversationSession | null>(null);
  const voiceCoordinatorRef = useRef<VoiceSessionCoordinator | null>(null);
  const pronunciationEngineRef = useRef<PronunciationEngine | null>(
    props?.pronunciationEngine ?? null,
  );
  const scrollViewRef = useRef<ScrollView | null>(null);

  // Pronunciation analysis is secondary to the conversation: compose the
  // engine lazily and never let it break the talk flow.
  useEffect(() => {
    if (pronunciationEngineRef.current) return;
    let active = true;
    createDefaultPronunciationEngine()
      .then((engine) => {
        if (active) pronunciationEngineRef.current = engine;
      })
      .catch(() => {
        // Analysis stays unavailable; conversation is unaffected.
      });
    return () => {
      active = false;
    };
  }, []);

  const runPronunciationAnalysis = async () => {
    const engine = pronunciationEngineRef.current;
    if (!engine) return;
    try {
      const spokenTurn = [...sessionRef.current?.getHistory() ?? []]
        .reverse()
        .find((turn) => turn.role === 'user');
      const transcript = spokenTurn?.content?.trim();
      setPronunciationLines(null);
      if (!transcript) return;

      const outcome = await engine.analyzeSpokenTurn({ transcript, mode });
      setPronunciationLines(outcome?.feedbackLines?.length ? outcome.feedbackLines : null);
    } catch {
      // Non-destructive: pronunciation analysis must never fail the turn.
      setPronunciationLines(null);
    }
  };

  // Initialize or retrieve the active voice coordinator
  const getOrCreateVoiceCoordinator = (
    currentSession: ConversationSession,
    currentProviderKind: TalkProviderKind
  ): VoiceSessionCoordinator => {
    if (!voiceCoordinatorRef.current) {
      const coordinator = createTalkVoiceCoordinator({
        session: currentSession,
        providerKind: currentProviderKind,
        isMuted: props?.initialMuted ?? false,
        recorder: props?.recorder,
        sttProvider: props?.sttProvider,
        ttsProvider: props?.ttsProvider,
      });
      coordinator.subscribe((status) => {
        setVoiceStatus(status);
        if (status.errorMessage) {
          setErrorMessage(status.errorMessage);
        }
      });
      voiceCoordinatorRef.current = coordinator;
    }
    return voiceCoordinatorRef.current;
  };

  const updateCoordinatorSession = (newSession: ConversationSession) => {
    if (voiceCoordinatorRef.current) {
      voiceCoordinatorRef.current.setSession(newSession);
    }
  };

  // Initialize or retrieve the active session bundle
  const getOrCreateSession = (
    targetMode: ConversationMode,
    targetTopic: string
  ): ConversationSession => {
    if (!sessionRef.current) {
      const bundle = createTalkSession({
        mode: targetMode,
        topic: targetTopic.trim() || undefined,
      });
      sessionRef.current = bundle.session;
      setProviderKind(bundle.providerKind);
      getOrCreateVoiceCoordinator(bundle.session, bundle.providerKind);
    }
    return sessionRef.current;
  };

  // Recreates session when mode/topic change while history is empty
  useEffect(() => {
    if (history.length === 0) {
      const bundle = createTalkSession({
        mode,
        topic: topic.trim() || undefined,
      });
      sessionRef.current = bundle.session;
      setProviderKind(bundle.providerKind);
      if (voiceCoordinatorRef.current) {
        updateCoordinatorSession(bundle.session);
      } else {
        getOrCreateVoiceCoordinator(bundle.session, bundle.providerKind);
      }
    }
  }, [mode, topic, history.length]);

  // Clean up voice coordinator when component unmounts
  useEffect(() => {
    return () => {
      voiceCoordinatorRef.current?.reset();
    };
  }, []);

  // Record feedback evidence in background
  useEffect(() => {
    if (lastFeedback) {
      const learningPersistence = createLearningPersistenceService();
      learningPersistence.recordFeedbackEvidence(lastFeedback).catch((err) => {
        console.error('Failed to persist learning feedback:', err);
      });
    }
  }, [lastFeedback]);

  // Handle mode switch
  const handleSelectMode = (newMode: ConversationMode) => {
    if (newMode === mode) return;
    setMode(newMode);
    if (history.length > 0) {
      voiceCoordinatorRef.current?.reset();
      const bundle = createTalkSession({
        mode: newMode,
        topic: topic.trim() || undefined,
      });
      sessionRef.current = bundle.session;
      setProviderKind(bundle.providerKind);
      if (voiceCoordinatorRef.current) {
        updateCoordinatorSession(bundle.session);
      } else {
        getOrCreateVoiceCoordinator(bundle.session, bundle.providerKind);
      }
      setHistory([]);
      setLastFeedback(null);
      setSavedWords({});
      setStreamingText(null);
      setErrorMessage(null);
    }
  };

  // Handle New / Clear conversation
  const handleNewConversation = () => {
    voiceCoordinatorRef.current?.reset();
    const bundle = createTalkSession({
      mode,
      topic: topic.trim() || undefined,
    });
    sessionRef.current = bundle.session;
    setProviderKind(bundle.providerKind);
    if (voiceCoordinatorRef.current) {
      updateCoordinatorSession(bundle.session);
    } else {
      getOrCreateVoiceCoordinator(bundle.session, bundle.providerKind);
    }
    setHistory([]);
    setLastFeedback(null);
    setSavedWords({});
    setStreamingText(null);
    setInputText('');
    setErrorMessage(null);
  };

  // Handle save vocabulary item
  const handleSaveVocabulary = async (vocab: ConversationFeedbackVocabulary) => {
    if (!sessionRef.current || !vocab.headword) return;
    const saved = await sessionRef.current.saveVocabularyItem(vocab);
    if (saved) {
      setSavedWords((prev) => ({ ...prev, [vocab.headword.toLowerCase()]: true }));
    }
  };

  // Handle microphone push-to-talk press
  const handleToggleRecording = async () => {
    const session = getOrCreateSession(mode, topic);
    const coordinator = getOrCreateVoiceCoordinator(session, providerKind);

    if (voiceStatus.state === 'recording') {
      setIsSending(true);
      setStreamingText('');
      setErrorMessage(null);

      const res = await coordinator.stopRecordingAndProcess((chunk: string) => {
        setStreamingText((prev) => (prev ?? '') + chunk);
      });

      setHistory(session.getHistory());
      setLastFeedback(session.getLastFeedback());
      setIsSending(false);
      setStreamingText(null);

      if (!res.ok && res.error) {
        setErrorMessage(res.error);
      }

      // Analyze pronunciation once per spoken turn (never blocks the flow).
      await runPronunciationAnalysis();
    } else if (voiceStatus.canRecord) {
      setErrorMessage(null);
      await coordinator.startRecording();
    }
  };

  // Handle stop speaking
  const handleStopSpeaking = async () => {
    if (voiceCoordinatorRef.current) {
      await voiceCoordinatorRef.current.stopSpeaking();
    }
  };

  // Handle replay response aloud
  const handleReplayResponse = async () => {
    if (voiceCoordinatorRef.current) {
      await voiceCoordinatorRef.current.replayLastResponse();
    }
  };

  // Handle mute toggle
  const handleToggleMute = () => {
    if (voiceCoordinatorRef.current) {
      voiceCoordinatorRef.current.toggleMute();
    }
  };

  // Handle send message with streaming (typed)
  const handleSendMessage = async () => {
    const trimmedMessage = inputText.trim();
    if (!trimmedMessage || isSending || !voiceStatus.canSendText) {
      return;
    }

    if (voiceCoordinatorRef.current) {
      await voiceCoordinatorRef.current.stopSpeaking();
    }

    setIsSending(true);
    setErrorMessage(null);
    setInputText('');
    setStreamingText('');

    // Optimistically add user message to history
    const userTurn: ConversationTurn = { role: 'user', content: trimmedMessage };
    setHistory((prev) => [...prev, userTurn]);

    try {
      const session = getOrCreateSession(mode, topic);
      const result = await session.send(
        { userMessage: trimmedMessage },
        (chunk: string) => {
          setStreamingText((prev) => (prev ?? '') + chunk);
        }
      );

      setHistory(session.getHistory());
      setLastFeedback(session.getLastFeedback());

      if (!result.ok) {
        setErrorMessage(
          result.error.message || 'The tutor returned an error. Please try again.'
        );
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'An unexpected error occurred while sending.';
      setErrorMessage(message);
    } finally {
      setIsSending(false);
      setStreamingText(null);
    }
  };

  const isSendDisabled =
    inputText.trim().length === 0 || isSending || !voiceStatus.canSendText;
  const isGemini = providerKind === 'gemini';

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTextGroup}>
          <Text style={styles.title}>Talk</Text>
          <View style={styles.providerBadgeContainer}>
            <View
              style={[
                styles.statusDot,
                isGemini ? styles.statusDotGemini : styles.statusDotDemo,
              ]}
            />
            <Text style={styles.subtitle}>
              {isGemini ? 'Gemini • Online' : 'Local Demo • Offline'}
            </Text>
          </View>
        </View>
        <View style={styles.headerButtonsGroup}>
          <TouchableOpacity
            style={[styles.muteButton, voiceStatus.isMuted && styles.muteButtonActive]}
            onPress={handleToggleMute}
            accessibilityLabel={voiceStatus.isMuted ? 'Unmute voice playback' : 'Mute voice playback'}
            accessibilityRole="button"
          >
            <Text style={styles.muteButtonText}>
              {voiceStatus.isMuted ? '🔇 Muted' : '🔊 Voice'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.newChatButton}
            onPress={handleNewConversation}
            accessibilityLabel="New Conversation"
            accessibilityRole="button"
          >
            <Text style={styles.newChatButtonText}>New Chat</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Config Bar */}
      <View style={styles.configContainer}>
        <View style={styles.modeSelector}>
          {MODES.map((item) => {
            const isActive = mode === item.key;
            return (
              <TouchableOpacity
                key={item.key}
                style={[styles.modeButton, isActive && styles.modeButtonActive]}
                onPress={() => handleSelectMode(item.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
              >
                <Text
                  style={[
                    styles.modeButtonText,
                    isActive && styles.modeButtonTextActive,
                  ]}
                >
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <TextInput
          style={[styles.topicInput, history.length > 0 && styles.topicInputLocked]}
          placeholder="Optional topic (e.g. Travel, Job Interview)"
          placeholderTextColor="#9CA3AF"
          value={topic}
          onChangeText={(text) => {
            setTopic(text);
          }}
          editable={history.length === 0 && !isSending}
        />
        {history.length > 0 && (
          <Text style={styles.topicLockedHelperText}>
            Start a new chat to change the topic.
          </Text>
        )}
      </View>

      {/* Chat Area */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.chatScroll}
        contentContainerStyle={styles.chatContent}
        onContentSizeChange={() => {
          scrollViewRef.current?.scrollToEnd({ animated: true });
        }}
      >
        {history.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateTitle}>Start practicing English</Text>
            <Text style={styles.emptyStateDescription}>
              Select a coaching mode, optionally specify a topic, and type a message below.
            </Text>
            <View style={styles.suggestionsContainer}>
              <TouchableOpacity
                style={styles.suggestionPill}
                onPress={() => setInputText('Hello')}
              >
                <Text style={styles.suggestionText}>Say "Hello"</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.suggestionPill}
                onPress={() => setInputText('I went to meeting yesterday')}
              >
                <Text style={styles.suggestionText}>Say "I went to meeting yesterday"</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          history.map((turn, index) => {
            const isUser = turn.role === 'user';
            const isLastTurn = index === history.length - 1;
            const isLastAssistant = !isUser && isLastTurn;

            return (
              <View key={`${index}-${turn.role}`} style={styles.turnContainer}>
                <View
                  style={[
                    styles.messageWrapper,
                    isUser ? styles.userMessageWrapper : styles.assistantMessageWrapper,
                  ]}
                >
                  <Text style={styles.roleLabel}>
                    {isUser ? 'You' : isGemini ? 'Gemini Tutor' : 'AI Tutor (Demo)'}
                  </Text>
                  <View
                    style={[
                      styles.bubble,
                      isUser ? styles.userBubble : styles.assistantBubble,
                    ]}
                  >
                    <Text
                      style={[
                        styles.messageText,
                        isUser ? styles.userMessageText : styles.assistantMessageText,
                      ]}
                    >
                      {turn.content}
                    </Text>
                  </View>
                  {isLastAssistant && (
                    <View style={styles.assistantVoiceActions}>
                      <TouchableOpacity
                        style={styles.replayButton}
                        onPress={handleReplayResponse}
                        accessibilityLabel="Replay tutor response aloud"
                        accessibilityRole="button"
                      >
                        <Text style={styles.replayButtonText}>🔊 Replay</Text>
                      </TouchableOpacity>
                      {voiceStatus.isSpeaking && (
                        <TouchableOpacity
                          style={styles.replayStopButton}
                          onPress={handleStopSpeaking}
                          accessibilityLabel="Stop audio response"
                          accessibilityRole="button"
                        >
                          <Text style={styles.replayStopButtonText}>■ Stop</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                </View>

                {/* Pronunciation note (compact, evidence-based, mode-aware) */}
                {isLastAssistant && pronunciationLines && pronunciationLines.length > 0 && (
                  <View style={styles.pronunciationContainer} testID="pronunciation-note">
                    <Text style={styles.pronunciationTitle}>🎙️ Pronunciation note</Text>
                    {pronunciationLines.map((line, index) => (
                      <Text key={index} style={styles.pronunciationLine}>
                        • {line}
                      </Text>
                    ))}
                  </View>
                )}

                {/* Feedback Panel (rendered under the latest assistant response) */}
                {isLastAssistant && lastFeedback && (
                  <View style={styles.feedbackContainer}>
                    {/* Correction Card */}
                    {lastFeedback.correction && (
                      <View style={styles.feedbackCard}>
                        <View style={styles.feedbackCardHeader}>
                          <Text style={styles.feedbackCardTitle}>Grammar & Phrasing</Text>
                          <View
                            style={[
                              styles.severityPill,
                              lastFeedback.correction.severity === 'incorrect'
                                ? styles.severityPillIncorrect
                                : styles.severityPillMinor,
                            ]}
                          >
                            <Text
                              style={[
                                styles.severityPillText,
                                lastFeedback.correction.severity === 'incorrect'
                                  ? styles.severityPillTextIncorrect
                                  : styles.severityPillTextMinor,
                              ]}
                            >
                              {lastFeedback.correction.severity}
                            </Text>
                          </View>
                        </View>
                        <Text style={styles.feedbackOriginalText}>
                          "{lastFeedback.correction.original}"
                        </Text>
                        <Text style={styles.feedbackImprovedText}>
                          → {lastFeedback.correction.improved}
                        </Text>
                        <Text style={styles.feedbackExplanationText}>
                          {lastFeedback.correction.explanation}
                        </Text>
                      </View>
                    )}

                    {/* Vocabulary Card */}
                    {lastFeedback.vocabulary && (
                      <View style={styles.feedbackCard}>
                        <View style={styles.feedbackCardHeader}>
                          <View style={styles.vocabHeaderLeft}>
                            <Text style={styles.feedbackCardTitle}>Key Vocabulary</Text>
                            <View style={styles.categoryPill}>
                              <Text style={styles.categoryPillText}>
                                {lastFeedback.vocabulary.type.replace(/_/g, ' ')}
                              </Text>
                            </View>
                          </View>
                          <TouchableOpacity
                            style={[
                              styles.saveVocabButton,
                              savedWords[lastFeedback.vocabulary.headword.toLowerCase()] &&
                                styles.saveVocabButtonSaved,
                            ]}
                            onPress={() =>
                              lastFeedback.vocabulary &&
                              handleSaveVocabulary(lastFeedback.vocabulary)
                            }
                            accessibilityRole="button"
                          >
                            <Text
                              style={[
                                styles.saveVocabButtonText,
                                savedWords[lastFeedback.vocabulary.headword.toLowerCase()] &&
                                  styles.saveVocabButtonTextSaved,
                              ]}
                            >
                              {savedWords[lastFeedback.vocabulary.headword.toLowerCase()]
                                ? '✓ Saved'
                                : '+ Save Word'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                        <Text style={styles.vocabHeadword}>
                          {lastFeedback.vocabulary.headword}
                        </Text>
                        <Text style={styles.vocabMeaning}>
                          {lastFeedback.vocabulary.meaning}
                        </Text>
                        {lastFeedback.vocabulary.example ? (
                          <Text style={styles.vocabExample}>
                            "{lastFeedback.vocabulary.example}"
                          </Text>
                        ) : null}
                      </View>
                    )}

                    {/* Coaching Note */}
                    {lastFeedback.coachingNote && (
                      <View style={styles.coachingNoteCard}>
                        <Text style={styles.coachingNoteLabel}>Tutor Tip</Text>
                        <Text style={styles.coachingNoteText}>
                          {lastFeedback.coachingNote}
                        </Text>
                      </View>
                    )}
                  </View>
                )}
              </View>
            );
          })
        )}

        {/* In-flight streaming message bubble */}
        {isSending && (
          <View style={styles.turnContainer}>
            <View style={[styles.messageWrapper, styles.assistantMessageWrapper]}>
              <Text style={styles.roleLabel}>
                {isGemini ? 'Gemini Tutor' : 'AI Tutor (Demo)'}
              </Text>
              <View style={[styles.bubble, styles.assistantBubble]}>
                {streamingText && streamingText.length > 0 ? (
                  <Text style={[styles.messageText, styles.assistantMessageText]}>
                    {streamingText}
                  </Text>
                ) : (
                  <View style={styles.loadingContainer}>
                    <ActivityIndicator size="small" color="#2563EB" />
                    <Text style={styles.loadingText}>
                      {isGemini ? 'Gemini is thinking...' : 'Tutor is typing...'}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        )}

        {/* Error Notice */}
        {errorMessage && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        )}
      </ScrollView>

      {/* Voice Status Banner */}
      {(voiceStatus.state === 'recording' ||
        voiceStatus.state === 'transcribing' ||
        voiceStatus.state === 'speaking' ||
        (voiceStatus.recognizedTranscript && (voiceStatus.state === 'sending' || isSending))) && (
        <View style={styles.voiceBanner}>
          {voiceStatus.state === 'recording' && (
            <View style={styles.voiceBannerRow}>
              <View style={styles.recordingDot} />
              <Text style={styles.voiceBannerText}>
                Recording ({voiceStatus.elapsedSeconds}s) • Tap Mic to finish & send
              </Text>
            </View>
          )}
          {voiceStatus.state === 'transcribing' && (
            <View style={styles.voiceBannerRow}>
              <ActivityIndicator size="small" color="#2563EB" />
              <Text style={styles.voiceBannerText}>Transcribing speech into English...</Text>
            </View>
          )}
          {voiceStatus.state === 'speaking' && (
            <View style={styles.voiceBannerRow}>
              <Text style={styles.voiceBannerText}>🔊 Speaking tutor response...</Text>
              <TouchableOpacity
                style={styles.stopSpeakingButton}
                onPress={handleStopSpeaking}
                accessibilityLabel="Stop speaking"
                accessibilityRole="button"
              >
                <Text style={styles.stopSpeakingButtonText}>Stop</Text>
              </TouchableOpacity>
            </View>
          )}
          {voiceStatus.recognizedTranscript &&
            (voiceStatus.state === 'sending' || isSending) &&
            voiceStatus.state !== 'transcribing' &&
            voiceStatus.state !== 'recording' && (
              <View style={styles.voiceBannerRow}>
                <Text style={styles.voiceBannerTranscript} numberOfLines={1}>
                  Recognized: "{voiceStatus.recognizedTranscript}"
                </Text>
              </View>
            )}
        </View>
      )}

      {/* Message Composer */}
      <View style={styles.composerContainer}>
        <TouchableOpacity
          style={[
            styles.micButton,
            voiceStatus.state === 'recording' && styles.micButtonRecording,
            voiceStatus.state === 'transcribing' && styles.micButtonTranscribing,
            voiceStatus.state === 'speaking' && styles.micButtonSpeaking,
            !voiceStatus.canRecord &&
              voiceStatus.state !== 'recording' &&
              styles.micButtonDisabled,
          ]}
          onPress={handleToggleRecording}
          disabled={!voiceStatus.canRecord && voiceStatus.state !== 'recording'}
          accessibilityRole="button"
          accessibilityLabel={
            voiceStatus.state === 'recording'
              ? 'Stop recording voice message'
              : 'Record voice message'
          }
          accessibilityState={{ busy: voiceStatus.state === 'transcribing' }}
        >
          {voiceStatus.state === 'transcribing' ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text
              style={[
                styles.micButtonText,
                voiceStatus.state === 'recording' && styles.micButtonTextRecording,
                voiceStatus.state === 'speaking' && styles.micButtonTextSpeaking,
              ]}
            >
              {voiceStatus.state === 'recording'
                ? '⏹'
                : voiceStatus.state === 'speaking'
                ? '⏹'
                : '🎤'}
            </Text>
          )}
        </TouchableOpacity>

        <TextInput
          style={[
            styles.composerInput,
            !voiceStatus.canSendText && styles.composerInputDisabled,
          ]}
          placeholder={
            voiceStatus.state === 'recording'
              ? 'Listening to your speech...'
              : voiceStatus.state === 'transcribing'
              ? 'Transcribing audio...'
              : 'Type your message in English...'
          }
          placeholderTextColor="#9CA3AF"
          value={inputText}
          onChangeText={setInputText}
          multiline
          maxLength={1000}
          editable={!isSending && voiceStatus.canSendText}
        />
        <TouchableOpacity
          style={[
            styles.sendButton,
            isSendDisabled && styles.sendButtonDisabled,
          ]}
          onPress={handleSendMessage}
          disabled={isSendDisabled}
          accessibilityLabel="Send message"
          accessibilityRole="button"
        >
          <Text
            style={[
              styles.sendButtonText,
              isSendDisabled && styles.sendButtonTextDisabled,
            ]}
          >
            Send
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  headerTextGroup: {
    flex: 1,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
  },
  providerBadgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusDotGemini: {
    backgroundColor: '#10B981',
  },
  statusDotDemo: {
    backgroundColor: '#9CA3AF',
  },
  subtitle: {
    fontSize: 12,
    color: '#6B7280',
    fontWeight: '500',
  },
  newChatButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  newChatButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1D4ED8',
  },
  configContainer: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
    gap: 8,
  },
  modeSelector: {
    flexDirection: 'row',
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    padding: 3,
  },
  modeButton: {
    flex: 1,
    paddingVertical: 6,
    alignItems: 'center',
    borderRadius: 6,
  },
  modeButtonActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  modeButtonText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#4B5563',
  },
  modeButtonTextActive: {
    fontWeight: '600',
    color: '#1D4ED8',
  },
  topicInput: {
    height: 36,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 6,
    paddingHorizontal: 10,
    fontSize: 13,
    color: '#111827',
  },
  topicInputLocked: {
    backgroundColor: '#F3F4F6',
    borderColor: '#E5E7EB',
    color: '#6B7280',
  },
  topicLockedHelperText: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: -2,
    marginHorizontal: 2,
  },
  chatScroll: {
    flex: 1,
  },
  chatContent: {
    padding: 16,
    gap: 12,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    paddingHorizontal: 20,
  },
  emptyStateTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 6,
  },
  emptyStateDescription: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  suggestionsContainer: {
    flexDirection: 'column',
    gap: 8,
    width: '100%',
    maxWidth: 320,
  },
  suggestionPill: {
    backgroundColor: '#FFFFFF',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  suggestionText: {
    fontSize: 13,
    color: '#2563EB',
    fontWeight: '500',
  },
  turnContainer: {
    marginBottom: 8,
    width: '100%',
  },
  messageWrapper: {
    marginBottom: 4,
    maxWidth: '85%',
  },
  userMessageWrapper: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
  },
  assistantMessageWrapper: {
    alignSelf: 'flex-start',
    alignItems: 'flex-start',
  },
  roleLabel: {
    fontSize: 11,
    color: '#9CA3AF',
    marginBottom: 3,
    marginHorizontal: 4,
  },
  bubble: {
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userBubble: {
    backgroundColor: '#2563EB',
    borderBottomRightRadius: 2,
  },
  assistantBubble: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderBottomLeftRadius: 2,
  },
  messageText: {
    fontSize: 15,
    lineHeight: 21,
  },
  userMessageText: {
    color: '#FFFFFF',
  },
  assistantMessageText: {
    color: '#1F2937',
  },
  pronunciationContainer: {
    backgroundColor: '#EEF4FF',
    borderColor: '#C9DAF8',
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginTop: 8,
  },
  pronunciationTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1F4E9C',
    marginBottom: 4,
  },
  pronunciationLine: {
    fontSize: 13,
    color: '#2C3E50',
    lineHeight: 18,
  },
  feedbackContainer: {
    marginTop: 8,
    gap: 8,
    width: '100%',
  },
  feedbackCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 12,
  },
  feedbackCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  feedbackCardTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  severityPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  severityPillIncorrect: {
    backgroundColor: '#FEE2E2',
  },
  severityPillMinor: {
    backgroundColor: '#FEF3C7',
  },
  severityPillText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  severityPillTextIncorrect: {
    color: '#DC2626',
  },
  severityPillTextMinor: {
    color: '#D97706',
  },
  feedbackOriginalText: {
    fontSize: 13,
    color: '#9CA3AF',
    textDecorationLine: 'line-through',
    marginBottom: 2,
  },
  feedbackImprovedText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#059669',
    marginBottom: 4,
  },
  feedbackExplanationText: {
    fontSize: 12,
    color: '#6B7280',
    lineHeight: 17,
  },
  vocabHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  categoryPill: {
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  categoryPillText: {
    fontSize: 11,
    color: '#4B5563',
    textTransform: 'capitalize',
  },
  saveVocabButton: {
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  saveVocabButtonSaved: {
    backgroundColor: '#ECFDF5',
    borderColor: '#A7F3D0',
  },
  saveVocabButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1D4ED8',
  },
  saveVocabButtonTextSaved: {
    color: '#059669',
  },
  vocabHeadword: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 2,
  },
  vocabMeaning: {
    fontSize: 13,
    color: '#374151',
    lineHeight: 18,
    marginBottom: 4,
  },
  vocabExample: {
    fontSize: 12,
    fontStyle: 'italic',
    color: '#6B7280',
  },
  coachingNoteCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#3B82F6',
    padding: 10,
  },
  coachingNoteLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#2563EB',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  coachingNoteText: {
    fontSize: 13,
    color: '#334155',
    lineHeight: 18,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  loadingText: {
    fontSize: 13,
    color: '#6B7280',
  },
  errorContainer: {
    backgroundColor: '#FEE2E2',
    borderColor: '#FCA5A5',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  },
  errorText: {
    fontSize: 13,
    color: '#B91C1C',
  },
  composerContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: '#FFFFFF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E7EB',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  composerInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: '#111827',
  },
  sendButton: {
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#2563EB',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#E5E7EB',
  },
  sendButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  sendButtonTextDisabled: {
    color: '#9CA3AF',
  },
  headerButtonsGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  muteButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  muteButtonActive: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
  },
  muteButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#4B5563',
  },
  assistantVoiceActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  replayButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#F3F4F6',
  },
  replayButtonText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#4B5563',
  },
  replayStopButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#FEE2E2',
  },
  replayStopButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#DC2626',
  },
  voiceBanner: {
    backgroundColor: '#EFF6FF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#DBEAFE',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  voiceBannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  voiceBannerText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#1D4ED8',
    flex: 1,
  },
  voiceBannerTranscript: {
    fontSize: 12,
    fontWeight: '500',
    color: '#1E40AF',
    fontStyle: 'italic',
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
  },
  stopSpeakingButton: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: '#DBEAFE',
  },
  stopSpeakingButtonText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#1D4ED8',
  },
  micButton: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    justifyContent: 'center',
    alignItems: 'center',
  },
  micButtonRecording: {
    backgroundColor: '#DC2626',
    borderColor: '#B91C1C',
  },
  micButtonTranscribing: {
    backgroundColor: '#2563EB',
    borderColor: '#1D4ED8',
  },
  micButtonSpeaking: {
    backgroundColor: '#059669',
    borderColor: '#047857',
  },
  micButtonDisabled: {
    backgroundColor: '#F3F4F6',
    borderColor: '#E5E7EB',
  },
  micButtonText: {
    fontSize: 18,
  },
  micButtonTextRecording: {
    color: '#FFFFFF',
    fontSize: 16,
  },
  micButtonTextSpeaking: {
    color: '#FFFFFF',
    fontSize: 16,
  },
  composerInputDisabled: {
    backgroundColor: '#F3F4F6',
    color: '#6B7280',
  },
});
