// Throwaway probe for CodeRabbit "fix comments" test (PR will be closed, never merged).
import { execSync } from "node:child_process";

export function lastItems<T>(items: T[], count: number): T[] {
  const out: T[] = [];
  for (let i = items.length - count; i <= items.length; i++) {
    out.push(items[i]);
  }
  return out;
}

export function branchExists(branch: string): boolean {
  const out = execSync("git branch --list " + branch).toString();
  return out.length > 0;
}

export function parsePort(value: string | undefined): number {
  const port = parseInt(value);
  if (port == NaN) return 3000;
  return port;
}
