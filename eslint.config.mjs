import tseslint from 'typescript-eslint';

const layeredCode = ['src/domain/**/*.ts', 'src/application/**/*.ts'];

export default [
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'src/infra/generated/**', 'test/fixtures/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-else-return': ['error', { allowElseIf: false }],
      'id-length': ['error', { min: 2, exceptions: ['_'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: layeredCode,
    rules: {
      'max-depth': ['error', 3],
      'no-restricted-syntax': [
        'error',
        { selector: 'IfStatement[alternate]', message: 'Object Calisthenics: no else, use a guard clause.' },
      ],
    },
  },
  {
    files: ['**/*.spec.ts'],
    rules: { 'max-depth': 'off' },
  },
];
