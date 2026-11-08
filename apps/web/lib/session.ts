"use client";
// Who is signed in, shared by the header, /signin, /signup and /settings (TDM-100). One
// GET /auth/me per page load; every component subscribes to the same result.
import type { ApiClient, User, UserSettings } from "@anybench/core";
import { ApiClientError } from "@anybench/core";
import { useSyncExternalStore } from "react";
import { api, apiErrorMessage, isUnreachable } from "./api";

export type SessionState =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "signed_in"; user: User; settings: UserSettings }
  /** The API could not be reached or answered with an error other than 401. */
  | { status: "error"; unreachable: boolean; message: string };

const LOADING: SessionState = { status: "loading" };

let state: SessionState = LOADING;
let inflight: Promise<void> | undefined;
const listeners = new Set<() => void>();

function set(next: SessionState): void {
  state = next;
  for (const l of listeners) l();
}

/** Fetch /auth/me (once, unless `force`). */
export function loadSession(force = false): Promise<void> {
  if (inflight && !force) return inflight;
  inflight = api()
    .auth.me()
    .then(
      ({ user, settings }) => set({ status: "signed_in", user, settings }),
      (err: unknown) => {
        if (err instanceof ApiClientError && err.status === 401) set({ status: "signed_out" });
        else
          set({ status: "error", unreachable: isUnreachable(err), message: apiErrorMessage(err) });
      },
    );
  return inflight;
}

/** PATCH the signed-in user's settings, then share the saved values with every subscriber. */
export async function saveSettings(
  patch: Partial<UserSettings>,
  client: ApiClient = api(),
): Promise<UserSettings> {
  const settings = await client.auth.updateSettings({ body: patch });
  if (state.status === "signed_in") set({ ...state, settings });
  return settings;
}

/** Revoke the session on the API, then forget it locally (even if the API call failed). */
export async function signOut(): Promise<void> {
  try {
    await api().auth.logout();
  } catch (err) {
    // 401 = already signed out; anything else is reported but the local state still clears.
    if (!(err instanceof ApiClientError && err.status === 401)) {
      set({ status: "signed_out" });
      throw err;
    }
  }
  set({ status: "signed_out" });
}

/** Test hook: back to "loading" with no cached request. */
export function resetSessionForTests(): void {
  inflight = undefined;
  state = LOADING;
  listeners.clear();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void loadSession();
  return () => listeners.delete(listener);
}

export function useSession(): SessionState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => LOADING,
  );
}
