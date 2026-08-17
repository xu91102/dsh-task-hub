// ESLint 9 flat config: eslint recommended + typescript-eslint recommended,
// a deterministic import order, and prettier-compatible (formatting rules off,
// prettier owns them — see .prettierrc.json).
//
// Run `npm run lint` to check; `npx eslint . --fix` fixes what is fixable.
import eslint from '@eslint/js'
import prettier from 'eslint-config-prettier'
import importX from 'eslint-plugin-import-x'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['lib/**', '.client-build/**', 'node_modules/**', '*.tgz'],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [eslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.recommended],
  },
  {
    plugins: { 'import-x': importX },
    rules: {
      'import-x/order': [
        'error',
        {
          alphabetize: { order: 'asc', caseInsensitive: true },
          'newlines-between': 'never',
        },
      ],
    },
  },
  // Must come last so its "off" settings win over any formatting-style rule.
  prettier,
)
