import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost";

const BASE_CLASS =
  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-slate-900 text-white hover:bg-slate-700",
  secondary: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100",
  ghost: "text-slate-600 hover:bg-slate-100",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = "primary", className, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`${BASE_CLASS} ${VARIANT_CLASSES[variant]} ${className ?? ""}`}
      {...rest}
    />
  );
}
