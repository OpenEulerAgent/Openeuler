/**
 * Variables usable inside a step's `promptTemplate`:
 *
 * - `{{task}}`             the run's task description
 * - `{{prevOutput}}`       the previous step's output this iteration (empty on
 *                          the first step; after a loop-back jump the first
 *                          re-run step receives the LAST step's output from
 *                          the previous iteration, so context flows across
 *                          the jump)
 * - `{{iterations}}`       the current loop pass, 1-based (`1` on the first
 *                          pass)
 * - `{{output:<nodeId>}}`  (graph workflows) the final output of an upstream
 *                          node — `{{prevOutput}}` stays as the alias for the
 *                          direct predecessor
 */
export const PROMPT_TEMPLATE_VARIABLES = ["task", "prevOutput", "iterations", "output"] as const;

export type PromptTemplateVariable = (typeof PROMPT_TEMPLATE_VARIABLES)[number];

export interface PromptTemplateVars {
  task?: string;
  prevOutput?: string;
  iterations?: number;
  /** Final outputs of graph nodes by id, backing `{{output:<nodeId>}}`. */
  outputs?: Readonly<Record<string, string>>;
}

/** `{{name}}` and `{{output:<nodeId>}}` tokens (node ids allow `-`). */
const TEMPLATE_TOKEN = /\{\{\s*(\w+)(?::([\w-]+))?\s*\}\}/g;

const VALID_VARIABLES_HELP = "{{task}}, {{prevOutput}}, {{iterations}}, {{output:<nodeId>}}";

/**
 * Every `{{output:<nodeId>}}` node id referenced by a template, in order of
 * appearance (duplicates preserved). Schema validation uses this to check
 * that references point at upstream nodes.
 */
export function extractOutputReferences(template: string): string[] {
  const refs: string[] = [];
  for (const match of template.matchAll(TEMPLATE_TOKEN)) {
    const name = match[1] ?? "";
    const nodeId = match[2];
    if (name === "output" && nodeId !== undefined) refs.push(nodeId);
  }
  return refs;
}

/**
 * Renders `{{task}}`, `{{prevOutput}}`, `{{iterations}}` and
 * `{{output:<nodeId>}}` tokens in a prompt template. Unknown variable names
 * throw with the list of valid ones; known variables missing from `vars`
 * render as an empty string. A `{{output:<nodeId>}}` reference with no
 * matching entry in `vars.outputs` throws — a missing node output is a real
 * error, not an empty string.
 */
export function renderPromptTemplate(template: string, vars: PromptTemplateVars): string {
  return template.replace(TEMPLATE_TOKEN, (token, name: string, nodeId?: string) => {
    if (name === "output") {
      if (nodeId === undefined) {
        throw new Error(
          `Malformed prompt template variable ${token}: the output variable requires a node id, e.g. {{output:implement}}. Valid variables: ${VALID_VARIABLES_HELP}`,
        );
      }
      const output = vars.outputs?.[nodeId];
      if (output === undefined) {
        const available = vars.outputs === undefined ? [] : Object.keys(vars.outputs);
        throw new Error(
          `Prompt template references {{output:${nodeId}}} but no output for node "${nodeId}" was provided (available: ${
            available.length > 0 ? available.join(", ") : "none"
          }). Valid variables: ${VALID_VARIABLES_HELP}`,
        );
      }
      return output;
    }
    if (!(PROMPT_TEMPLATE_VARIABLES as readonly string[]).includes(name)) {
      throw new Error(
        `Unknown prompt template variable ${token}. Valid variables: ${VALID_VARIABLES_HELP}`,
      );
    }
    const value = vars[name as Exclude<PromptTemplateVariable, "output">];
    return value === undefined ? "" : String(value);
  });
}
