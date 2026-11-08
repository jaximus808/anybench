// Settings (TDM-100): account, API keys, BYOK model keys, sign out.
import type { Metadata } from "next";
import { SettingsView } from "./SettingsView";

export const metadata: Metadata = {
  title: "Settings",
  description: "Manage your Anybench API keys and model provider keys.",
};

export default function SettingsPage() {
  return <SettingsView />;
}
