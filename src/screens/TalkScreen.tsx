import React, { useEffect, useRef, useState } from 'react';
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
  type ConversationMode,
  type ConversationSession,
  type ConversationTurn,
  type TalkProviderKind,
} from '../talk-demo';

const MODES: { readonly key: ConversationMode; readonly label: string }[] = [
  { key: 'natural', label: 'Natural' },
  { key: 'coach', label: 'Coach' },
  { key: 'intensive', label: 'Intensive' },
];

export default function TalkScreen() {
  const [mode, setMode] = useState<ConversationMode>('natural');
  const [topic, setTopic] = useState<string>('');
  const [inputText, setInputText] = useState<string>('');
  const [history, setHistory] = useState<readonly ConversationTurn[]>([]);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [providerKind, setProviderKind] = useState<TalkProviderKind>('demo');

  const sessionRef = useRef<ConversationSession | null>(null);
  const scrollViewRef = useRef<ScrollView | null>(null);

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
    }
  }, [mode, topic, history.length]);

  // Handle mode switch
  const handleSelectMode = (newMode: ConversationMode) => {
    if (newMode === mode) return;
    setMode(newMode);
    if (history.length > 0) {
      const bundle = createTalkSession({
        mode: newMode,
        topic: topic.trim() || undefined,
      });
      sessionRef.current = bundle.session;
      setProviderKind(bundle.providerKind);
      setHistory([]);
      setErrorMessage(null);
    }
  };

  // Handle New / Clear conversation
  const handleNewConversation = () => {
    const bundle = createTalkSession({
      mode,
      topic: topic.trim() || undefined,
    });
    sessionRef.current = bundle.session;
    setProviderKind(bundle.providerKind);
    setHistory([]);
    setInputText('');
    setErrorMessage(null);
  };

  // Handle send message
  const handleSendMessage = async () => {
    const trimmedMessage = inputText.trim();
    if (!trimmedMessage || isSending) {
      return;
    }

    setIsSending(true);
    setErrorMessage(null);
    setInputText('');

    try {
      const session = getOrCreateSession(mode, topic);
      const result = await session.send({ userMessage: trimmedMessage });

      setHistory(session.getHistory());

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
    }
  };

  const isSendDisabled = inputText.trim().length === 0 || isSending;
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
        <TouchableOpacity
          style={styles.newChatButton}
          onPress={handleNewConversation}
          accessibilityLabel="New Conversation"
          accessibilityRole="button"
        >
          <Text style={styles.newChatButtonText}>New Chat</Text>
        </TouchableOpacity>
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
            return (
              <View
                key={`${index}-${turn.role}`}
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
              </View>
            );
          })
        )}

        {/* Loading Indicator */}
        {isSending && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" color="#2563EB" />
            <Text style={styles.loadingText}>
              {isGemini ? 'Gemini is thinking...' : 'Tutor is typing...'}
            </Text>
          </View>
        )}

        {/* Error Notice */}
        {errorMessage && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        )}
      </ScrollView>

      {/* Message Composer */}
      <View style={styles.composerContainer}>
        <TextInput
          style={styles.composerInput}
          placeholder="Type your message in English..."
          placeholderTextColor="#9CA3AF"
          value={inputText}
          onChangeText={setInputText}
          multiline
          maxLength={1000}
          editable={!isSending}
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
  messageWrapper: {
    marginBottom: 4,
    maxWidth: '82%',
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
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
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
});
