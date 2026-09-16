const fs = require('fs');
let content = fs.readFileSync('src/review/index.test.ts', 'utf8');

const oldTest = `  it('20. explicit demo toggle configures demo AI provider', async () => {
    const { createReviewService } = await import('./factory');
    // Pass a fake adapter so it doesn't crash
    const fakeAdapter: any = { query: vi.fn().mockResolvedValue([]), execute: vi.fn() };
    const demoService = createReviewService(fakeAdapter, true);
    // Should not crash and should return empty plan because repo is empty,
    // but the underlying AI provider is Demo (internal state).
    const candidates = await demoService.planSession(learnerId);
    expect(candidates).toHaveLength(0);
  });`;

const newTest = `  it('20. explicit demo toggle configures demo AI provider', async () => {
    const { createReviewService } = await import('./factory');
    const fakeAdapter: any = { query: vi.fn().mockResolvedValue([]), execute: vi.fn() };
    const demoService = createReviewService(fakeAdapter, true);
    
    // Evaluate using DemoProvider's special json path
    const candidate: any = {
      id: 'demo-open',
      learnerId: '123',
      exerciseType: 'sentence_correction',
      prompt: 'Fix this.',
      expectedAnswer: 'I have a dog',
    };
    
    const evalResult = await demoService.evaluateAnswer(candidate, 'I have a dog');
    
    expect(evalResult.result).toBe('correct');
    expect(evalResult.feedback).toBe('Good job!');
    expect(evalResult.explanation).toBe('Demo explanation.');
  });`;

content = content.replace(oldTest, newTest);
fs.writeFileSync('src/review/index.test.ts', content);
