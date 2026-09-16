const fs = require('fs');
let content = fs.readFileSync('src/review/evaluator.ts', 'utf8');
content = content.replace(
  /async evaluate\(\n    candidate: ReviewItemCandidate,\n    userAnswer: string,\n  \): Promise<EvaluationResult> \{/,
  `async evaluate(
    candidate: ReviewItemCandidate,
    userAnswer: string,
    coachingContext?: CoachingContext
  ): Promise<EvaluationResult> {`
);
fs.writeFileSync('src/review/evaluator.ts', content);
