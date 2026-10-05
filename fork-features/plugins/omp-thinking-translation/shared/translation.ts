import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const translateThinking = defineRpc({
  name: "translate-thinking",
  input: z.object({ text: z.string().min(1) }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ready"), hash: z.string(), translation: z.string().min(1) }),
    z.object({ status: z.literal("error"), message: z.string() }),
  ]),
});
