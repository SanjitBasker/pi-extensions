import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import {
  commandInvocations,
  extractInPlaceTargets,
  isSafeBash,
  parseBash,
  permanentBlock,
} from "./policy.ts";

type Rule = { contains: string; preferred: string; message: string };
const defaults: Rule[] = [{
  contains: "grep",
  preferred: "rg",
  message: "The user prefers that you use rg instead of grep.",
}, {
  contains: "find",
  preferred: "fd",
  message: "The user prefers that you use fd instead of find.",
}];
let ruleMtime: number | undefined, rules = defaults;
const availability = new Map<string, boolean>();
function preferredRules(): Rule[] {
  const file = join(homedir(), ".config/pi_extensions/preferred_commands.toml");
  let mt: number | undefined;
  try {
    mt = statSync(file).mtimeMs;
  } catch {}
  if (mt === ruleMtime) return rules;
  ruleMtime = mt;
  if (mt === undefined) return rules = defaults;
  try {
    const text = readFileSync(file, "utf8");
    const found: Rule[] = [];
    for (
      const section of text.split(/^\s*\[\[(?:rule|rules)\]\]\s*(?:#.*)?$/m)
        .slice(1)
    ) {
      const value = (k: string) => {
        const m = section.match(
          new RegExp(`^\\s*${k}\\s*=\\s*"((?:\\\\"|[^"])*)"\\s*(?:#.*)?$`, `m`),
        );
        return m?.[1].replace(/\\"/g, '"');
      };
      const contains = value("contains"), preferred = value("preferred");
      if (contains && preferred) {
        found.push({
          contains,
          preferred,
          message: value("message") ||
            `Use ${preferred} instead of ${contains}.`,
        });
      }
    }
    rules = found.length ? found : defaults;
  } catch {
    rules = defaults;
  }
  return rules;
}
function available(name: string) {
  if (!availability.has(name)) {
    try {
      execFileSync("which", [name], { stdio: "ignore" });
      availability.set(name, true);
    } catch {
      availability.set(name, false);
    }
  }
  return availability.get(name)!;
}
function inside(path: string, root: string) {
  const r = resolve(root), p = resolve(path);
  return p === r || p.startsWith(r + sep);
}
async function safeEdit(targets: string[], cwd: string) {
  for (const target of targets) {
    try {
      const logical = resolve(cwd, target);
      if (!lstatSync(logical).isFile()) return false;
      const real = realpathSync(logical);
      const repo = execFileSync("git", [
        "-C",
        dirname(real),
        "rev-parse",
        "--show-toplevel",
      ], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!inside(real, realpathSync(repo))) return false;
    } catch {
      return false;
    }
  }
  return true;
}
function splitStatements(s: string) {
  let out = "", depth = 0, quote = "", esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (esc) {
      out += c;
      esc = false;
      continue;
    }
    if (c === "\\" && quote !== "'") {
      out += c;
      esc = true;
      continue;
    }
    if (quote) {
      out += c;
      if (c === quote) quote = "";
      continue;
    }
    if ("'\"`".includes(c)) {
      quote = c;
      out += c;
      continue;
    }
    if ("({[".includes(c)) depth++;
    if (")}]".includes(c)) depth = Math.max(0, depth - 1);
    if (
      !depth &&
      (c === "\n" || c === ";" || (c === "&" && n === "&") ||
        (c === "|" && n === "|"))
    ) {
      if (c !== "\n") out += c + (n === c ? (i++, c) : "");
      out = out.trimEnd() + "\n";
      continue;
    }
    out += c;
  }
  return out.trim();
}
function formatCommand(command: string) {
  const r = spawnSync("shfmt", [
    "-i",
    "2",
    "-ci",
    "-bn",
    "-filename",
    "script.sh",
  ], {
    input: command,
    encoding: "utf8",
    timeout: 500,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const formatted = r.status === 0 ? r.stdout.trimEnd() : "";
  return formatted && formatted !== command.trim()
    ? formatted
    : splitStatements(command);
}
function repoRoot(cwd: string) {
  let p = resolve(cwd);
  for (;;) {
    if (existsSync(join(p, ".git"))) return p;
    const up = dirname(p);
    if (up === p) return resolve(cwd);
    p = up;
  }
}
function physical(input: string, cwd: string) {
  let encountered = false, unsafe = false;
  let current = isAbsolute(input) ? parse(input).root : realpathSync(cwd);
  if (!isAbsolute(input) && resolve(cwd) !== current) encountered = true;
  for (const part of input.split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (encountered) unsafe = true;
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    try {
      if (lstatSync(next).isSymbolicLink()) {
        encountered = true;
        current = realpathSync(next);
      } else current = next;
    } catch {
      current = next;
    }
  }
  return { path: resolve(current), unsafe };
}

export default function (pi: ExtensionAPI) {
  const awayEntryType = "user-permissions-away";
  const awayStatusKey = "user-permissions-away";
  let userAway = false;

  const updateAwayStatus = (ctx: any) => {
    ctx.ui.setStatus(
      awayStatusKey,
      userAway ? "user away: approvals disabled" : undefined,
    );
  };

  pi.on("session_start", (_event: any, ctx: any) => {
    userAway = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== awayEntryType) {
        continue;
      }
      const enabled = (entry.data as { enabled?: unknown } | undefined)
        ?.enabled;
      if (typeof enabled === "boolean") userAway = enabled;
    }
    updateAwayStatus(ctx);
  });

  pi.registerCommand("user-away", {
    description:
      "Toggle rejection of commands needing approval (on|off|status)",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "status") {
        ctx.ui.notify(
          `User-away mode is ${userAway ? "on" : "off"}.`,
          "info",
        );
        return;
      }
      if (action && action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /user-away [on|off|status]", "warning");
        return;
      }

      const enabled = action === "on"
        ? true
        : action === "off"
        ? false
        : !userAway;
      if (userAway !== enabled) {
        userAway = enabled;
        pi.appendEntry(awayEntryType, { enabled });
      }
      updateAwayStatus(ctx);
      ctx.ui.notify(
        enabled
          ? "User-away mode enabled; commands needing approval will be rejected."
          : "User-away mode disabled; approval prompts are available again.",
        "info",
      );
    },
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.toolName === "bash") {
      const command = String(event.input?.command ?? "");
      const parsed = parseBash(command);
      if (parsed) {
        const block = permanentBlock(parsed.root);
        if (block) return { block: true, reason: block };
        const invoked = new Set(
          commandInvocations(parsed.root).map((x) => x.name),
        );
        for (const rule of preferredRules()) {
          if (invoked.has(rule.contains) && available(rule.preferred)) {
            return { block: true, reason: rule.message };
          }
        }
      }
      if (!command.trim()) {
        return { block: true, reason: "Empty bash command blocked." };
      }
      if (parsed && isSafeBash(parsed.root)) return;
      if (parsed) {
        const targets = extractInPlaceTargets(parsed.root);
        if (targets && await safeEdit(targets, ctx.cwd)) return;
      }
      if (userAway) {
        const reviewFile = join(
          repoRoot(ctx.cwd),
          ".pi",
          "user-permissions-review.md",
        );
        return {
          block: true,
          reason:
            "Command rejected: the user is away and cannot approve it. " +
            "If you believe this command is read-only or should be added to " +
            `the auto-approve list, save the exact command and a brief rationale to ${reviewFile} ` +
            "and report it at the end of your turn.",
        };
      }
      if (!ctx.hasUI) {
        return {
          block: true,
          reason:
            "Bash command blocked: permission prompt is unavailable in this mode.",
        };
      }
      if (
        !await ctx.ui.confirm("Allow bash command?", formatCommand(command))
      ) return { block: true, reason: "Bash command blocked by user." };
      return;
    }
    if (event.toolName === "write") {
      const raw = typeof event.input?.path === "string" ? event.input.path : "";
      if (!raw.trim()) {
        return { block: true, reason: "Write blocked: missing file path." };
      }
      const root = repoRoot(ctx.cwd), workspace = dirname(root);
      let target: { path: string; unsafe: boolean };
      try {
        target = physical(raw, ctx.cwd);
      } catch {
        target = { path: resolve(ctx.cwd, raw), unsafe: true };
      }
      let rr = root, wr = workspace;
      try {
        rr = realpathSync(root);
      } catch {}
      try {
        wr = realpathSync(workspace);
      } catch {}
      if (
        inside(target.path, rr) || (inside(target.path, wr) && !target.unsafe)
      ) return;
      const logical = resolve(ctx.cwd, raw),
        body =
          `Target: ${logical}\nResolves to: ${target.path}\nRepo/session root: ${root}`;
      if (!ctx.hasUI) {
        return {
          block: true,
          reason:
            `Write outside workspace blocked: permission prompt is unavailable in this mode.\n${body}`,
        };
      }
      if (!await ctx.ui.confirm("Allow write outside workspace?", body)) {
        return {
          block: true,
          reason: "Write outside workspace blocked by user.",
        };
      }
    }
  });
}
