const fs = require('fs');
const files = ['src/learner-model/index.test.ts', 'src/review/index.test.ts'];
for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/markResolved:\s*vi\.fn\(\),\s*updateMistake:\s*vi\.fn\(\),/g, 'markResolved: vi.fn(),');
  content = content.replace(/mistakes:\s*\{\s*updateMistake:\s*vi\.fn\(\),/g, 'mistakes: {');
  content = content.replace(/mistakes:\s*\{/, 'mistakes: {\n      updateMistake: vi.fn(),');
  fs.writeFileSync(file, content);
}
