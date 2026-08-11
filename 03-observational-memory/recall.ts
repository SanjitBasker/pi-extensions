import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  isSource,
  renderSource,
  sourceTokens,
  validDrop,
  validRecorded,
} from "./core.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;

function truncateOutput(text: string) {
  const lines = text.split("\n");
  const lineLimited = lines.length > MAX_OUTPUT_LINES;
  const selected = lineLimited
    ? lines.slice(0, MAX_OUTPUT_LINES).join("\n")
    : text;
  const byteLimited = Buffer.byteLength(selected, "utf8") > MAX_OUTPUT_BYTES;
  if (!lineLimited && !byteLimited) return { text, truncated: false };

  const notice =
    `\n\n[Recall output truncated at ${MAX_OUTPUT_LINES} lines or ${
      MAX_OUTPUT_BYTES / 1024
    }KB.]`;
  const budget = MAX_OUTPUT_BYTES - Buffer.byteLength(notice, "utf8");
  let bytes = 0;
  let prefix = "";
  for (const character of selected) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > budget) break;
    prefix += character;
    bytes += size;
  }
  return { text: prefix.replace(/\s+$/, "") + notice, truncated: true };
}

function emptyResult(status: string, id: string, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {
      status,
      id,
      collision: false,
      partial: false,
      truncated: false,
      reflectionCount: 0,
      observationCount: 0,
      sourceCount: 0,
      sourceTokens: 0,
    },
  };
}

export function registerRecall(pi: ExtensionAPI) {
  pi.registerTool({
    name: "recall",
    label: "Recall memory evidence",
    description:
      "Recover exact evidence for a known compacted observation/reflection ID on the current branch. Use before important decisions when wording, rationale, paths, commands, errors, commits, constraints, provenance, or support is unclear. This is not semantic search or transcript browsing and requires a specific ID; do not call it for every memory.",
    parameters: Type.Object({ id: Type.String({ pattern: "^[a-f0-9]{12}$" }) }),
    async execute(
      _call: unknown,
      params: any,
      _signal: AbortSignal,
      _onUpdate: unknown,
      ctx: any,
    ) {
      const id = String(params.id || "");
      if (!/^[a-f0-9]{12}$/.test(id)) {
        return emptyResult(
          "invalid_id",
          id,
          "Invalid memory ID: expected exactly 12 lowercase hexadecimal characters.",
        );
      }

      const branch = ctx.sessionManager.getBranch();
      const entries = new Map(branch.map((entry: any) => [entry.id, entry]));
      const direct: any[] = [];
      const reflections: any[] = [];
      const allObservations: any[] = [];
      for (const [entryIndex, entry] of branch.entries()) {
        const recordedObservations = validRecorded(
          entry,
          "om.observations.recorded",
        );
        if (recordedObservations) {
          recordedObservations.observations.forEach(
            (observation: any, recordIndex: number) => {
              if (observation.id === id) {
                direct.push({ x: observation, entryIndex, recordIndex });
              }
              allObservations.push({ x: observation, entryIndex, recordIndex });
            },
          );
        }
        const recordedReflections = validRecorded(
          entry,
          "om.reflections.recorded",
        );
        if (recordedReflections) {
          recordedReflections.reflections.forEach(
            (reflection: any, recordIndex: number) => {
              if (reflection.id === id) {
                reflections.push({ x: reflection, entryIndex, recordIndex });
              }
            },
          );
        }
      }
      if (!direct.length && !reflections.length) {
        return emptyResult(
          "not_found",
          id,
          "No matching memory exists on the current branch.",
        );
      }

      const observations = [...direct];
      const missingSupport: string[] = [];
      for (const reflection of reflections) {
        for (
          const supportId of new Set<string>(
            reflection.x.supportingObservationIds,
          )
        ) {
          const observation = allObservations.find((item) =>
            item.x.id === supportId
          );
          if (
            observation &&
            !observations.some((item) =>
              item.entryIndex === observation.entryIndex &&
              item.recordIndex === observation.recordIndex
            )
          ) {
            observations.push(observation);
          } else if (!observation) {
            missingSupport.push(supportId);
          }
        }
      }

      const dropped = new Set<string>();
      for (const entry of branch) {
        const drop = validDrop(entry);
        if (drop) {
          drop.observationIds.forEach((observationId: string) =>
            dropped.add(observationId)
          );
        }
      }

      const sources: any[] = [];
      const missing: string[] = [];
      const nonSource: string[] = [];
      for (const observation of observations) {
        for (const sourceId of observation.x.sourceEntryIds) {
          const entry = entries.get(sourceId);
          if (!entry) missing.push(sourceId);
          else if (!isSource(entry)) nonSource.push(sourceId);
          else if (!sources.some((source) => source.id === sourceId)) {
            sources.push(entry);
          }
        }
      }

      const partial =
        !!(missingSupport.length || missing.length || nonSource.length);
      const collision = direct.length + reflections.length > 1;
      let text = collision
        ? "Warning: multiple ledger records share this memory ID.\n\n"
        : "";
      if (reflections.length) {
        text += "Reflections\n" + reflections.map((item) =>
          `[${item.x.id}] ${item.x.content}\nSupports: ${
            item.x.supportingObservationIds.join(", ")
          }`
        ).join("\n") + "\n\n";
      }
      if (observations.length) {
        text += "Observations\n" + observations.map((item) =>
          `[${item.x.id}]${
            dropped.has(item.x.id) ? " [dropped]" : ""
          } ${item.x.timestamp} [${item.x.relevance}] ${item.x.content}`
        ).join("\n") + "\n\n";
      }
      if (sources.length) {
        text += "Exact sources\n" +
          sources.map((entry) =>
            `[Source entry id: ${entry.id}]\n${renderSource(entry)}`
          ).join("\n\n");
      }
      if (missingSupport.length) {
        text += `\nUnavailable supports: ${
          [...new Set(missingSupport)].join(", ")
        }`;
      }
      if (missing.length) {
        text += `\nMissing sources: ${[...new Set(missing)].join(", ")}`;
      }
      if (nonSource.length) {
        text += `\nNon-source IDs: ${[...new Set(nonSource)].join(", ")}`;
      }

      let status = partial ? "partial" : "ok";
      if (direct.length && !reflections.length && !sources.length) {
        status = missing.length || nonSource.length
          ? "source_unavailable"
          : "no_source";
      }
      const output = truncateOutput(text.trim());
      return {
        content: [{ type: "text" as const, text: output.text }],
        details: {
          status,
          id,
          collision,
          partial,
          truncated: output.truncated,
          reflectionCount: reflections.length,
          observationCount: observations.length,
          sourceCount: sources.length,
          sourceTokens: sources.reduce(
            (total, entry) => total + sourceTokens(entry),
            0,
          ),
          missingSupportIds: missingSupport,
          missingSourceIds: missing,
          nonSourceIds: nonSource,
        },
      };
    },
    renderCall(args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", `recall ${args.id || "..."}`),
        0,
        0,
      );
    },
    renderResult(result: any, _options: any, theme: any) {
      const details = result.details || {};
      const ok = ["ok", "partial", "no_source", "source_unavailable"].includes(
        details.status,
      );
      const summary = `${ok ? "✓ success" : "× failure"} • ${
        details.reflectionCount || 0
      } reflections • ${details.observationCount || 0} observations • ${
        details.sourceCount || 0
      } sources • ~${details.sourceTokens || 0} tokens${
        details.partial ? " • partial" : ""
      }${details.truncated ? " • output truncated" : ""}`;
      return new Text(
        theme.fg(ok ? "success" : "error", summary) + "\n" +
          (result.content?.[0]?.text || ""),
        0,
        0,
      );
    },
  } as any);
}
