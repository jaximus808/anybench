// Sign in (TDM-100). GitHub now; the email form ([17.2]) slots into AuthPanel.
import type { Metadata } from "next";
import { AuthPanel } from "../../components/auth/AuthPanel";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Anybench with GitHub to run benchmarks and read your reports.",
};

export default function SignInPage() {
  return <AuthPanel mode="signin" />;
}
