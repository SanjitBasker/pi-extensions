import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  isEditToolResult,
  isReadToolResult,
  isWriteToolResult,
} from "@earendil-works/pi-coding-agent";

type ProjectConfig = {
  name: string;
  memoryRoot: string;
};

type DirectoryMapping = {
  directory: string;
  project: string;
};

type ExternalMemoryConfig = {
  projects: ProjectConfig[];
  mappings: DirectoryMapping[];
};

type ActiveProject = {
  name: string;
  projectRoot: string;
  memoryRoot: string;
};

type ExternalMemoryEntry =
  | {
    kind: "memory-sent";
    project: string;
    memoryPath: string;
    forPath: string;
    timestamp: number;
  }
  | {
    kind: "path-touched";
    project: string;
    path: string;
    timestamp: number;
  };

const CONFIG_PATH = join(
  homedir(),
  ".config",
  "pi_extensions",
  "external_memory.toml",
);
const ENTRY_TYPE = "external-memory";
const AGENTS_FILE = "AGENTS.md";

let config: ExternalMemoryConfig = { projects: [], mappings: [] };
let activeProject: ActiveProject | undefined;
let sentMemoryFiles = new Set<string>();
let touchedPaths = new Set<string>();

function unquoteTomlString(value: string): string | undefined {
  const match = value.trim().match(/^"((?:\\"|[^"])*)"$/);
  return match?.[1].replace(/\\"/g, '"');
}

function parseExternalMemoryToml(text: string): ExternalMemoryConfig {
  const projects: ProjectConfig[] = [];
  const mappings: DirectoryMapping[] = [];
  let section: "project" | "mapping" | undefined;
  let current: Record<string, string> = {};

  const flush = () => {
    if (
      section === "project" && current.name &&
      (current.memory_root || current.memoryRoot)
    ) {
      projects.push({
        name: current.name,
        memoryRoot: current.memory_root ?? current.memoryRoot,
      });
    } else if (
      section === "mapping" && (current.directory || current.path) &&
      current.project
    ) {
      mappings.push({
        directory: current.directory ?? current.path,
        project: current.project,
      });
    }
    current = {};
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line) continue;

    if (line === "[[project]]" || line === "[[projects]]") {
      flush();
      section = "project";
      continue;
    }
    if (
      line === "[[mapping]]" || line === "[[mappings]]" ||
      line === "[[directory_mapping]]"
    ) {
      flush();
      section = "mapping";
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!match || !section) continue;
    const value = unquoteTomlString(match[2]);
    if (value !== undefined) current[match[1]] = value;
  }

  flush();
  return { projects, mappings };
}

function loadConfig(): ExternalMemoryConfig {
  if (!existsSync(CONFIG_PATH)) return { projects: [], mappings: [] };
  try {
    return parseExternalMemoryToml(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { projects: [], mappings: [] };
  }
}

function isUnderOrEqual(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveActiveProject(cwd: string): ActiveProject | undefined {
  const projectByName = new Map(
    config.projects.map((project) => [project.name, project]),
  );
  const resolvedCwd = resolve(cwd);
  const matching = config.mappings
    .map((mapping) => ({ ...mapping, directory: resolve(mapping.directory) }))
    .filter((mapping) => isUnderOrEqual(resolvedCwd, mapping.directory))
    .sort((a, b) => b.directory.length - a.directory.length)[0];
  if (!matching) return undefined;

  const project = projectByName.get(matching.project);
  if (!project) return undefined;

  return {
    name: project.name,
    projectRoot: matching.directory,
    memoryRoot: resolve(project.memoryRoot),
  };
}

function projectRelativePath(
  filePath: string,
  project: ActiveProject,
): string | undefined {
  const absolutePath = resolve(project.projectRoot, filePath);
  if (!isUnderOrEqual(absolutePath, project.projectRoot)) return undefined;
  return relative(project.projectRoot, absolutePath).replace(/\\/g, "/");
}

function memoryFilesForProjectPath(
  projectRelativeFile: string,
  project: ActiveProject,
): string[] {
  const normalized = projectRelativeFile.replace(/\\/g, "/");
  const dir = normalized.endsWith("/") ? normalized : dirname(normalized);
  const parts = dir === "." ? [] : dir.split("/").filter(Boolean);
  const candidates: string[] = [];

  let current = project.memoryRoot;
  candidates.push(join(current, AGENTS_FILE));
  for (const part of parts) {
    current = join(current, part);
    candidates.push(join(current, AGENTS_FILE));
  }

  return candidates.filter((candidate) => {
    try {
      return existsSync(candidate) && statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function formatMemory(files: string[], intro: string): string {
  const sections = files.map((filePath) =>
    `## ${filePath}\n\n${readFileSync(filePath, "utf8").trim()}\n`
  );
  return `# External Memory\n\n${intro}\n\n${sections.join("\n")}`.trim();
}

function markTouched(
  pi: ExtensionAPI,
  project: ActiveProject,
  relativePath: string,
): void {
  const key = `${project.name}:${relativePath}`;
  if (touchedPaths.has(key)) return;
  touchedPaths.add(key);
  pi.appendEntry<ExternalMemoryEntry>(ENTRY_TYPE, {
    kind: "path-touched",
    project: project.name,
    path: relativePath,
    timestamp: Date.now(),
  });
}

function markSent(
  pi: ExtensionAPI,
  project: ActiveProject,
  memoryPath: string,
  forPath: string,
): void {
  const resolvedMemoryPath = resolve(memoryPath);
  if (sentMemoryFiles.has(resolvedMemoryPath)) return;
  sentMemoryFiles.add(resolvedMemoryPath);
  pi.appendEntry<ExternalMemoryEntry>(ENTRY_TYPE, {
    kind: "memory-sent",
    project: project.name,
    memoryPath: resolvedMemoryPath,
    forPath,
    timestamp: Date.now(),
  });
}

function restoreState(ctx: ExtensionContext): void {
  sentMemoryFiles = new Set();
  touchedPaths = new Set();

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const data = entry.data as ExternalMemoryEntry | undefined;
    if (!data || data.project !== activeProject?.name) continue;

    if (data.kind === "memory-sent") {
      sentMemoryFiles.add(resolve(data.memoryPath));
    } else if (data.kind === "path-touched") {
      touchedPaths.add(`${data.project}:${data.path}`);
    }
  }
}

function extractPromptPaths(prompt: string, project: ActiveProject): string[] {
  const candidates = new Set<string>();
  const regex =
    /`([^`]+)`|"([^"]+)"|'([^']+)'|([A-Za-z0-9_./~@+-]+\/[A-Za-z0-9_./~@+-]*)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(prompt))) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!raw || raw.includes("\n")) continue;
    const cleaned = raw.replace(/[.?!]+$/, "");
    const rel = projectRelativePath(cleaned, project);
    if (rel) candidates.add(rel);
  }

  return Array.from(candidates);
}

function unsentMemoryForPaths(
  paths: string[],
  project: ActiveProject,
): string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  for (const relPath of paths) {
    for (const file of memoryFilesForProjectPath(relPath, project)) {
      const resolved = resolve(file);
      if (sentMemoryFiles.has(resolved) || seen.has(resolved)) continue;
      seen.add(resolved);
      files.push(resolved);
    }
  }

  return files;
}

function pathFromReadEvent(
  event: { input: { path?: unknown } },
): string | undefined {
  const rawPath = event.input.path;
  return typeof rawPath === "string" ? rawPath : undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    activeProject = resolveActiveProject(ctx.cwd);
    restoreState(ctx);

    if (activeProject) {
      ctx.ui.setStatus(ENTRY_TYPE, `external memory: ${activeProject.name}`);
    } else {
      ctx.ui.setStatus(ENTRY_TYPE, "");
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!activeProject) return undefined;

    const touchedProjectPaths = Array.from(touchedPaths)
      .map((key) => key.split(":", 2))
      .filter(([projectName]) => projectName === activeProject?.name)
      .map(([, relPath]) => relPath)
      .filter((relPath): relPath is string => !!relPath);
    const promptPaths = extractPromptPaths(event.prompt, activeProject);
    const paths = Array.from(new Set([...touchedProjectPaths, ...promptPaths]));
    const files = unsentMemoryForPaths(paths, activeProject);
    if (files.length === 0) return undefined;

    for (const file of files) {
      markSent(pi, activeProject, file, "before-agent-start");
    }

    return {
      message: {
        customType: ENTRY_TYPE,
        content: formatMemory(files, "External memory relevant to this turn."),
        display: true,
        details: { files },
      },
    };
  });

  pi.on("tool_result", async (event) => {
    if (!activeProject || event.isError) return undefined;

    let rawPath: string | undefined;
    if (isReadToolResult(event)) rawPath = pathFromReadEvent(event);
    else if (isEditToolResult(event) || isWriteToolResult(event)) {
      rawPath = typeof event.input.path === "string"
        ? event.input.path
        : undefined;
    }
    if (!rawPath) return undefined;

    const relPath = projectRelativePath(rawPath, activeProject);
    if (!relPath) return undefined;
    markTouched(pi, activeProject, relPath);

    if (!isReadToolResult(event)) return undefined;

    const files = unsentMemoryForPaths([relPath], activeProject);
    if (files.length === 0) return undefined;
    for (const file of files) markSent(pi, activeProject, file, relPath);

    return {
      content: [
        ...event.content,
        {
          type: "text",
          text: `\n\n---\n\n${
            formatMemory(files, `External memory relevant to ${relPath}.`)
          }`,
        },
      ],
    };
  });
}
