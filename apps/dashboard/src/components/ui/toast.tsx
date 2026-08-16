import * as React from "react";
import { XCircle, CheckCircle, AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface ToastProps {
  message: string;
  type?: "success" | "error" | "warning" | "info";
  onClose?: () => void;
}

const Toast = React.forwardRef<HTMLDivElement, ToastProps>(
  ({ message, type = "success", onClose, ...props }, ref) => {
    const icons = {
      success: <CheckCircle className="h-4 w-4" />,
      error: <XCircle className="h-4 w-4" />,
      warning: <AlertTriangle className="h-4 w-4" />,
      info: <Info className="h-4 w-4" />,
    };

    const styles = {
      success: "bg-success/10 border-success/20 text-success",
      error: "bg-destructive/10 border-destructive/20 text-destructive",
      warning: "bg-warning/10 border-warning/20 text-warning",
      info: "bg-accent/10 border-accent/20 text-accent",
    };

    return (
      <div
        ref={ref}
        className={cn(
          "fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-md border p-4 shadow-lg transition-all duration-300",
          styles[type]
        )}
        {...props}
      >
        {icons[type]}
        <span className="text-sm font-medium">{message}</span>
        <button
          onClick={onClose}
          className="ml-2 text-text-muted hover:text-text-primary"
        >
          ×
        </button>
      </div>
    );
  }
);
Toast.displayName = "Toast";

export { Toast };
