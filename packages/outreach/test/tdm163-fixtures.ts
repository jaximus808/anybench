// TDM-163 fixtures: trimmed from the TDM-162 spike's raw log (Context.dev /web/search and GitHub
// /repos responses, 2026-11-08). README bodies are rebuilt around the claim lines the spike saw,
// including the markup that fooled its loose regex (`<td width="25%">`, badges, img alt text).
// Names, blogs and Hunter answers for test users are invented. No secrets.

export const SEARCH_BODY = {
  results: [
    {
      url: "https://github.com/aarora79/agentic-coding-harness-benchmarks",
      title: "GitHub - aarora79/agentic-coding-harness-benchmarks",
      description:
        "... Claude Code against pi on the ... Claude Code is a few points more accurate on some models; pi is far more token-efficient, so faster and, self-hosted, cheaper....",
      relevance: "high",
    },
    {
      url: "https://github.com/samuelfaj/distill",
      title: "GitHub - samuelfaj/distill: Get FAR MORE done with FAR FEWER tokens",
      description:
        "Distill is a lightweight coding agent harness and TUI, built to get far more done with far fewer tokens.",
      relevance: "high",
    },
    {
      url: "https://github.com/VILA-Lab/Dive-into-Claude-Code",
      title: "GitHub - VILA-Lab/Dive-into-Claude-Code",
      description:
        "Beats a state-of-the-art context-management system by 7.7 points while using 4x fewer context tokens, and its discovered harnesses surpass the best hand-engineered baselines on TerminalBench-2.",
      relevance: "high",
    },
    {
      url: "https://github.com/trailhq/Trail-Code",
      title: "GitHub - trailhq/Trail-Code: One shared memory for every coding agent on your team.",
      description:
        "The only difference is whether the graft map is wired in. ... The graft map resolved 33 of 50 instances against cold Claude Code's 27, with 25% fewer tool calls, 23% fewer tokens and 32% less wall-clock time.",
      relevance: "medium",
    },
    {
      url: "https://github.com/Heretek-AI/harness-benchmark/issues/60",
      title: "[Benchmark Report] 2026-10-14 · Issue #60 · Heretek-AI/harness-benchmark",
      description: "Automated Benchmark Arena Report",
      relevance: "medium",
    },
    {
      url: "https://github.com/juliusbrussee/caveman",
      title: "GitHub - JuliusBrussee/caveman",
      description:
        "Caveman make your AI agent say less and read less. Code stay exact. Brain still big.",
      relevance: "medium",
    },
    {
      url: "https://github.com/bradagi/awesome-cli-coding-agents",
      title: "GitHub - bradAGI/awesome-cli-coding-agents",
      description: "Vendor-published DeepSWE comparison claims 77.5% fewer tokens than Codex CLI.",
      relevance: "medium",
    },
    {
      url: "https://github.com/mibayy/token-savior",
      title: "GitHub - Mibayy/token-savior",
      description:
        "MCP server that gets Claude to 97.9% (188/192) on a real coding benchmark at -80% active tokens and -83% wall time, vs 78.3% plain.",
      relevance: "medium",
    },
    {
      url: "https://github.com/ai-boost/awesome-harness-engineering/blob/main/README.md",
      title: "awesome-harness-engineering/README.md at main",
      description: "Token Savior cuts active tokens by 77% and benchmark wall time by 76%.",
      relevance: "medium",
    },
    {
      url: "https://github.com/topics/agent-harness",
      title: "agent-harness · GitHub Topics · GitHub",
      description: "skills cursor codex ai-agents",
      relevance: "medium",
    },
  ],
  key_metadata: { credits_consumed: 1, credits_remaining: 541 },
  request_id: "8dc3c8ab-2978-48b7-a38e-5d6f33a38bca",
};

export const USAGE_BODY = {
  credits_remaining: 542,
  period: { start: "2026-10-29T07:01:00.000Z", credits_used: 370 },
  key_metadata: { credits_consumed: 0, credits_remaining: 542 },
};

export const NOW = Date.parse("2026-11-08T02:00:00Z");

function repo(
  full: string,
  ownerType: "User" | "Organization",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const [owner] = full.split("/");
  return {
    full_name: full,
    html_url: `https://github.com/${full}`,
    owner: { login: owner, type: ownerType },
    homepage: "",
    description: "",
    stargazers_count: 100,
    forks_count: 5,
    language: "TypeScript",
    topics: ["claude-code"],
    license: { spdx_id: "MIT" },
    pushed_at: "2026-11-05T17:28:52Z",
    created_at: "2026-03-06T14:37:09Z",
    archived: false,
    fork: false,
    default_branch: "main",
    ...extra,
  };
}

export const REPOS: Record<string, Record<string, unknown>> = {
  "aarora79/agentic-coding-harness-benchmarks": repo(
    "aarora79/agentic-coding-harness-benchmarks",
    "User",
    { stargazers_count: 42, language: "Python" },
  ),
  "samuelfaj/distill": repo("samuelfaj/distill", "User", {
    description: "Get FAR MORE done with FAR FEWER tokens",
    stargazers_count: 777,
    forks_count: 54,
    language: "Rust",
    license: { spdx_id: "Apache-2.0" },
  }),
  "vila-lab/dive-into-claude-code": repo("VILA-Lab/Dive-into-Claude-Code", "Organization", {
    stargazers_count: 300,
  }),
  "trailhq/trail-code": repo("trailhq/Trail-Code", "Organization", {
    homepage: "https://trailhq.com/trail-code",
    stargazers_count: 11135,
    forks_count: 990,
    pushed_at: "2026-11-07T19:49:32Z",
  }),
  "juliusbrussee/caveman": repo("JuliusBrussee/caveman", "User", { stargazers_count: 2000 }),
  "mibayy/token-savior": repo("Mibayy/token-savior", "User", {
    stargazers_count: 1212,
    language: "Python",
    pushed_at: "2026-10-15T08:00:00Z",
  }),
};

export const DISTILL_README = [
  '<p align="center"><img src="assets/logo.png" alt="distill 100% logo" width="25%"/></p>',
  "",
  "[![CI](https://img.shields.io/badge/coverage-100%25-green)](https://github.com/samuelfaj/distill/actions)",
  "",
  "# distill",
  "",
  "Get **far more** done",
  "with far fewer tokens.**",
  "",
  "<table><tr>",
  '<td width="25%" valign="top">',
  "",
  "# 93% cheaper",
  "",
  "UltraSave cost **0.069x the credits of Normal** on our 20-case benchmark,",
  "",
  '<td width="25%" valign="top">',
  "",
  "# ~2x faster",
  "",
  "UltraFast finished in **0.509x the wall time of Normal**, about half,",
  "",
  "```bash",
  "distill --budget 50% --faster 3x",
  "```",
  "<!-- 99% faster than anything",
  "     hidden for now -->",
  "Install with `cargo install distill --jobs 4x` then run it.",
  "Licensed under Apache 2.0.",
].join("\n");

export const TRAIL_README = [
  '<img src="assets/trail-code-banner.png" alt="Trail-code. keep retries at 4." width="100%"/>',
  "",
  "### **46% fewer tool calls**, **60% less time**, and more real issues solved.",
  "",
  "| Tool calls, 162 runs | baseline | **46% fewer** |",
  "| SWE-bench Verified, 50 real issues | 27 solved (54%) | **33 solved (66%)** |",
].join("\n");

export const TOKEN_SAVIOR_README = [
  "# token-savior",
  "",
  "Gets Claude to **97.9%** on tsbench at -80% tokens.",
  "Benchmark source + fixtures: not currently published.",
].join("\n");

export const PLAIN_README = "# caveman\n\nwhy use many token when few token do trick\n";

export const AARORA_README = [
  "# agentic-coding-harness-benchmarks",
  "",
  "pi used 41% fewer tokens than Claude Code on the same tasks.",
].join("\n");

export const DIVE_README =
  "# Dive\n\nBeats the baseline by 7.7 points with 4x fewer context tokens.\n";

export function readmeBody(path: string, text: string) {
  return {
    path,
    sha: `blob-${path.length}-${text.length}`,
    encoding: "base64",
    content: Buffer.from(text, "utf8").toString("base64"),
  };
}

export const READMES: Record<string, Record<string, unknown>> = {
  "aarora79/agentic-coding-harness-benchmarks": readmeBody("README.md", AARORA_README),
  "samuelfaj/distill": readmeBody("README.md", DISTILL_README),
  "VILA-Lab/Dive-into-Claude-Code": readmeBody("README.md", DIVE_README),
  "trailhq/Trail-Code": readmeBody("README.md", TRAIL_README),
  "JuliusBrussee/caveman": readmeBody("README.md", PLAIN_README),
  "Mibayy/token-savior": readmeBody("docs/README.md", TOKEN_SAVIOR_README),
};

export const USERS: Record<string, Record<string, unknown>> = {
  aarora79: { login: "aarora79", type: "User", name: "Test Arora", company: "@aws", blog: "" },
  samuelfaj: {
    login: "samuelfaj",
    type: "User",
    name: "Samuel Test",
    company: null,
    blog: "https://samuelfaj.example",
    email: "do-not-use@example.com",
  },
  JuliusBrussee: { login: "JuliusBrussee", type: "User", name: null, company: null, blog: "" },
  Mibayy: { login: "Mibayy", type: "User", name: "Mibayy", company: null, blog: "" },
};

export const HUNTER_FOUND = {
  runId: "01HUNTER0000000000000000001",
  provider: "hunterio",
  endpoint: "/email-finder",
  status: "COMPLETED",
  output: {
    email: "Samuel@Samuelfaj.example",
    score: 91,
    verification: { status: "valid" },
  },
  providerResponse: { httpStatus: 200 },
  billing: { reportedCost: { currency: "USD", value: 24500, unit: "MICRO_DOLLAR" } },
};

export const HUNTER_NOT_FOUND = {
  ...HUNTER_FOUND,
  runId: "01HUNTER0000000000000000002",
  output: { email: null, score: null },
  billing: { reportedCost: { currency: "USD", value: 0, unit: "MICRO_DOLLAR" } },
};

/** anyapi /github.repository output (shape from the inspect summary). */
export const ANYAPI_REPO_RUN = {
  runId: "01ANYAPI000000000000000001",
  provider: "anyapi",
  endpoint: "/github.repository",
  status: "COMPLETED",
  output: {
    fullName: "samuelfaj/distill",
    url: "https://github.com/samuelfaj/distill",
    homepage: "",
    description: "Get FAR MORE done with FAR FEWER tokens",
    stars: 777,
    forks: 54,
    language: "Rust",
    topics: ["claude-code"],
    license: "Apache-2.0",
    pushedAt: "2026-11-05T17:28:52Z",
    createdUtc: "2026-03-06T14:37:09Z",
    archived: false,
    fork: false,
    defaultBranch: "main",
    owner: "samuelfaj",
  },
  providerResponse: { httpStatus: 200 },
  billing: { reportedCost: { currency: "USD", value: 1200, unit: "MICRO_DOLLAR" } },
};
