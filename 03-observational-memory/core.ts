import { createHash } from "node:crypto";
import { estimateTokens as estimateMessageTokens } from "@earendil-works/pi-agent-core";
export type Relevance = "low" | "medium" | "high" | "critical";
export type Observation = {
  id: string;
  content: string;
  timestamp: string;
  relevance: Relevance;
  sourceEntryIds: string[];
  tokenCount: number;
};
export type Reflection = {
  id: string;
  content: string;
  supportingObservationIds: string[];
  tokenCount: number;
};
const ID = /^[a-f0-9]{12}$/;
const rel = new Set(["low", "medium", "high", "critical"]);
const strings = (x: any) =>
  Array.isArray(x) && x.length > 0 &&
  x.every((y) => typeof y === "string" && y.length > 0);
export function validObservation(x: any): x is Observation {
  return !!x && ID.test(x.id) && typeof x.content === "string" &&
    x.content.length > 0 && typeof x.timestamp === "string" &&
    x.timestamp.length > 0 && rel.has(x.relevance) &&
    strings(x.sourceEntryIds) && Number.isFinite(x.tokenCount) &&
    x.tokenCount >= 0;
}
export function validReflection(x: any): x is Reflection {
  return !!x && ID.test(x.id) && typeof x.content === "string" &&
    x.content.length > 0 && !/[\r\n]/.test(x.content) &&
    strings(x.supportingObservationIds) && Number.isFinite(x.tokenCount) &&
    x.tokenCount >= 0;
}
export function customData(e: any, type: string) {
  if (
    e?.type !== "custom" || e.customType !== type || !e.data ||
    typeof e.data.coversUpToId !== "string" || !e.data.coversUpToId
  ) return;
  return e.data;
}
export function validRecorded(
  e: any,
  type: "om.observations.recorded" | "om.reflections.recorded",
) {
  const d = customData(e, type);
  if (!d) return;
  const a = type.includes("observations") ? d.observations : d.reflections;
  const fn = type.includes("observations") ? validObservation : validReflection;
  return Array.isArray(a) && a.length && a.every(fn) ? d : undefined;
}
export function validDrop(e: any) {
  const d = customData(e, "om.observations.dropped");
  return d && strings(d.observationIds) ? d : undefined;
}
export function validDetails(d: any) {
  return !!d && d.type === "om.folded" && d.version === 1 &&
    typeof d.fullFold === "boolean" && Array.isArray(d.observations) &&
    d.observations.every(validObservation) && Array.isArray(d.reflections) &&
    d.reflections.every(validReflection);
}
export function fold(branch: any[], boundary?: string) {
  let end = boundary ? branch.findIndex((e) => e.id === boundary) : -1;
  if (end < 0) end = branch.length - 1;
  const observations = new Map<string, Observation>(),
    reflections = new Map<string, Reflection>(),
    dropped = new Set<string>();
  for (const e of branch.slice(0, end + 1)) {
    const o = validRecorded(e, "om.observations.recorded");
    if (o) {
      for (const x of o.observations) {
        if (!observations.has(x.id)) observations.set(x.id, x);
      }
    }
    const r = validRecorded(e, "om.reflections.recorded");
    if (r) {
      for (const x of r.reflections) {
        if (!reflections.has(x.id)) reflections.set(x.id, x);
      }
    }
    const d = validDrop(e);
    if (d) { for (const id of d.observationIds) dropped.add(id); }
  }
  return {
    observations: [...observations.values()],
    activeObservations: [...observations.values()].filter((x) =>
      !dropped.has(x.id)
    ),
    reflections: [...reflections.values()],
    dropped,
  };
}
export function projection(
  branch: any[],
  boundaries: { observations?: string; reflections?: string; drops?: string },
) {
  const index = new Map(branch.map((e, i) => [e.id, i]));
  const limits: any = {};
  for (const k of ["observations", "reflections", "drops"] as const) {
    limits[k] = boundaries[k] === undefined
      ? -1
      : (index.get(boundaries[k]!) ?? branch.length - 1);
  }
  const os = new Map<string, Observation>(),
    rs = new Map<string, Reflection>(),
    drops = new Set<string>();
  for (const e of branch) {
    const o = validRecorded(e, "om.observations.recorded");
    if (
      o && (index.get(o.coversUpToId) ?? Infinity) <= limits.observations
    ) { for (const x of o.observations) if (!os.has(x.id)) os.set(x.id, x); }
    const r = validRecorded(e, "om.reflections.recorded");
    if (
      r && (index.get(r.coversUpToId) ?? Infinity) <= limits.reflections
    ) { for (const x of r.reflections) if (!rs.has(x.id)) rs.set(x.id, x); }
    const d = validDrop(e);
    if (d && (index.get(d.coversUpToId) ?? Infinity) <= limits.drops) {
      for (const id of d.observationIds) {
        drops.add(id);
      }
    }
  }
  return {
    observations: [...os.values()].filter((x) => !drops.has(x.id)),
    reflections: [...rs.values()],
  };
}
export function fullProjection(branch: any[], boundary?: string) {
  const b = boundary ?? branch.at(-1)?.id;
  return b
    ? projection(branch, { observations: b, reflections: b, drops: b })
    : { observations: [], reflections: [] };
}
export function visibleProjection(branch: any[]) {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === "compaction" && validDetails(e.details)) {
      return {
        observations: e.details.observations.map((x: any) => ({ ...x })),
        reflections: e.details.reflections.map((x: any) => ({ ...x })),
      };
    }
  }
  return { observations: [], reflections: [] };
}
export function maintenanceBoundary(branch: any[]) {
  const ids = new Set(branch.map((e) => e.id));
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (
      e.type === "compaction" && validDetails(e.details) &&
      e.details.fullFold && typeof e.firstKeptEntryId === "string" &&
      ids.has(e.firstKeptEntryId)
    ) return e.firstKeptEntryId;
  }
}
export function compactionProjection(
  branch: any[],
  kept: string,
  max = 20_000,
) {
  const maintenance = maintenanceBoundary(branch);
  let p = projection(branch, {
    observations: kept,
    reflections: maintenance,
    drops: maintenance,
  });
  const full = p.observations.reduce((n, x) => n + x.tokenCount, 0) >= max;
  if (full) {
    p = projection(branch, {
      observations: kept,
      reflections: kept,
      drops: kept,
    });
  }
  return { ...p, fullFold: full };
}
export function truncateContent(s: string) {
  s = s.trim();
  if (s.length <= 10_000) return s;
  const n = s.length - 10_000;
  return s.slice(0, 10_000) + ` … [truncated ${n} chars]`;
}
export function memoryId(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}
export function estimate(s: string) {
  return Math.ceil(s.length / 4);
}
export function isSource(e: any) {
  return ["message", "custom_message", "branch_summary"].includes(e?.type);
}
function text(c: any) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((x) =>
    x?.type === "text" ? x.text : "[non-text content omitted]"
  ).join(" ");
}
export function sourceTokens(e: any) {
  if (e.type === "custom_message") {
    const c = e.content;
    if (typeof c === "string") return estimate(c);
    if (Array.isArray(c)) {
      return c.reduce(
        (n: number, x: any) =>
          n +
          (x?.type === "text" && typeof x.text === "string"
            ? estimate(x.text)
            : 0),
        0,
      );
    }
    return 0;
  }
  if (e.type === "branch_summary") return estimate(e.summary || "");
  if (e.type === "message") {
    try {
      return estimateMessageTokens(e.message);
    } catch {
      return estimate(text(e.message?.content));
    }
  }
  return 0;
}
function localTime(value: any) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "????-??-?? ??:??";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${
    p(d.getHours())
  }:${p(d.getMinutes())}`;
}
export function renderSource(e: any) {
  const time = localTime(e.message?.timestamp ?? e.timestamp);
  if (e.type === "custom_message") {
    return `[Custom (${e.customType}) @ ${time}]: ${text(e.content)}`;
  }
  if (e.type === "branch_summary") {
    return `[Branch summary @ ${time}]: ${e.summary}`;
  }
  const m = e.message;
  if (m?.role === "user") return `[User @ ${time}]: ${text(m.content)}`;
  if (m?.role === "toolResult") {
    return `[Tool result for ${m.toolName} @ ${time}]: ${text(m.content)}`;
  }
  if (m?.role === "assistant") {
    const c = (m.content || []).map((x: any) =>
      x.type === "text"
        ? x.text
        : x.type === "thinking" && !x.redacted
        ? `[thinking: ${x.thinking}]`
        : x.type === "toolCall"
        ? `[${x.name}(${JSON.stringify(x.arguments)})]`
        : x.type === "thinking"
        ? ""
        : "[non-text content omitted]"
    ).filter(Boolean).join(" ");
    return `[Assistant @ ${time}]: ${c}`;
  }
  return "";
}
export function coverage(branch: any[], type: string) {
  const indexes = new Map(branch.map((e, i) => [e.id, i]));
  let best = -1, id: string | undefined;
  for (const e of branch) {
    let d;
    if (
      type === "om.observations.recorded" || type === "om.reflections.recorded"
    ) d = validRecorded(e, type as any);
    else d = validDrop(e);
    if (d) {
      const i = indexes.get(d.coversUpToId);
      if (i !== undefined && i >= best) {
        best = i;
        id = d.coversUpToId;
      }
    }
  }
  return { index: best, id };
}
export function progress(branch: any[], type: string) {
  const c = coverage(branch, type);
  return branch.slice(c.index + 1).filter(isSource).reduce(
    (n, e) => n + sourceTokens(e),
    0,
  );
}
export function renderSummary(
  p: { observations: Observation[]; reflections: Reflection[] },
) {
  if (!p.observations.length && !p.reflections.length) return "";
  let s =
    "These are condensed memories from earlier in this session. Reflections are durable facts; observations are chronological events. Prefer recent observations when memories conflict, do not redo completed work, and use recall with a memory ID when exact evidence materially matters.";
  if (p.reflections.length) {
    s += "\n\n## Reflections\n" +
      p.reflections.map((x) => `[${x.id}] ${x.content}`).join("\n");
  }
  if (p.observations.length) {
    s += "\n\n## Observations\n" +
      p.observations.map((x) =>
        `[${x.id}] ${x.timestamp} [${x.relevance}] ${x.content}`
      ).join("\n");
  }
  return s;
}
