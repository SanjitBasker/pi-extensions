import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { basename, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

type LspDiagnostic = {
  range?: { start: Position; end: Position };
  severity?: number;
  message?: string;
  source?: string;
  code?: string | number;
};
type Position = { line: number; character: number };
type LspRange = { start: Position; end: Position };
type LspTextEdit = { range: LspRange; newText: string };
type LspWorkspaceEdit = {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{
    textDocument?: { uri?: string };
    edits?: LspTextEdit[];
    kind?: string;
  }>;
};
type LspCodeAction = {
  title?: string;
  kind?: string;
  disabled?: { reason?: string };
  edit?: LspWorkspaceEdit;
};
type Location = { uri: string; range: LspRange };
type LspResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

const cppExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".c++",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".h++",
  ".m",
  ".mm",
  ".inc",
]);

function isCppPath(path: string) {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && cppExtensions.has(path.slice(dot).toLowerCase());
}
function cleanPath(path: string, cwd: string) {
  return resolve(cwd, path.replace(/^@/, ""));
}

function preferredClangdPath() {
  const configPath = resolve(homedir(), ".config/pi_extensions/clangd.toml");
  try {
    const config = readFileSync(configPath, "utf8");
    const match =
      /^\s*(?:path|clangd)\s*=\s*(?:"((?:\\.|[^"])*)"|'([^']*)')\s*(?:#.*)?$/m
        .exec(
          config,
        );
    if (!match) return "clangd";
    const configured = match[1] !== undefined
      ? JSON.parse(`"${match[1]}"`)
      : match[2];
    if (!configured) return "clangd";
    return configured === "~"
      ? homedir()
      : configured.startsWith("~/")
      ? resolve(homedir(), configured.slice(2))
      : configured;
  } catch {
    return "clangd";
  }
}

async function positionFor(
  path: string,
  line: number | string,
  column: number | undefined,
  symbol: string | undefined,
): Promise<Position> {
  // If column is provided, we don't need to resolve line text
  if (column !== undefined) {
    if (typeof line !== "number") {
      throw new Error(
        "When using column, 'line' must be a numeric line number.",
      );
    }
    return { line: line - 1, character: column - 1 };
  }

  const sourceLines = (await readFile(path, "utf8")).split(/\r?\n/);

  let lineIndex: number;
  if (typeof line === "string") {
    // Search for the first matching line
    const matchingLines = sourceLines
      .map((text, idx) => ({ text, idx }))
      .filter(({ text }) => text.includes(line));

    if (matchingLines.length === 0) {
      throw new Error(
        `No line containing ${JSON.stringify(line)} found in ${path}.`,
      );
    }

    if (matchingLines.length > 1) {
      const locations = matchingLines.map(({ idx }) => idx + 1).join(", ");
      throw new Error(
        `Line text ${
          JSON.stringify(line)
        } is ambiguous (found on lines: ${locations}). ` +
          `Supply a numeric line number or more specific text to disambiguate.`,
      );
    }

    lineIndex = matchingLines[0].idx;
  } else {
    lineIndex = line - 1;
  }

  if (lineIndex < 0 || lineIndex >= sourceLines.length) {
    throw new Error(`${path} has no line ${line}.`);
  }

  const sourceLine = sourceLines[lineIndex];

  if (!symbol) return { line: lineIndex, character: 0 };

  const index = sourceLine.indexOf(symbol);
  if (index < 0) {
    throw new Error(`Could not find symbol ${JSON.stringify(symbol)} on line
 ${lineIndex + 1}.`);
  }

  return { line: lineIndex, character: index };
}

async function rangeForLine(
  path: string,
  line: number | string,
): Promise<LspRange> {
  const start = await positionFor(path, line, undefined, undefined);
  const lines = (await readFile(path, "utf8")).split(/\r?\n/);
  return {
    start,
    end: { line: start.line, character: lines[start.line].length },
  };
}

async function rangeForFile(path: string): Promise<LspRange> {
  const lines = (await readFile(path, "utf8")).split(/\r?\n/);
  return {
    start: { line: 0, character: 0 },
    end: { line: lines.length - 1, character: lines[lines.length - 1].length },
  };
}

function severity(value: number | undefined) {
  return [
    "error",
    "warning",
    "information",
    "hint",
  ][Math.max(0, (value ?? 1) - 1)] ?? "error";
}
function location(value: unknown): Location[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is Location =>
    !!item && typeof item === "object" &&
    typeof (item as Location).uri === "string" &&
    !!(item as Location).range
  );
}

/** A deliberately small JSON-RPC client for the session-owned clangd process. */
class Clangd {
  private process?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private diagnosticWaiters = new Map<
    string,
    (diagnostics: LspDiagnostic[]) => void
  >();
  private started = false;
  private stopped = false;
  private failed = false;
  private crashReported = false;

  constructor(
    private readonly root: string,
    private readonly reportCrash: (message: string) => void,
  ) {}

  get unavailable() {
    return this.failed || this.stopped;
  }

  async start() {
    if (this.process) return;
    if (this.failed) {
      throw new Error(
        "clangd is unavailable after it exited; it will not be restarted in this session.",
      );
    }
    if (this.stopped) {
      throw new Error("clangd has been stopped for this session.");
    }

    const child = spawn(preferredClangdPath(), [
      `--compile-commands-dir=${this.root}`,
      "--background-index",
      "--clang-tidy",
    ], { cwd: this.root, stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", () => {}); // clangd logs here; errors are surfaced through its exit.
    child.once(
      "error",
      (error) => this.crashed(`could not start clangd: ${error.message}`),
    );
    child.once("exit", (code, signal) => {
      if (!this.stopped) {
        this.crashed(
          `clangd exited unexpectedly${code === null ? "" : ` (code ${code})`}${
            signal ? ` (${signal})` : ""
          }. It will not be restarted this session.`,
        );
      }
    });

    try {
      await this.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.root).href,
        capabilities: {
          textDocument: {
            definition: { linkSupport: true },
            codeAction: {
              dynamicRegistration: false,
              codeActionLiteralSupport: {
                codeActionKind: { valueSet: ["quickfix"] },
              },
            },
            publishDiagnostics: { relatedInformation: true },
          },
        },
        workspaceFolders: [{
          uri: pathToFileURL(this.root).href,
          name: basename(this.root),
        }],
      });
      this.notify("initialized", {});
      this.started = true;
    } catch (error) {
      this.crashed(
        `clangd initialization failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  async definition(path: string, at: Position) {
    await this.start();
    const uri = pathToFileURL(path).href;
    return this.withOpenDocument(
      uri,
      path,
      async () =>
        location(
          await this.request("textDocument/definition", {
            textDocument: { uri },
            position: at,
          }),
        ),
    );
  }

  async diagnostics(path: string) {
    await this.start();
    const uri = pathToFileURL(path).href;
    return this.withOpenDocument(uri, path, async () => {
      const published = this.waitForDiagnostics(uri);
      // clangd publishes diagnostics in response to didOpen. Pull diagnostics is not
      // universally supported by older clangd versions, so use the portable protocol.
      return await published;
    });
  }

  async quickFix(path: string, range: LspRange) {
    await this.start();
    const uri = pathToFileURL(path).href;
    return this.withOpenDocument(uri, path, async () => {
      const diagnostics = await this.waitForDiagnostics(uri);
      const result = await this.request("textDocument/codeAction", {
        textDocument: { uri },
        range,
        context: { diagnostics, only: ["quickfix"] },
      });
      return Array.isArray(result) ? result : [];
    });
  }

  async close() {
    this.stopped = true;
    const child = this.process;
    this.process = undefined;
    if (!child) return;
    try {
      if (this.started) {
        await Promise.race([
          this.request("shutdown", null).catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
        this.notify("exit", undefined);
      }
    } finally {
      child.kill();
      this.rejectPending(new Error("clangd stopped"));
    }
  }

  private async withOpenDocument<T>(
    uri: string,
    path: string,
    work: () => Promise<T>,
  ) {
    const text = await readFile(path, "utf8");
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "cpp", version: 1, text },
    });
    try {
      return await work();
    } finally {
      if (!this.unavailable) {
        this.notify("textDocument/didClose", { textDocument: { uri } });
      }
    }
  }

  private waitForDiagnostics(uri: string) {
    return new Promise<LspDiagnostic[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.diagnosticWaiters.delete(uri);
        reject(
          new Error("clangd did not publish diagnostics within 10 seconds"),
        );
      }, 10_000);
      this.diagnosticWaiters.set(uri, (diagnostics) => {
        clearTimeout(timer);
        resolve(diagnostics);
      });
    });
  }

  private request(method: string, params: unknown) {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown) {
    if (!this.process?.stdin.writable) throw new Error("clangd is not running");
    const body = JSON.stringify(message);
    this.process.stdin.write(
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  }

  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const boundary = this.buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const header = this.buffer.subarray(0, boundary).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(boundary + 4);
        continue;
      }
      const length = Number(match[1]), start = boundary + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      try {
        this.handle(JSON.parse(body));
      } catch { /* Ignore malformed server output. */ }
    }
  }

  private handle(message: LspResponse & { method?: string; params?: unknown }) {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? "clangd request failed"),
        );
      } else pending.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as {
        uri?: string;
        diagnostics?: LspDiagnostic[];
      };
      if (!params?.uri) return;
      const waiter = this.diagnosticWaiters.get(params.uri);
      if (waiter) {
        this.diagnosticWaiters.delete(params.uri);
        waiter(params.diagnostics ?? []);
      }
    }
  }

  private crashed(message: string) {
    if (this.failed || this.stopped) return;
    this.failed = true;
    this.process = undefined;
    this.rejectPending(new Error(message));
    if (!this.crashReported) {
      this.crashReported = true;
      this.reportCrash(message);
    }
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.diagnosticWaiters.values()) waiter([]);
    this.diagnosticWaiters.clear();
  }
}

function displayPath(path: string, startedIn: string) {
  const fromStart = relative(startedIn, path);
  if (fromStart && fromStart !== ".." && !fromStart.startsWith(`..${sep}`)) {
    return fromStart;
  }
  const home = homedir();
  const fromHome = relative(home, path);
  if (fromHome === "") return "~";
  if (fromHome && fromHome !== ".." && !fromHome.startsWith(`..${sep}`)) {
    return `~/${fromHome}`;
  }
  return path;
}

async function contextForLocation(location: Location, startedIn: string) {
  if (!location.uri.startsWith("file:")) {
    return `${location.uri}:${location.range.start.line + 1}`;
  }
  const path = fileURLToPath(location.uri),
    shownPath = displayPath(path, startedIn);
  try {
    const lines = (await readFile(path, "utf8")).split(/\r?\n/);
    const line = location.range.start.line;
    const start = Math.max(0, line - 2), end = Math.min(lines.length, line + 3);
    return `${shownPath}:${line + 1}:${location.range.start.character + 1}\n${
      lines.slice(start, end).map((text, index) =>
        `${start + index + 1}: ${text}`
      ).join("\n")
    }`;
  } catch {
    return `${shownPath}:${location.range.start.line + 1}:${
      location.range.start.character + 1
    }`;
  }
}

type OffsetEdit = LspTextEdit & { startOffset: number; endOffset: number };
type AppliedOffsetEdit = OffsetEdit & { path: string };
type QuickFixCandidate = { title: string; edits: AppliedOffsetEdit[] };

function offsetForPosition(text: string, position: Position) {
  if (position.line < 0 || position.character < 0) {
    throw new Error("clangd returned a negative text edit position");
  }
  let lineStart = 0;
  for (let line = 0; line < position.line; line++) {
    const newline = text.indexOf("\n", lineStart);
    if (newline < 0) {
      throw new Error("clangd returned an out-of-range text edit");
    }
    lineStart = newline + 1;
  }
  const newline = text.indexOf("\n", lineStart);
  const lineEnd = newline < 0
    ? text.length
    : newline > lineStart && text[newline - 1] === "\r"
    ? newline - 1
    : newline;
  if (position.character > lineEnd - lineStart) {
    throw new Error("clangd returned an out-of-range text edit");
  }
  // JavaScript string indexes and LSP character offsets are both UTF-16.
  return lineStart + position.character;
}

function offsetEdits(text: string, edits: LspTextEdit[]): OffsetEdit[] {
  const mapped = edits.map((edit) => ({
    ...edit,
    startOffset: offsetForPosition(text, edit.range.start),
    endOffset: offsetForPosition(text, edit.range.end),
  }));
  if (mapped.some((edit) => edit.endOffset < edit.startOffset)) {
    throw new Error("clangd returned an invalid text edit range");
  }
  mapped.sort((a, b) =>
    a.startOffset - b.startOffset || a.endOffset - b.endOffset
  );
  for (let index = 1; index < mapped.length; index++) {
    const previous = mapped[index - 1], current = mapped[index];
    const sameInsertion = previous.startOffset === previous.endOffset &&
      current.startOffset === current.endOffset &&
      previous.startOffset === current.startOffset;
    if (sameInsertion || current.startOffset < previous.endOffset) {
      throw new Error("clangd returned overlapping text edits");
    }
  }
  return mapped;
}

function sameEdit(a: OffsetEdit, b: OffsetEdit) {
  return a.startOffset === b.startOffset && a.endOffset === b.endOffset &&
    a.newText === b.newText;
}

function editsOverlap(a: OffsetEdit, b: OffsetEdit) {
  if (sameEdit(a, b)) return false;
  if (a.startOffset === a.endOffset && b.startOffset === b.endOffset) {
    return a.startOffset === b.startOffset;
  }
  if (a.startOffset === a.endOffset) {
    return a.startOffset > b.startOffset && a.startOffset < b.endOffset;
  }
  if (b.startOffset === b.endOffset) {
    return b.startOffset > a.startOffset && b.startOffset < a.endOffset;
  }
  return a.startOffset < b.endOffset && b.startOffset < a.endOffset;
}

function filePathForUri(uri: string) {
  if (!uri.startsWith("file:")) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function workspaceEditEntries(edit: LspWorkspaceEdit) {
  const entries: Array<{ uri: string; edits: LspTextEdit[] }> = [];
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    if (Array.isArray(edits)) entries.push({ uri, edits });
  }
  for (const change of edit.documentChanges ?? []) {
    if (change.textDocument?.uri && Array.isArray(change.edits)) {
      entries.push({ uri: change.textDocument.uri, edits: change.edits });
    }
  }
  return entries;
}

async function applyQuickFixes(actions: unknown[]) {
  const candidates: QuickFixCandidate[] = [];
  const skipped: string[] = [];
  const contents = new Map<string, string>();

  for (const value of actions) {
    const action = value as LspCodeAction | undefined;
    if (!action || typeof action !== "object") continue;
    const title = action.title ?? "untitled clangd quick fix";
    if (action.disabled) {
      skipped.push(`${title} (${action.disabled.reason ?? "disabled"})`);
      continue;
    }
    if (!action.edit) {
      skipped.push(`${title} (clangd returned no workspace edit)`);
      continue;
    }

    const edits: AppliedOffsetEdit[] = [];
    try {
      for (const entry of workspaceEditEntries(action.edit)) {
        const path = filePathForUri(entry.uri);
        if (!path) continue; // Quick fixes normally only edit file URIs.
        let text = contents.get(path);
        if (text === undefined) {
          text = await readFile(path, "utf8");
          contents.set(path, text);
        }
        edits.push(
          ...offsetEdits(text, entry.edits).map((edit) => ({
            ...edit,
            path,
          })),
        );
      }
    } catch (error) {
      skipped.push(
        `${title} (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    if (!edits.length) {
      skipped.push(`${title} (no file edits)`);
      continue;
    }
    candidates.push({ title, edits });
  }

  const accepted = new Map<string, OffsetEdit[]>();
  const appliedTitles: string[] = [];
  for (const candidate of candidates) {
    const byPath = new Map<string, AppliedOffsetEdit[]>();
    for (const edit of candidate.edits) {
      const list = byPath.get(edit.path) ?? [];
      list.push(edit);
      byPath.set(edit.path, list);
    }
    const conflict = [...byPath].some(([path, edits]) => {
      const existing = accepted.get(path) ?? [];
      if (
        edits.some((edit) =>
          existing.some((other) => editsOverlap(edit, other))
        )
      ) {
        return true;
      }
      try {
        offsetEdits(contents.get(path)!, edits);
        return false;
      } catch {
        return true;
      }
    });
    if (conflict) {
      skipped.push(`${candidate.title} (overlaps another quick fix)`);
      continue;
    }
    for (const [path, edits] of byPath) {
      const existing = accepted.get(path) ?? [];
      for (const edit of edits) {
        if (!existing.some((other) => sameEdit(edit, other))) {
          existing.push(edit);
        }
      }
      accepted.set(path, existing);
    }
    appliedTitles.push(candidate.title);
  }

  let filesChanged = 0;
  for (const [path, edits] of accepted) {
    const original = contents.get(path)!;
    const updated = [...edits].sort((a, b) => b.startOffset - a.startOffset)
      .reduce(
        (text, edit) =>
          text.slice(0, edit.startOffset) + edit.newText +
          text.slice(edit.endOffset),
        original,
      );
    if (updated !== original) {
      await writeFile(path, updated);
      filesChanged++;
    }
  }
  return { appliedTitles, skipped, filesChanged };
}

export default function (pi: ExtensionAPI) {
  let client: Clangd | undefined;
  let root: string | undefined;

  function getClient(ctx: any) {
    const cwd = resolve(ctx.cwd);
    if (root && root !== cwd) {
      throw new Error(
        "clangd is bound to a different project root for this session.",
      );
    }
    root = cwd;
    const compdb = resolve(cwd, "compile_commands.json");
    if (!existsSync(compdb)) {
      throw new Error(
        `compile_commands.json is required at ${compdb}; generate it yourself, then start a new session.`,
      );
    }
    return client ??= new Clangd(cwd, (message) => {
      if (ctx.hasUI) ctx.ui.notify(`clangd: ${message}`, "error");
    });
  }

  pi.registerTool({
    name: "cpp_goto",
    label: "C++ Go To Definition",
    description:
      "Resolve the definition or an #include target at a 1-based C/C++ source location using clangd and the root compile_commands.json. Supply column, or symbol to locate on the line.",
    promptSnippet: "Resolve C/C++ symbols and #includes through clangd",
    promptGuidelines: [
      "Use cpp_goto for C/C++ symbol definitions and #include targets; do not search Bazel caches for generated headers.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description:
          "C/C++ file path, relative to the project root or absolute",
      }),

      line: Type.Union(
        [
          Type.Integer({
            minimum: 1,
            description: "1-based line number containing the symbol or include",
          }),
          Type.String({
            minLength: 1,
            description:
              "Substring to match as a line in the source file (disambiguated if multiple lines match)",
          }),
        ],
        {
          description:
            "1-based line number, or substring to find the line in the source file",
        },
      ),

      column: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "1-based column; takes precedence when supplied",
        }),
      ),
      symbol: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Symbol text on line used to infer the column when column is omitted",
        }),
      ),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const path = cleanPath(params.path, ctx.cwd);
      if (!isCppPath(path)) {
        throw new Error("cpp_goto only accepts C/C++ source or header files.");
      }
      const locations = await getClient(ctx).definition(
        path,
        await positionFor(path, params.line, params.column, params.symbol),
      );
      if (!locations.length) {
        return {
          content: [{ type: "text", text: "No definition found." }],
          details: {},
        };
      }
      return {
        content: [{
          type: "text",
          text: (await Promise.all(
            locations.slice(0, 20).map((location) =>
              contextForLocation(location, root ?? ctx.cwd)
            ),
          )).join("\n\n"),
        }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "cpp_quickfix",
    label: "Apply C++ Quick Fix",
    description:
      "Apply clangd quick fixes to a C/C++ file. Supply either a 1-based line number or unique line substring, or all=true to apply fixes for the whole file.",
    promptSnippet: "Apply clangd quick fixes to a C/C++ file",
    parameters: Type.Union([
      Type.Object({
        path: Type.String({
          description:
            "C/C++ file path, relative to the project root or absolute",
        }),
        line: Type.Union([
          Type.Integer({
            minimum: 1,
            description: "1-based line number containing the diagnostic",
          }),
          Type.String({
            minLength: 1,
            description:
              "Substring to match as a line in the source file (disambiguated if multiple lines match)",
          }),
        ]),
      }),
      Type.Object({
        path: Type.String({
          description:
            "C/C++ file path, relative to the project root or absolute",
        }),
        all: Type.Literal(true, {
          description: "Apply quick fixes across the whole file",
        }),
      }),
    ]),
    async execute(_id, params, _signal, _update, ctx) {
      const path = cleanPath(params.path, ctx.cwd);
      if (!isCppPath(path)) {
        throw new Error(
          "cpp_quickfix only accepts C/C++ source or header files.",
        );
      }
      const range = "all" in params
        ? await rangeForFile(path)
        : await rangeForLine(path, params.line);
      const actions = await getClient(ctx).quickFix(path, range);
      const result = await applyQuickFixes(actions);
      const location = relative(ctx.cwd, path) || path;
      const lines: string[] = result.filesChanged
        ? [
          `Applied ${result.appliedTitles.length} quick fix(es) to ${location}.`,
        ]
        : ["No quick fixes changed the file."];
      if (result.appliedTitles.length) {
        lines.push(`Applied: ${result.appliedTitles.join("; ")}`);
      }
      if (result.skipped.length) {
        lines.push(`Skipped: ${result.skipped.join("; ")}`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          filesChanged: result.filesChanged,
          applied: result.appliedTitles,
          skipped: result.skipped,
        },
      };
    },
  });

  pi.registerTool({
    name: "cpp_diagnostics",
    label: "C++ Diagnostics",
    description:
      "Report clangd diagnostics for C/C++ files using the root compile_commands.json.",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), {
        minItems: 1,
        description: "C/C++ file paths",
      }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const clangd = getClient(ctx);
      const reports: string[] = [];
      for (const raw of params.paths) {
        const path = cleanPath(raw, ctx.cwd);
        if (!isCppPath(path)) continue;
        const diagnostics = await clangd.diagnostics(path);
        reports.push(
          `${relative(ctx.cwd, path) || path}: ${
            diagnostics.length
              ? diagnostics.map((d) =>
                `${severity(d.severity)}:${(d.range?.start.line ?? 0) + 1}:${
                  (d.range?.start.character ?? 0) + 1
                }: ${d.message ?? ""}`
              ).join("\n")
              : "no diagnostics"
          }`,
        );
      }
      return {
        content: [{
          type: "text",
          text: reports.join("\n\n") || "No C/C++ files supplied.",
        }],
        details: {},
      };
    },
  });

  pi.registerCommand("clangd-check", {
    description: "Run clangd diagnostics on git-changed C/C++ files",
    handler: async (_args, ctx) => {
      try {
        const result = await pi.exec("git", ["diff", "--name-only", "HEAD"], {
          cwd: ctx.cwd,
          timeout: 10_000,
        });
        if (result.code !== 0) {
          throw new Error(result.stderr || "git diff failed");
        }
        const paths = result.stdout.split(/\r?\n/).filter((path) =>
          path && isCppPath(path)
        );
        if (!paths.length) {
          if (ctx.hasUI) {
            ctx.ui.notify("clangd-check: no changed C/C++ files", "info");
          }
          return;
        }
        const clangd = getClient(ctx);
        const reports = await Promise.all(paths.map(async (raw) => {
          const path = cleanPath(raw, ctx.cwd),
            diagnostics = await clangd.diagnostics(path);
          return `${raw}: ${
            diagnostics.length
              ? diagnostics.map((d) =>
                `${severity(d.severity)}:${(d.range?.start.line ?? 0) + 1}: ${
                  d.message ?? ""
                }`
              ).join("; ")
              : "no diagnostics"
          }`;
        }));
        if (ctx.hasUI) {
          ctx.ui.notify(`clangd-check:\n${reports.join("\n")}`, "info");
        }
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `clangd-check: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "error",
          );
        }
      }
    },
  });

  // Start eagerly when the user has supplied the root compilation database so
  // clangd can build its background index before the first semantic query.
  pi.on("session_start", (_event, ctx) => {
    if (!existsSync(resolve(ctx.cwd, "compile_commands.json"))) return;
    getClient(ctx).start().catch(() => {
      // start() has already reported the one permitted crash notification.
    });
  });
  pi.on("session_shutdown", async () => {
    await client?.close();
  });
}
