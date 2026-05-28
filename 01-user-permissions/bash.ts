import type { BashToolCallEvent, ExtensionContext, ToolCallEventResult } from "@mariozechner/pi-coding-agent";

export async function handleBashToolCall(
	event: BashToolCallEvent,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	const command = String(event.input.command ?? "");
	if (command.trim().length === 0) {
		return { block: true, reason: "Empty bash command blocked." };
	}

	if (!ctx.hasUI) {
		return {
			block: true,
			reason: "Bash command blocked: permission prompt is unavailable in this mode.",
		};
	}

	const allowed = await ctx.ui.confirm("Allow bash command?", command);
	if (!allowed) {
		return { block: true, reason: "Bash command blocked by user." };
	}

	return undefined;
}
