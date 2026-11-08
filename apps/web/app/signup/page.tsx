// Sign up (TDM-100). Open to anyone: the first GitHub sign-in creates the account.
import type { Metadata } from "next";
import { AuthPanel } from "../../components/auth/AuthPanel";

export const metadata: Metadata = {
  title: "Sign up",
  description: "Create an Anybench account with GitHub and run your first benchmark.",
};

export default function SignUpPage() {
  return <AuthPanel mode="signup" />;
}
