import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseModelResponse, type ParseLimits } from "../../src/engine/parser.js";

const LIMITS: ParseLimits = { entryIdMaxChars: 128, entryContentMaxChars: 2000, statusMaxChars: 300 };

/** Builds a well-formed <bank_ops> block from a real JSON.stringify of `ops`, so adversarial characters inside an id/content are escaped exactly the way a real model response would encode them. */
function bankOpsBlock(ops: unknown[]): string {
  return `<bank_ops>${JSON.stringify(ops)}</bank_ops>`;
}

describe("parser: Phase 1 (bank_ops)", () => {
  test("absent <bank_ops> block yields an empty op list, not an error", () => {
    const parsed = parseModelResponse("<no_intervention/>", LIMITS);
    assert.deepEqual(parsed.opEntries, []);
  });

  test("empty array is parsed cleanly", () => {
    const parsed = parseModelResponse("<bank_ops>[]</bank_ops>\n<no_intervention/>", LIMITS);
    assert.deepEqual(parsed.opEntries, []);
  });

  test("valid save_knowledge, save_procedural, delete, update_status all parse", () => {
    const raw = `<bank_ops>[
      {"op":"save_knowledge","id":"req:a","content":"fact"},
      {"op":"save_procedural","id":"proc:b","content":"observation"},
      {"op":"delete","id":"old"},
      {"op":"update_status","status":"debugging"}
    ]</bank_ops>
    <no_intervention/>`;
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries.length, 4);
    assert.ok(parsed.opEntries.every((e) => e.valid));
    const ops = parsed.opEntries.map((e) => (e.valid ? e.op.op : null));
    assert.deepEqual(ops, ["save_knowledge", "save_procedural", "delete", "update_status"]);
  });

  test("ids and content are trimmed", () => {
    const raw = `<bank_ops>[{"op":"save_knowledge","id":"  req:a  ","content":"  fact  "}]</bank_ops>`;
    const parsed = parseModelResponse(raw, LIMITS);
    const entry = parsed.opEntries[0];
    assert.ok(entry?.valid);
    if (entry?.valid && entry.op.op === "save_knowledge") {
      assert.equal(entry.op.id, "req:a");
      assert.equal(entry.op.content, "fact");
    }
  });

  test("unrecognized op type is rejected but does not throw", () => {
    const raw = `<bank_ops>[{"op":"reticulate_splines","id":"x"}]</bank_ops>`;
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries.length, 1);
    assert.equal(parsed.opEntries[0]?.valid, false);
  });

  test("save_knowledge missing content is rejected", () => {
    const raw = `<bank_ops>[{"op":"save_knowledge","id":"x"}]</bank_ops>`;
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries[0]?.valid, false);
  });

  test("save_knowledge with empty-string id is rejected", () => {
    const raw = `<bank_ops>[{"op":"save_knowledge","id":"","content":"x"}]</bank_ops>`;
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries[0]?.valid, false);
  });

  test("save_knowledge exceeding entryIdMaxChars is rejected", () => {
    const raw = `<bank_ops>[{"op":"save_knowledge","id":"${"x".repeat(200)}","content":"c"}]</bank_ops>`;
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries[0]?.valid, false);
  });

  test("save_knowledge exceeding entryContentMaxChars is rejected", () => {
    const raw = `<bank_ops>[{"op":"save_knowledge","id":"x","content":"${"c".repeat(3000)}"}]</bank_ops>`;
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries[0]?.valid, false);
  });

  test("update_status exceeding statusMaxChars is rejected", () => {
    const raw = `<bank_ops>[{"op":"update_status","status":"${"s".repeat(500)}"}]</bank_ops>`;
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries[0]?.valid, false);
  });

  test("delete missing id is rejected", () => {
    const raw = `<bank_ops>[{"op":"delete"}]</bank_ops>`;
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries[0]?.valid, false);
  });

  test("malformed JSON inside bank_ops degrades to a single invalid entry, not a throw", () => {
    const raw = `<bank_ops>[{"op": "save_knowledge", "id": }]</bank_ops>`;
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries.length, 1);
    assert.equal(parsed.opEntries[0]?.valid, false);
  });

  test("non-array JSON inside bank_ops degrades to a single invalid entry", () => {
    const raw = `<bank_ops>{"op":"save_knowledge"}</bank_ops>`;
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries.length, 1);
    assert.equal(parsed.opEntries[0]?.valid, false);
  });

  test("op entries that are not objects (e.g. bare strings/numbers) are rejected individually", () => {
    const raw = `<bank_ops>["not an object", 42, {"op":"save_knowledge","id":"ok","content":"c"}]</bank_ops>`;
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries.length, 3);
    assert.equal(parsed.opEntries[0]?.valid, false);
    assert.equal(parsed.opEntries[1]?.valid, false);
    assert.equal(parsed.opEntries[2]?.valid, true);
  });

  test("order is preserved exactly as written", () => {
    const raw = `<bank_ops>[
      {"op":"delete","id":"a"},
      {"op":"save_knowledge","id":"b","content":"c"},
      {"op":"delete","id":"d"}
    ]</bank_ops>`;
    const parsed = parseModelResponse(raw, LIMITS);
    const kinds = parsed.opEntries.map((e) => (e.valid ? e.op.op : "invalid"));
    assert.deepEqual(kinds, ["delete", "save_knowledge", "delete"]);
  });
});

describe("parser: bank entry id grammar (conservative slug only)", () => {
  test("accepts lowercase alphanumeric ids with ':', '_', '-'", () => {
    const raw = bankOpsBlock([
      { op: "save_knowledge", id: "req:ipv4-octets", content: "c" },
      { op: "save_procedural", id: "proc_regex-fail_14", content: "c" },
      { op: "save_knowledge", id: "abc123", content: "c" },
    ]);
    const parsed = parseModelResponse(raw, LIMITS);
    assert.ok(
      parsed.opEntries.every((e) => e.valid),
      "every grammar-valid id must be accepted",
    );
  });

  test("rejects an uppercase id", () => {
    const raw = bankOpsBlock([{ op: "save_knowledge", id: "REQ:A", content: "c" }]);
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries[0]?.valid, false);
  });

  test("rejects an id containing a newline", () => {
    const raw = bankOpsBlock([{ op: "save_knowledge", id: "req:a\n## fake section", content: "c" }]);
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries[0]?.valid, false);
  });

  test("rejects an id containing a double quote", () => {
    const raw = bankOpsBlock([{ op: "save_knowledge", id: 'req:a"injected', content: "c" }]);
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries[0]?.valid, false);
  });

  test("rejects an id containing a space", () => {
    const raw = bankOpsBlock([{ op: "save_knowledge", id: "req a", content: "c" }]);
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries[0]?.valid, false);
  });

  test("rejects an id containing punctuation outside the allowed set (e.g. '.', '/')", () => {
    for (const id of ["req.a", "req/a", "req\\a", "req,a", "req;a"]) {
      const raw = bankOpsBlock([{ op: "save_knowledge", id, content: "c" }]);
      const parsed = parseModelResponse(raw, LIMITS);
      assert.equal(parsed.opEntries[0]?.valid, false, `id "${id}" must be rejected`);
    }
  });

  test("save_procedural is validated with the same grammar as save_knowledge", () => {
    const raw = bankOpsBlock([{ op: "save_procedural", id: "Bad Id!", content: "c" }]);
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries[0]?.valid, false);
  });

  test("delete also enforces the id grammar", () => {
    const raw = bankOpsBlock([{ op: "delete", id: "not a valid id\nwith a newline" }]);
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries[0]?.valid, false);
  });

  test("delete accepts a grammar-valid id", () => {
    const raw = bankOpsBlock([{ op: "delete", id: "req:ipv4-octets" }]);
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.opEntries[0]?.valid, true);
  });

  test("a grammar-invalid id is dropped, not silently sanitized/truncated to something valid", () => {
    const raw = bankOpsBlock([{ op: "save_knowledge", id: "Req:A", content: "should not be stored" }]);
    const parsed = parseModelResponse(raw, LIMITS);
    const entry = parsed.opEntries[0];
    assert.equal(entry?.valid, false);
    if (entry && !entry.valid) {
      assert.match(entry.reason, /id/i);
    }
  });
});

describe("parser: Phase 2 (selective intervention)", () => {
  test("<no_intervention/> parses cleanly", () => {
    const parsed = parseModelResponse("<bank_ops>[]</bank_ops>\n<no_intervention/>", LIMITS);
    assert.deepEqual(parsed.phase2, { kind: "no_intervention" });
    assert.equal(parsed.parseError, null);
  });

  test("<no_intervention/> tolerates internal whitespace before the slash", () => {
    const parsed = parseModelResponse("<no_intervention />", LIMITS);
    assert.equal(parsed.phase2.kind, "no_intervention");
  });

  test("well-formed <context_for_action> parses grounding and text", () => {
    const raw = `<context_for_action grounding="req:ipv4-octets,proc:regex-fail-14">
Reminder: the task requires single-digit IPv4 octets to match; the current regex was already observed failing on "1.2.3.4" at step 14.
</context_for_action>`;
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.phase2.kind, "context_for_action");
    if (parsed.phase2.kind === "context_for_action") {
      assert.equal(parsed.phase2.groundingRaw, "req:ipv4-octets,proc:regex-fail-14");
      assert.match(parsed.phase2.text, /^Reminder: the task requires/);
    }
  });

  test("context_for_action with missing grounding attribute parses with an empty grounding string", () => {
    const raw = `<context_for_action>Reminder: something.</context_for_action>`;
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.phase2.kind, "context_for_action");
    if (parsed.phase2.kind === "context_for_action") {
      assert.equal(parsed.phase2.groundingRaw, "");
    }
  });

  test("response with neither tag is unparseable", () => {
    const parsed = parseModelResponse("<bank_ops>[]</bank_ops>\nI have decided to say nothing useful.", LIMITS);
    assert.equal(parsed.phase2.kind, "unparseable");
    assert.ok(parsed.parseError);
  });

  test("response with BOTH tags is treated as ambiguous/unparseable, not resolved silently", () => {
    const raw = `<no_intervention/><context_for_action grounding="a">Reminder: x.</context_for_action>`;
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.phase2.kind, "unparseable");
  });

  test("extraneous prose around the tags does not break parsing", () => {
    const raw = `Sure, here is my analysis:\n<bank_ops>[]</bank_ops>\nAnd my decision:\n<no_intervention/>\nDone.`;
    const parsed = parseModelResponse(raw, LIMITS);
    assert.equal(parsed.phase2.kind, "no_intervention");
  });
});
