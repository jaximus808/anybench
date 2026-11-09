// Onboarding after sign-up (TDM-224, E20): the first benchmark is free with your own model key, so
// the card is optional. Sign-up lands here (lib/api.ts POST_SIGN_UP_PATH) and goes on to /runs/new.
import type { Metadata } from "next";
import { WelcomeView } from "./WelcomeView";

export const metadata: Metadata = {
  title: "Welcome",
  description:
    "Add your model key and start your first benchmark. No card needed for the first one.",
  robots: { index: false },
};

export default function WelcomePage() {
  return <WelcomeView />;
}
