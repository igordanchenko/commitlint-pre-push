import globals from "globals";
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";

export default defineConfig(eslint.configs.recommended, {
  languageOptions: { globals: globals.node },
});
