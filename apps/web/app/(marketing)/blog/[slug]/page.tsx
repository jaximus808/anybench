import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import styles from "../../../../components/blog/blog.module.css";
import { formatPostDate, getAllPosts, getPost } from "../../../../lib/blog/posts";

// Every post, drafts included, is built at deploy time; any other slug is a 404.
export const dynamicParams = false;

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams(): { slug: string }[] {
  return getAllPosts().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = getPost((await params).slug);
  if (!post) return { title: "Post not found", robots: { index: false } };
  const url = `/blog/${post.slug}`;
  return {
    title: post.title,
    description: post.description,
    // A draft is reachable by its URL for review, but search engines are asked to skip it.
    ...(post.draft
      ? { robots: { index: false, follow: false } }
      : { alternates: { canonical: url } }),
    openGraph: {
      type: "article",
      url,
      siteName: "Anybench",
      title: post.title,
      description: post.description,
      publishedTime: post.date,
    },
    twitter: { card: "summary", title: post.title, description: post.description },
  };
}

export default async function BlogPostPage({ params }: Props) {
  const post = getPost((await params).slug);
  if (!post) notFound();
  return (
    <div className={styles.shell}>
      <article>
        {post.draft && (
          <div className={styles.draft} role="note" aria-label="Draft notice">
            <strong>Draft</strong>
            <span>
              This post is not listed on the blog and asks search engines not to index it. Set{" "}
              <code>draft: false</code> in its file to publish it.
            </span>
          </div>
        )}
        <p className={styles.kicker}>
          <Link href="/blog">Blog</Link>
        </p>
        <h1 className={styles.title}>{post.title}</h1>
        <p className={styles.date}>
          <time dateTime={post.date}>{formatPostDate(post.date)}</time>
        </p>
        {/* Our own Markdown, rendered and escaped at build time by lib/blog/markdown.ts. */}
        <div className={styles.body} dangerouslySetInnerHTML={{ __html: post.html }} />
      </article>
    </div>
  );
}
