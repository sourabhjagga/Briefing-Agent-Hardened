import * as React from "react";
import { cn } from "@/lib/utils";

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
  action?: React.ReactNode;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, title, action, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "rounded-lg border bg-card text-card-foreground shadow-sm",
          className
        )}
        {...props}
      >
        {(title || action) && (
          <div className="flex h-10 items-center gap-2 border-b px-4">
            {title && (
              <h3 className="text-sm font-semibold leading-none tracking-tight">
                {title}
              </h3>
            )}
            {action && <div className="ml-auto">{action}</div>}
          </div>
        )}
        <div className="p-4">{children}</div>
      </div>
    );
  }
);
Card.displayName = "Card";

export { Card };
