"use client";

import type { StepConfig } from "@openeuler/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import type { CanvasNode } from "@/lib/graph/canvas-document";
import { issuesForNode, type CanvasIssue } from "@/lib/graph/validation";

/**
 * Right drawer for the selected node (#46): agent step config (name, driver,
 * model, agent, mode, prompt template, session chaining) or the exit node's
 * name. Patches flow to the editor, which debounces them into undo entries.
 */
export function NodePropertiesDrawer({
  node,
  drivers,
  issues,
  onPatchAgent,
  onPatchName,
  onDelete,
  onClose,
}: {
  node: CanvasNode;
  drivers: readonly string[];
  issues: readonly CanvasIssue[];
  onPatchAgent: (patch: Partial<StepConfig>) => void;
  onPatchName: (name: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const nodeIssues = issuesForNode(issues, node.id);
  const fieldIssue = (field: string): string | undefined =>
    nodeIssues.find((issue) => issue.field === field)?.message;

  return (
    <Drawer open onClose={onClose} label={`Edit ${node.data.name || "node"}`} className="max-w-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-title font-semibold text-fg">
            {node.data.kind === "agent" ? "Agent step" : "Exit node"}
          </h2>
          {node.data.kind === "agent" && node.data.isEntry ? (
            <Badge variant="accent" className="mt-1">
              entry · pinned
            </Badge>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="mt-4 flex flex-col gap-4">
        <Field label="Name" htmlFor="node-name" error={fieldIssue("name")}>
          <Input
            id="node-name"
            value={node.data.name}
            invalid={fieldIssue("name") !== undefined}
            onChange={(event) => onPatchName(event.target.value)}
            placeholder={node.data.kind === "agent" ? "e.g. implement" : "Exit"}
          />
        </Field>

        {node.data.kind === "agent" ? (
          <>
            <Field label="Driver" htmlFor="node-driver" error={fieldIssue("config.driver")}>
              <Select
                id="node-driver"
                value={node.data.config.driver}
                onChange={(event) => onPatchAgent({ driver: event.target.value })}
              >
                {(drivers.length > 0 ? drivers : [node.data.config.driver]).map((driver) => (
                  <option key={driver} value={driver}>
                    {driver}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Model" hint="(optional)" htmlFor="node-model">
              <Input
                id="node-model"
                value={node.data.config.model ?? ""}
                onChange={(event) =>
                  onPatchAgent({
                    model:
                      event.target.value.trim().length === 0
                        ? undefined
                        : event.target.value.trim(),
                  })
                }
                placeholder="driver default"
                className="font-mono"
              />
            </Field>

            <Field label="Agent" hint="(optional)" htmlFor="node-agent">
              <Input
                id="node-agent"
                value={node.data.config.agent ?? ""}
                onChange={(event) =>
                  onPatchAgent({
                    agent:
                      event.target.value.trim().length === 0
                        ? undefined
                        : event.target.value.trim(),
                  })
                }
                placeholder="driver default"
                className="font-mono"
              />
            </Field>

            <Field label="Mode" htmlFor="node-mode" error={fieldIssue("config.mode")}>
              <Select
                id="node-mode"
                value={node.data.config.mode}
                onChange={(event) =>
                  onPatchAgent({ mode: event.target.value as StepConfig["mode"] })
                }
              >
                <option value="auto">auto — run without asking</option>
                <option value="ask">ask — wait for approval</option>
              </Select>
            </Field>

            <Field
              label="Prompt template"
              htmlFor="node-prompt"
              error={fieldIssue("config.promptTemplate")}
            >
              <Textarea
                id="node-prompt"
                rows={6}
                value={node.data.config.promptTemplate}
                invalid={fieldIssue("config.promptTemplate") !== undefined}
                onChange={(event) => onPatchAgent({ promptTemplate: event.target.value })}
                placeholder={
                  "Use {{task}} for the run task and {{output:<nodeId>}} for upstream outputs."
                }
                className="font-mono text-xs"
              />
            </Field>

            <label className="flex items-start gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={node.data.config.continueSession}
                onChange={(event) => onPatchAgent({ continueSession: event.target.checked })}
                className="mt-0.5 size-4 rounded border-border accent-[var(--accent)]"
              />
              <span>
                Continue previous session
                <span className="block text-xs font-normal text-muted-fg">
                  Chain this step onto the session of the run so far.
                </span>
              </span>
            </label>
          </>
        ) : null}

        {nodeIssues.length > 0 ? (
          <div className="rounded-lg border border-danger/40 bg-danger-subtle p-3" role="alert">
            <p className="text-sm font-medium text-danger">
              {nodeIssues.length} issue{nodeIssues.length === 1 ? "" : "s"} on this node
            </p>
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4 text-xs text-danger">
              {nodeIssues.map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-auto flex justify-end pt-2">
          {node.data.kind === "agent" && node.data.isEntry ? (
            <p className="text-xs text-muted-fg">The entry node cannot be deleted.</p>
          ) : (
            <Button variant="danger" onClick={onDelete}>
              Delete node
            </Button>
          )}
        </div>
      </div>
    </Drawer>
  );
}
