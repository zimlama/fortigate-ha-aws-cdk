import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/test/**/*.spec.ts"],
  collectCoverageFrom: [
    "<rootDir>/src/domain/**/*.ts",
    "<rootDir>/src/application/**/*.ts",
  ],
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov"],
};

export default config;
