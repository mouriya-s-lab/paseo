import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ThinkingTranslation, thinkingSchema } from "./client/thinking";
import { projectThinking } from "./client/project-thinking";

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "omp-thinking-translation",
    query: { itemType: "reasoning" },
    transform: projectThinking,
  });
  client.addTimelineRenderer({
    kind: "thinking-translation",
    version: 1,
    schema: thinkingSchema,
    Component: ThinkingTranslation,
  });
  return () => {};
}
