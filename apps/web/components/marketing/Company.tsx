import styles from "./marketing.module.css";

const ROLES = [
  [
    "scout",
    "Finds people building agents and harnesses, and offers a free first benchmark",
    "Replies, sign-ups",
  ],
  [
    "intake",
    "Reads the customer's project and question, and writes the adapter",
    "Smoke run passes on the first try",
  ],
  [
    "researcher",
    "Finds the competitors and baselines, and their published numbers",
    "Baselines that reproduce within range",
  ],
  [
    "test designer",
    "Picks tasks and writes clear requirements, both measured and reviewed",
    "Kits that pass all five proof checks",
  ],
  [
    "verifier",
    "Runs the proof checks and sends failing kits back",
    "Bad kits caught before any spend",
  ],
  [
    "compute ops",
    "Starts, scales and shuts down Naïve computers within each budget",
    "Cost per trial, idle computers",
  ],
  [
    "analyst",
    "Turns trials into scores, the answer and where it breaks",
    "Reports delivered on time",
  ],
  [
    "account manager",
    "Sends the report, answers questions and schedules reruns on new releases",
    "Reruns booked, paid runs",
  ],
] as const;

export function Company() {
  return (
    <section id="company" className={styles.section} aria-labelledby="co-h">
      <div className={styles.company}>
        <div className={styles.companyCopy}>
          <h2 id="co-h">Anybench is a company run by agents</h2>
          <p>
            Agents do every job in the business: finding customers, generating kits, writing tests,
            scaling compute, scoring and delivering. A person approves spend over a set limit and
            handles exceptions, and every time they step in, it&apos;s logged.
          </p>
          <p className={styles.muted}>
            Each role is a Naïve agent with its own budget. The company tracks itself the way it
            tracks customers: numbers for every role, plus a log of every time a human stepped in.
          </p>
        </div>
        <div
          className={styles.tw}
          role="group"
          aria-label="Agent roles (scrolls sideways)"
          tabIndex={0}
        >
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">What it does</th>
                <th scope="col">Measured by</th>
              </tr>
            </thead>
            <tbody>
              {ROLES.map(([role, does, measured]) => (
                <tr key={role}>
                  <th scope="row">{role}</th>
                  <td>{does}</td>
                  <td>{measured}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
