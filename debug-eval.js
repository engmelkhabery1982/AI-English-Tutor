const fs = require('fs');
let content = fs.readFileSync('src/review/evaluator.ts', 'utf8');
content = content.replace(
  '} catch {',
  `} catch (e) { console.error('AI Eval Error:', e);`
);
fs.writeFileSync('src/review/evaluator.ts', content);
