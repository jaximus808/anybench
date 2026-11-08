/* eslint-disable @typescript-eslint/no-explicit-any -- spike script reads untyped JSON */
// GitHub REST signals for 3 leads, UNAUTHENTICATED (GITHUB_TOKEN is empty): 60 requests/hour per IP.
// 2 calls per repo (repo + README) + 2 rate_limit checks.
import { http, key, record } from "./lib.js";

const token = key("GITHUB_TOKEN", false);
const headers: Record<string, string> = {
  accept: "application/vnd.github+json",
  "user-agent": "anybench-outreach-spike",
  "x-github-api-version": "2022-11-28",
};
if (token) headers.authorization = `Bearer ${token}`;

const repos = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["samuelfaj/distill", "trailhq/Trail-Code", "Mibayy/token-savior"];
const CLAIM =
  /(faster|fewer tokens|token|benchmark|\d+(\.\d+)?\s?%|\bx\d|\d+x\b|wall[- ]?(clock|time)|swe-?bench|terminal-?bench)/i;

const rl0 = await http("https://api.github.com/rate_limit", { headers });
record("github GET /rate_limit (before)", {
  status: rl0.status,
  core: (rl0.body as any)?.resources?.core,
});

for (const full of repos) {
  const r = await http(`https://api.github.com/repos/${full}`, { headers });
  const b = r.body as any;
  const readme = await http(`https://api.github.com/repos/${full}/readme`, {
    headers: { ...headers, accept: "application/vnd.github.raw+json" },
  });
  const text = typeof readme.body === "string" ? readme.body : JSON.stringify(readme.body);
  const claims = text
    .split("\n")
    .map((line, i) => ({ line: i + 1, text: line.trim() }))
    .filter((l) => l.text && CLAIM.test(l.text) && !l.text.startsWith("!["))
    .slice(0, 8)
    .map((l) => ({ ...l, text: l.text.slice(0, 220) }));
  record(`github ${full}`, {
    repoStatus: r.status,
    rateLimitRemaining: r.headers["x-ratelimit-remaining"],
    signals: {
      full_name: b?.full_name,
      owner_type: b?.owner?.type,
      owner_login: b?.owner?.login,
      html_url: b?.html_url,
      homepage: b?.homepage,
      description: b?.description,
      stargazers_count: b?.stargazers_count,
      forks_count: b?.forks_count,
      open_issues_count: b?.open_issues_count,
      language: b?.language,
      topics: b?.topics,
      license: b?.license?.spdx_id,
      pushed_at: b?.pushed_at,
      created_at: b?.created_at,
      archived: b?.archived,
      fork: b?.fork,
      default_branch: b?.default_branch,
    },
    readmeStatus: readme.status,
    readmeBytes: text.length,
    claims,
  });
}
const rl1 = await http("https://api.github.com/rate_limit", { headers });
record("github GET /rate_limit (after)", {
  status: rl1.status,
  core: (rl1.body as any)?.resources?.core,
});
