// The kit folder layout (plan.md P2, seven wrapper layers). TDM-33 [4.1].
//
//   anybench.yaml                     the manifest (KitSpec v2)
//   adapters/<contender>/install.sh   L1, runs at snapshot build
//   adapters/<contender>/healthcheck.sh
//   adapters/<contender>/driver.sh    L2, verbs start | ready | run <in> <out> | stop
//   workloads/<workload>/input/       L3, deterministic bytes (sha256 per file + manifest)
//   workloads/<workload>/instruction.md, setup.sh
//   gates/<gate>/check.sh             L5, runs only on the scoring computer
//   reference/                        L5 reference outputs shared by gates (or gates/<gate>/reference/)
//   rubric.md                         L6, reviewed requirements
//   proof/{oracle,do_less,regression}/  L7, contender overlays
//
// Every default here matches the `Defaults to ...` comments on the core schemas.

export const KIT_LAYOUT = {
  manifest: "anybench.yaml",
  adaptersDir: "adapters",
  workloadsDir: "workloads",
  gatesDir: "gates",
  referenceDir: "reference",
  proofDir: "proof",
  proofOracleDir: "proof/oracle",
  proofDoLessDir: "proof/do_less",
  proofRegressionDir: "proof/regression",
  rubric: "rubric.md",

  installScript: (contenderId: string) => `adapters/${contenderId}/install.sh`,
  healthcheckScript: (contenderId: string) => `adapters/${contenderId}/healthcheck.sh`,
  driverScript: (contenderId: string) => `adapters/${contenderId}/driver.sh`,
  workloadDir: (workloadId: string) => `workloads/${workloadId}`,
  workloadInput: (workloadId: string) => `workloads/${workloadId}/input`,
  workloadInstruction: (workloadId: string) => `workloads/${workloadId}/instruction.md`,
  workloadSetup: (workloadId: string) => `workloads/${workloadId}/setup.sh`,
  gateDir: (gateId: string) => `gates/${gateId}`,
  gateCheck: (gateId: string) => `gates/${gateId}/check.sh`,
} as const;

/** Top-level entries a kit is expected to contain. Anything else is allowed (e.g. `baselines/`). */
export const KIT_TOP_LEVEL = [
  KIT_LAYOUT.manifest,
  KIT_LAYOUT.adaptersDir,
  KIT_LAYOUT.workloadsDir,
  KIT_LAYOUT.gatesDir,
  KIT_LAYOUT.referenceDir,
  KIT_LAYOUT.proofDir,
  KIT_LAYOUT.rubric,
] as const;

/** Strip a trailing `/` so `proof/oracle/` and `proof/oracle` compare equal. */
export function normalizeKitPath(p: string): string {
  return p.replace(/\/+$/, "");
}
