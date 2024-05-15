module.exports = {
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:@typescript-eslint/recommended",
    "prettier",
  ],
  ignorePatterns: [
    ".eslintrc.js",
    "jest.config.cjs",
    "project.jest.config.cjs",
    "jest.setup.ts",
    "node_modules/**/*",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: ["./tsconfig-cjs.json", "./tsconfig-jest.json"],
    sourceType: "module",
    tsconfigRootDir: __dirname,
  },
  plugins: [
    "@typescript-eslint",
    "prettier",
    "sort-imports-es6-autofix",
    "eslint-plugin-sort-class-members",
    "typescript-sort-keys",
    "sort-keys-fix",
  ],
  root: true,
  rules: {
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/interface-name-prefix": "off",
    "@typescript-eslint/lines-between-class-members": ["error"],
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-namespace": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
    "@typescript-eslint/no-use-before-define": "off",
    "@typescript-eslint/no-var-requcires": "off",
    "no-console": "error",
    "lines-between-class-members": "off",
    "prettier/prettier": "error",
    "sort-class-members/sort-class-members": [
      2,
      {
        accessorPairPositioning: "getThenSet",
        groups: {
          "computed-key-properties": [
            {
              name: "/^\\[[^\\]]+\\]$/",
              sort: "alphabetical",
              type: "property",
            },
          ],
          methods: [
            {
              sort: "alphabetical",
              type: "method",
            },
          ],
        },
        order: [
          "[properties]",
          "[conventional-private-properties]",
          "constructor",
          "[methods]",
          "[conventional-private-methods]",
          "[static-properties]",
          "[static-methods]",
          "[computed-key-properties]",
        ],
      },
    ],
    "sort-imports-es6-autofix/sort-imports-es6": [
      2,
      {
        ignoreCase: false,
        ignoreMemberSort: false,
        memberSyntaxSortOrder: ["none", "all", "multiple", "single"],
      },
    ],
    "sort-keys-fix/sort-keys-fix": "error",
    "typescript-sort-keys/interface": "error",
    "typescript-sort-keys/string-enum": "error",
  },
};
