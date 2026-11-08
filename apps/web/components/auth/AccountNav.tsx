"use client";
// The header's account items (TDM-100): Sign in + Sign up when signed out; the user (to
// My runs, New run and the account (avatar + login, to /settings, where Sign out lives) when signed in. Renders <li>s so the header owns the layout.
import Link from "next/link";
import { NEW_RUN_LINK, RUNS_LINK, SETTINGS_LINK, SIGN_IN_LINK, SIGN_UP_LINK } from "../site/nav";
import { useSession } from "../../lib/session";

export interface AccountNavProps {
  /** Class for secondary items (Sign in, the user, Sign out). */
  linkClassName?: string | undefined;
  /** Class for the primary item (Sign up, New run). */
  primaryClassName?: string | undefined;
  /** Class for the secondary button (My runs). */
  buttonClassName?: string | undefined;
  /** Class for the account item (avatar + login, links to /settings). */
  userClassName?: string | undefined;
  /** Called after any item is used (closes the mobile menu). */
  onNavigate?: () => void;
}

export function AccountNav({
  linkClassName,
  primaryClassName,
  buttonClassName,
  userClassName,
  onNavigate,
}: AccountNavProps) {
  const session = useSession();

  if (session.status === "signed_in")
    return (
      <>
        <li>
          <Link
            href={RUNS_LINK.href}
            className={buttonClassName ?? linkClassName}
            onClick={onNavigate}
          >
            {RUNS_LINK.label}
          </Link>
        </li>
        <li>
          <Link href={NEW_RUN_LINK.href} className={primaryClassName} onClick={onNavigate}>
            {NEW_RUN_LINK.label}
          </Link>
        </li>
        <li>
          {/* The account: settings, billing and Sign out live on /settings. */}
          <Link
            href={SETTINGS_LINK.href}
            className={userClassName ?? linkClassName}
            onClick={onNavigate}
            title="Account settings"
          >
            <span aria-hidden="true" data-slot="avatar">
              {session.user.github_login.slice(0, 1).toUpperCase()}
            </span>
            {session.user.github_login}
          </Link>
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
