const ANSI_OSC = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu;
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const INLINE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu;

export function sanitizeInlineText(value: string): string {
  return value
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(INLINE_CONTROL, " ")
    .replace(/ +/gu, " ")
    .trim();
}
