import type { PluginServerContext } from "@getpaseo/plugin/server";
import { checkWorkspace } from "./server/gate";
import { workspaceGateRpc } from "./shared/gate";

export default function contribute(server: PluginServerContext) {
  server.handle(workspaceGateRpc, checkWorkspace);
  return () => {};
}
