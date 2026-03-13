import eslint from '@eslint/js'
import { defineConfig } from 'eslint/config'
import eslintPluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  {
    ignores: ['**/*.d.ts', '**/coverage/**', '**/dist/**', '**/node_modules/**']
  },
  {
    files: ['**/*.{ts,vue}'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      ...eslintPluginVue.configs['flat/essential']
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: {
        parser: tseslint.parser
      }
    },
    rules: {
      'vue/multi-word-component-names': ['error', { ignores: ['App'] }]
    }
  }
)
