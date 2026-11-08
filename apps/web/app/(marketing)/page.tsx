// Placeholder home page (TDM-98). TDM-99 [11.2] replaces this file with the landing page.
export default function HomePage() {
  return (
    <section className="wrap" style={{ paddingBlock: "var(--space-9)" }}>
      <h1 style={{ fontSize: "var(--text-3xl)", maxWidth: "13ch" }}>
        Find out if what you built is actually better.
      </h1>
      <p className="lede muted" style={{ marginTop: "var(--space-5)" }}>
        Point Anybench at any project: an agent, a harness, or any other software.
      </p>
    </section>
  );
}
