import { ClaudeCodeSession } from "./ClaudeCodeSession";
import { Company } from "./Company";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import styles from "./marketing.module.css";
import { Pricing } from "./Pricing";
import { ProductTour } from "./ProductTour";
import { ProjectKinds } from "./ProjectKinds";
import { ScanExample } from "./ScanExample";
import { Velocitty } from "./Velocitty";
import { WhyDifferent } from "./WhyDifferent";

/** The marketing landing page at `/` (TDM-99). Static: no API calls. */
export function LandingPage() {
  return (
    <div className={styles.page}>
      <Hero />
      <HowItWorks />
      <ProjectKinds />
      <ProductTour />
      <Velocitty />
      <ClaudeCodeSession />
      <ScanExample />
      <WhyDifferent />
      <Pricing />
      <Company />
    </div>
  );
}
