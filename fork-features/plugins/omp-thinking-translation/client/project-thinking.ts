import type { PluginTimelineTransformResult } from "@getpaseo/plugin";

interface ThinkingProjectionInput {
  item: { text: string };
  phase: "streaming" | "complete";
}

export function projectThinking({
  item,
  phase,
}: ThinkingProjectionInput): PluginTimelineTransformResult | undefined {
  if (phase === "streaming") return undefined;
  return {
    items: [
      {
        type: "plugin",
        kind: "thinking-translation",
        version: 1,
        data: { original: item.text, phase },
      },
    ],
  };
}
