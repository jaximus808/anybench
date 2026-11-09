// A small Markdown renderer for the blog (TDM-214). Posts are our own files, rendered once at
// build time, so a subset is enough and we avoid a dependency:
//
//   blocks:  # / ## / ### / #### headings, paragraphs, `-` and `1.` lists (one level), fenced
//            code, pipe tables, `>` quotes, `---` rules, `:::name … :::` containers, and
//            `<!-- … -->` comments (kept in the output, so a number's source note survives)
//   inline:  `code`, **bold**, *italic*, [text](href), and `<!-- … -->` comments
//
// Everything else is escaped. Links are limited to http(s), mailto, site paths and #anchors.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Heading anchor: lowercase words joined by `-`, with markup and comments dropped. */
export function slugify(text: string): string {
  return stripInline(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The visible text of an inline run: no comments, no markup, link text kept. */
export function stripInline(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim();
}

function safeHref(href: string): string | undefined {
  if (/^(https?:\/\/|mailto:)/i.test(href)) return href;
  if (/^[/#]/.test(href) && !href.startsWith("//")) return href;
  return undefined;
}

const INLINE =
  /(<!--[\s\S]*?-->)|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|\*(?!\s)(.+?)\*/g;

export function renderInline(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    out += escapeHtml(text.slice(last, m.index));
    last = m.index + m[0].length;
    const [, comment, code, linkText, href, bold, italic] = m;
    if (comment !== undefined) out += comment;
    else if (code !== undefined) out += `<code>${escapeHtml(code)}</code>`;
    else if (linkText !== undefined && href !== undefined) {
      const safe = safeHref(href);
      const inner = renderInline(linkText);
      if (!safe) out += inner;
      else {
        const ext = /^https?:\/\//i.test(safe) ? ' rel="noreferrer"' : "";
        out += `<a href="${escapeHtml(safe)}"${ext}>${inner}</a>`;
      }
    } else if (bold !== undefined) out += `<strong>${renderInline(bold)}</strong>`;
    else if (italic !== undefined) out += `<em>${renderInline(italic)}</em>`;
  }
  return out + escapeHtml(text.slice(last));
}

const HEADING = /^(#{1,4})\s+(.*)$/;
const FENCE = /^```\s*([\w-]*)\s*$/;
const UL_ITEM = /^[-*]\s+(.*)$/;
const OL_ITEM = /^\d+\.\s+(.*)$/;
const TABLE_SEP = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const CONTAINER_OPEN = /^:::([a-z][a-z-]*)\s*$/;
const CONTAINER_CLOSE = /^:::\s*$/;
const HR = /^-{3,}\s*$/;

function isBlockStart(line: string, next: string | undefined): boolean {
  return (
    HEADING.test(line) ||
    FENCE.test(line) ||
    UL_ITEM.test(line) ||
    OL_ITEM.test(line) ||
    CONTAINER_OPEN.test(line) ||
    CONTAINER_CLOSE.test(line) ||
    HR.test(line) ||
    line.startsWith(">") ||
    line.startsWith("<!--") ||
    (line.startsWith("|") && next !== undefined && TABLE_SEP.test(next))
  );
}

function tableCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Render a Markdown document (the subset above) to an HTML string. */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const next = lines[i + 1];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      i++; // closing fence
      const lang = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
      html.push(`<pre tabindex="0"><code${lang}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (line.startsWith("<!--")) {
      const body: string[] = [];
      while (i < lines.length) {
        const l = lines[i++] ?? "";
        body.push(l);
        if (l.includes("-->")) break;
      }
      html.push(body.join("\n"));
      continue;
    }

    const container = CONTAINER_OPEN.exec(line);
    if (container) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !CONTAINER_CLOSE.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      i++; // closing :::
      html.push(
        `<aside class="md-${container[1]}" role="note">\n${renderMarkdown(body.join("\n"))}\n</aside>`,
      );
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 2;
      const text = heading[2] ?? "";
      html.push(`<h${level} id="${slugify(text)}">${renderInline(text)}</h${level}>`);
      i++;
      continue;
    }

    if (HR.test(line)) {
      html.push("<hr>");
      i++;
      continue;
    }

    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">"))
        body.push((lines[i++] ?? "").replace(/^>\s?/, ""));
      html.push(`<blockquote>\n${renderMarkdown(body.join("\n"))}\n</blockquote>`);
      continue;
    }

    if (line.startsWith("|") && next !== undefined && TABLE_SEP.test(next)) {
      const head = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("|"))
        rows.push(tableCells(lines[i++] ?? ""));
      const th = head.map((c) => `<th scope="col">${renderInline(c)}</th>`).join("");
      const tr = rows
        .map(
          (r) =>
            `<tr>${r.map((c, j) => (j === 0 ? `<th scope="row">${renderInline(c)}</th>` : `<td>${renderInline(c)}</td>`)).join("")}</tr>`,
        )
        .join("\n");
      html.push(
        `<div class="md-table"><table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${tr}\n</tbody>\n</table></div>`,
      );
      continue;
    }

    const ordered = OL_ITEM.test(line);
    if (ordered || UL_ITEM.test(line)) {
      const itemRe = ordered ? OL_ITEM : UL_ITEM;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const m = itemRe.exec(l);
        if (m) items.push(m[1] ?? "");
        else if (/^\s{2,}\S/.test(l) && items.length > 0) items[items.length - 1] += ` ${l.trim()}`;
        else break;
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(
        `<${tag}>\n${items.map((t) => `<li>${renderInline(t)}</li>`).join("\n")}\n</${tag}>`,
      );
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (l.trim() === "" || isBlockStart(l, lines[i + 1])) break;
      para.push(l.trim());
      i++;
    }
    html.push(`<p>${renderInline(para.join(" "))}</p>`);
  }

  return html.join("\n");
}
