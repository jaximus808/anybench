# Naïve health probe (worker-hardening, 2026-11-08)

The provider-outage breaker (apps/server/src/lib/provider-breaker.ts) closes only after a probe:
`computers.list({tag: "ab-infra-probe"})`, then a tiny create + destroy. One live check:

```
$ cd /Users/jaxon/coding-project/anybench && tsx <scratch>/probe-live.mts   # probeProvider(NaiveProvider)
{"probe":"failed","ms":1653,"error":"naive validation_failed (400): diskGb must be an integer in 5–100"}
{"leftover_probe_computers":[]}
```

- Naïve rejects `diskGb < 5` with 400 `validation_failed` ("diskGb must be an integer in 5–100");
  the create never happened. The probe now asks for 1 vCPU / 1024 MB / 5 GB.

```
$ tsx <scratch>/probe-live.mts
{"probe":"passed","ms":5600,"provider":"naive"}
{"leftover_probe_computers":[]}
```

- list + create + destroy took 5.6 s end to end and left nothing behind (the probe does not wait
  for the computer to boot: create answering is what failed in the 07:18–07:26 UTC outage, when
  create/fork and proxy-key mint returned 500 "the sandbox request failed").
- The probe only runs while the breaker is open (every PROVIDER_BREAKER_PROBE_MS, default 30 s), so
  it costs nothing in normal operation.
