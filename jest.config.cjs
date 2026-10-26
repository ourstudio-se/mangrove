const ROOT_DIR = __dirname;

module.exports = {
  moduleFileExtensions: ["ts", "json", "js"],
  // Source files use ESM-compatible `.js` import specifiers; resolve them to the `.ts` sources.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  modulePathIgnorePatterns: [
    "dist",
    "lib",
    "test-assets",
    "test-files",
    "fixtures",
  ],
  rootDir: ROOT_DIR,
  testEnvironment: "node",
  testRegex: "\\.test\\.ts$",
  transform: {
    "\\.ts$": ["ts-jest", { tsconfig: "tsconfig-jest.json" }],
  },
};
