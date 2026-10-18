import { describe, expect, it } from "vitest";
import { parseNodeOutput } from "../workflows/structured-output.js";

const schema = { type: "object", required: ["score"], properties: { score: { type: "number" } } };

describe("parseNodeOutput", () => {
  it("returns text unchanged in text mode", () => {
    expect(parseNodeOutput("  not json ", "text")).toEqual({ ok: true, value: "  not json " });
  });

  it("parses raw JSON", () => {
    expect(parseNodeOutput('{"score": 3}', "json")).toEqual({ ok: true, value: { score: 3 } });
    expect(parseNodeOutput(" [1,2] \n", "json")).toEqual({ ok: true, value: [1, 2] });
  });

  it("parses a fenced json block surrounded by prose", () => {
    const text = 'Here you go:\n```json\n{"score": 9, "notes": "ok"}\n```\nThanks.';
    expect(parseNodeOutput(text, "json", schema)).toEqual({ ok: true, value: { score: 9, notes: "ok" } });
  });

  it("fails without JSON or with an invalid fenced block", () => {
    const none = parseNodeOutput("no json here", "json");
    expect(none.ok).toBe(false);
    expect(!none.ok && none.error).toMatch(/not valid JSON/);
    const bad = parseNodeOutput("```json\n{oops}\n```", "json");
    expect(!bad.ok && bad.error).toMatch(/Invalid JSON in/);
  });

  it("validates against a schema", () => {
    const result = parseNodeOutput('{"score": "high"}', "json", schema);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/does not match schema.*score/);
  });

  it("reports an invalid schema instead of throwing", () => {
    const result = parseNodeOutput("{}", "json", { type: "nonsense" });
    expect(!result.ok && result.error).toMatch(/Invalid output schema/);
  });
});
