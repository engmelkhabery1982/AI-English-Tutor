const fs = require('fs');
let content = fs.readFileSync('src/review/service.ts', 'utf8');

// Update imports
if (!content.includes("import type { CoachingContext }")) {
  content = content.replace("import type { LearnerWeakness } from '../domain/models/learner';", "import type { LearnerWeakness } from '../domain/models/learner';\nimport type { CoachingContext } from '../learner-model';");
}

content = content.replace(
  /async evaluateAnswer\(\n    candidate: ReviewItemCandidate,\n    userAnswer: string,\n  \): Promise<EvaluationResult> \{/,
  `async evaluateAnswer(
    candidate: ReviewItemCandidate,
    userAnswer: string,
    coachingContext?: CoachingContext
  ): Promise<EvaluationResult> {`
);

content = content.replace(
  /return this\.evaluator\.evaluate\(candidate, userAnswer\);/,
  `return this.evaluator.evaluate(candidate, userAnswer, coachingContext);`
);

fs.writeFileSync('src/review/service.ts', content);
