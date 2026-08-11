import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import type { Config } from "./config.ts";
import {
  fold,
  fullProjection,
  type Observation,
  progress,
  type Reflection,
  visibleProjection,
} from "./core.ts";

type CommandState = {
  phase?: string;
  auto: boolean;
  hook: boolean;
  errors: Record<string, string | undefined>;
};

type Notify = (ctx: any, message: string, level?: any) => void;

function formatMemory(projection: any, empty: string) {
  const reflections = projection.reflections.length
    ? projection.reflections.map((item: Reflection) =>
      `[${item.id}] ${item.content}`
    ).join("\n")
    : `${empty} reflections.`;
  const observations = projection.observations.length
    ? projection.observations.map((item: Observation) =>
      `[${item.id}] ${item.timestamp} [${item.relevance}] ${item.content}`
    ).join("\n")
    : `${empty} observations.`;
  return `── Reflections ──\n${reflections}\n\n── Observations ──\n${observations}`;
}

function copy(text: string) {
  const commands = process.platform === "darwin"
    ? [["pbcopy"]]
    : process.platform === "win32"
    ? [["clip"]]
    : [["wl-copy"], ["xclip", "-selection", "clipboard"], [
      "xsel",
      "--clipboard",
      "--input",
    ], ["termux-clipboard-set"]];
  return commands.some(([command, ...args]) =>
    spawnSync(command, args, {
      input: text,
      timeout: 2_000,
      stdio: ["pipe", "ignore", "ignore"],
    }).status === 0
  );
}

export function registerCommands(
  pi: ExtensionAPI,
  state: CommandState,
  config: (ctx: any) => Config,
  notify: Notify,
  sinceCompaction: (branch: any[]) => number,
) {
  pi.registerCommand("om:on", {
    description: "Enable observational-memory workers",
    handler: async (_args, ctx) => {
      config(ctx).passive = false;
      notify(
        ctx,
        "observer, reflector, dropper, and auto-compaction workers are active and will run on the next threshold-eligible turn",
      );
    },
  });

  pi.registerCommand("om:off", {
    description: "Disable observational-memory workers",
    handler: async (_args, ctx) => {
      config(ctx).passive = true;
      notify(
        ctx,
        "workers are disabled; commands, recall, and recorded memory remain available",
      );
    },
  });

  pi.registerCommand("om:view", {
    description: "View visible or full observational memory",
    handler: async (args: any, ctx: any) => {
      const mode = typeof args === "string"
        ? args.trim()
        : Array.isArray(args)
        ? args[0]
        : args?.mode;
      if (mode && mode !== "visible" && mode !== "full") {
        if (ctx.hasUI) ctx.ui.notify("Usage: /om:view [full]", "warning");
        return;
      }
      const projection = mode === "full"
        ? fullProjection(ctx.sessionManager.getBranch())
        : visibleProjection(ctx.sessionManager.getBranch());
      const output = formatMemory(
        projection,
        mode === "full" ? "No recorded" : "No visible",
      );
      const copied = copy(output);
      if (ctx.hasUI) {
        ctx.ui.notify(
          output +
            `\n\n${
              copied
                ? "Copied to clipboard."
                : "Warning: could not copy to clipboard."
            }`,
          copied ? "info" : "warning",
        );
      }
    },
  });

  pi.registerCommand("om:status", {
    description: "Show observational-memory status",
    handler: async (_args, ctx: any) => {
      const currentConfig = config(ctx);
      const branch = ctx.sessionManager.getBranch();
      const memory = fold(branch);
      const visible = visibleProjection(branch);
      const full = fullProjection(branch);
      const observationProgress = progress(branch, "om.observations.recorded");
      const reflectionProgress = progress(branch, "om.reflections.recorded");
      const compactionProgress = sinceCompaction(branch);
      const tokens = (items: any[]) =>
        items.reduce((total, item) => total + item.tokenCount, 0);
      const percent = (value: number, target: number) =>
        Math.round(target > 0 ? value / target * 100 : 0);

      let status = currentConfig.passive
        ? "Mode\nAutomatic workers and auto-compaction are disabled; manual/Pi compaction, commands, and recall remain active.\n\n"
        : "";
      status +=
        `Memory\nObservations: ${memory.observations.length} recorded / ${
          memory.observations.filter((item) => memory.dropped.has(item.id))
            .length
        } dropped / ${memory.activeObservations.length} active / ${visible.observations.length} visible (+${
          full.observations.filter((item) =>
            !visible.observations.some((other) => other.id === item.id)
          ).length
        }, -${
          visible.observations.filter((item) =>
            !full.observations.some((other) => other.id === item.id)
          ).length
        })\nReflections: ${memory.reflections.length} recorded / ${visible.reflections.length} visible (+${
          full.reflections.filter((item) =>
            !visible.reflections.some((other) => other.id === item.id)
          ).length
        })\n\nActivity\nNext observation: ${observationProgress.toLocaleString()} / ${currentConfig.observeAfterTokens.toLocaleString()} (${
          percent(observationProgress, currentConfig.observeAfterTokens)
        }%)\nNext reflection: ${reflectionProgress.toLocaleString()} / ${currentConfig.reflectAfterTokens.toLocaleString()} (${
          percent(reflectionProgress, currentConfig.reflectAfterTokens)
        }%)\nNext compaction: ${compactionProgress.toLocaleString()} / ${currentConfig.compactAfterTokens.toLocaleString()} (${
          percent(compactionProgress, currentConfig.compactAfterTokens)
        }%)\nVisible observation pool: ${
          tokens(visible.observations).toLocaleString()
        } / ${currentConfig.observationsPoolMaxTokens.toLocaleString()}\nActive observation pool: ${
          tokens(memory.activeObservations).toLocaleString()
        } / ${currentConfig.observationsPoolTargetTokens.toLocaleString()}\nVisible reflection pool: ${
          tokens(visible.reflections).toLocaleString()
        }`;

      const inFlight = [
        state.phase && `consolidation (${state.phase})`,
        state.auto && "auto-compaction",
        state.hook && "compaction hook",
      ].filter(Boolean);
      if (inFlight.length) status += `\n\nIn flight\n${inFlight.join(", ")}`;
      const errors = Object.entries(state.errors).filter(([, error]) => error);
      if (errors.length) {
        status += `\n\nLast error\n${
          errors.map(([stage, error]) => `${stage}: ${error}`).join("\n")
        }`;
      }
      notify(ctx, status);
    },
  });
}
