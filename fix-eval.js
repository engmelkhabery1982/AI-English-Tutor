const fs = require('fs');
let content = fs.readFileSync('src/review/evaluator.ts', 'utf8');

// I replaced `coachingContext: coachingContext ?? {` ...
// Let's see what is on line 240. It's likely `const coachingContextToUse = coachingContext ?? {`
// Let's check `grep -n "coachingContext" src/review/evaluator.ts`
