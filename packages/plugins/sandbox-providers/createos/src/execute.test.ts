import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./execute.js";

/**
 * `shellQuote` wraps a value in single quotes and, for each embedded single
 * quote, emits `'"'"'`: close the single-quoted span, open a double-quoted
 * span holding a literal `'`, close the double-quoted span, then reopen the
 * single-quoted span. This is a valid alternative to the more common
 * `'\''` (backslash-escaped quote) pattern, and it is POSIX-shell safe: a
 * single-quoted span treats every other character literally, so nothing
 * inside it — `"`, `` ` ``, `$`, `\`, newlines, spaces — is reinterpreted.
 *
 * Besides checking the literal output, these tests round-trip each quoted
 * value through a real `bash -c "printf '%s' <quoted>"` to confirm the
 * shell reconstructs the original string with no injection side effects.
 */
describe("shellQuote", () => {
  it("wraps a plain alphanumeric string in single quotes", () => {
    expect(shellQuote("plain123")).toBe("'plain123'");
  });

  it("wraps the empty string in a pair of single quotes", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("escapes a single embedded single quote", () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });

  it("escapes multiple embedded single quotes, including adjacent ones", () => {
    expect(shellQuote("''''")).toBe(`''"'"''"'"''"'"''"'"''`);
  });

  it("escapes a leading single quote", () => {
    expect(shellQuote("'a")).toBe(`''"'"'a'`);
  });

  it("escapes a trailing single quote", () => {
    expect(shellQuote("a'")).toBe(`'a'"'"''`);
  });

  it("does not interpret double quotes, backticks, dollar signs, or backslashes", () => {
    const value = `a'b"c\`d$e\\f`;
    expect(shellQuote(value)).toBe(`'a'"'"'b"c\`d$e\\f'`);
  });

  it("rejects a value containing a NUL byte", () => {
    expect(() => shellQuote("a\0b")).toThrow("Sandbox command values cannot contain NUL.");
  });

  describe("round-tripped through a real shell", () => {
    const cases: Array<[string, string]> = [
      ["plain alphanumeric", "hello"],
      ["single embedded quote", "it's"],
      ["only quotes", "''''"],
      ["empty string", ""],
      ["mixed special characters", "a'b\"c`d$e\\f"],
      ["quote followed by shell metacharacters", "' ; rm -rf / #"],
      ["quote-terminated injection attempt", "''; echo pwned; '"],
      ["command substitution syntax", "$(echo pwned)"],
      ["backtick command substitution syntax", "`echo pwned`"],
      ["embedded newline", "a\nb"],
      ["leading and trailing whitespace", "   spaced   "],
    ];

    it.each(cases)("reconstructs the original value for: %s", (_label, value) => {
      const quoted = shellQuote(value);
      const output = execFileSync("bash", ["-c", `printf '%s' ${quoted}`], { encoding: "utf8" });
      expect(output).toBe(value);
    });

    it("never executes shell metacharacters or command substitution embedded in the value", () => {
      const dangerous = ["$(touch /tmp/paperclip-shellquote-pwn-test)", "`touch /tmp/paperclip-shellquote-pwn-test`", "'; touch /tmp/paperclip-shellquote-pwn-test; '"];
      for (const value of dangerous) {
        const quoted = shellQuote(value);
        execFileSync("bash", ["-c", `printf '%s' ${quoted} > /dev/null`], { encoding: "utf8" });
      }
      expect(() => execFileSync("test", ["-e", "/tmp/paperclip-shellquote-pwn-test"])).toThrow();
    });
  });
});
