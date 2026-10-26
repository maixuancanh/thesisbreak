import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      ".local/**",
      "**/dist/**",
      "packages/db/migrations/**",
    ],
  },
  ...tseslint.configs.recommended,
);
