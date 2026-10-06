import type { PluginServerContext } from "@getpaseo/plugin/server";
import { translateThinking } from "./shared/translation";
import { createTranslator } from "./server/translator";

export default function contribute(server: PluginServerContext) {
  const translator = createTranslator();
  server.handle(translateThinking, ({ text }) => translator.translate(text));
  return () => translator.dispose();
}
