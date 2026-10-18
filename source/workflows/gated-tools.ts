import type { AgavConfig } from "../config/config.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import { isDestructiveCommand } from "../utils/sandbox.js";
import { validateToolInput, WORKFLOW_TOOLS } from "./definition.js";

/** Trusted application callbacks, never read from workflow definitions or tool input. */
/** Which workflow node a confirmation belongs to (used to key inbox decisions). */
export interface ToolCallContext { nodeId: string; iteration?: number[] }
export interface WorkflowExecutionHost {
  /** May throw `DecisionPendingError` to park the node on an inbox decision. */
  confirmTool: (name: string, input: Record<string, unknown>, signal: AbortSignal, context?: ToolCallContext) => Promise<boolean>;
  executeTool?: (registry: ToolRegistry, name: string, input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

const SAFE = new Set(["read_file", "grep_search", "find_files", "list_directory", "overview"]);
function allowed(name: string, input: Record<string, unknown>, rules: string[] = []): boolean {
  const primary = name === "run_command" ? String(input.command ?? "") : String(input.path ?? "");
  return rules.some(rule => {
    const colon = rule.indexOf(":");
    if (colon < 0) return rule === name;
    if (rule.slice(0, colon) !== name) return false;
    const pattern = rule.slice(colon + 1).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${pattern}$`).test(primary);
  });
}
/** Headless foreground gate: no missing confirmation callback can imply consent. */
export async function gatedToolExecute(registry: ToolRegistry, name: string, input: Record<string, unknown>, config: AgavConfig, signal: AbortSignal, host?: WorkflowExecutionHost, callContext?: ToolCallContext): Promise<ToolResult> {
  signal.throwIfAborted();
  if (!WORKFLOW_TOOLS.includes(name as typeof WORKFLOW_TOOLS[number])) throw new Error(`Unsupported workflow tool: ${name}`);
  validateToolInput(registry, name, input);
  const safe = SAFE.has(name);
  if (name === "run_command" && isDestructiveCommand(String(input.command ?? ""))) throw new Error("Destructive commands are not supported by foreground workflows.");
  if (!safe && config.allowedTools?.length && !allowed(name, input, config.allowedTools)) throw new Error(`Tool '${name}' is not permitted in this mode.`);
  if (!safe && config.permissionMode === "deny-writes") throw new Error("Write operations are denied (--deny-writes mode).");
  if (!safe && config.permissionMode !== "auto-accept" && !allowed(name, input, config.allowedTools)) {
    if (!host) throw new Error(`Tool '${name}' requires confirmation but no confirmation handler is available (headless mode).`);
    if (!await host.confirmTool(name, input, signal, callContext)) throw new Error(`Tool '${name}' permission denied.`);
  }
  signal.throwIfAborted();
  const context: ToolContext = { signal, headless: !host, permissionMode: config.permissionMode };
  return host?.executeTool ? host.executeTool(registry, name, input, context) : registry.execute(name, input, context);
}
