/** Join class names, dropping falsy parts. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts
    .filter((part) => part !== false && part !== null && part !== undefined && part !== "")
    .join(" ");
}
