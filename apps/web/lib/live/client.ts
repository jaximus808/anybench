"use client";
// Which API client the live run page uses. Defaults to the web app's shared client (lib/api.ts:
// the same-origin `/api` proxy in the browser once TDM-100 lands), so the page never names a
// host itself. Tests provide a client over a fake fetch.
import type { ApiClient } from "@anybench/core";
import { createContext, useContext } from "react";
import { api } from "../api";

export const LiveApiContext = createContext<ApiClient | null>(null);

export function useLiveApi(): ApiClient {
  return useContext(LiveApiContext) ?? api();
}
