import type { Metadata } from "next";
import Link from "next/link";
import styles from "../../../components/blog/blog.module.css";
import { formatPostDate, getPublishedPosts } from "../../../lib/blog/posts";

// Built once at deploy time from apps/web/content/blog/*.md. Drafts are never listed here.
export const dynamic = "force-static";

const DESCRIPTION = "Notes from the team building Anybench: what we measured, and what we learned.";

export function generateMetadata(): Metadata {
  const empty = getPublishedPosts().length === 0;
  return {
    title: "Blog",
    description: DESCRIPTION,
    alternates: { canonical: "/blog" },
    // An empty index is not worth a search result.
    ...(empty ? { robots: { index: false, follow: true } } : {}),
  };
}

export default function BlogIndexPage() {
  const posts = getPublishedPosts();
  return (
    <div className={styles.shell}>
      <h1 className={styles.title}>Blog</h1>
      <p className={styles.lede}>{DESCRIPTION}</p>
      {posts.length === 0 ? (
        <p className={styles.empty}>No posts yet.</p>
      ) : (
        <ol className={styles.list} aria-label="Posts">
          {posts.map((p) => (
            <li key={p.slug} className={styles.item}>
              <time className={styles.itemDate} dateTime={p.date}>
                {formatPostDate(p.date)}
              </time>
              <div>
                <h2 className={styles.itemTitle}>
                  <Link href={`/blog/${p.slug}`}>{p.title}</Link>
                </h2>
                <p className={styles.itemDesc}>{p.description}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
