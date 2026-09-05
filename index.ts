import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import userPermissions from "./01-user-permissions/index.ts";
import descriptiveFooter from "./02-descriptive-footer/index.ts";
import observationalMemory from "./03-observational-memory/index.ts";
import backgroundTerminals from "./background-terminals/index.ts";
import fileSearch from "./file-search/index.ts";
import subagents from "./subagents/index.ts";

export default function piExtensions(pi: ExtensionAPI) {
  userPermissions(pi);
  descriptiveFooter(pi);
  observationalMemory(pi);
  backgroundTerminals(pi);
  fileSearch(pi);
  subagents(pi);
}
