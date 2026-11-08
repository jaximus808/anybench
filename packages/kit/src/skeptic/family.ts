// TDM-187 [16.16]: model families, for the skeptic's independence rule (plan.md 17.2 rule 8,
// the founder's methodology review gap 4): the agent that audits a test plan must come from a
// different model family than the kit designer and every contender, and never from Anthropic.
//
// The family is read from the model id alone: a name pattern first (so `claude` inside any
// reseller's id is still Anthropic), then the provider prefix, then the provider slug itself.
// Routers (`vetta/auto`) and moving aliases (`~x/y-latest`, `*-latest`) have no fixed family and
// are refused as a skeptic.

/** Name patterns that identify a family wherever they appear in the id. Order matters. */
const FAMILY_BY_NAME: readonly (readonly [RegExp, string])[] = [
  [/claude|(^|[/-])(fable|opus|sonnet|haiku)([-.\d]|$)/i, "anthropic"],
  [/deepseek/i, "deepseek"],
  [/gemini|gemma/i, "google"],
  [/(^|\/)(gpt|chatgpt|codex|o\d)([-.\d]|$)|gpt-oss/i, "openai"],
  [/qwen|qwq/i, "qwen"],
  [/mistral|mixtral|ministral|devstral|codestral|magistral|voxtral|pixtral/i, "mistral"],
  [/llama|(^|\/)muse-/i, "meta"],
  [/glm/i, "zhipu"],
  [/grok/i, "xai"],
  [/kimi/i, "moonshot"],
];

/** Provider prefixes (`<provider>/<model>`) that name a family. */
const FAMILY_BY_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  "meta-llama": "meta",
  meta: "meta",
  mistralai: "mistral",
  qwen: "qwen",
  deepseek: "deepseek",
  "z-ai": "zhipu",
  "zai-org": "zhipu",
  "x-ai": "xai",
  moonshotai: "moonshot",
};

/** Ids that route to whichever model they like: no fixed family. */
const ROUTERS = new Set(["vetta/auto", "openrouter/auto", "auto"]);

/** A moving alias: `~provider/x-latest`, `*-latest`, `latest`. */
export function isMovingModelAlias(id: string): boolean {
  const s = id.trim();
  return s.startsWith("~") || /(^|[-_.@:/])latest$/i.test(s) || ROUTERS.has(s.toLowerCase());
}

/**
 * The family of a model id (`anthropic`, `openai`, `google`, ...), or null when the id names
 * nothing (empty, a router). Unknown providers are their own family (`fireworks/ember-1` →
 * `fireworks`); an id with no provider and no known name is its own family.
 */
export function modelFamily(id: string): string | null {
  const s = id.trim().replace(/^~/, "").toLowerCase();
  if (s === "" || ROUTERS.has(s)) return null;
  for (const [re, family] of FAMILY_BY_NAME) if (re.test(s)) return family;
  const slash = s.indexOf("/");
  if (slash > 0) {
    const provider = s.slice(0, slash);
    return FAMILY_BY_PROVIDER[provider] ?? provider;
  }
  return s.split(/[-_.:@]/)[0] || s;
}

/** Families no skeptic may come from, whatever the kit: the company that builds our designer. */
export const ALWAYS_BANNED_SKEPTIC_FAMILIES: readonly string[] = ["anthropic"];

/**
 * The kit designer's families when its role is not known yet (TDM-60 not merged): Anthropic and
 * DeepSeek are the ones our own agents may use (packages/agents/understander runs deepseek).
 */
export const DEFAULT_DESIGNER_FAMILIES: readonly string[] = ["anthropic", "deepseek"];

export interface SkepticModelRuleInput {
  /** The kit designer's model ids (or families, e.g. `deepseek`). */
  designer: readonly string[];
  /** Every model a contender runs (KitSpec driver.model and *MODEL* env values). */
  contenders: readonly string[];
}

export type SkepticModelCheck =
  { ok: true; model: string; family: string } | { ok: false; model: string; reason: string };

function familyOf(idOrFamily: string): string | null {
  // A bare family name ("deepseek") is its own family.
  return modelFamily(idOrFamily);
}

/**
 * The independence rule, enforced in code: a skeptic model is refused when it is a router or a
 * moving alias, from Anthropic, or from the family of the designer or of any contender.
 */
export function checkSkepticModel(model: string, rule: SkepticModelRuleInput): SkepticModelCheck {
  if (isMovingModelAlias(model)) {
    return {
      ok: false,
      model,
      reason: `skeptic model '${model}' is a router or a moving alias: pin one model id so its family is known`,
    };
  }
  const family = modelFamily(model);
  if (family === null) {
    return { ok: false, model, reason: `skeptic model '${model}' names no model family` };
  }
  if (ALWAYS_BANNED_SKEPTIC_FAMILIES.includes(family)) {
    return {
      ok: false,
      model,
      reason: `skeptic model '${model}' is from ${family}, which builds our kit designer: the skeptic must be independent`,
    };
  }
  for (const d of rule.designer) {
    if (familyOf(d) === family) {
      return {
        ok: false,
        model,
        reason: `skeptic model '${model}' is from ${family}, the kit designer's family (${d})`,
      };
    }
  }
  for (const c of rule.contenders) {
    if (familyOf(c) === family) {
      return {
        ok: false,
        model,
        reason: `skeptic model '${model}' is from ${family}, the family of contender model '${c}'`,
      };
    }
  }
  return { ok: true, model, family };
}
