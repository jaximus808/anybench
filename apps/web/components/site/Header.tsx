"use client";
// Sticky, translucent site header with a mobile menu (TDM-98). Signed-out state only;
// the signed-in variant arrives with the auth UI.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Mark } from "./Mark";
import { NAV_LINKS, SIGN_IN_LINK } from "./nav";
import styles from "./Header.module.css";

export { NAV_LINKS } from "./nav";

export function Header() {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const pathname = usePathname() ?? "/";
  // The landing page and live runs are always dark (screens, not documents); match them.
  const instrument = pathname === "/" || pathname.startsWith("/runs");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const wide = window.matchMedia?.("(min-width: 720px)");
    const onWide = () => wide?.matches && setOpen(false);
    document.addEventListener("keydown", onKey);
    wide?.addEventListener("change", onWide);
    return () => {
      document.removeEventListener("keydown", onKey);
      wide?.removeEventListener("change", onWide);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <header
      className={`${styles.header}${instrument ? " instrument" : ""}`}
      data-open={open || undefined}
    >
      <nav className={`wrap ${styles.bar}`} aria-label="Main">
        <Link href="/" className={styles.brand} onClick={close}>
          <Mark />
          <span>Anybench</span>
        </Link>
        <ul className={styles.links}>
          {NAV_LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className={styles.link}>
                {l.label}
              </Link>
            </li>
          ))}
          <li>
            <Link href={SIGN_IN_LINK.href} className={styles.signin}>
              {SIGN_IN_LINK.label}
            </Link>
          </li>
        </ul>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((o) => !o)}
        >
          <span className={styles.burger} aria-hidden="true" />
          <span className="visually-hidden">{open ? "Close menu" : "Open menu"}</span>
        </button>
      </nav>
      <div id={menuId} className={styles.sheet} hidden={!open}>
        {open ? (
          <ul className="wrap">
            {NAV_LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} onClick={close}>
                  {l.label}
                </Link>
              </li>
            ))}
            <li>
              <Link href={SIGN_IN_LINK.href} onClick={close} className={styles.sheetSignin}>
                {SIGN_IN_LINK.label}
              </Link>
            </li>
          </ul>
        ) : null}
      </div>
    </header>
  );
}
