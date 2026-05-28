import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import type { BashToolCallEvent, ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

type PreferredCommandRule = {
	contains: string;
	preferred: string;
	message?: string;
};

const CONFIG_PATH = join(homedir(), ".config", "pi_extensions", "preferred_commands.toml");
const DEFAULT_RULES: PreferredCommandRule[] = [
	{ contains: "grep", preferred: "rg", message: "Use rg instead of grep." },
	{ contains: "find", preferred: "fd", message: "Use fd instead of find." },
];

let cachedRules: { mtimeMs: number | undefined; rules: PreferredCommandRule[] } | undefined;
const availabilityCache = new Map<string, boolean>();

// yuck
function parsePreferredCommandsToml(text: string): PreferredCommandRule[] {
	const rules: PreferredCommandRule[] = [];
	let current: Partial<PreferredCommandRule> | undefined;

	const flush = () => {
		if (current?.contains && current.preferred) {
			rules.push({ contains: current.contains, preferred: current.preferred, message: current.message });
		}
	};

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/\s+#.*$/, "").trim();
		if (!line) continue;

		if (line === "[[rule]]" || line === "[[rules]]") {
			flush();
			current = {};
			continue;
		}

		const match = line.match(/^(contains|preferred|message)\s*=\s*"((?:\\"|[^"])*)"\s*$/);
		if (!match) continue;
		current ??= {};
		current[match[1] as keyof PreferredCommandRule] = match[2].replace(/\\"/g, '"');
	}

	flush();
	return rules;
}

function getConfigMtimeMs(): number | undefined {
	try {
		return existsSync(CONFIG_PATH) ? statSync(CONFIG_PATH).mtimeMs : undefined;
	} catch {
		return undefined;
	}
}

function loadRules(): PreferredCommandRule[] {
	const mtimeMs = getConfigMtimeMs();
	if (cachedRules && cachedRules.mtimeMs === mtimeMs) return cachedRules.rules;

	let rules = DEFAULT_RULES;
	if (existsSync(CONFIG_PATH)) {
		try {
			const parsed = parsePreferredCommandsToml(readFileSync(CONFIG_PATH, "utf8"));
			if (parsed.length > 0) rules = parsed;
		} catch {
			rules = DEFAULT_RULES;
		}
	}

	cachedRules = { mtimeMs, rules };
	return rules;
}

function commandExists(command: string): boolean {
	const cached = availabilityCache.get(command);
	if (cached !== undefined) return cached;

	let exists = false;
	try {
		execFileSync("which", [command], { stdio: "ignore" });
		exists = true;
	} catch {
		exists = false;
	}

	availabilityCache.set(command, exists);
	return exists;
}

function commandContainsWord(command: string, word: string): boolean {
	const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`).test(command);
}

async function handleBashToolCall(
	event: BashToolCallEvent,
	_ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	const command = String(event.input.command ?? "");
	for (const rule of loadRules()) {
		if (commandContainsWord(command, rule.contains) && commandExists(rule.preferred)) {
			return {
				block: true,
				reason: rule.message ?? `Use ${rule.preferred} instead of ${rule.contains}.`,
			};
		}
	}

	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("bash", event)) {
			return handleBashToolCall(event, ctx);
		}

		return undefined;
	});
}
