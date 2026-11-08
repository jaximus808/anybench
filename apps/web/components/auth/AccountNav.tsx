"use client";
// The header's account items (TDM-100): Sign in + Sign up when signed out; the user (to
// /settings), New run and Sign out when signed in. Renders <li>s so the header owns the layout.
import Link from "next/link";
import { NEW_RUN_LINK, RUNS_LINK, SETTINGS_LINK, SIGN_IN_LINK, SIGN_UP_LINK } from "../site/nav";
import { signOut, useSession } from "../../lib/session";

export interface AccountNavProps {
  /** Class for secondary items (Sign in, the user, Sign out). */
  linkClassName?: string | undefined;
  /** Class for the primary item (Sign up, New run). */
  primaryClassName?: string | undefined;
  /** Called after any item is used (closes the mobile menu). */
  onNavigate?: () => void;
}

export function AccountNav({ linkClassName, primaryClassName, onNavigate }: AccountNavProps) {
  const session = useSession();

  if (session.status === "signed_in")
    return (
      <>
        <li>
          <Link
            href={SETTINGS_LINK.href}
            className={linkClassName}
            onClick={onNavigate}
            title={SETTINGS_LINK.label}
          >
            {session.user.github_login}
          </Link>
        </li>
        <li>
          <Link href={RUNS_LINK.href} className={linkClassName} onClick={onNavigate}>
            {RUNS_LINK.label}
          </Link>
        </li>
        <li>
          <Link href={NEW_RUN_LINK.href} className={primaryClassName} onClick={onNavigate}>
            {NEW_RUN_LINK.label}
          </Link>
        </li>
        <li>
          <button
            type="button"
            className={linkClassName}
            onClick={async () => {
              onNavigate?.();
              await signOut().catch(() => undefined);
              window.location.assign("/");
            }}
          >
            Sign out
          </button>
        </li>
      </>
    );

  return (
    <>
      <li>
        <Link href={SIGN_IN_LINK.href} className={linkClassName} onClick={onNavigate}>
          {SIGN_IN_LINK.label}
        </Link>
      </li>
      <li>
        <Link href={SIGN_UP_LINK.href} className={primaryClassName} onClick={onNavigate}>
          {SIGN_UP_LINK.label}
        </Link>
      </li>
    </>
  );
}
