const fs = require('fs');
let content = fs.readFileSync('src/providers/ai/demo/index.ts', 'utf8');
content = content.replace(
  "  if (mode === 'coach') {",
  `  if (topic === 'Review Evaluation') {
    // Generate deterministic JSON for ReviewEvaluator
    const resultObj = {
      result: lowerText.includes('dog') ? 'correct' : 'incorrect',
      feedback: lowerText.includes('dog') ? 'Good job!' : 'Not quite.',
      explanation: 'Demo explanation.',
      suggestedCorrection: 'I have a dog'
    };
    return {
      content: JSON.stringify(resultObj),
      feedback: null
    };
  }

  if (mode === 'coach') {`
);
fs.writeFileSync('src/providers/ai/demo/index.ts', content);
