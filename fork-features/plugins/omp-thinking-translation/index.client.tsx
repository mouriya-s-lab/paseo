import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ThinkingTranslation, thinkingSchema } from "./client/thinking";

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "omp-thinking-translation",
    query: { itemType: "reasoning" },
    transform: ({ item, phase }) => ({
      items: [
        {
          type: "plugin",
          kind: "thinking-translation",
          version: 1,
          data: { original: item.text, phase },
        },
      ],
    }),
  });
  client.addTimelineRenderer({
    kind: "thinking-translation",
    version: 1,
    schema: thinkingSchema,
    Component: ThinkingTranslation,
  });
  return () => {};
}
