/**
 * Variables usable inside a step's `promptTemplate`:
 *
 * - `{{task}}`        the run's task description
 * - `{{prevOutput}}`  the previous step's output (empty on the first step/iteration)
 * - `{{iterations}}`  how many loop iterations have completed so far
 */
export const PROMPT_TEMPLATE_VARIABLES = ["task", "prevOutput", "iterations"] as const;

export type PromptTemplateVariable = (typeof PROMPT_TEMPLATE_VARIABLES)[number];

export interface PromptTemplateVars {
  task?: string;
  prevOutput?: string;
  iterations?: number;
}

const TEMPLATE_TOKEN = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Renders `{{task}}`, `{{prevOutput}}` and `{{iterations}}` tokens in a
 * prompt template. Unknown variable names throw with the list of valid ones;
 * known variables missing from `vars` render as an empty string.
 */
export function renderPromptTemplate(template: string, vars: PromptTemplateVars): string {
  return template.replace(TEMPLATE_TOKEN, (token, name: string) => {
    if (!(PROMPT_TEMPLATE_VARIABLES as readonly string[]).includes(name)) {
      throw new Error(
        `Unknown prompt template variable ${token}. Valid variables: ${PROMPT_TEMPLATE_VARIABLES.map(
          (variable) => `{{${variable}}}`,
        ).join(", ")}`,
      );
    }
    const value = vars[name as PromptTemplateVariable];
    return value === undefined ? "" : String(value);
  });
}
