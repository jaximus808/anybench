// Your runs (TDM-101): newest first, each linking to its live page.
import type { Metadata } from "next";
import Link from "next/link";
import { RunsList } from "./RunsList";
import styles from "./new/new-run.module.css";

export const metadata: Metadata = {
  title: "Runs",
  description: "Your Anybench runs.",
};

export default function RunsPage() {
  return (
    <main id="main" className={styles.main}>
      <div className={styles.head}>
        <h1 className={styles.title}>Runs</h1>
        <Link href="/runs/new" className="btn">
          New run
        </Link>
      </div>
      <RunsList />
    </main>
  );
}
