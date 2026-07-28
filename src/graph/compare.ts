export function compareOpaqueId(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function compareNumberThenId(
  a: { issueNumber: number; id: string },
  b: { issueNumber: number; id: string },
): number {
  return a.issueNumber - b.issueNumber || compareOpaqueId(a.id, b.id);
}
