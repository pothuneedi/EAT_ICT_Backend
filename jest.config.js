module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'srv/**/*.js',
    'db/**/*.js',
    '!srv/lib/**',
    '!db/lib/**'
  ],
  testMatch: [
    '**/__tests__/**/*.js',
    '**/?(*.)+(spec|test).js'
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1'
  },
  setupFilesAfterEnv: ['<rootDir>/test/setup.js'],
  verbose: true,
  bail: 1,
  testTimeout: 10000
};
