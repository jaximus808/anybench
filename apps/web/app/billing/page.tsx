// Billing (stripe-onboarding): add a card after sign-up, see usage, start a run that waits on it.
import type { Metadata } from "next";
import { BillingView } from "./BillingView";

export const metadata: Metadata = {
  title: "Billing",
  description: "Add a card, see this month's usage and manage invoices.",
  robots: { index: false },
};

export default function BillingPage() {
  return <BillingView />;
}
