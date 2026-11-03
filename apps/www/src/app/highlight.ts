/**
 * A deliberately small TypeScript/shell highlighter. It runs during SSR like
 * the rest of the template, so the landing ships coloured code without an
 * editor bundle or a client-side highlighter.
 */
export type TokenKind =
  | "plain"
  | "keyword"
  | "string"
  | "comment"
  | "decorator"
  | "type"
  | "function"
  | "number"
  | "punctuation"
  | "property";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

export type CodeLanguage = "ts" | "shell";

const KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "class",
  "const",
  "default",
  "export",
  "extends",
  "false",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "let",
  "new",
  "null",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "this",
  "true",
  "type",
  "undefined",
]);

const SHELL_COMMANDS = new Set(["pnpm", "npm", "npx", "yarn", "bun", "cd"]);

// Order matters: comments and strings must win over everything they contain.
const TS_PATTERN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(@[A-Za-z_$][\w$]*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.<>:=?!|&+*/-]+)/g;

const SHELL_PATTERN = /(#[^\n]*)|("[^"\n]*"|'[^'\n]*')|(@?[\w./@-]+)/g;

export function highlight(code: string, language: CodeLanguage = "ts"): Token[] {
  return language === "shell" ? highlightShell(code) : highlightTs(code);
}

function highlightTs(code: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  for (const match of code.matchAll(TS_PATTERN)) {
    const index = match.index;
    if (index > cursor) push(tokens, "plain", code.slice(cursor, index));
    const [text, comment, string, decorator, number, word] = match;

    if (comment) push(tokens, "comment", text);
    else if (string) push(tokens, "string", text);
    else if (decorator) push(tokens, "decorator", text);
    else if (number) push(tokens, "number", text);
    else if (word) push(tokens, classifyWord(code, index, word), text);
    else push(tokens, "punctuation", text);

    cursor = index + text.length;
  }

  if (cursor < code.length) push(tokens, "plain", code.slice(cursor));
  return tokens;
}

function classifyWord(code: string, index: number, word: string): TokenKind {
  if (KEYWORDS.has(word)) return "keyword";
  const next = code.slice(index + word.length).match(/^\s*(\S)/)?.[1];
  const previous = code[index - 1];
  if (next === "(") return "function";
  if (/^[A-Z]/.test(word)) return "type";
  if (previous === ".") return "property";
  return "plain";
}

function highlightShell(code: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  let commandExpected = true;

  for (const match of code.matchAll(SHELL_PATTERN)) {
    const index = match.index;
    const between = code.slice(cursor, index);
    if (between) {
      push(tokens, "plain", between);
      if (between.includes("\n") || /[;&|]/.test(between)) commandExpected = true;
    }
    const [text, comment, string] = match;

    if (comment) push(tokens, "comment", text);
    else if (string) push(tokens, "string", text);
    else if (commandExpected && SHELL_COMMANDS.has(text)) {
      push(tokens, "function", text);
      commandExpected = false;
    } else if (text.startsWith("-")) push(tokens, "keyword", text);
    else if (text.startsWith("@")) push(tokens, "type", text);
    else {
      push(tokens, "plain", text);
      commandExpected = false;
    }

    cursor = index + text.length;
  }

  if (cursor < code.length) push(tokens, "plain", code.slice(cursor));
  return tokens;
}

function push(tokens: Token[], kind: TokenKind, text: string): void {
  const last = tokens.at(-1);
  // Merge neighbours of the same kind to keep the rendered DOM small.
  if (last && last.kind === kind) {
    tokens[tokens.length - 1] = { kind, text: last.text + text };
    return;
  }
  tokens.push({ kind, text });
}
