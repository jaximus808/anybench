// TDM-23 done condition: DockerLocalProvider passes the shared ComputeProvider contract.
// Skips cleanly when no Docker daemon answers. Every container and image it creates is
// labelled with a per-run namespace and removed in afterAll, which also fails the file if
// anything leaked.
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { runProviderContract } from "../src/contract.js";
import { DOCKER_LOCAL_HOME, DockerLocalProvider, dockerLocalAvailable } from "../src/docker.js";
import { isProviderError } from "../src/errors.js";
import { decodeText, trialTag } from "../src/helpers.js";

const available = await dockerLocalAvailable();
const NS_LABEL = "anybench.test-tdm23";
const ns = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const providers: DockerLocalProvider[] = [];
const makeTdm23Provider = () => {
  const p = new DockerLocalProvider({ labels: { [NS_LABEL]: ns } });
  providers.push(p);
  return p;
};

function dockerLines(args: string[]): string[] {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return (r.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

afterAll(async () => {
  if (!available) return;
  const filter = `label=${NS_LABEL}=${ns}`;
  const containers = dockerLines(["ps", "-a", "-q", "--filter", filter]);
  const images = dockerLines(["images", "-q", "--filter", filter]);
  if (containers.length) spawnSync("docker", ["rm", "-f", "-v", ...containers]);
  if (images.length) spawnSync("docker", ["rmi", "-f", ...images]);
  for (const p of providers) await p.dispose();
  expect({ containers, images }, "the suite leaked docker resources").toEqual({
    containers: [],
    images: [],
  });
}, 120_000);

runProviderContract("docker-local", makeTdm23Provider, {
  enabled: available,
  spec: { vcpu: 1, memoryMb: 512, diskGb: 5 },
  readyTimeoutMs: 600_000, // first run may pull and build the base image
  readyIntervalMs: 200,
  testTimeoutMs: 60_000,
  detachedWaitMs: 20_000,
});

describe.skipIf(!available)("docker-local specifics", () => {
  const T = 120_000;

  it(
    "runs as a naive-home computer: root exec, naive-owned files, symlink escapes refused",
    async () => {
      const p = makeTdm23Provider();
      const c = await p.waitReady(
        (await p.create({ vcpu: 1, memoryMb: 256, tags: [trialTag(ns, "spec")] })).id,
      );
      try {
        expect(c.home).toBe(DOCKER_LOCAL_HOME);
        expect((await p.exec(c.id, "id -un")).stdout).toBe("root\n");
        expect((await p.exec(c.id, "pwd; echo $HOME")).stdout).toBe(
          `${DOCKER_LOCAL_HOME}\n${DOCKER_LOCAL_HOME}\n`,
        );
        expect((await p.exec(c.id, "runuser -u naive -- id -un")).stdout).toBe("naive\n");

        await p.putFile(c.id, "deep/dir/secret.env", "K=v\n", { mode: 0o600 });
        const st = await p.exec(c.id, `stat -c '%U %a' deep deep/dir deep/dir/secret.env`);
        expect(st.stdout).toBe("naive 755\nnaive 755\nnaive 600\n");

        await p.exec(c.id, "ln -s /etc etc-link && ln -s /etc/hostname host-link");
        const e1 = await p.getFile(c.id, "host-link").catch((e: unknown) => e);
        expect(isProviderError(e1, "forbidden")).toBe(true);
        const e2 = await p.putFile(c.id, "etc-link/ab-tdm23.txt", "x").catch((e: unknown) => e);
        expect(isProviderError(e2, "forbidden")).toBe(true);
        expect((await p.exec(c.id, "test -e /etc/ab-tdm23.txt")).exitCode).not.toBe(0);
        const e3 = await p.getFile(c.id, "deep").catch((e: unknown) => e);
        expect(isProviderError(e3, "validation")).toBe(true);
      } finally {
        await p.destroy(c.id);
      }
    },
    T,
  );

  it(
    "a timed-out exec kills its whole process group",
    async () => {
      const p = makeTdm23Provider();
      const c = await p.waitReady((await p.create({ vcpu: 1, memoryMb: 256 })).id);
      try {
        const r = await p.exec(c.id, "sleep 40 & sleep 41; wait", { timeoutMs: 1_000 });
        expect(r.timedOut).toBe(true);
        expect(r.exitCode).toBe(124);
        // give the group kill a moment, then nothing from that exec may be left
        const left = await p.exec(
          c.id,
          "sleep 1; for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < $f; echo; done | grep -c '^sleep 4[01]' || true",
        );
        expect(left.stdout.trim()).toBe("0");
      } finally {
        await p.destroy(c.id);
      }
    },
    T,
  );

  it(
    "labels carry spec and tags, fork does not inherit the source's tags, and output is capped",
    async () => {
      const p = new DockerLocalProvider({
        labels: { [NS_LABEL]: ns },
        capabilities: { maxOutputChars: 1_000 },
      });
      providers.push(p);
      const tag = trialTag(ns, "src");
      const c = await p.waitReady(
        (await p.create({ name: "tdm23 source", vcpu: 1, memoryMb: 300, diskGb: 7, tags: [tag] }))
          .id,
      );
      let forkId: string | undefined;
      let snapId: string | undefined;
      try {
        expect(c).toMatchObject({ name: "tdm23 source", vcpu: 1, memoryMb: 300, diskGb: 7 });
        const big = await p.exec(c.id, "head -c 5000 /dev/zero | tr '\\0' a");
        expect(big.stdout.length).toBe(1_000);
        expect(big.truncated).toBe(true);

        await p.putFile(c.id, "fork-me.txt", "hello fork");
        snapId = (await p.snapshot(c.id)).snapshotId;
        const forkTag = trialTag(ns, "dst");
        const f = await p.waitReady((await p.fork(snapId, { tags: [forkTag] })).id);
        forkId = f.id;
        expect(f.tags).toEqual([forkTag]);
        expect(f.snapshotId).toBe(snapId);
        expect(decodeText(await p.getFile(f.id, "fork-me.txt"))).toBe("hello fork");
        expect((await p.list({ tag })).map((x) => x.id)).toEqual([c.id]);

        // a snapshot still used by a fork cannot be deleted
        const busy = await p.deleteSnapshot(snapId).catch((e: unknown) => e);
        expect(isProviderError(busy, "unavailable")).toBe(true);
      } finally {
        if (forkId) await p.destroy(forkId);
        if (snapId) await p.deleteSnapshot(snapId);
        await p.destroy(c.id);
      }
      const gone = await p.deleteSnapshot(snapId!).catch((e: unknown) => e);
      expect(isProviderError(gone, "not_found")).toBe(true);
    },
    T,
  );
});
