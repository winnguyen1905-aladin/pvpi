// Console activity-log line for the parties: [timestamp][from][to] - content.
// `from`/`to` are the message direction (e.g. A->B for a broadcast, B->A for a
// gradient); A's internal ops use to=A (aggregate) or to="chain" (anchor).
export function logLine(from: string, to: string, content: string): string {
  return `[${new Date().toISOString()}][${from}][${to}] - ${content}`;
}
