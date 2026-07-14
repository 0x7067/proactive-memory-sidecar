import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { preflightProviderEgress } from "../../src/privacy/provider-egress.js";
import { makePostToolUsePayload } from "../helpers/fixtures.js";

function shell(command: string) {
  return preflightProviderEgress(makePostToolUsePayload({ tool_input: { command } }));
}

describe("provider-egress preflight: adversarial shell matrix", () => {
  const deniedCases: Array<[string, string, string]> = [
    ["environment assignment", "TOKEN=top-secret railway status", "infrastructure"],
    ["env wrapper", "env TOKEN=top-secret /usr/local/bin/gh pr list", "external_service"],
    ["env unset wrapper", "env -u TOKEN railway status", "infrastructure"],
    ["sudo wrapper", "sudo -u root curl https://example.invalid", "network"],
    ["command wrapper", "command wget https://example.invalid", "network"],
    ["nested bash -lc", "bash -lc 'railway logs'", "infrastructure"],
    ["nested zsh -c", "zsh -c \"ntn search docs\"", "external_service"],
    ["pipeline", "printf ok | psql app", "database"],
    ["compound command", "rg TODO . && kubectl get pods", "infrastructure"],
    ["command substitution", "printf '%s' \"$(aws sts get-caller-identity)\"", "infrastructure"],
    ["process substitution", "cat <(curl https://example.invalid)", "network"],
    ["backtick substitution", "echo `gcloud auth list`", "infrastructure"],
    ["xargs executable", "printf host | xargs -I {} ssh {}", "network"],
    ["find -exec", "find . -exec docker inspect {} ;", "infrastructure"],
    ["networked git push", "git push origin main", "network"],
    ["networked git fetch", "git fetch --all", "network"],
    ["networked git pull", "git pull --ff-only", "network"],
    ["networked git clone", "git clone https://example.invalid/repo", "network"],
    ["git remote operation", "git remote -v", "network"],
    ["git submodule network access", "git submodule update --init", "network"],
    ["browser command", "open https://example.invalid", "browser"],
    ["messaging command", "slack send '#ops' hello", "messaging"],
    ["Linear command", "linear issue list", "messaging"],
    ["Notion command", "notion search docs", "external_service"],
    ["database command", "mysql app", "database"],
    ["cloud command", "az account show", "infrastructure"],
  ];

  for (const [name, command, category] of deniedCases) {
    test(`${name}: denied before provider egress`, () => {
      const result = shell(command);
      assert.equal(result.decision, "deny");
      assert.equal(result.skipReason, `egress_denied:${category}`);
      assert.ok(result.inputFingerprint?.startsWith("sha256:"));
      assert.doesNotMatch(JSON.stringify(result), /top-secret|example\.invalid/);
    });
  }

  const ambiguousCases: Array<[string, string]> = [
    ["unknown executable", "company-cli deploy"],
    ["variable executable", "$RUNNER --mode local"],
    ["eval", "eval 'echo safe'"],
    ["source", "source ./script.sh"],
    ["unclosed quote", "echo 'unterminated"],
    ["here document", "cat <<EOF\nsecret\nEOF"],
    ["awk can execute subcommands", "awk 'BEGIN { system(\"curl example.invalid\") }'"],
    ["sed can execute subcommands", "sed '1e curl example.invalid' file"],
    ["unknown Git extension", "git company-sync"],
  ];

  for (const [name, command] of ambiguousCases) {
    test(`${name}: ambiguous means silence and no provider eligibility`, () => {
      const result = shell(command);
      assert.equal(result.decision, "ambiguous");
      assert.equal(result.skipReason, "egress_ambiguous");
    });
  }

  test("local Git operations remain eligible without exposing arguments", () => {
    for (const command of ["git status --short", "git diff -- src", "git log -5 --oneline", "git add README.md", "git commit -m local"]) {
      const result = shell(command);
      assert.equal(result.decision, "allow", command);
      assert.equal(result.skipReason, "none");
      assert.deepEqual(result.summary.executables, ["git"]);
      assert.equal(JSON.stringify(result).includes("README.md"), false);
      assert.equal(JSON.stringify(result).includes("-m local"), false);
    }
  });

  test("known local shell grammar yields a minimal structured summary", () => {
    const result = shell("A=private rg TODO . | sort && git status --short");
    assert.equal(result.decision, "allow");
    assert.deepEqual(result.summary.executables, ["git", "rg", "sort"]);
    assert.deepEqual(result.summary.gitOperations, ["status"]);
    assert.equal(result.summary.commandCount, 3);
    assert.equal(result.summary.hasPipeline, true);
    assert.equal(result.summary.hasCompoundCommand, true);
    assert.doesNotMatch(JSON.stringify(result.summary), /private|TODO/);
  });

  test("ripgrep --pre executable is inspected", () => {
    const result = shell("rg --pre='curl https://example.invalid' pattern .");
    assert.equal(result.decision, "deny");
    assert.equal(result.skipReason, "egress_denied:network");
  });

  test("direct external-service tools are denied without inspecting their arguments", () => {
    for (const toolName of ["railway", "mcp__slack__send_message", "linear_create_issue", "browser.open"]) {
      const result = preflightProviderEgress(
        makePostToolUsePayload({ tool_name: toolName, tool_input: { token: "top-secret", body: "private" } }),
      );
      assert.equal(result.decision, "deny", toolName);
      assert.doesNotMatch(JSON.stringify(result), /top-secret|private/);
    }
  });
});
