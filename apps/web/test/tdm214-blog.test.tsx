import { existsSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import BlogPostPage, {
  generateMetadata as postMetadata,
  generateStaticParams,
} from "../app/(marketing)/blog/[slug]/page";
import BlogIndexPage from "../app/(marketing)/blog/page";
import { renderMarkdown, stripInline } from "../lib/blog/markdown";
import { getAllPosts, getPublishedPosts, parsePost } from "../lib/blog/posts";

afterEach(cleanup);

const REPO_ROOT = path.resolve(process.cwd(), "..", "..");

describe("blog markdown renderer (TDM-214)", () => {
  it("escapes raw HTML but keeps comments", () => {
    const html = renderMarkdown("A <script>x</script> & b <!-- source: README.md -->");
    expect(html).toBe("<p>A &lt;script&gt;x&lt;/script&gt; &amp; b <!-- source: README.md --></p>");
  });

  it("renders headings, lists, tables, code and placeholder containers", () => {
    const html = renderMarkdown(
      [
        "## The whole-app test",
        "",
        "- **one** and *two*",
        "- `three`",
        "",
        "1. first",
        "2. second",
        "",
        "| | A | B |",
        "|---|---|---|",
        "| rate | 94% | 89% |",
        "",
        "```bash",
        "npx -y x <y>",
        "```",
        "",
        ":::placeholder",
        "Coming later.",
        ":::",
      ].join("\n"),
    );
    expect(html).toContain('<h2 id="the-whole-app-test">The whole-app test</h2>');
    expect(html).toContain("<li><strong>one</strong> and <em>two</em></li>");
    expect(html).toContain("<li><code>three</code></li>");
    expect(html).toContain("<ol>\n<li>first</li>\n<li>second</li>\n</ol>");
    expect(html).toContain('<th scope="row">rate</th><td>94%</td><td>89%</td>');
    expect(html).toContain('<code class="language-bash">npx -y x &lt;y&gt;</code>');
    expect(html).toContain('<aside class="md-placeholder" role="note">\n<p>Coming later.</p>');
  });

  it("only links safe hrefs", () => {
    expect(renderMarkdown("[a](/signup) [b](https://x.dev) [c](javascript:void)")).toBe(
      '<p><a href="/signup">a</a> <a href="https://x.dev" rel="noreferrer">b</a> c</p>',
    );
  });
});

describe("blog frontmatter (TDM-214)", () => {
  it("rejects missing fields, bad dates and unknown keys", () => {
    expect(() => parsePost("x", "---\ntitle: X\n---\nbody")).toThrow(/frontmatter/);
    expect(() =>
      parsePost("x", "---\ntitle: X\ndescription: D\ndate: Nov 8\ndraft: true\n---\n"),
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      parsePost("x", "---\ntitle: X\ndescription: D\ndate: 2026-11-08\ndraft: true\nfoo: 1\n---\n"),
    ).toThrow(/frontmatter/);
  });

  it("parses a valid post", () => {
    const p = parsePost(
      "hello-world",
      '---\ntitle: "Hello: world"\ndescription: D\ndate: 2026-11-08\ndraft: false\n---\nHi.\n',
    );
    expect(p).toMatchObject({ slug: "hello-world", title: "Hello: world", draft: false });
    expect(p.html).toBe("<p>Hi.</p>");
  });
});

describe("/blog posts (TDM-214)", () => {
  const posts = getAllPosts();

  it("has the two launch posts", () => {
    expect(posts.map((p) => p.slug).sort()).toEqual(
      expect.arrayContaining(["what-is-tandem", "why-we-built-anybench"]),
    );
  });

  it("builds every post, drafts included, so a draft is reachable by URL", () => {
    expect(
      generateStaticParams()
        .map((p) => p.slug)
        .sort(),
    ).toEqual(posts.map((p) => p.slug).sort());
  });

  it("the index lists exactly the non-draft posts", () => {
    render(<BlogIndexPage />);
    const hrefs = screen
      .queryAllByRole("link")
      .map((a) => a.getAttribute("href"))
      .filter((h) => h?.startsWith("/blog/"));
    expect(hrefs.sort()).toEqual(
      getPublishedPosts()
        .map((p) => `/blog/${p.slug}`)
        .sort(),
    );
    for (const d of posts.filter((p) => p.draft)) expect(hrefs).not.toContain(`/blog/${d.slug}`);
  });

  for (const post of posts) {
    it(`${post.slug}: draft posts are noindex, published ones have a canonical`, async () => {
      const meta = await postMetadata({ params: Promise.resolve({ slug: post.slug }) });
      expect(meta.title).toBe(post.title);
      if (post.draft) {
        expect(meta.robots).toEqual({ index: false, follow: false });
      } else {
        expect(meta.robots).toBeUndefined();
        expect(meta.alternates?.canonical).toBe(`/blog/${post.slug}`);
      }
    });

    it(`${post.slug}: renders its title, and the draft notice only on a draft`, async () => {
      render(await BlogPostPage({ params: Promise.resolve({ slug: post.slug }) }));
      expect(screen.getByRole("heading", { level: 1, name: post.title })).toBeTruthy();
      expect(screen.queryByRole("note", { name: "Draft notice" }) !== null).toBe(post.draft);
    });

    // The product's rule applied to our own writing: no number without a source. Every block
    // (paragraph, list item, table row) whose visible text has a digit must carry a
    // `<!-- source: a; b -->` comment, and each source must be a file in this repo
    // (`tandem:` sources are the Tandem repo, github.com/jaximus808/tandem).
    it(`${post.slug}: every number names a source file that exists`, () => {
      const body = post.markdown.replace(/```[\s\S]*?```/g, "");
      const blocks = body
        .split(/\n\s*\n/)
        .flatMap((b) => b.split(/\n(?=\s*(?:[-*]|\d+\.|\|)\s)/))
        .filter((b) => !b.trim().startsWith("<!--") && !/^\|?\s*-{3,}/.test(b.trim()));
      const missing: string[] = [];
      const sources = new Set<string>();
      for (const block of blocks) {
        const visible = stripInline(
          block
            .replace(/`[^`]*`/g, "")
            .replace(/^\s*\d+\.\s/gm, "")
            .replace(/\]\([^)]*\)/g, "]"),
        );
        const cited = [...block.matchAll(/<!--\s*source:\s*([^>]*?)\s*-->/g)];
        for (const c of cited) for (const s of (c[1] ?? "").split(";")) sources.add(s.trim());
        if (/\d/.test(visible) && cited.length === 0) missing.push(block.trim());
      }
      expect(missing).toEqual([]);
      const absent = [...sources].filter(
        (s) => !s.startsWith("tandem:") && !existsSync(path.join(REPO_ROOT, s)),
      );
      expect(absent).toEqual([]);
    });
  }

  it("the Anybench post keeps a marked placeholder for the whole-app test", () => {
    const post = posts.find((p) => p.slug === "why-we-built-anybench");
    expect(post?.html).toContain('<h2 id="the-whole-app-test">The whole-app test</h2>');
    expect(post?.html).toContain('<aside class="md-placeholder" role="note">');
  });
});
