"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onChange, disabled, label }, ref) => {
    const id = React.useId();

    return (
      <label htmlFor={id} className="flex items-center gap-2 cursor-pointer">
        <button
          ref={ref}
          id={id}
          role="switch"
          aria-checked={checked}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          className={cn(
            "relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            checked ? "bg-primary" : "bg-border",
            disabled && "cursor-not-allowed opacity-50"
          )}
        >
          <span
            className={cn(
              "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
              checked ? "translate-x-[18px]" : "translate-x-[3px]"
            )}
          />
        </button>
        {label && <span className="text-sm text-text-primary">{label}</span>}
      </label>
    );
  }
);
Switch.displayName = "Switch";

export { Switch };
