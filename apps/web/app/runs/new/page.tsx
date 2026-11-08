// New run (Ask screen, TDM-101). The form is a client component; it signs the user in if needed.
import type { Metadata } from "next";
import { NewRunForm } from "./NewRunForm";
import styles from "./new-run.module.css";

export const metadata: Metadata = {
  title: "New run",
  description: "Paste a repo, ask whether it's better, and Anybench designs the test.",
};

export default function NewRunPage() {
  return (
    <main id="main" className={styles.main}>
      <h1 className={styles.title}>New run</h1>
      <p className={styles.lede}>
        Point Anybench at what you built and ask your question. It reads your repo and suggests the
        rest; you check the test plan before Go.
      </p>
      <NewRunForm />
    </main>
  );
}
