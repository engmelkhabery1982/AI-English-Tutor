const fs = require('fs');
const content = fs.readFileSync('src/review/evaluator.ts', 'utf8');
const newContent = content.replace(/const emptyCoachingContext[\s\S]*?};/, `const coachingContextToUse = coachingContext ?? {
          profile: {
            learnerId: candidate.learnerId,
            displayName: 'Learner',
            currentLevel: 'Unknown',
            targetLevel: 'Unknown',
            learningGoals: [],
            preferredModes: ['natural'],
          },
          activeWeaknesses: [],
          strengths: [],
          vocabularyFocus: [],
          expressionFocus: [],
          recentProgress: null,
          dueReviewCount: 0,
          generatedAt: new Date().toISOString(),
        };`);
fs.writeFileSync('src/review/evaluator.ts', newContent);
