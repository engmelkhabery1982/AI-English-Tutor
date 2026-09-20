import { createLanguageInspector, type InspectionInput, type LanguageInspection } from './inspector';
import type { ProviderFailure } from '../providers/failures';
import { canLearnerRetry } from '../shared/safe-retry';
import type { AIProvider } from '../providers/ai/types';

export interface InspectorState {
  readonly input: InspectionInput;
  readonly status: 'idle' | 'loading' | 'success' | 'error';
  readonly result: LanguageInspection | null;
  readonly failure: ProviderFailure | null;
  readonly canRetry: boolean;
}
/** Screen-independent request ownership: editing text invalidates, failure never clears input. */
export class InspectorController {
  private generation = 0;
  private disposed = false;
  private state: InspectorState;
  constructor(private readonly provider: AIProvider | undefined | (() => AIProvider | undefined), input: InspectionInput, private readonly changed: () => void = () => {}) {
    this.state = { input, status: 'idle', result: null, failure: null, canRetry: false };
  }
  snapshot() { return this.state; }
  edit(input: InspectionInput) { ++this.generation; this.state = { input, status: 'idle', result: null, failure: null, canRetry: false }; this.changed(); }
  async inspect() {
    if (this.disposed || this.state.status === 'loading') return;
    const gen = ++this.generation;
    this.state = { ...this.state, status: 'loading', result: null, failure: null, canRetry: false }; this.changed();
    const result = await createLanguageInspector(typeof this.provider === 'function' ? this.provider() : this.provider).inspect(this.state.input, () => this.disposed || gen !== this.generation);
    if (this.disposed || gen !== this.generation) return;
    this.state = result.ok ? { ...this.state, status: 'success', result: result.value } : { ...this.state, status: 'error', failure: result.failure, canRetry: canLearnerRetry(result.failure) };
    this.changed();
  }
  cancel() { ++this.generation; if (this.state.status === 'loading') { this.state = { ...this.state, status: 'idle' }; this.changed(); } }
  dispose() { this.disposed = true; ++this.generation; }
}
