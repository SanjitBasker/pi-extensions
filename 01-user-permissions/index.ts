import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { handleBashToolCall } from "./bash.js";
import { handleWriteToolCall } from "./file-paths.js";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("bash", event)) {
			return handleBashToolCall(event, ctx);
		}

		if (isToolCallEventType("write", event)) {
			return handleWriteToolCall(event, ctx);
		}

		return undefined;
	});
}
