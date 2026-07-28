export function compareOpaqueId(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function compareUnicodeCodePoints(a: string, b: string): number {
  const aPoints = Array.from(a, (value) => value.codePointAt(0)!);
  const bPoints = Array.from(b, (value) => value.codePointAt(0)!);
  const length = Math.min(aPoints.length, bPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = aPoints[index]! - bPoints[index]!;
    if (difference !== 0) return difference;
  }
  return aPoints.length - bPoints.length;
}

export function compareNumberThenId(
  a: { issueNumber: number; id: string },
  b: { issueNumber: number; id: string },
): number {
  return a.issueNumber - b.issueNumber || compareOpaqueId(a.id, b.id);
}
