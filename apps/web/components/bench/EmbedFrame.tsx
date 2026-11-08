"use client";
// The embed widget's root (TDM-205). It carries the theme and tells the parent page its height
// ({ type: "anybench:height", slug, height }) on mount and on every resize, so the iframe (or
// public/embed.js) sizes it to its content and it never scrolls.
import { useEffect, useRef, type ReactNode } from "react";
import { EMBED_HEIGHT_MESSAGE, type EmbedHeightMessage, type EmbedTheme } from "./embed-model";
import styles from "./Embed.module.css";

export function EmbedFrame({
  slug,
  theme,
  children,
}: {
  slug: string;
  theme: EmbedTheme;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = -1;
    const post = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      const msg: EmbedHeightMessage = { type: EMBED_HEIGHT_MESSAGE, slug, height };
      // The height is not sensitive and the host page is unknown, so any origin may read it.
      window.parent.postMessage(msg, "*");
    };
    post();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", post);
      return () => window.removeEventListener("resize", post);
    }
    const ro = new ResizeObserver(post);
    ro.observe(el);
    return () => ro.disconnect();
  }, [slug]);

  return (
    <div
      ref={ref}
      className={`${styles.root}${theme === "dark" ? " instrument" : ""}`}
      data-theme={theme}
      data-anybench-embed-root=""
    >
      {children}
    </div>
  );
}
