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
import { WatchLive } from "./WatchLive";
import { WhyDifferent } from "./WhyDifferent";

/**
 * The marketing landing page at `/` (TDM-99, redesigned). Always dark (.instrument), like the
 * run page it shows. Static: the hero figure is a labelled example, and the trial-field canvas
 * behind it is decorative. No network calls.
 */
export function LandingPage() {
  return (
    <div className={`instrument ${styles.landing}`}>
      <Hero />
      <div className={styles.page}>
        <HowItWorks />
        <Velocitty />
        <WatchLive />
        <ProductTour />
        <ProjectKinds />
        <ClaudeCodeSession />
        <ScanExample />
        <WhyDifferent />
        <Pricing />
        <Company />
      </div>
    </div>
  );
}
