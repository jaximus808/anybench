// New run (Ask screen, TDM-101). The form is a client component; it signs the user in if needed.
import type { Metadata } from "next";
import { NewRunForm } from "./NewRunForm";
import styles from "./new-run.module.css";

export const metadata: Metadata = {
  title: "New run",
  description: "Paste a repo or upload a binary, ask whether it's better, and Anybench tests it.",
};

export default function NewRunPage() {
  return (
    <main id="main" className={styles.main}>
      <h1 className={styles.title}>New run</h1>
      <p className={styles.lede}>
        Paste a repo or upload what you built, ask whether it&rsquo;s better or faster, and name
        anything you want it compared with. Agents design the test; you review it before Go.
      </p>
      <NewRunForm />
    </main>
  );
}
