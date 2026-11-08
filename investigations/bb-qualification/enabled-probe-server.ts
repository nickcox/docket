import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const waitMarker = "DOCKET_Q1_WAIT_20261108";
const rejectMarker = "DOCKET_Q1_REJECT_20261108";
const boundMarker = "DOCKET_Q1_BOUND_20261108";
const stateDir = "/private/tmp/docket-bb-probe-20261108/state";

export default function plugin(bb: BbPluginApi): void {
  bb.experimental_hooks.on("message.dispatch", (context) => {
    if (context.input.text.includes(boundMarker)) {
      const statePath = join(stateDir, `${context.thread.id}.json`);
      let state = "pending";
      try {
        state = JSON.parse(readFileSync(statePath, "utf8")).state;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      bb.log.info(`Binding ${context.thread.id}: ${state}`);
      if (state === "pending") return { action: "wait", reason: "Waiting for Docket binding" };
      if (state === "fenced" || state === "used") {
        return { action: "reject", message: `Docket binding ${state}` };
      }
      if (state !== "permitted") throw new Error(`Unexpected binding state: ${state}`);
      writeFileSync(statePath, JSON.stringify({ state: "used" }));
      return { action: "proceed" };
    }
    if (context.input.text.includes(waitMarker)) {
      bb.log.info(`Held ${waitMarker} for thread ${context.thread.id}`);
      return { action: "wait", reason: "Docket disposable enabled-plugin probe" };
    }
    if (context.input.text.includes(rejectMarker)) {
      bb.log.info(`Rejected ${rejectMarker} for thread ${context.thread.id}`);
      return { action: "reject", message: "Docket disposable terminal fence" };
    }
    return { action: "proceed" };
  });
}
