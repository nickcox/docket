import type { BbPluginApi } from "@get-bb/plugin-sdk";

const marker = "DOCKET_Q1_PROBE_20261108";

export default function plugin(bb: BbPluginApi): void {
  bb.experimental_hooks.on("message.dispatch", (context) => {
    if (!context.input.text.includes(marker)) return { action: "proceed" };
    bb.log.info(`Held ${marker} for thread ${context.thread.id}`);
    return { action: "wait", reason: "Docket Q1 disposable admission probe" };
  });
}
