import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      ".local/**",
      "**/dist/**",
      "**/.venv/**",
      "**/__pycache__/**",
      "packages/db/migrations/**",
    ],
  },
  ...tseslint.configs.recommended,
);
