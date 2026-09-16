const fs = require('fs');
let content = fs.readFileSync('src/talk-demo/integration.test.ts', 'utf8');

content = content.replace(
  `    const weaknesses2 = await weaknessRepo.listWeaknesses(learnerId);
    expect(weaknesses2).toHaveLength(1); // No duplicate weakness
    expect(weaknesses2[0].occurrenceCount).toBe(2);
    expect(weaknesses2[0].status).toBe('repeated');`,
  `    const weaknesses2 = await weaknessRepo.listWeaknesses(learnerId);
    expect(weaknesses2).toHaveLength(1); // No duplicate weakness
    expect(weaknesses2[0].occurrenceCount).toBe(2);
    expect(weaknesses2[0].status).toBe('repeated');
    
    // Third correction
    await persistence.recordFeedbackEvidence({
      correction: {
        original: 'Yesterday I go',
        improved: 'Yesterday I went',
        explanation: 'Use past tense',
        severity: 'incorrect',
      }
    });

    const mistakes3 = await mistakeRepo.listMistakes(learnerId);
    expect(mistakes3).toHaveLength(1);
    expect(mistakes3[0].occurrenceCount).toBe(3);

    const weaknesses3 = await weaknessRepo.listWeaknesses(learnerId);
    expect(weaknesses3).toHaveLength(1); // No duplicate weakness
    expect(weaknesses3[0].occurrenceCount).toBe(3);
    // the status could still be repeated or confirmed
    
    const reviews3 = await reviewRepo.listDue(learnerId, new Date(Date.now() + 1000000).toISOString());
    expect(reviews3).toHaveLength(1); // No duplicate review weakness`
);

fs.writeFileSync('src/talk-demo/integration.test.ts', content);
