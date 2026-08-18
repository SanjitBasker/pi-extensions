import Parser from "tree-sitter";
import Bash from "tree-sitter-bash";
import { basename } from "node:path";

const parser = new Parser();
parser.setLanguage(Bash as any);
export type Node = Parser.SyntaxNode;
export type ParseResult = { root: Node } | undefined;

export function parseBash(source: string): ParseResult {
  try {
    const root = parser.parse(source).rootNode;
    return root.hasError ? undefined : { root };
  } catch {
    return undefined;
  }
}

function literalName(n: Node): string | undefined {
  if (n.type !== "command") return;
  const cn = n.childForFieldName("name");
  if (!cn || cn.type !== "command_name" || cn.namedChildCount !== 1) return;
  const word = cn.namedChild(0)!;
  if (word.type !== "word" || word.namedChildCount) return;
  return basename(word.text);
}
export function commandInvocations(root: Node): { name: string; node: Node }[] {
  const out: { name: string; node: Node }[] = [];
  const walk = (n: Node) => {
    const name = literalName(n);
    if (name) out.push({ name, node: n });
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  return out;
}
function literalArg(n: Node): string | undefined {
  if ((n.type === "word" || n.type === "number") && n.namedChildCount === 0) {
    return n.text.replace(/\\(.)/g, "$1");
  }
  if (n.type === "raw_string" && n.namedChildCount === 0) {
    return n.text.slice(1, -1);
  }
  if (
    n.type === "string" &&
    n.namedChildren.every((c) => c.type === "string_content")
  ) return n.text.slice(1, -1).replace(/\\([\\"$`])/g, "$1");
  if (n.type === "concatenation") {
    const parts = n.namedChildren.map(literalArg);
    if (parts.every((x) => x !== undefined)) return parts.join("");
  }
}
function args(node: Node): Node[] {
  const name = node.childForFieldName("name");
  const redirects = new Set(node.childrenForFieldName("redirect"));
  return node.namedChildren.filter((n) =>
    n !== name && n.type !== "variable_assignment" && !redirects.has(n)
  );
}
export function gitSubcommand(node: Node): string | undefined {
  const a = args(node).map(literalArg);
  let i = 0;
  const takes = new Set([
    "-C",
    "-c",
    "--config-env",
    "--exec-path",
    "--git-dir",
    "--work-tree",
    "--namespace",
  ]);
  while (i < a.length) {
    const v = a[i];
    if (v === undefined) return;
    if (takes.has(v)) {
      i += 2;
      continue;
    }
    if (v.startsWith("-")) {
      i++;
      continue;
    }
    return v;
  }
}
export function permanentBlock(root: Node): string | undefined {
  for (const x of commandInvocations(root)) {
    if (x.name === "git" && gitSubcommand(x.node) === "worktree") {
      return "git worktree commands are disabled because the user does not use Git worktrees.";
    }
  }
}

const unconditional = new Set(
  "c++filt cat cd cmp comm diff du echo false grep head ls nl objdump pwd readelf readlink sha256sum stat tail test true uniq wc which"
    .split(" "),
);
const structural = new Set(["program", "list", "pipeline", "negated_command"]);
function executableAllowedPath(node: Node): string | undefined {
  const cn = node.childForFieldName("name");
  if (!cn || cn.type !== "command_name" || cn.namedChildCount !== 1) return;
  const w = cn.namedChild(0)!;
  if (w.type !== "word" || w.namedChildCount) return;
  const s = w.text;
  if (s.includes("/") && !/^\/(?:usr\/)?bin\/[^/]+$/.test(s)) return;
  return basename(s);
}
function dynamic(n: Node): boolean {
  if (
    [
      "arithmetic_expansion",
      "command_substitution",
      "variable_expansion",
      "process_substitution",
      "simple_expansion",
      "expansion",
    ].includes(n.type)
  ) return true;
  return n.namedChildren.some(dynamic);
}
function hasEq(a: string, option: string) {
  return a === option || a.startsWith(option + "=");
}
function reviewed(name: string, values: string[]): boolean {
  if (name === "find") {
    return !values.some((a) =>
      [
        "-delete",
        "-exec",
        "-execdir",
        "-fls",
        "-fprint",
        "-fprint0",
        "-ok",
        "-okdir",
      ].some((x) => hasEq(a, x))
    );
  }
  if (name === "fd") {
    return !values.some((a) =>
      hasEq(a, "--exec") || hasEq(a, "--exec-batch") ||
      (/^-[^-]/.test(a) && /[xX]/.test(a.slice(1)))
    );
  }
  if (name === "rg") return !values.some((a) => hasEq(a, "--pre"));
  if (name === "sed") {
    if (values[0] !== "-n" || !values[1]) return false;
    const p = values[1].replace(/^(['"])(.*)\1$/, "$2");
    if (!/^\d+(?:,\d+)?p(?:;\d+(?:,\d+)?p)*$/.test(p)) return false;
    let dash = false;
    for (const x of values.slice(2)) {
      if (x === "--") {
        dash = true;
        continue;
      }
      if (!dash && x.startsWith("-")) return false;
    }
    return true;
  }
  if (name === "sort") {
    return !values.some((a) =>
      /^-o/.test(a) || hasEq(a, "--output") || hasEq(a, "--compress-program")
    );
  }
  if (name === "date") {
    return !values.some((a) => /^-s/.test(a) || hasEq(a, "--set"));
  }
  if (name === "command") return values.length >= 2 && values[0] === "-v";
  if (name === "file") {
    return !values.some((a) => /^-C/.test(a) || hasEq(a, "--compile"));
  }
  if (name === "printf") return !values.some((a) => /^-v/.test(a));
  if (name === "nm") return !values.some((a) => hasEq(a, "--plugin"));
  if (name === "bazel") {
    return ["query", "cquery", "aquery", "build", "test"].includes(
      values.find((a) => !a.startsWith("-")) || "",
    );
  }
  if (name === "git") {
    let i = 0;
    while (i < values.length && values[i].startsWith("-")) {
      if (values[i] === "-C" && values[i + 1]) i += 2;
      else if (["--no-pager", "--literal-pathspecs"].includes(values[i])) i++;
      else return false;
    }
    const sub = values[i++];
    const rest = values.slice(i);
    if (sub === "branch") {
      return (rest.length === 1 && rest[0] === "--show-current") ||
        (rest.length === 3 && ["-a", "--all"].includes(rest[0]) &&
          rest[1] === "--contains" && !rest[2].startsWith("-"));
    }
    if (sub === "remote") return rest.length === 1 && rest[0] === "-v";
    if (["ls-files", "ls-tree", "merge-base", "rev-parse"].includes(sub)) {
      return true;
    }
    return ["status", "diff", "log", "show", "blame"].includes(sub) &&
      !rest.some((a) =>
        ["--output", "--ext-diff", "--textconv"].some((x) => hasEq(a, x))
      );
  }
  return false;
}
function safeRedirect(n: Node): boolean {
  if (n.type === "herestring_redirect") {
    return n.namedChildren.every((c) => !containsUnsafeNested(c));
  }
  const t = n.text.replace(/^\d+/, "");
  if (/^(?:>|<)&(?:\d+|-)$/.test(t)) return true;
  if (/^(?:>|>>|>\||&>|&>>|<>)/.test(t)) {
    const d = n.childForFieldName("destination") ?? n.namedChildren.at(-1);
    return !!d && literalArg(d) === "/dev/null";
  }
  return false;
}
function containsUnsafeNested(n: Node): boolean {
  if (n.type === "command_substitution" || n.type === "process_substitution") {
    return !n.namedChildCount || !n.namedChildren.every(safeNode);
  }
  if (n.type === "command") return true;
  return n.namedChildren.some(containsUnsafeNested);
}
function safeCommand(n: Node): boolean {
  const name = executableAllowedPath(n);
  if (!name) return false;
  const redirects = n.childrenForFieldName("redirect");
  if (!redirects.every(safeRedirect)) return false;
  const an = args(n);
  for (const a of an) if (containsUnsafeNested(a)) return false;
  if (unconditional.has(name)) return true;
  if (
    ![
      "find",
      "fd",
      "rg",
      "sed",
      "sort",
      "date",
      "command",
      "file",
      "printf",
      "nm",
      "bazel",
      "git",
    ].includes(name)
  ) return false;
  const assignments = n.namedChildren.filter((x) =>
    x.type === "variable_assignment"
  );
  if ([...an, ...assignments].some(dynamic)) return false;
  const values = an.map(literalArg);
  return values.every((x) => x !== undefined) &&
    reviewed(name, values as string[]);
}
export function safeNode(n: Node): boolean {
  if (n.type === "comment") return true;
  if (structural.has(n.type)) {
    return n.namedChildCount > 0 && n.namedChildren.every(safeNode);
  }
  if (n.type === "command") return safeCommand(n);
  if (n.type === "redirected_statement") {
    const body = n.childForFieldName("body");
    const rs = n.childrenForFieldName("redirect");
    return !!body && safeNode(body) && rs.length > 0 && rs.every(safeRedirect);
  }
  return false;
}
export function isSafeBash(root: Node): boolean {
  return safeNode(root);
}

export function extractInPlaceTargets(root: Node): string[] | undefined {
  const out: string[] = [];
  let changed = false;
  const editor = (n: Node): boolean => {
    const name = executableAllowedPath(n);
    if (!name) return false;
    if (name === "cd") return false;
    if (
      n.childrenForFieldName("redirect").length ||
      n.namedChildren.some((x) => x.type === "variable_assignment")
    ) return false;
    if (safeCommand(n)) return true;
    if (!["sed", "clang-format", "perl"].includes(name)) return false;
    const ns = args(n);
    if (ns.some((x) => !["word", "raw_string", "string"].includes(x.type))) {
      return false;
    }
    const av = ns.map(literalArg);
    if (av.some((x) => x === undefined) || ns.some(dynamic)) return false;
    const a = av as string[];
    const shellMeta = (node: Node, value: string) => {
      if (value.includes("~")) return true;
      if (node.type !== "word") return false;
      for (let i = 0; i < node.text.length; i++) {
        if (node.text[i] === "\\") {
          i++;
          continue;
        }
        if ("*?[]{}".includes(node.text[i])) return true;
      }
      return false;
    };
    if (a.some((x, i) => shellMeta(ns[i], x))) return false;
    let targets: string[] = [];
    if (name === "sed") {
      let ip = false, explicit = false, end = false;
      const pos: string[] = [];
      for (let i = 0; i < a.length; i++) {
        const x = a[i];
        if (!end && x === "--") {
          end = true;
          continue;
        }
        if (!end && (x === "-i" || x === "--in-place")) {
          ip = true;
          continue;
        }
        if (!end && (/^(-i.+|--in-place=)/.test(x))) return false;
        if (!end && ["-e", "--expression", "-f", "--file"].includes(x)) {
          if (!a[++i]) return false;
          explicit = true;
          continue;
        }
        if (
          !end &&
          (/^-[nErsuz]+$/.test(x) ||
            [
              "--quiet",
              "--silent",
              "--regexp-extended",
              "--separate",
              "--unbuffered",
              "--null-data",
            ].includes(x))
        ) continue;
        if (!end && x.startsWith("-")) return false;
        pos.push(x);
      }
      if (!ip) return false;
      if (!explicit) pos.shift();
      targets = pos;
    } else if (name === "clang-format") {
      let ip = false, end = false;
      const takes = new Set(
        "--assume-filename --cursor --fallback-style --length --lines --offset --qualifier-alignment --style"
          .split(" "),
      );
      for (let i = 0; i < a.length; i++) {
        const x = a[i];
        if (!end && x === "--") {
          end = true;
          continue;
        }
        if (!end && x === "-i") {
          ip = true;
          continue;
        }
        if (!end && takes.has(x)) {
          if (!a[++i]) return false;
          continue;
        }
        if (!end && x.startsWith("-")) continue;
        targets.push(x);
      }
      if (!ip) return false;
    } else {
      let ip = false, explicit = false;
      const pos: string[] = [];
      for (let i = 0; i < a.length; i++) {
        const x = a[i];
        if (/^-[0-9lnpswa]*i$/.test(x)) {
          ip = true;
          continue;
        }
        if (x === "-e" || x === "-E") {
          if (!a[++i]) return false;
          explicit = true;
          continue;
        }
        if (x.startsWith("-")) return false;
        pos.push(x);
      }
      if (!ip) return false;
      if (!explicit) pos.shift();
      targets = pos;
    }
    if (!targets.length || targets.includes("-")) return false;
    changed = true;
    out.push(...targets);
    return true;
  };
  const walk = (n: Node): boolean => {
    if (structural.has(n.type)) {
      return n.namedChildCount > 0 && n.namedChildren.every(walk);
    }
    if (n.type === "comment") return true;
    if (n.type === "command") return editor(n);
    return false;
  };
  if (!walk(root) || !changed) return;
  const unique = [...new Set(out)];
  return unique.length <= 16 ? unique : undefined;
}
