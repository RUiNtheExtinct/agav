import { Ajv } from "ajv";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYAML } from "yaml";
import type { ToolRegistry } from "../tools/registry.js";

export interface WorkflowNode {
  id: string;
  type: "tool" | "approval" | "job";
  dependsOn?: string[];
  tool?: string;
  /** Literal shell text for `job` nodes; no interpolation. */
  command?: string;
  input?: Record<string, unknown>;
  prompt?: string;
  timeoutSeconds?: number;
}
export type WorkflowInputType = "string" | "number" | "boolean" | "object" | "array";
/** Typed run input; `default` must match `type`, and a required input cannot declare a default. */
export interface WorkflowInputSpec {
  type: WorkflowInputType;
  default?: unknown;
  required?: boolean;
  description?: string;
}
export interface WorkflowDefinition {
  version: 1;
  name: string;
  description?: string;
  inputs?: Record<string, WorkflowInputSpec>;
  nodes: WorkflowNode[];
}
/** Input names are plain identifiers so `${inputs.<name>}` stays unambiguous. */
export const INPUT_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]{0,63}$";
export const INPUT_TYPES = ["string", "number", "boolean", "object", "array"] as const;
/** True when `value` has the JSON type `type` (numbers must be finite; arrays are not objects). */
export function matchesInputType(value: unknown, type: WorkflowInputType): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return !!value && typeof value === "object" && !Array.isArray(value);
  }
}
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile({
  type: "object", additionalProperties: false, required: ["version", "name", "nodes"],
  properties: {
    version: { const: 1 }, name: { type: "string", minLength: 1, maxLength: 200 }, description: { type: "string" },
    inputs: {
      type: "object", maxProperties: 100, propertyNames: { pattern: INPUT_NAME_PATTERN },
      additionalProperties: {
        type: "object", additionalProperties: false, required: ["type"],
        properties: { type: { enum: INPUT_TYPES }, default: {}, required: { type: "boolean" }, description: { type: "string" } },
      },
    },
    nodes: { type: "array", minItems: 1, maxItems: 1000, items: {
      type: "object", additionalProperties: false, required: ["id", "type"],
      properties: {
        id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
        type: { enum: ["tool", "approval", "job"] },
        dependsOn: { type: "array", uniqueItems: true, items: { type: "string" } },
        tool: { type: "string" }, input: { type: "object" }, command: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1 },
        timeoutSeconds: { type: "number", exclusiveMinimum: 0, maximum: 86400 },
      },
    } },
  },
});

// Only built-ins whose execution/settlement and permission boundary are supported here.
export const WORKFLOW_TOOLS = ["read_file", "write_file", "edit_file", "run_command", "grep_search", "find_files", "list_directory", "overview"] as const;

export function validateDefinition(value: unknown, registry: ToolRegistry): WorkflowDefinition {
  if (!validate(value)) throw new Error(`Invalid workflow (supported nodes: tool, approval, job): ${ajv.errorsText(validate.errors)}`);
  const definition = value as WorkflowDefinition;
  for (const [name, spec] of Object.entries(definition.inputs ?? {})) {
    if (spec.default !== undefined && !matchesInputType(spec.default, spec.type)) throw new Error(`Input ${name}: default must be of type ${spec.type}.`);
    if (spec.required === true && spec.default !== undefined) throw new Error(`Input ${name}: a required input cannot have a default.`);
  }
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (ids.has(node.id)) throw new Error(`Duplicate node: ${node.id}`);
    ids.add(node.id);
    if (node.type === "approval") {
      if (!node.prompt || node.tool !== undefined || node.input !== undefined || node.command !== undefined || node.timeoutSeconds !== undefined) throw new Error(`Invalid approval node: ${node.id}`);
    } else if (node.type === "job") {
      // Literal command only; the supervisor has no runtime-timeout support, so timeoutSeconds is refused.
      if (typeof node.command !== "string" || node.command.trim() === "") throw new Error(`Job node requires a non-empty command: ${node.id}`);
      if (node.command.includes("${")) throw new Error("Shell interpolation is not supported; use a literal command.");
      if (node.tool !== undefined || node.input !== undefined || node.prompt !== undefined) throw new Error(`Invalid job node (only command and dependsOn are allowed): ${node.id}`);
      if (node.timeoutSeconds !== undefined) throw new Error(`Job nodes do not support timeoutSeconds: ${node.id}`);
    } else {
      if (node.command !== undefined) throw new Error(`Tool node cannot have command: ${node.id}`);
      if (!node.tool || !WORKFLOW_TOOLS.includes(node.tool as typeof WORKFLOW_TOOLS[number]) || !registry.get(node.tool)) throw new Error(`Unsupported workflow tool: ${node.tool}`);
      if (node.prompt !== undefined) throw new Error(`Tool node cannot have prompt: ${node.id}`);
      if (node.tool === "run_command" && JSON.stringify(node.input ?? {}).includes("${")) throw new Error("Shell interpolation is not supported; use a literal command.");
      if (!JSON.stringify(node.input ?? {}).includes("${")) validateToolInput(registry, node.tool, node.input ?? {});
    }
  }
  const done = new Set<string>();
  const visiting = new Set<string>();
  const byId = new Map(definition.nodes.map(node => [node.id, node]));
  const visit = (id: string): void => {
    if (!ids.has(id)) throw new Error(`Unknown dependency: ${id}`);
    if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);
    if (done.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)!.dependsOn ?? []) visit(dep);
    visiting.delete(id); done.add(id);
  };
  for (const id of ids) visit(id);
  return definition;
}
export function validateToolInput(registry: ToolRegistry, name: string, input: Record<string, unknown>): void {
  const check = ajv.compile(registry.get(name)!.schema.inputSchema);
  if (!check(input)) throw new Error(`Invalid ${name} input: ${ajv.errorsText(check.errors)}`);
}
export const WORKFLOW_EXTENSIONS = [".json", ".yaml", ".yml"] as const;
/**
 * Parses JSON or YAML (by extension) into plain JSON data before validation, so the stored
 * definition and its hash are identical for equivalent JSON and YAML sources.
 */
export function parseDefinitionText(text: string, path: string): unknown {
  const ext = extname(path).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    // Normalize to JSON: YAML-only values (e.g. undefined, non-finite numbers) cannot survive as such.
    const parsed: unknown = parseYAML(text);
    return parsed === undefined ? undefined : JSON.parse(JSON.stringify(parsed)) as unknown;
  }
  return JSON.parse(text) as unknown;
}
export async function loadDefinition(path: string, registry: ToolRegistry): Promise<WorkflowDefinition> {
  return validateDefinition(parseDefinitionText(await readFile(path, "utf8"), path), registry);
}
