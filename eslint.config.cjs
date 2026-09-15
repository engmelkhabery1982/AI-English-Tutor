const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: { React: 'readonly' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'openai',
                '@openai/*',
                'anthropic',
                '@anthropic/*',
                'google-genai',
                '@google/*',
                'elevenlabs',
                '@elevenlabs/*',
                'supabase',
                '@supabase/*',
                '@google-cloud/*',
              ],
              message:
                'Vendor SDKs are forbidden in src/. Use a provider interface from src/domain/providers instead.',
            },
          ],
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],
      'no-console': 'warn',
    },
  },
];