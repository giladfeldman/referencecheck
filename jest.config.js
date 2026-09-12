export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  // The root tsconfig sets rootDir to ./src and excludes tests, so a helper
  // imported from tests/ (the recorded Crossref fixtures) fails to compile
  // under it. tsconfig.test.json widens rootDir for the test program only.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.test.json' }],
  },
};
