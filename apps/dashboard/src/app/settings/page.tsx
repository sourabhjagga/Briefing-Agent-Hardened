"use client";

import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api-client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/toast-provider";
import { formatUptime } from "@/lib/utils";

interface Health {
  healthy: boolean;
  whatsapp: string;
  messagesToday: number;
  targetGroups: number;
  uptime: number;
}

interface EnvVar {
  key: string;
  description: string;
}

const envVars: EnvVar[] = [
  { key: "TELEGRAM_BOT_TOKEN", description: "Telegram bot authentication" },
  { key: "TELEGRAM_CHAT_ID", description: "Telegram target chat" },
  { key: "GEMINI_API_KEY", description: "Google Gemini API access" },
  { key: "OPENROUTER_API_KEY", description: "OpenRouter API access" },
  { key: "WHATSAPP_ADMIN_JID", description: "WhatsApp admin JID" },
];

export default function SettingsPage() {
  const { toast } = useToast();

  const { data: health, isLoading } = useQuery<Health>({
    queryKey: ['health'],
    queryFn: () => apiRequest<Health>('/health'),
  });

  const triggerMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ success: boolean; message: string }>('/api/schedules/trigger', { method: 'POST', body: '{}' }),
    onSuccess: (data) => toast(data.message, 'success'),
    onError: (err: Error) => toast(err.message, 'error'),
  });

  const resetWhatsappMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ success: boolean; message: string }>('/api/admin/reset-whatsapp', { method: 'DELETE' }),
    onSuccess: (data) => toast(data.message ?? 'WhatsApp connection reset', 'success'),
    onError: (err: Error) => toast(err.message, 'error'),
  });

  const restartWhatsappMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ success: boolean; message: string }>('/api/admin/force-whatsapp-reconnect', { method: 'POST' }),
    onSuccess: (data) => toast(data.message ?? 'WhatsApp connection restarted', 'success'),
    onError: (err: Error) => toast(err.message, 'error'),
  });

  return (
    <div className="flex-1 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      <Card title="System Information">
        {isLoading ? (
          <CardSkeleton />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Health</span>
              <div>
                <Badge variant={health?.healthy ? 'success' : 'destructive'}>
                  {health?.healthy ? 'Healthy' : 'Unhealthy'}
                </Badge>
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Uptime</span>
              <p className="text-sm font-medium">
                {health?.uptime ? formatUptime(health.uptime) : '—'}
              </p>
            </div>
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">WhatsApp</span>
              <p className="text-sm font-medium">{health?.whatsapp ?? '—'}</p>
            </div>
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Messages Today</span>
              <p className="text-sm font-medium">{health?.messagesToday ?? '—'}</p>
            </div>
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Target Groups</span>
              <p className="text-sm font-medium">{health?.targetGroups ?? '—'}</p>
            </div>
          </div>
        )}
      </Card>

      <Card title="Environment Variables">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-3 px-4 font-medium">Variable</th>
                <th className="text-left py-3 px-4 font-medium">Description</th>
                <th className="text-right py-3 px-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {envVars.map((v) => (
                <tr key={v.key} className="border-b hover:bg-surface-2">
                  <td className="py-3 px-4 font-mono text-xs">{v.key}</td>
                  <td className="py-3 px-4 text-muted-foreground">{v.description}</td>
                  <td className="py-3 px-4 text-right">
                    <Badge variant="success" className="text-xs">Set</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Environment variables are configured on the backend via its .env file.
        </p>
      </Card>

      <Card title="Quick Actions">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Trigger All Briefs</p>
              <p className="text-xs text-muted-foreground">Run all scheduled briefing jobs now</p>
            </div>
            <Button
              variant="default"
              size="sm"
              onClick={() => triggerMutation.mutate()}
              disabled={triggerMutation.isPending}
            >
              {triggerMutation.isPending ? 'Triggering...' : 'Trigger All'}
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Restart WhatsApp</p>
              <p className="text-xs text-muted-foreground">Restart the WhatsApp connection</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (window.confirm('Restart the WhatsApp connection?')) {
                  restartWhatsappMutation.mutate();
                }
              }}
              disabled={restartWhatsappMutation.isPending}
            >
              {restartWhatsappMutation.isPending ? 'Restarting...' : 'Restart'}
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Delete WhatsApp Connection</p>
              <p className="text-xs text-muted-foreground">Clear the stale session and generate a fresh QR to re-pair</p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (window.confirm('Delete the WhatsApp connection and generate a new QR? You will need to re-scan from your phone.')) {
                  resetWhatsappMutation.mutate();
                }
              }}
              disabled={resetWhatsappMutation.isPending}
            >
              {resetWhatsappMutation.isPending ? 'Resetting...' : 'Delete & Re-pair'}
            </Button>
          </div>
        </div>
      </Card>

      <Card title="About">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">App Version</span>
            <p className="text-sm font-medium">v1.0.0</p>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Dashboard</span>
            <p className="text-sm font-medium">Next.js 15</p>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Backend</span>
            <p className="text-sm font-medium">Express</p>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Monorepo</span>
            <p className="text-sm font-medium">Turborepo</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
