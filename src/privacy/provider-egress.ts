import { createHash } from "node:crypto";
import { basename } from "node:path";
import { canonicalizeToolInput } from "../lib/canonicalize.js";
import { isRecord } from "../lib/type-guards.js";
import type { HookPayload } from "../types.js";

export type EgressDecision = "allow" | "deny" | "ambiguous";

export type EgressSkipReason =
  | "none"
  | "egress_ambiguous"
  | `egress_denied:${
      | "browser"
      | "credential"
      | "database"
      | "external_service"
      | "infrastructure"
      | "messaging"
      | "network"}`;

export interface ProviderEventSummary {
  toolName: string | null;
  eventKind: "precompact" | "tool";
  outcome: "failure" | "not_applicable" | "success" | "unknown";
  commandCount: number;
  executables: string[];
  gitOperations: string[];
  hasPipeline: boolean;
  hasCompoundCommand: boolean;
  hasNestedShell: boolean;
  hasCommandSubstitution: boolean;
}

export interface ProviderEgressPreflight {
  decision: EgressDecision;
  skipReason: EgressSkipReason;
  summary: ProviderEventSummary;
  /** Content-free digest used for repeat detection; raw tool input is never persisted. */
  inputFingerprint: string | null;
}

type DeniedCategory = Exclude<EgressSkipReason, "none" | "egress_ambiguous"> extends `egress_denied:${infer C}`
  ? C
  : never;

interface ScanState {
  decision: EgressDecision;
  deniedCategory: DeniedCategory | null;
  executables: Set<string>;
  gitOperations: Set<string>;
  commandCount: number;
  hasPipeline: boolean;
  hasCompoundCommand: boolean;
  hasNestedShell: boolean;
  hasCommandSubstitution: boolean;
}

interface LexResult {
  words: string[];
  segments: string[][];
  hasPipeline: boolean;
  hasCompoundCommand: boolean;
  ambiguous: boolean;
}

const SHELL_TOOL_NAMES = new Set([
  "bash",
  "exec",
  "exec_command",
  "shell",
  "sh",
  "terminal",
  "unified_exec",
  "zsh",
]);

const SAFE_DIRECT_TOOL_NAMES = new Set([
  "apply_patch",
  "edit",
  "glob",
  "grep",
  "read",
  "view_image",
  "write",
]);

const SAFE_LOCAL_EXECUTABLES = new Set([
  "[",
  "basename",
  "cat",
  "cd",
  "chmod",
  "cmp",
  "comm",
  "cp",
  "cut",
  "date",
  "dirname",
  "du",
  "echo",
  "false",
  "file",
  "head",
  "id",
  "join",
  "jq",
  "ls",
  "md5",
  "mkdir",
  "mktemp",
  "mv",
  "paste",
  "printf",
  "pwd",
  "read",
  "readlink",
  "realpath",
  "rg",
  "rm",
  "rmdir",
  "shasum",
  "sort",
  "stat",
  "tail",
  "tee",
  "test",
  "touch",
  "tr",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
]);

const DENIED_EXECUTABLES: Readonly<Record<string, DeniedCategory>> = {
  az: "infrastructure",
  ansible: "infrastructure",
  aws: "infrastructure",
  chrome: "browser",
  "chrome-devtools-axi": "browser",
  chromium: "browser",
  discord: "messaging",
  curl: "network",
  docker: "infrastructure",
  gcloud: "infrastructure",
  gh: "external_service",
  "gh-axi": "external_service",
  glab: "external_service",
  helm: "infrastructure",
  http: "network",
  https: "network",
  kubectl: "infrastructure",
  jira: "external_service",
  linear: "messaging",
  mysql: "database",
  mongosh: "database",
  nc: "network",
  netcat: "network",
  notion: "external_service",
  "notion-axi": "external_service",
  ntn: "external_service",
  op: "credential",
  pass: "credential",
  open: "browser",
  osascript: "browser",
  playwright: "browser",
  podman: "infrastructure",
  psql: "database",
  "redis-cli": "database",
  rsync: "network",
  railway: "infrastructure",
  scp: "network",
  security: "credential",
  sftp: "network",
  slack: "messaging",
  ssh: "network",
  socat: "network",
  sqlite3: "database",
  teams: "messaging",
  terraform: "infrastructure",
  vault: "credential",
  wget: "network",
  "xdg-open": "browser",
  xdg_open: "browser",
};

const NETWORK_GIT_OPERATIONS = new Set([
  "archive",
  "clone",
  "fetch",
  "ls-remote",
  "pull",
  "push",
  "remote",
  "send-email",
  "svn",
  "p4",
]);

const LOCAL_GIT_OPERATIONS = new Set([
  "add",
  "bisect",
  "blame",
  "branch",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "config",
  "describe",
  "diff",
  "diff-tree",
  "for-each-ref",
  "gc",
  "grep",
  "log",
  "merge",
  "merge-base",
  "mv",
  "rebase",
  "reflog",
  "reset",
  "restore",
  "rev-list",
  "rev-parse",
  "rm",
  "show",
  "show-ref",
  "stash",
  "status",
  "switch",
  "tag",
  "worktree",
]);

const PACKAGE_MANAGER_NETWORK_OPERATIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  bun: new Set(["add", "install", "publish", "update", "x"]),
  npm: new Set(["ci", "exec", "install", "login", "logout", "owner", "ping", "profile", "publish", "search", "star", "team", "unpublish", "update", "view"]),
  npx: new Set(["*"]),
  pip: new Set(["download", "index", "install", "search", "uninstall"]),
  pip3: new Set(["download", "index", "install", "search", "uninstall"]),
  pnpm: new Set(["add", "dlx", "fetch", "install", "publish", "update"]),
  yarn: new Set(["add", "dlx", "install", "npm", "publish", "up"]),
};

function normalizeExecutable(raw: string): string {
  const withoutTrailingSlash = raw.replace(/\/+$/, "");
  return basename(withoutTrailingSlash).toLowerCase();
}

function mergeDecision(state: ScanState, decision: EgressDecision, category: DeniedCategory | null = null): void {
  if (decision === "deny") {
    state.decision = "deny";
    state.deniedCategory ??= category;
  } else if (decision === "ambiguous" && state.decision === "allow") {
    state.decision = "ambiguous";
  }
}

function isEnvironmentAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function lexShell(command: string): LexResult {
  const segments: string[][] = [[]];
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let ambiguous = false;
  let hasPipeline = false;
  let hasCompoundCommand = false;

  const pushWord = (): void => {
    if (current === "") return;
    words.push(current);
    segments[segments.length - 1]?.push(current);
    current = "";
  };

  const pushSegment = (): void => {
    pushWord();
    if ((segments[segments.length - 1]?.length ?? 0) > 0) segments.push([]);
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (ch === "\n") {
        hasCompoundCommand = true;
        pushSegment();
      } else {
        pushWord();
      }
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|") {
      const next = command[i + 1];
      if (ch === "|") hasPipeline = true;
      if (ch !== "|" || next === "|") hasCompoundCommand = true;
      pushSegment();
      if (next === ch) i += 1;
      continue;
    }
    if (ch === "<" || ch === ">") {
      pushWord();
      if (command[i + 1] === ch) {
        // Here-documents can contain arbitrary shell and are intentionally
        // outside this dependency-free parser's trusted grammar.
        ambiguous = true;
        i += 1;
      }
      continue;
    }
    current += ch;
  }
  pushWord();
  if (quote !== null || escaped) ambiguous = true;
  return {
    words,
    segments: segments.filter((segment) => segment.length > 0),
    hasPipeline,
    hasCompoundCommand,
    ambiguous,
  };
}

function extractCommandSubstitutions(command: string): { commands: string[]; ambiguous: boolean; found: boolean } {
  const commands: string[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let found = false;
  let ambiguous = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (ch === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (ch === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote === "'") continue;

    if (ch === "`") {
      found = true;
      let end = i + 1;
      while (end < command.length && command[end] !== "`") end += 1;
      if (end >= command.length) {
        ambiguous = true;
        break;
      }
      commands.push(command.slice(i + 1, end));
      i = end;
      continue;
    }

    if ((ch === "$" || ch === "<" || ch === ">") && command[i + 1] === "(") {
      found = true;
      let depth = 1;
      let nestedQuote: "'" | '"' | null = null;
      let nestedEscaped = false;
      let end = i + 2;
      for (; end < command.length; end++) {
        const inner = command[end] as string;
        if (nestedEscaped) {
          nestedEscaped = false;
          continue;
        }
        if (inner === "\\" && nestedQuote !== "'") {
          nestedEscaped = true;
          continue;
        }
        if ((inner === "'" || inner === '"') && (nestedQuote === null || nestedQuote === inner)) {
          nestedQuote = nestedQuote === inner ? null : inner;
          continue;
        }
        if (nestedQuote) continue;
        if (inner === "(") depth += 1;
        if (inner === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) {
        ambiguous = true;
        break;
      }
      commands.push(command.slice(i + 2, end));
      i = end;
    }
  }
  return { commands, ambiguous, found };
}

function nextCommandIndex(words: string[], start: number, wrapper: string): number | null {
  let index = start;
  const valueOptions = wrapper === "sudo"
    ? new Set(["-C", "-D", "-g", "-h", "-p", "-R", "-T", "-u", "--chdir", "--group", "--host", "--prompt", "--role", "--type", "--user"])
    : wrapper === "env"
      ? new Set(["-C", "-S", "-u", "--chdir", "--split-string", "--unset"])
      : wrapper === "xargs"
        ? new Set(["-E", "-I", "-L", "-P", "-a", "-e", "-i", "-l", "-n", "-s", "--arg-file", "--eof", "--max-args", "--max-chars", "--max-lines", "--max-procs", "--replace"])
    : wrapper === "timeout"
      ? new Set(["-k", "-s", "--kill-after", "--signal"])
      : wrapper === "nice"
        ? new Set(["-n", "--adjustment"])
        : new Set<string>();

  while (index < words.length) {
    const word = words[index] as string;
    if (isEnvironmentAssignment(word)) {
      index += 1;
      continue;
    }
    if (word === "--") return index + 1 < words.length ? index + 1 : null;
    if (word.startsWith("-")) {
      if (valueOptions.has(word)) index += 2;
      else index += 1;
      continue;
    }
    return index;
  }
  return null;
}

function gitOperation(words: string[]): string | null {
  let index = 1;
  while (index < words.length) {
    const word = words[index] as string;
    if (word === "-C" || word === "-c" || word === "--git-dir" || word === "--work-tree" || word === "--namespace") {
      index += 2;
      continue;
    }
    if (word.startsWith("-")) {
      index += 1;
      continue;
    }
    return word.toLowerCase();
  }
  return null;
}

function classifyExecutable(words: string[], state: ScanState, depth: number): void {
  let index = 0;
  while (index < words.length && isEnvironmentAssignment(words[index] as string)) index += 1;
  if (index >= words.length) return;

  const rawExecutable = words[index] as string;
  if (/[${}]/.test(rawExecutable) || rawExecutable.includes("(")) {
    mergeDecision(state, "ambiguous");
    return;
  }

  const executable = normalizeExecutable(rawExecutable);
  state.executables.add(executable);
  state.commandCount += 1;

  const denied = DENIED_EXECUTABLES[executable];
  if (denied) {
    mergeDecision(state, "deny", denied);
    return;
  }

  if (executable === "git") {
    const op = gitOperation(words.slice(index));
    if (!op) {
      mergeDecision(state, "ambiguous");
      return;
    }
    state.gitOperations.add(op);
    if (NETWORK_GIT_OPERATIONS.has(op) || op === "credential") {
      mergeDecision(state, "deny", op === "credential" ? "credential" : "network");
      return;
    }
    if (op === "submodule") {
      const subOp = words.slice(index + 2).find((word) => !word.startsWith("-"))?.toLowerCase();
      if (subOp !== "status") mergeDecision(state, "deny", "network");
      return;
    }
    if (op === "lfs") {
      mergeDecision(state, "deny", "network");
      return;
    }
    if (!LOCAL_GIT_OPERATIONS.has(op)) mergeDecision(state, "ambiguous");
    return;
  }

  const packageNetworkOps = PACKAGE_MANAGER_NETWORK_OPERATIONS[executable];
  if (packageNetworkOps) {
    const op = words.slice(index + 1).find((word) => !word.startsWith("-"))?.toLowerCase() ?? "";
    if (packageNetworkOps.has("*") || packageNetworkOps.has(op)) mergeDecision(state, "deny", "network");
    else mergeDecision(state, "ambiguous");
    return;
  }

  if (["bash", "sh", "zsh"].includes(executable)) {
    state.hasNestedShell = true;
    const shellArgs = words.slice(index + 1);
    const cIndex = shellArgs.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
    if (cIndex < 0 || cIndex + 1 >= shellArgs.length || depth >= 8) {
      mergeDecision(state, "ambiguous");
      return;
    }
    scanShell(shellArgs[cIndex + 1] as string, state, depth + 1);
    return;
  }

  if (["env", "sudo", "command", "exec", "nice", "nohup", "time", "timeout", "watch"].includes(executable)) {
    if (executable === "command" && ["-v", "-V"].includes(words[index + 1] ?? "")) return;
    const nestedIndex = nextCommandIndex(words, index + 1, executable);
    if (nestedIndex === null) {
      mergeDecision(state, "ambiguous");
      return;
    }
    classifyExecutable(words.slice(nestedIndex), state, depth + 1);
    return;
  }

  if (executable === "xargs") {
    const nestedIndex = nextCommandIndex(words, index + 1, executable);
    if (nestedIndex === null) {
      mergeDecision(state, "ambiguous");
      return;
    }
    classifyExecutable(words.slice(nestedIndex), state, depth + 1);
    return;
  }

  if (executable === "find") {
    const execIndex = words.findIndex((word, i) => i > index && ["-exec", "-execdir", "-ok", "-okdir"].includes(word));
    if (execIndex >= 0) {
      if (execIndex + 1 >= words.length) mergeDecision(state, "ambiguous");
      else classifyExecutable(words.slice(execIndex + 1).filter((word) => word !== "{}" && word !== ";" && word !== "+"), state, depth + 1);
      return;
    }
  }

  if (executable === "rg") {
    const preIndex = words.findIndex((word, i) => i > index && (word === "--pre" || word.startsWith("--pre=")));
    if (preIndex >= 0) {
      const value = (words[preIndex] as string).startsWith("--pre=")
        ? (words[preIndex] as string).slice("--pre=".length)
        : words[preIndex + 1];
      if (value) scanShell(value, state, depth + 1);
      else mergeDecision(state, "ambiguous");
      return;
    }
  }

  if (["eval", "source", "."].includes(executable)) {
    mergeDecision(state, "ambiguous");
    return;
  }

  if (!SAFE_LOCAL_EXECUTABLES.has(executable) && executable !== "find") {
    mergeDecision(state, "ambiguous");
  }
}

function scanShell(command: string, state: ScanState, depth = 0): void {
  if (depth > 8) {
    mergeDecision(state, "ambiguous");
    return;
  }
  const substitutions = extractCommandSubstitutions(command);
  if (substitutions.found) state.hasCommandSubstitution = true;
  if (substitutions.ambiguous) mergeDecision(state, "ambiguous");
  for (const nested of substitutions.commands) scanShell(nested, state, depth + 1);

  const lexed = lexShell(command);
  state.hasPipeline ||= lexed.hasPipeline;
  state.hasCompoundCommand ||= lexed.hasCompoundCommand;
  if (lexed.ambiguous) mergeDecision(state, "ambiguous");
  for (const segment of lexed.segments) classifyExecutable(segment, state, depth);
}

function directToolCategory(toolName: string): DeniedCategory | null {
  const lower = toolName.toLowerCase();
  if (/slack|teams|discord|message/.test(lower)) return "messaging";
  if (/linear/.test(lower)) return "messaging";
  if (/notion|github|railway|atlassian|jira|gmail|outlook|calendar|drive|box|sharepoint/.test(lower)) return "external_service";
  if (/browser|chrome|playwright|web(search)?/.test(lower)) return "browser";
  if (/credential|secret|vault|keychain/.test(lower)) return "credential";
  if (/postgres|psql|mysql|database|redis|sqlite/.test(lower)) return "database";
  if (/docker|kube|aws|gcloud|azure|\baz\b/.test(lower)) return "infrastructure";
  if (/ssh|curl|wget|http|network/.test(lower)) return "network";
  return null;
}

function outcomeFor(payload: HookPayload): ProviderEventSummary["outcome"] {
  if (payload.hook_event_name === "PreCompact") return "not_applicable";
  if (payload.hook_event_name === "PostToolUseFailure") return "failure";
  return payload.tool_failed ? "failure" : "success";
}

function fingerprint(summary: ProviderEventSummary): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(summary)).digest("hex")}`;
}

function commandFingerprint(command: string): string {
  // Whitespace-only retries remain identical, while command text and secrets
  // are irreversibly reduced before persistence.
  const normalized = command.trim().replace(/\s+/g, " ");
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

function toolInputFingerprint(input: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalizeToolInput(input)).digest("hex")}`;
}

/**
 * Mechanical provider-egress boundary. It runs before prompt construction and
 * returns only a content-free summary. Known external/networked operations are
 * denied; anything outside the parser's conservative grammar is ambiguous.
 * Both cases remain fail-open for the action agent while forcing sidecar
 * silence and zero provider calls.
 */
export function preflightProviderEgress(payload: HookPayload): ProviderEgressPreflight {
  const toolName = payload.hook_event_name === "PreCompact" ? null : payload.tool_name;
  const baseSummary: ProviderEventSummary = {
    toolName,
    eventKind: payload.hook_event_name === "PreCompact" ? "precompact" : "tool",
    outcome: outcomeFor(payload),
    commandCount: 0,
    executables: [],
    gitOperations: [],
    hasPipeline: false,
    hasCompoundCommand: false,
    hasNestedShell: false,
    hasCommandSubstitution: false,
  };

  if (toolName === null) {
    return { decision: "allow", skipReason: "none", summary: baseSummary, inputFingerprint: null };
  }

  const normalizedTool = normalizeExecutable(toolName);
  if (!SHELL_TOOL_NAMES.has(normalizedTool)) {
    const denied = directToolCategory(toolName);
    if (denied) {
      return {
        decision: "deny",
        skipReason: `egress_denied:${denied}`,
        summary: baseSummary,
        inputFingerprint: fingerprint(baseSummary),
      };
    }
    const decision: EgressDecision = SAFE_DIRECT_TOOL_NAMES.has(normalizedTool) ? "allow" : "ambiguous";
    return {
      decision,
      skipReason: decision === "allow" ? "none" : "egress_ambiguous",
      summary: baseSummary,
      inputFingerprint: decision === "allow"
        ? toolInputFingerprint("tool_input" in payload ? payload.tool_input : null)
        : fingerprint(baseSummary),
    };
  }

  const toolInput = payload.hook_event_name === "PreCompact" ? null : payload.tool_input;
  const command = isRecord(toolInput) && typeof toolInput.command === "string"
    ? toolInput.command
    : null;
  if (command === null || command.trim() === "") {
    return {
      decision: "ambiguous",
      skipReason: "egress_ambiguous",
      summary: baseSummary,
      inputFingerprint: fingerprint(baseSummary),
    };
  }

  const state: ScanState = {
    decision: "allow",
    deniedCategory: null,
    executables: new Set(),
    gitOperations: new Set(),
    commandCount: 0,
    hasPipeline: false,
    hasCompoundCommand: false,
    hasNestedShell: false,
    hasCommandSubstitution: false,
  };
  scanShell(command, state);

  const summary: ProviderEventSummary = {
    ...baseSummary,
    commandCount: state.commandCount,
    executables: [...state.executables].sort(),
    gitOperations: [...state.gitOperations].sort(),
    hasPipeline: state.hasPipeline,
    hasCompoundCommand: state.hasCompoundCommand,
    hasNestedShell: state.hasNestedShell,
    hasCommandSubstitution: state.hasCommandSubstitution,
  };
  const skipReason: EgressSkipReason = state.decision === "deny"
    ? `egress_denied:${state.deniedCategory ?? "network"}`
    : state.decision === "ambiguous"
      ? "egress_ambiguous"
      : "none";
  return {
    decision: state.decision,
    skipReason,
    summary,
    inputFingerprint: commandFingerprint(command),
  };
}
