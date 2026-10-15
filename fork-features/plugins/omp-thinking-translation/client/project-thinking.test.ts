import { expect, it } from "vitest";
import { projectThinking } from "./project-thinking";

it("keeps streaming reasoning in Paseo's native renderer", () => {
  expect(
    projectThinking({ item: { text: "I am still thinking." }, phase: "streaming" }),
  ).toBeUndefined();
});

it("translates completed reasoning without dropping its original text", () => {
  expect(
    projectThinking({ item: { text: "I have finished thinking." }, phase: "complete" }),
  ).toEqual({
    items: [
      {
        type: "plugin",
        kind: "thinking-translation",
        version: 1,
        data: { original: "I have finished thinking.", phase: "complete" },
      },
    ],
  });
});
