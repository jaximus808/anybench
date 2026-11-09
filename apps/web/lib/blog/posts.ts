// Blog posts (TDM-214): Markdown files in apps/web/content/blog/, read and rendered at build
// time. The file name is the slug. A post with `draft: true` is reachable by its URL (so the
// founder can review it) but is left off /blog and asked not to be indexed.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { renderMarkdown } from "./markdown";

/** Next runs `build` and `dev` from apps/web, and so do the package's tests. */
export const BLOG_DIR = path.join(process.cwd(), "content", "blog");

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const PostFrontmatterSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
    draft: z.boolean(),
  })
  .strict();

export type PostFrontmatter = z.infer<typeof PostFrontmatterSchema>;

export interface Post extends PostFrontmatter {
  slug: string;
  /** The Markdown body, without the frontmatter. */
  markdown: string;
  html: string;
}

/** Splits `---` frontmatter (flat `key: value` lines) from the body. */
export function parseFrontmatter(src: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src.replace(/\r\n?/g, "\n"));
  if (!m) return { data: {}, body: src };
  const data: Record<string, unknown> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`frontmatter line is not "key: value": ${line}`);
    const raw = (kv[2] ?? "").trim();
    let value: unknown = raw;
    if (raw === "true" || raw === "false") value = raw === "true";
    else if (/^"(.*)"$/.test(raw) || /^'(.*)'$/.test(raw)) value = raw.slice(1, -1);
    data[kv[1] ?? ""] = value;
  }
  return { data, body: src.slice(m[0].length) };
}

export function parsePost(slug: string, src: string): Post {
  if (!SLUG.test(slug)) throw new Error(`blog: bad slug "${slug}" (lowercase words and dashes)`);
  const { data, body } = parseFrontmatter(src);
  const fm = PostFrontmatterSchema.safeParse(data);
  if (!fm.success) throw new Error(`blog: ${slug}.md frontmatter: ${z.prettifyError(fm.error)}`);
  return { ...fm.data, slug, markdown: body, html: renderMarkdown(body) };
}

let cache: readonly Post[] | undefined;

/** Every post, drafts included, newest first. */
export function getAllPosts(): readonly Post[] {
  if (cache) return cache;
  const files = readdirSync(BLOG_DIR).filter((f) => f.endsWith(".md"));
  cache = files
    .map((f) => parsePost(f.slice(0, -3), readFileSync(path.join(BLOG_DIR, f), "utf8")))
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  return cache;
}

/** The posts /blog lists: everything not marked `draft: true`. */
export function getPublishedPosts(): readonly Post[] {
  return getAllPosts().filter((p) => !p.draft);
}

export function getPost(slug: string): Post | undefined {
  return getAllPosts().find((p) => p.slug === slug);
}

const DATE = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/** "2026-11-08" → "November 8, 2026", without the reader's time zone shifting the day. */
export function formatPostDate(date: string): string {
  return DATE.format(new Date(`${date}T00:00:00Z`));
}
