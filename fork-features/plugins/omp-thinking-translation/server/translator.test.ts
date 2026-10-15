import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTranslator } from "./translator";

const source = "I will inspect the configuration before changing the code.";
const translated = "我会先检查配置，再修改代码。";
const hash = createHash("sha256").update(source).digest("hex");
const requests: Record<string, unknown>[] = [];
let respond: (body: Record<string, unknown>, response: ServerResponse) => void;
const endpoint = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const parsed: Record<string, unknown> = JSON.parse(body);
  requests.push(parsed);
  respond(parsed, response);
});
let agentDir: string;
let translator: ReturnType<typeof createTranslator>;

beforeEach(async () => {
  requests.length = 0;
  respond = (_body, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: translated } }] }));
  };
  agentDir = await mkdtemp(path.join(tmpdir(), "paseo-thinking-translation-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  endpoint.listen(0, "127.0.0.1");
  await once(endpoint, "listening");
  const address = endpoint.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  await writeFile(
    path.join(agentDir, "models.yml"),
    JSON.stringify({
      providers: {
        translator: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "test-credential",
        },
      },
    }),
  );
  await configure([{ provider: "translator", id: "first", effort: "minimal" }]);
  translator = createTranslator();
});

afterEach(async () => {
  translator.dispose();
  endpoint.closeAllConnections();
  await promisify(endpoint.close.bind(endpoint))();
  vi.unstubAllEnvs();
  await rm(agentDir, { recursive: true, force: true });
});

async function configure(translatorModels: unknown) {
  await writeFile(
    path.join(agentDir, "thinking-translator.json"),
    JSON.stringify({ enabled: true, targetLanguage: "Simplified Chinese", translatorModels }),
  );
}

it("translates using the current OMP model-chain configuration and its effort", async () => {
  expect(await translator.translate(source)).toEqual({ status: "pending" });
  await expect
    .poll(() => translator.translate(source))
    .toEqual({
      status: "ready",
      hash,
      translation: translated,
    });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ model: "first", reasoning_effort: "minimal" });
});

it("tries models in order after HTTP, empty-text and prompt-echo failures", async () => {
  await configure([
    { provider: "translator", id: "unavailable" },
    { provider: "translator", id: "empty", effort: "off" },
    { provider: "translator", id: "echo" },
    { provider: "translator", id: "working", effort: "low" },
  ]);
  respond = (body, response) => {
    if (body.model === "unavailable") {
      response.writeHead(503).end();
      return;
    }
    let content = translated;
    if (body.model === "empty") content = "";
    if (body.model === "echo") content = "SOURCE_TEXT_BEGIN\n" + source;
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  };
  expect(await translator.translate(source)).toEqual({ status: "pending" });
  await expect
    .poll(() => translator.translate(source))
    .toEqual({
      status: "ready",
      hash,
      translation: translated,
    });
  expect(requests.map((request) => request.model)).toEqual([
    "unavailable",
    "empty",
    "echo",
    "working",
  ]);
  expect(requests[0]).not.toHaveProperty("reasoning_effort");
  expect(requests[1]).toHaveProperty("reasoning_effort", "none");
  expect(requests[3]).toHaveProperty("reasoning_effort", "low");

  expect(await translator.translate(source + " Next step.")).toEqual({ status: "pending" });
  await expect
    .poll(() => translator.translate(source + " Next step."))
    .toMatchObject({ status: "ready" });
  expect(requests.map((request) => request.model)).toEqual([
    "unavailable",
    "empty",
    "echo",
    "working",
    "unavailable",
    "empty",
    "echo",
    "working",
  ]);
});

it("shares pending requests and cached translations, but invalidates changed model effort", async () => {
  const responses: ServerResponse[] = [];
  respond = (_body, response) => {
    responses.push(response);
  };
  expect(await translator.translate(source)).toEqual({ status: "pending" });
  await expect.poll(() => responses.length).toBe(1);
  expect(await translator.translate(source)).toEqual({ status: "pending" });
  expect(await translator.translate(source)).toEqual({ status: "pending" });
  responses[0].end(JSON.stringify({ choices: [{ message: { content: translated } }] }));
  await expect
    .poll(() => translator.translate(source))
    .toEqual({ status: "ready", hash, translation: translated });
  expect(await translator.translate(source)).toEqual({
    status: "ready",
    hash,
    translation: translated,
  });
  expect(requests).toHaveLength(1);

  await configure([{ provider: "translator", id: "first", effort: "low" }]);
  expect(await translator.translate(source)).toEqual({ status: "pending" });
  await expect.poll(() => responses.length).toBe(2);
  responses[1].end(JSON.stringify({ choices: [{ message: { content: translated } }] }));
  await expect.poll(() => translator.translate(source)).toMatchObject({ status: "ready" });
  expect(requests[1]).toHaveProperty("reasoning_effort", "low");
});

it("reports the exhausted chain and allows the same text to be retried", async () => {
  respond = (_body, response) => {
    response.writeHead(503).end();
  };
  expect(await translator.translate(source)).toEqual({ status: "pending" });
  await expect
    .poll(() => translator.translate(source))
    .toEqual({
      status: "error",
      message: "translator/first: Translator endpoint returned HTTP 503",
    });
  respond = (_body, response) => {
    response.end(JSON.stringify({ choices: [{ message: { content: translated } }] }));
  };
  expect(await translator.translate(source)).toEqual({ status: "pending" });
  await expect
    .poll(() => translator.translate(source))
    .toEqual({ status: "ready", hash, translation: translated });
  expect(requests).toHaveLength(2);
});

it("rejects a bad entry without silently changing the configured fallback chain", async () => {
  await configure([
    { provider: "translator", id: "first" },
    { provider: "translator", id: "second", effort: "fast" },
  ]);
  expect(await translator.translate(source)).toMatchObject({
    status: "error",
    message: expect.stringContaining("translatorModels.1.effort"),
  });
  expect(requests).toEqual([]);
});

it("reports an empty chain without contacting a provider", async () => {
  await configure([]);
  expect(await translator.translate(source)).toEqual({
    status: "error",
    message: "Configure translatorModels in thinking-translator.json",
  });
  expect(requests).toEqual([]);
});

it("resolves Command Code's default API while honoring its configured endpoint", async () => {
  const address = endpoint.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  await writeFile(
    path.join(agentDir, "models.yml"),
    JSON.stringify({
      providers: {
        commandcode: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "test-credential" },
      },
    }),
  );
  await configure([
    { provider: "commandcode", id: "inclusionai/ling-3.1-flash:free", effort: "minimal" },
  ]);
  expect(await translator.translate(source)).toEqual({ status: "pending" });
  await expect
    .poll(() => translator.translate(source))
    .toEqual({ status: "ready", hash, translation: translated });
  expect(requests[0]).toHaveProperty("model", "inclusionai/ling-3.1-flash:free");
});

it("aborts an in-flight translation on disposal without advancing to another model", async () => {
  await configure([
    { provider: "translator", id: "first" },
    { provider: "translator", id: "second" },
  ]);
  respond = () => {};
  expect(await translator.translate(source)).toEqual({ status: "pending" });
  await expect.poll(() => requests.length).toBe(1);
  translator.dispose();
  expect(await translator.translate(source)).toMatchObject({ status: "error" });
  expect(requests.map((request) => request.model)).toEqual(["first"]);
});
