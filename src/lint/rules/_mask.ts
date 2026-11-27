export const TEST_FILE = /(?:^|\/)(?:__tests__|__mocks__)\/|\.(?:test|spec)\.[cm]?[tj]sx?$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

export function maskLiterals(source: string): string {
  const out = source.split("");
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        out[index] = " ";
        out[index + 1] = " ";
        index += 1;
        state = "line";
        continue;
      }
      if (char === "/" && next === "*") {
        out[index] = " ";
        out[index + 1] = " ";
        index += 1;
        state = "block";
        continue;
      }
      if (char === "'") {
        out[index] = " ";
        state = "single";
        continue;
      }
      if (char === '"') {
        out[index] = " ";
        state = "double";
        continue;
      }
      if (char === "`") {
        out[index] = " ";
        state = "template";
      }
      continue;
    }
    if (state === "line") {
      if (char === "\n") state = "code";
      else out[index] = " ";
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        out[index] = " ";
        out[index + 1] = " ";
        index += 1;
        state = "code";
        continue;
      }
      out[index] = char === "\n" ? "\n" : " ";
      continue;
    }
    if (char === "\\") {
      out[index] = " ";
      if (index + 1 < source.length) {
        out[index + 1] = source[index + 1] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
    if (char === quote) {
      out[index] = " ";
      state = "code";
      continue;
    }
    out[index] = char === "\n" ? "\n" : " ";
  }
  return out.join("");
}

export function position(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === "\n") {
      line += 1;
      lineStart = cursor + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

export function linePrefix(text: string, index: number): string {
  return text.slice(text.lastIndexOf("\n", index) + 1, index);
}
