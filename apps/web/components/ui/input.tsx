"use client";

import type {
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

/**
 * Themed form controls (issue #50): one place for input styling incl. the
 * focus-visible ring, so forms across the app stay consistent.
 */

const CONTROL_CLASS =
  "rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-fg shadow-1 " +
  "transition-colors placeholder:text-muted-fg " +
  "focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40";

const INVALID_CLASS = "border-danger focus-visible:border-danger focus-visible:ring-danger/40";

export function Input({
  className,
  invalid,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; ref?: Ref<HTMLInputElement> }) {
  return (
    <input ref={ref} className={cn(CONTROL_CLASS, invalid && INVALID_CLASS, className)} {...rest} />
  );
}

export function Textarea({
  className,
  invalid,
  ref,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <textarea
      ref={ref}
      className={cn(CONTROL_CLASS, "font-normal", invalid && INVALID_CLASS, className)}
      {...rest}
    />
  );
}

export function Select({
  className,
  invalid,
  ref,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean; ref?: Ref<HTMLSelectElement> }) {
  return (
    <select ref={ref} className={cn(CONTROL_CLASS, invalid && INVALID_CLASS, className)} {...rest}>
      {children}
    </select>
  );
}

/** Label wrapper that keeps the field + error pattern uniform. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
        {label}
        {hint ? <span className="ml-1 font-normal text-muted-fg">{hint}</span> : null}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
