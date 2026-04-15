import type { TriggerConfig } from "@trigger.dev/sdk/v3";

export const config: TriggerConfig = {
  project: "your-trigger-project-id",
  retries: {
    enabledInDev: false,
  },
};
