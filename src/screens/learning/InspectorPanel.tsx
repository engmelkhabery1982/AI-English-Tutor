import { useFocusEffect } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { Text, TextInput, View, Button } from 'react-native';
import { InspectorController } from '../../dictionary/inspector-controller';
import { inspectionSaveInput, type InspectionInput, type InspectionType } from '../../dictionary/inspector';
import type { LearningTools } from '../../lessons/composition';

const TYPES: readonly InspectionType[] = ['word','phrase','idiom','collocation','expression','sentence','short_text'];
export default function InspectorPanel({ tools, initial }: { tools: LearningTools; initial?: InspectionInput }) {
  const [, redraw] = useReducer(n => n + 1, 0);
  const controller = useMemo(() => new InspectorController(() => tools.provider, initial ?? { originalText: '', selectedText: '', itemType: 'word', targetLanguage: tools.profile?.nativeLanguage ?? 'Arabic' }, redraw), [tools, initial]);
  const [saveNote, setSaveNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => () => controller.dispose(), [controller]);
  useFocusEffect(useCallback(() => () => controller.cancel(), [controller]));
  const state = controller.snapshot(), input = state.input;
  const edit = (patch: Partial<InspectionInput>) => { controller.edit({ ...input, ...patch }); setSaveNote(''); };
  return <View style={{ gap: 10 }}>
    <Text>Language inspector · Meaning / translate / rephrase</Text>
    <Text>Paste up to 4,000 characters. Select a word, phrase, expression, sentence, or the whole short text.</Text>
    <TextInput accessibilityLabel="Original text" placeholder="Paste original text" value={input.originalText} multiline maxLength={4000} onChangeText={originalText => edit({ originalText, selectedText: originalText })} style={{ borderWidth: 1, padding: 8 }} />
    <TextInput accessibilityLabel="Selected language" placeholder="Selected item from the original text" value={input.selectedText} onChangeText={selectedText => edit({ selectedText })} style={{ borderWidth: 1, padding: 8 }} />
    <Text>Item type: {input.itemType}</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{TYPES.map(itemType => <Button key={itemType} title={itemType.replace('_', ' ')} onPress={() => edit({ itemType })} />)}</View>
    <TextInput accessibilityLabel="Source context" placeholder="Optional sentence/context" value={input.context ?? ''} multiline maxLength={4000} onChangeText={context => edit({ context })} style={{ borderWidth: 1, padding: 8 }} />
    <TextInput accessibilityLabel="Translation language" value={input.targetLanguage} onChangeText={targetLanguage => edit({ targetLanguage })} style={{ borderWidth: 1, padding: 8 }} />
    <Button title={state.status === 'loading' ? 'Inspecting…' : 'Inspect / Translate / Rephrase'} disabled={state.status === 'loading' || !input.originalText.trim()} onPress={() => void controller.inspect()} />
    {state.failure && <Text accessibilityRole="alert">{state.failure.message} Your original text is kept.</Text>}
    {state.canRetry && <Button title="Retry inspection" onPress={() => void controller.inspect()} />}
    {state.result && <View style={{ gap: 10 }}>
      <Text>Provider-generated explanation · {state.result.provenance.providerId} · Not authoritative dictionary truth</Text>
      <Text>In context: {state.result.contextualMeaning}</Text>
      <Text>Translation: {state.result.translation}</Text><Text>Rephrase: {state.result.rephrase}</Text>
      <Text>Natural alternatives: {state.result.alternatives.join(' / ')}</Text>
      {state.result.meanings.map(meaning => <View key={meaning.id} style={{ gap: 6 }}>
        <Text>{meaning.id === state.result?.contextualSenseId ? 'Contextual sense: ' : 'Other common sense: '}{meaning.meaning}</Text>
        <Text>{meaning.translation}</Text><Text>{meaning.usage} · {meaning.register}</Text>
        {meaning.examples.map(example => <Text key={example}>{example}</Text>)}
        <Button title="Save this meaning to Review" disabled={saving || !tools.profile} onPress={() => {
          if (!state.result || !tools.profile || saving) return;
          setSaving(true);
          void tools.save.save(inspectionSaveInput(tools.profile.id, state.result, meaning.id)).then(result => setSaveNote(result.ok ? result.duplicate ? 'Already saved. The existing meaning and review schedule were kept.' : result.reviewQueued ? 'Saved to Review — not marked learned.' : 'Saved. Review queue could not be updated; find it in Vocabulary.' : 'Could not save. Create a profile or retry.')).finally(() => setSaving(false));
        }} />
      </View>)}
    </View>}
    {!!saveNote && <Text accessibilityLiveRegion="polite">{saveNote}</Text>}
  </View>;
}
