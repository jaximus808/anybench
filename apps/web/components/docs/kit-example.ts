// The minimal `anybench.yaml` shown on /docs/kits. A test parses it with safeParseKitSpec from
// @anybench/core, so the example can never drift from the real KitSpec v2 schema.

export const MINIMAL_KIT_YAML = `schema_version: 2

subject:
  kind: software
  name: fastcsv
  summary: A CSV-to-JSON converter that says it is faster than csvkit.
  better_means:
    - converts the same file in less time
    - uses less memory

# L0 source, L1 install, L2 driver: one entry per contender.
contenders:
  - id: fastcsv
    role: subject
    source: { github: acme/fastcsv, ref: v1.4.0 }
    install:
      script: adapters/fastcsv/install.sh
      healthcheck: adapters/fastcsv/healthcheck.sh
    driver:
      type: cli
      verbs:
        run: fastcsv {in}/data.csv --out {out}/rows.json
  - id: csvkit
    role: competitor
    source: { github: wireservice/csvkit, ref: "2.0.1" }
    driver:
      type: cli
      verbs:
        run: sh -c 'csvjson {in}/data.csv > {out}/rows.json'
    found_by: "researcher: the most common alternative"

# L3 workload: fixed input bytes, hashed on every trial.
workloads:
  - id: quoted-1gb
    title: 1 GB of quoted CSV with embedded newlines
    input: workloads/quoted-1gb/input/

# L5 gate: runs on the scoring computer, never on the computer that ran the contender.
gates:
  - id: same-rows
    kind: output-diff
    check: gates/same-rows/check.sh
    reference: gates/same-rows/reference/

# Every measured number names the gate that must pass first.
requirements:
  - id: wall
    type: measured
    title: Time to convert
    metric: wall_s
    unit: s
    better: lower
    gate_id: same-rows
  - id: memory
    type: measured
    title: Peak memory
    metric: peak_rss_mb
    unit: MB
    better: lower
    gate_id: same-rows

# L7 proof: overlays that show the gate can tell right from wrong.
proof:
  oracle:
    id: reference-output
    dir: proof/oracle/
    description: Copies the reference rows into the output, so the gate must pass.
  do_less:
    - id: first-half
      dir: proof/do_less/first-half/
      driver_patch: proof/do_less/first-half/driver.sh
      description: Converts only the first half of the file, so the gate must fail.
  regression:
    id: no-simd
    dir: proof/regression/no-simd/
    env: { FASTCSV_DISABLE_SIMD: "1" }
    description: Turns off the fast path, so it must score lower.

scoring:
  weights: { wall: 70, memory: 30 }

repeats: 5
`;
