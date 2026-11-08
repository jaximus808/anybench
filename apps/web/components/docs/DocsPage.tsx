import Link from "next/link";
import type { ReactNode } from "react";
import { DOCS_NAV, type SiteLink } from "./links";
import styles from "./docs.module.css";

/** Left nav shared by /docs and the legal pages. `current` is the route being shown. */
export function SideNav({
  label,
  links,
  current,
}: {
  label: string;
  links: readonly SiteLink[];
  current: string;
}) {
  return (
    <nav className={styles.sideNav} aria-label={label}>
      <p className={styles.sideNavTitle}>{label}</p>
      <ul>
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} aria-current={l.href === current ? "page" : undefined}>
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function DocsNav({ current }: { current: string }) {
  return <SideNav label="Docs" links={DOCS_NAV} current={current} />;
}

export interface DocsPageProps {
  path: string;
  title: string;
  lede: ReactNode;
  children: ReactNode;
}

/** Shared frame for every /docs page: left nav, title, lede, then the page body. */
export function DocsPage({ path, title, lede, children }: DocsPageProps) {
  const i = DOCS_NAV.findIndex((l) => l.href === path);
  const next = i >= 0 ? DOCS_NAV[i + 1] : undefined;
  return (
    <div className={styles.shell}>
      <DocsNav current={path} />
      <article className={styles.prose}>
        <h1>{title}</h1>
        <p className={styles.lede}>{lede}</p>
        {children}
        {next && (
          <p className={styles.next}>
            Next: <Link href={next.href}>{next.label}</Link>
          </p>
        )}
      </article>
    </div>
  );
}
