import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

// dist/test/package.test.js -> up two levels -> repo root (matches the
// established ../../src/... resolution pattern in test/bin/hook-cli.test.ts).
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface NpmPackFileEntry {
  path: string;
}
interface NpmPackReport {
  files: NpmPackFileEntry[];
}

function normalizePackReports(parsed: unknown): NpmPackReport[] {
  if (Array.isArray(parsed)) return parsed as NpmPackReport[];
  if (parsed && typeof parsed === "object") {
    if ("files" in parsed) return [parsed as NpmPackReport];
    return Object.values(parsed).filter(
      (value): value is NpmPackReport => Boolean(value && typeof value === "object" && "files" in value),
    );
  }
  return [];
}

/**
 * Package hygiene (Low-severity review fix #6): the npm package allowlist
 * (`package.json#files`) must not ship compiled test output or source
 * maps. This runs the real `npm pack --dry-run` against the already-built
 * `dist/` (no network access — dry-run never contacts a registry) and
 * asserts on its reported file list, so a regression in `files` is caught
 * mechanically rather than by manual inspection.
 */
describe("package.json files allowlist (npm pack)", () => {
  test("npm pack --dry-run excludes compiled test output and source maps, and still includes the bin entrypoints", () => {
    const stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const [report] = normalizePackReports(JSON.parse(stdout));
    if (!report) throw new Error("npm pack --dry-run --json returned no report");
    const paths = report.files.map((f) => f.path);

    assert.ok(paths.length > 10, "sanity check: the tarball should contain a substantial number of files");

    const testOutputPaths = paths.filter((p) => p.startsWith("dist/test/"));
    assert.deepEqual(testOutputPaths, [], "compiled test output (dist/test/**) must not be shipped");

    const mapPaths = paths.filter((p) => p.endsWith(".map"));
    assert.deepEqual(mapPaths, [], "source maps (**/*.map) must not be shipped");

    for (const required of [
      "dist/src/bin/hook.js",
      "dist/src/bin/maintain.js",
      "README.md",
      "LICENSE",
      "hooks/settings.example.json",
      "hooks/README.md",
      "package.json",
    ]) {
      assert.ok(paths.includes(required), `expected "${required}" to still be shipped`);
    }
  });
});
