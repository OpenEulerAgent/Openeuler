"use client";

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "icon";

const BASE_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  secondary: "border border-border bg-surface text-fg hover:bg-elevated",
  ghost: "text-muted-fg hover:bg-elevated hover:text-fg",
  danger: "bg-danger text-white hover:opacity-90",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "px-2 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
  icon: "size-8 p-0",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, disables the button and announces `aria-busy`. */
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

function Spinner() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 animate-spin" fill="none">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  type = "button",
  disabled,
  children,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(
        BASE_CLASS,
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        loading && "cursor-wait",
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

export interface LinkButtonProps {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
}

/** Button-styled anchor for CTAs that must be real links. */
export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  className,
  children,
}: LinkButtonProps) {
  return (
    <a
      href={href}
      className={cn(BASE_CLASS, VARIANT_CLASSES[variant], SIZE_CLASSES[size], className)}
    >
      {children}
    </a>
  );
}
