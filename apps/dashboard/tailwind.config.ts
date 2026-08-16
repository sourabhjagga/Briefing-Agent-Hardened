import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "rgb(var(--background))",
        foreground: "rgb(var(--text-primary))",
        surface: "rgb(var(--surface))",
        "surface-2": "rgb(var(--surface-2))",
        card: "rgb(var(--surface))",
        "card-foreground": "rgb(var(--text-primary))",
        border: "rgb(var(--border))",
        muted: "rgb(var(--surface-2))",
        "muted-foreground": "rgb(var(--text-muted))",
        "text-primary": "rgb(var(--text-primary))",
        "text-secondary": "rgb(var(--text-secondary))",
        "text-muted": "rgb(var(--text-muted))",
        primary: "rgb(var(--primary))",
        "primary-foreground": "rgb(var(--primary-foreground))",
        accent: "rgb(var(--accent))",
        "accent-foreground": "rgb(255 255 255)",
        secondary: "rgb(var(--surface-2))",
        "secondary-foreground": "rgb(var(--text-secondary))",
        destructive: "rgb(var(--danger))",
        "destructive-foreground": "rgb(255 255 255)",
        success: "rgb(var(--success))",
        warning: "rgb(var(--warning))",
        danger: "rgb(var(--danger))",
        ring: "rgb(var(--primary))",
        "ring-offset-background": "rgb(var(--background))",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;