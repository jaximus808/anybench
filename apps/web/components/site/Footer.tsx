// Site footer (TDM-98): brand, product and legal links. The legal pages land in TDM-106.
import Link from "next/link";
import { Mark } from "./Mark";
import { LEGAL_LINKS, NAV_LINKS, type NavLink } from "./nav";
import styles from "./Footer.module.css";

export { LEGAL_LINKS as FOOTER_LINKS } from "./nav";

function LinkGroup({ title, links }: { title: string; links: readonly NavLink[] }) {
  return (
    <nav aria-label={title} className={styles.group}>
      <h2 className={styles.groupTitle}>{title}</h2>
      <ul>
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href}>{l.label}</Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={`wrap ${styles.grid}`}>
        <div className={styles.about}>
          <Link href="/" className={styles.brand}>
            <Mark size={22} />
            <span>Anybench</span>
          </Link>
          <p>
            Benchmarks for anything you build. Every speed or quality number passes a correctness
            check first.
          </p>
        </div>
        <LinkGroup title="Product" links={NAV_LINKS} />
        <LinkGroup title="Legal" links={LEGAL_LINKS} />
      </div>
      <div className={`wrap ${styles.base}`}>
        <span>© {new Date().getFullYear()} Anybench</span>
        <span>Trials run on Naïve cloud computers.</span>
      </div>
    </footer>
  );
}
