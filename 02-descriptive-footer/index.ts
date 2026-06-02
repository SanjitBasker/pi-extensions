import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type FooterData = {
	getGitBranch?: () => string | null;
	getExtensionStatuses?: () => ReadonlyMap<string, string>;
	getAvailableProviderCount?: () => number;
	onBranchChange?: (callback: () => void) => () => void;
};

type Totals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function truncate(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	if (width <= 3) return text.slice(0, width);
	return `${text.slice(0, width - 3)}...`;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function compactCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

function justifyLine(left: string, right: string, width: number): string {
	const minPadding = 2;

	if (width <= 0) return "";
	if (!right) return truncate(left, width);
	if (!left) return truncate(right, width);

	const totalWidth = left.length + minPadding + right.length;
	if (totalWidth <= width) return `${left}${" ".repeat(width - left.length - right.length)}${right}`;

	const availableForLeft = width - minPadding - right.length;
	if (availableForLeft > 0) {
		const truncatedLeft = truncate(left, availableForLeft);
		return `${truncatedLeft}${" ".repeat(Math.max(minPadding, width - truncatedLeft.length - right.length))}${right}`;
	}

	return truncate(right, width);
}

function getTotals(ctx: ExtensionContext): Totals {
	const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		totals.input += message.usage.input;
		totals.output += message.usage.output;
		totals.cacheRead += message.usage.cacheRead;
		totals.cacheWrite += message.usage.cacheWrite;
		totals.cost += message.usage.cost.total;
	}

	return totals;
}

function installFooter(ctx: ExtensionContext): void {
	ctx.ui.setFooter((tui, theme, rawFooterData) => {
		const footerData = rawFooterData as FooterData;
		const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender()) ?? (() => {});

		return {
			dispose: unsubscribe,
			invalidate() {},
			render(width: number): string[] {
				const totals = getTotals(ctx);
				const context = ctx.getContextUsage();
				const contextPercent = context?.percent == null ? "?" : `${context.percent.toFixed(1)}%`;
				const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow;
				const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;

				let cwd = compactCwd(ctx.sessionManager.getCwd());
				const branch = footerData.getGitBranch?.();
				if (branch) cwd = `${cwd} (${branch})`;
				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) cwd = `${cwd} • ${sessionName}`;

				const cachedInput = totals.cacheRead + totals.cacheWrite;
				const totalInputTraffic = totals.input + cachedInput;
				const cachePct = cachedInput > 0 && totalInputTraffic > 0 ? (cachedInput / totalInputTraffic) * 100 : null;
				const inputCacheSuffix = cachePct == null ? "" : ` ($${cachePct.toFixed(0)}%)`;
				const trafficParts = [
					`↑ ${formatTokens(totals.input)}${inputCacheSuffix}`,
					`↓ ${formatTokens(totals.output)}`,
				];

				const contextPart = contextWindow
					? `context: ${contextPercent} of ${formatTokens(contextWindow)}`
					: `context: ${contextPercent}`;

				const modelParts: string[] = [];
				if ((footerData.getAvailableProviderCount?.() ?? 0) > 1 && ctx.model?.provider) {
					modelParts.push(ctx.model.provider);
				}
				modelParts.push(ctx.model?.id ?? "no model");
				if (ctx.model?.reasoning) modelParts.push("reasoning enabled");

				const line1 = cwd;
				const line2Left = [contextPart, `model: ${modelParts.join(" / ")}`].join("   |   ");
				const line2Right = [
					`cost: $${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
					`total traffic: ${trafficParts.join(", ")}`,
				].join("   |   ");
				const line2 = justifyLine(line2Left, line2Right, width);

				const lines = [
					theme.fg("dim", truncate(line1, width)),
					theme.fg("dim", truncate(line2, width)),
				];

				const statuses = footerData.getExtensionStatuses?.();
				if (statuses && statuses.size > 0) {
					const statusLine = Array.from(statuses.entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatusText(text))
						.join(" ");
					lines.push(theme.fg("dim", truncate(statusLine, width)));
				}

				return lines;
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	let enabled = process.env.PI_DESCRIPTIVE_FOOTER !== "0";

	pi.on("session_start", async (_event, ctx) => {
		if (enabled) installFooter(ctx);
	});

	pi.registerCommand("descriptive-footer", {
		description: "Toggle the descriptive footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				installFooter(ctx);
				ctx.ui.notify("Descriptive footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});
}
