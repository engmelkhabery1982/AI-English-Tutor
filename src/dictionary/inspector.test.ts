import { describe, expect, it, vi } from 'vitest';
import { createLanguageInspector, inspectionSaveInput, type InspectionInput } from './inspector';
import { InspectorController } from './inspector-controller';
import { inspectionPayload, providerWith, failingProvider } from '../lessons/testing/fixtures';

const input: InspectionInput = { originalText: 'A joke can break the ice at a meeting.', selectedText: 'break the ice', itemType: 'idiom', targetLanguage: 'Arabic', context: 'At a meeting' };
describe('unified language inspector', () => {
  it.each(['word','phrase','idiom','collocation','expression','sentence','short_text'] as const)('inspects %s using one provider contract', async itemType => {
    const provider = providerWith(inspectionPayload);
    const result = await createLanguageInspector(provider).inspect({ ...input, itemType });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.input.itemType).toBe(itemType);
    expect(result.value.provenance).toEqual({ kind: 'ai-generated', providerId: provider.id });
    expect(provider.generate).toHaveBeenCalledOnce();
  });
  it('returns contextual sense, translations, rephrase, usage, register and examples without persisting', async () => {
    const result = await createLanguageInspector(providerWith(inspectionPayload)).inspect(input);
    expect(result.ok && result.value).toMatchObject(inspectionPayload);
  });
  it('preserves selected sense identity in Save to Review input and separates generated examples from pasted text', async () => {
    const result = await createLanguageInspector(providerWith(inspectionPayload)).inspect(input);
    if (!result.ok) throw Error('Expected success');
    expect(inspectionSaveInput('learner', result.value, 'sense-1')).toMatchObject({ text: input.selectedText, originalText: input.originalText, itemType: 'idiom', meaningIsGenerated: true, generatedBy: 'test-provider', selectedSenseId: 'sense-1', contextSource: 'manual', additionalExamples: [inspectionPayload.meanings[0].examples[1]] });
    expect(() => inspectionSaveInput('learner', result.value, 'unknown')).toThrow();
  });
  it('rejects out-of-source selections, oversized input, and malformed meanings', async () => {
    const provider = providerWith({});
    expect((await createLanguageInspector(provider).inspect({ ...input, selectedText: 'not in passage' })).ok).toBe(false);
    expect((await createLanguageInspector(provider).inspect({ ...input, originalText: 'x'.repeat(4001) })).ok).toBe(false);
    expect(provider.generate).not.toHaveBeenCalled();
    const result = await createLanguageInspector(provider).inspect(input);
    expect(!result.ok && result.failure.kind).toBe('malformed_response');
  });
  it('classifies quota failure, preserves exact input, supports explicit retry and never auto-retries quota', async () => {
    const provider = failingProvider();
    const controller = new InspectorController(provider, input);
    await controller.inspect();
    expect(controller.snapshot()).toMatchObject({ input, status: 'error', canRetry: true, result: null, failure: { kind: 'rate_limited' } });
    expect(controller.snapshot().failure?.message).not.toMatch(/secret|HTTP|429/);
    expect(provider.generate).toHaveBeenCalledOnce();
    await controller.inspect();
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });
  it('does not silently use demo when unconfigured; keeps input for configuration recovery', async () => {
    let provider: ReturnType<typeof providerWith> | undefined;
    const controller = new InspectorController(() => provider, input);
    await controller.inspect();
    expect(controller.snapshot().failure?.kind).toBe('not_configured');
    expect(controller.snapshot().input).toEqual(input);
    provider = providerWith(inspectionPayload);
    await controller.inspect();
    expect(controller.snapshot().status).toBe('success');
  });
  it('uses one safe transient retry before any commit', async () => {
    vi.useFakeTimers();
    try {
      const provider = providerWith(inspectionPayload);
      vi.mocked(provider.generate).mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: 'service unavailable', retryable: true } });
      const pending = createLanguageInspector(provider).inspect(input);
      await vi.runAllTimersAsync();
      expect((await pending).ok).toBe(true);
      expect(provider.generate).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('blocks double submit and drops stale edited/unmounted results', async () => {
    let resolve!: (v: Awaited<ReturnType<ReturnType<typeof providerWith>['generate']>>) => void;
    const provider = providerWith(inspectionPayload);
    vi.mocked(provider.generate).mockImplementation(() => new Promise(r => { resolve = r; }));
    const changed = vi.fn(), controller = new InspectorController(provider, input, changed);
    const pending = controller.inspect();
    await controller.inspect();
    expect(provider.generate).toHaveBeenCalledOnce();
    controller.edit({ ...input, originalText: 'new text', selectedText: 'new' });
    controller.dispose();
    const calls = changed.mock.calls.length;
    resolve({ ok: true, response: { content: JSON.stringify(inspectionPayload) } });
    await pending;
    expect(changed).toHaveBeenCalledTimes(calls);
    expect(controller.snapshot().result).toBeNull();
  });
});
