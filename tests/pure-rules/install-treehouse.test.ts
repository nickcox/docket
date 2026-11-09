import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Run the installer with fake external owners, including time, so its download
// and checksum paths are exercised without GitHub, extraction or real waits.
const source = (await readFile(new URL("../../.github/scripts/install-treehouse.mjs", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "");
const asset = "treehouse-v3.1.4-linux-amd64.tar.gz";
const archive = Buffer.from("release archive");
const checksum = createHash("sha256").update(archive).digest("hex");
type Reply = number | Error | "body error";

async function install(replies: Partial<Record<string, Reply[]>>, expectedChecksum = checksum) {
  const requests: string[] = [];
  const waits: number[] = [];
  const logs: string[] = [];
  const programs: string[] = [];
  const writes: string[] = [];
  let error: unknown;
  try {
    await runInNewContext(`(async () => {\n${source}\n})()`, {
      Buffer, createHash, join,
      process: { platform: "linux", arch: "x64", env: { RUNNER_TEMP: "/tmp", GITHUB_PATH: "/github-path" } },
      console: { log: (message: string) => logs.push(message) },
      delay: async (ms: number) => { waits.push(ms); },
      fetch: async (url: string) => {
        const name = url.slice(url.lastIndexOf("/") + 1);
        requests.push(name);
        const reply = replies[name]?.shift() ?? 200;
        if (reply instanceof Error) throw reply;
        if (reply === "body error") {
          return { ok: true, arrayBuffer: async () => { throw new Error("connection reset reading body"); } };
        }
        return new Response(reply === 200
          ? (name === "checksums.txt" ? `${expectedChecksum}  ${asset}\n` : archive)
          : "temporary error", { status: reply });
      },
      mkdtemp: async () => "/tmp/treehouse-test",
      mkdir: async () => {},
      chmod: async () => {},
      writeFile: async (path: string) => { writes.push(path); },
      appendFile: async (path: string) => { writes.push(path); },
      execFileSync: (program: string) => { programs.push(program); },
    });
  } catch (caught) {
    error = caught;
  }
  return { requests, waits, logs, programs, writes, error };
}

test("CI download retry: each file retries 429, 5xx, network and body errors with 2/4/8/16 second waits", async () => {
  const result = await install({
    "checksums.txt": [504, 429, new Error("connection reset"), 503, 200],
    [asset]: [500, "body error", 599, new Error("fetch failed"), 200],
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.requests, [...Array(5).fill("checksums.txt"), ...Array(5).fill(asset)]);
  assert.deepEqual(result.waits, [2000, 4000, 8000, 16000, 2000, 4000, 8000, 16000]);
  const retries = result.logs.filter(line => line.startsWith("Retry download"));
  assert.equal(retries.length, 8);
  const statuses = ["HTTP 504", "HTTP 429", "network error: connection reset", "HTTP 503",
    "HTTP 500", "network error: connection reset reading body", "HTTP 599", "network error: fetch failed"];
  retries.forEach((line, index) => {
    assert.ok(line.includes(index < 4 ? "checksums.txt" : asset));
    assert.ok(line.includes(statuses[index]!));
    assert.ok(line.includes(`waiting ${[2, 4, 8, 16][index % 4]}s`));
  });
  assert.match(result.logs.at(-1)!, new RegExp(`SHA-256 ${checksum}$`));
  assert.equal(result.programs.length, 2);
});

for (const name of ["checksums.txt", asset]) {
  for (const failure of [504, 429, new Error("fetch failed")]) {
    test(`CI download retry: ${name} stops after five ${failure} failures`, async () => {
      const result = await install({ [name]: Array<Reply>(5).fill(failure) });
      assert.match(String(result.error), new RegExp(`Download ${name}: ${typeof failure === "number" ? `HTTP ${failure}` : "network error: fetch failed"}`));
      assert.equal(result.requests.filter(file => file === name).length, 5);
      assert.deepEqual(result.waits, [2000, 4000, 8000, 16000]);
      assert.equal(result.logs.length, 4);
      assert.deepEqual(result.programs, []);
    });
  }
  for (const status of [400, 401, 403, 404, 408, 499]) {
    test(`CI download retry: ${name} fails immediately on HTTP ${status}`, async () => {
      const result = await install({ [name]: [status] });
      assert.ok(String(result.error).includes(`Download ${name}: HTTP ${status}`));
      assert.equal(result.requests.filter(file => file === name).length, 1);
      assert.deepEqual(result.waits, []);
      assert.deepEqual(result.logs, []);
      assert.deepEqual(result.programs, []);
    });
  }
}

test("CI download retry: a recovered download still rejects a checksum mismatch before extraction", async () => {
  const result = await install({ "checksums.txt": [504, 200], [asset]: [429, 200] }, "0".repeat(64));
  assert.ok(String(result.error).includes(`Checksum mismatch for ${asset}`));
  assert.deepEqual(result.requests, ["checksums.txt", "checksums.txt", asset, asset]);
  assert.deepEqual(result.waits, [2000, 2000]);
  assert.deepEqual(result.programs, []);
  assert.deepEqual(result.writes, []);
});
