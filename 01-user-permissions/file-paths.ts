import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import type { ExtensionContext, ToolCallEventResult, WriteToolCallEvent } from "@mariozechner/pi-coding-agent";

export function findRepoRoot(cwd: string): string {
	let dir = resolve(cwd);
	while (true) {
		if (existsSync(resolve(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return resolve(cwd);
		dir = parent;
	}
}

export function realpathIfExists(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}

export function isWithinDirectory(path: string, directory: string): boolean {
	const resolvedPath = resolve(path);
	const resolvedDirectory = resolve(directory);
	return resolvedPath === resolvedDirectory || resolvedPath.startsWith(`${resolvedDirectory}/`);
}

function pathComponents(path: string): string[] {
	return path.split(/[\\/]+/).filter(Boolean);
}

export function resolvePhysicalWritePath(
	inputPath: string,
	cwd: string,
): { path: string; unsafeSymlinkTraversal: boolean } {
	const absoluteCwd = resolve(cwd);
	const realCwd = realpathIfExists(absoluteCwd);
	const absoluteInputPath = resolve(inputPath);
	let physical = isAbsolute(inputPath) ? parse(absoluteInputPath).root : realCwd;
	let sawSymlink = !isAbsolute(inputPath) && realCwd !== absoluteCwd;
	let unsafeSymlinkTraversal = false;
	const components = isAbsolute(inputPath)
		? pathComponents(absoluteInputPath.slice(parse(absoluteInputPath).root.length))
		: pathComponents(inputPath);

	for (const component of components) {
		if (component === ".") continue;
		if (component === "..") {
			if (sawSymlink) unsafeSymlinkTraversal = true;
			physical = dirname(physical);
			continue;
		}

		const candidate = resolve(physical, component);
		try {
			const stat = lstatSync(candidate);
			if (stat.isSymbolicLink()) {
				sawSymlink = true;
				physical = realpathSync.native(candidate);
			} else {
				physical = candidate;
			}
		} catch {
			physical = candidate;
		}
	}

	return { path: physical, unsafeSymlinkTraversal };
}

export async function handleWriteToolCall(
	event: WriteToolCallEvent,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	const inputPath = String(event.input.path ?? "");
	if (inputPath.trim().length === 0) {
		return { block: true, reason: "Write blocked: missing file path." };
	}

	const targetPath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(ctx.cwd, inputPath);
	const physicalTarget = resolvePhysicalWritePath(inputPath, ctx.cwd);
	const repoRoot = findRepoRoot(ctx.cwd);
	const physicalRepoRoot = realpathIfExists(repoRoot);
	const physicalWorkspaceRoot = realpathIfExists(dirname(repoRoot));

	const allowedByPath =
		isWithinDirectory(physicalTarget.path, physicalRepoRoot) ||
		(!physicalTarget.unsafeSymlinkTraversal && isWithinDirectory(physicalTarget.path, physicalWorkspaceRoot));

	if (allowedByPath) {
		return undefined;
	}

	if (!ctx.hasUI) {
		return {
			block: true,
			reason: `Write blocked: ${targetPath} resolves to ${physicalTarget.path}, which is outside the permitted workspace, and permission prompt is unavailable in this mode.`,
		};
	}

	const allowed = await ctx.ui.confirm(
		"Allow write outside workspace?",
		`Target: ${targetPath}\nResolves to: ${physicalTarget.path}\nRepo/session root: ${repoRoot}`,
	);
	if (!allowed) {
		return { block: true, reason: "Write outside workspace blocked by user." };
	}

	return undefined;
}
