// The run's question as a title: the stored question minus the "Preferences:" block the New run
// form appends (app/runs/new/new-run.ts). Display only; the stored question and what the agents
// receive are unchanged.
export function questionTitle(question: string): string {
  const lines = question.split(/\r?\n/);
  const cut = lines.findIndex((l) => /^\s*preferences:/i.test(l));
  return (cut === -1 ? lines : lines.slice(0, cut)).join("\n").trim();
}
