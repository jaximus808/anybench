// TDM-55 [6.1]: `pnpm --filter @anybench/agents sync [--dry-run] [--role <r>]... [--model <m>]`.
// Reads NAIVE_API_KEY (and NAIVE_BASE_URL) from the environment. Never prints the key.
import { createNaiveClientFromEnv, type NaiveClient } from "@anybench/naive";
import { parseArgs } from "node:util";
import { listRoles, RoleError, type RegistryOptions } from "./registry.js";
import { planSync, syncAgents, type SyncOptions } from "./sync.js";

export interface SyncCliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: Record<string, string | undefined>;
  /** Tests inject a FakeNaive; default: the live client from NAIVE_API_KEY. */
  client?: (env: Record<string, string | undefined>) => NaiveClient;
}

const USAGE =
  "usage: sync [--dry-run] [--role <role>]... [--model <model>] [--roles-dir <dir>]\n" +
  "  --dry-run   print what would be synced; no call to Naïve\n" +
  "  --role      only this role (repeatable); default every role folder\n" +
  "  --model     override every synced role's model";

export async function syncMain(argv: readonly string[], io: SyncCliIo): Promise<number> {
  let values: {
    "dry-run"?: boolean;
    role?: string[];
    model?: string;
    "roles-dir"?: string;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        "dry-run": { type: "boolean" },
        role: { type: "string", multiple: true },
        model: { type: "string" },
        "roles-dir": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  const registry: RegistryOptions = values["roles-dir"] ? { rolesDir: values["roles-dir"] } : {};
  const options: SyncOptions = {
    ...registry,
    ...(values.role ? { roles: values.role } : {}),
  };
  try {
    const roles = options.roles ?? listRoles(registry);
    if (values.model) {
      options.overrides = Object.fromEntries(roles.map((r) => [r, { model: values.model! }]));
    }
    const plan = planSync(options);
    if (plan.length === 0) {
      io.stdout("no agent roles to sync");
      return 0;
    }
    if (values["dry-run"]) {
      for (const p of plan) {
        io.stdout(
          `plan ${p.role}: agent ${p.name}, model ${p.model}, fingerprint ${p.fingerprint}, prompt sha256 ${p.promptSha256.slice(0, 12)}, output schema ${p.hasOutputSchema ? "yes" : "no"}`,
        );
      }
      io.stdout(`dry run: ${plan.length} role(s), no call to Naïve`);
      return 0;
    }
    if (!io.client && !io.env.NAIVE_API_KEY) {
      io.stderr("NAIVE_API_KEY is not set (use --dry-run to print the plan without Naïve)");
      return 1;
    }
    const client = (io.client ?? ((env) => createNaiveClientFromEnv(env)))(io.env);
    const synced = await syncAgents(client, options);
    for (const s of synced) {
      io.stdout(
        `${s.action} ${s.role}: agent ${s.agent.name} (${s.agent.id}) version ${s.agent.version}, fingerprint ${s.fingerprint}`,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof RoleError) {
      io.stderr(error.message);
      return 1;
    }
    io.stderr(`sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
