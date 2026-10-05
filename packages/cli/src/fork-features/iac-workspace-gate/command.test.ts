import { describe, expect, it } from "vitest";
import { gateExit } from "./command.js";

// github-agent-router treats exit 0 as dispatchable and reports any other code's
// line as the blocker; 16/17 are reserved for its own daemon/hub checks.
describe("gateExit", () => {
  it("passes only a clean checkout", () => {
    expect(
      gateExit({ tag: "verdict", verdict: { verdict: "clean", branch: "main", head: "abc" } }),
    ).toEqual({
      code: 0,
      line: "clean main abc",
    });
  });

  it.each([
    ["lock-held", 10],
    ["git-error", 11],
    ["not-default-branch", 12],
    ["not-at-remote-tip", 13],
    ["dirty-tracked", 14],
    ["submodule-unclean", 15],
  ] as const)("maps %s to exit %i with its detail", (verdict, code) => {
    expect(gateExit({ tag: "verdict", verdict: { verdict, detail: "why" } })).toEqual({
      code,
      line: `${verdict}: why`,
    });
  });

  it("never passes when the daemon or plugin cannot answer", () => {
    const result = gateExit({ tag: "unavailable", detail: "Plugin is not running" });
    expect(result.code).toBe(18);
    expect(result.line).toBe("gate-unavailable: Plugin is not running");
  });
});
