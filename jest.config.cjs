const ROOT_DIR = __dirname;

module.exports = {
  globals: {
    "ts-jest": {
      tsconfig: "tsconfig-jest.json",
    },
  },
  moduleFileExtensions: ["ts", "json", "js"],
  modulePathIgnorePatterns: ["dist", "test-assets", "test-files", "fixtures"],
  rootDir: ROOT_DIR,
  testEnvironment: "node",
  transform: {
    ".ts": "ts-jest",
  }
}
