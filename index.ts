import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import userPermissions from "./01-user-permissions/index.ts";
import descriptiveFooter from "./02-descriptive-footer/index.ts";
import observationalMemory from "./03-observational-memory/index.ts";
import clangd from "./04-clangd/index.ts";

export default function piExtensions(pi: ExtensionAPI) {
  userPermissions(pi);
  descriptiveFooter(pi);
  observationalMemory(pi);
  clangd(pi);
}
