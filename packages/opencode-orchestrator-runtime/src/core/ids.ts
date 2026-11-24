// Pure, deterministic identifiers. Not cryptographic: they only need to be stable
// across restarts and distinct between tasks, attempts and intents.

function cyrb53(text: string, seed: number): number {
  let first = 0xdeadbeef ^ seed;
  let second = 0x41c6ce57 ^ seed;

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }

  first = Math.imul(first ^ (first >>> 16), 2246822507);
  first ^= Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507);
  second ^= Math.imul(first ^ (first >>> 13), 3266489909);

  return 4294967296 * (2097151 & second) + (first >>> 0);
}

export function hashText(text: string): string {
  return [1, 2].map((seed) => cyrb53(text, seed).toString(36).padStart(11, "0")).join("");
}

export function deriveId(prefix: "ses_" | "msg_", ...parts: readonly string[]): string {
  return `${prefix}oo${hashText(parts.join("\u0000"))}`;
}

export function deriveTaskId(salt: string, commandID: string): string {
  return `t${hashText(`${salt}\u0000${commandID}`).slice(0, 7)}`;
}
