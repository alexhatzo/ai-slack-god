import { defineConfig } from "@trigger.dev/sdk/v3";
import { aptGet } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  project: "your-trigger-project-id",
  maxDuration: 120,
  build: {
    extensions: [
      aptGet({ packages: ["git", "ripgrep"] }),
    ],
  },
  retries: {
    enabledInDev: false,
  },
});
