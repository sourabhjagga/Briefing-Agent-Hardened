"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api-client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { useToast } from "@/components/toast-provider";
import { CardSkeleton, TableRowSkeleton } from "@/components/ui/skeleton";
import { formatUptime, formatTimestamp } from "@/lib/utils";
import Link from "next/link";
interface HealthStatus {
  healthy: boolean;
  whatsapp: 'connected' | 'connecting';
  messagesToday: number;
  targetGroups: number;
  uptime: number;
}

interface ScraperHealth {
  source_id: string;
  source_type: string;
  last_success: number;
  last_attempt: number;
  error_count: number;
}

interface SourceStats {
  source_type: string;
  total: number;
  today: number;
}

interface DashboardStats {
  whatsappTotalMessages: number;
  scraperStats: SourceStats[];
}

export default function Dashboard() {
  const [searchTerm, setSearchTerm] = useState('');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const refreshDashboard = () => {
    queryClient.invalidateQueries({ queryKey: ['health'] });
    queryClient.invalidateQueries({ queryKey: ['scraper-health'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
    toast('Dashboard refreshed', 'success');
  };

  const triggerAllBriefs = () => {
    apiRequest('/api/schedules/trigger', { method: 'POST', body: '{}' })
      .then(() => toast('All briefs triggered', 'success'))
      .catch((err: Error) => toast(err.message, 'error'));
  };

  const { data: health, isLoading: healthLoading } = useQuery<HealthStatus>({
    queryKey: ['health'],
    queryFn: () => apiRequest<HealthStatus>('/health'),
  });

  const { data: scraperHealth, isLoading: scraperLoading } = useQuery<ScraperHealth[]>({
    queryKey: ['scraper-health'],
    queryFn: () => apiRequest<ScraperHealth[]>('/api/health'),
  });

  const { data: stats } = useQuery<DashboardStats>({
    queryKey: ['dashboard-stats'],
    queryFn: () => apiRequest<DashboardStats>('/api/stats'),
  });

  const scraperStatsMap = new Map(stats?.scraperStats.map(s => [s.source_type, s]));

  const groupedHealth = scraperHealth?.reduce<Record<string, ScraperHealth[]>>((acc, s) => {
    (acc[s.source_type] ??= []).push(s);
    return acc;
  }, {});
  const healthSummary = Object.entries(groupedHealth || {}).map(([type, rows]) => ({
    source_type: type,
    total: rows.length,
    healthy: rows.filter(r => r.error_count === 0).length,
    totalErrors: rows.reduce((sum, r) => sum + r.error_count, 0),
    lastSuccess: rows.reduce((latest, r) => Math.max(latest, r.last_success), 0),
    lastAttempt: rows.reduce((latest, r) => Math.max(latest, r.last_attempt), 0),
  }));

  const formatTimeAgo = formatTimestamp;

  return (
    <div className="flex-1 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="flex items-center gap-2">
          <Badge variant="outline">v1.0.0</Badge>
          <Button variant="outline" size="sm" onClick={refreshDashboard}>Refresh</Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card title="WhatsApp Status">
          {healthLoading ? (
            <CardSkeleton />
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Connection</span>
                <Badge
                  variant={health?.whatsapp === 'connected' ? 'success' : 'warning'}
                >
                  {health?.whatsapp === 'connected' ? 'Connected' : 'Connecting'}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Messages Today</span>
                <span className="text-sm text-muted-foreground">
                  {health?.messagesToday || '0'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Total Collected</span>
                <span className="text-sm text-muted-foreground">
                  {stats?.whatsappTotalMessages?.toLocaleString() || '0'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Target Groups</span>
                <span className="text-sm text-muted-foreground">
                  {health?.targetGroups || '0'}
                </span>
              </div>
            </div>
          )}
        </Card>

        <Card title="Scraper Health">
          {scraperLoading ? (
            <CardSkeleton />
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Healthy Scrapers</span>
                <span className="text-sm font-medium">
                  {scraperHealth?.filter(s => s.error_count === 0).length || 0} / {scraperHealth?.length || 0}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Total Errors</span>
                <span className="text-sm text-muted-foreground">
                  {scraperHealth?.reduce((sum, s) => sum + s.error_count, 0) || 0}
                </span>
              </div>
            </div>
          )}
        </Card>

        <Card title="System Status">
          {healthLoading ? (
            <CardSkeleton />
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Uptime</span>
                <span className="text-sm text-muted-foreground">
                  {health?.uptime ? formatUptime(health.uptime) : '0m'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Health Check</span>
                <Badge variant={health?.healthy ? 'success' : 'destructive'}>
                  {health?.healthy ? 'Healthy' : 'Unhealthy'}
                </Badge>
              </div>
            </div>
          )}
        </Card>

        <Card title="Quick Actions">
          <div className="flex flex-col gap-2">
            <Button variant="default" size="sm" onClick={triggerAllBriefs}>Trigger All Briefs</Button>
            <Link href="/settings">
              <Button variant="outline" size="sm" className="w-full">System Settings</Button>
            </Link>
            <Button variant="ghost" size="sm" onClick={() => toast('View logs feature coming soon', 'info')}>View Logs</Button>
          </div>
        </Card>
      </div>

      <div className="flex items-center gap-2">
        <Input
          placeholder="Search sources..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="max-w-sm"
        />
      </div>

      <Card title="Scraper Health">
        {scraperLoading ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-3 px-4 font-medium">Source</th>
                  <th className="text-left py-3 px-4 font-medium">Type</th>
                  <th className="text-left py-3 px-4 font-medium">Msgs Collected</th>
                  <th className="text-left py-3 px-4 font-medium">In Last Brief</th>
                  <th className="text-left py-3 px-4 font-medium">Last Success</th>
                  <th className="text-left py-3 px-4 font-medium">Last Attempt</th>
                  <th className="text-left py-3 px-4 font-medium">Errors</th>
                  <th className="text-left py-3 px-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 5 }).map((_, i) => (
                  <TableRowSkeleton key={i} cols={8} />
                ))}
              </tbody>
            </table>
          </div>
        ) : scraperHealth?.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">No scraper health data yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-3 px-4 font-medium">Category</th>
                  <th className="text-left py-3 px-4 font-medium">Sources</th>
                  <th className="text-left py-3 px-4 font-medium">Healthy</th>
                  <th className="text-left py-3 px-4 font-medium">Msgs Collected</th>
                  <th className="text-left py-3 px-4 font-medium">In Last Brief</th>
                  <th className="text-left py-3 px-4 font-medium">Last Success</th>
                  <th className="text-left py-3 px-4 font-medium">Last Attempt</th>
                  <th className="text-left py-3 px-4 font-medium">Errors</th>
                  <th className="text-left py-3 px-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {healthSummary.
                  filter((s) =>
                    s.source_type.toLowerCase().includes(searchTerm.toLowerCase())
                  )
                  .map((s) => {
                    const ss = scraperStatsMap.get(s.source_type);
                    return (
                    <tr key={s.source_type} className="border-b hover:bg-surface-2">
                      <td className="py-3 px-4">
                        <Badge variant="info" className="text-xs">
                          {s.source_type}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 text-muted-foreground font-medium">
                        {s.total}
                      </td>
                      <td className="py-3 px-4 text-muted-foreground font-medium">
                        {s.healthy}
                      </td>
                      <td className="py-3 px-4 text-muted-foreground font-medium">
                        {ss?.total?.toLocaleString() || '0'}
                      </td>
                      <td className="py-3 px-4 text-muted-foreground">
                        {ss?.today?.toLocaleString() || '0'}
                      </td>
                      <td className="py-3 px-4 text-muted-foreground">
                        {s.lastSuccess ? formatTimeAgo(s.lastSuccess) : '\u2014'}
                      </td>
                      <td className="py-3 px-4 text-muted-foreground">
                        {s.lastAttempt ? formatTimeAgo(s.lastAttempt) : '\u2014'}
                      </td>
                      <td className="py-3 px-4">
                        {s.totalErrors > 0 ? (
                          <span className="text-destructive font-medium">
                            {s.totalErrors}
                          </span>
                        ) : (
                          <span className="text-success">0</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <Badge
                          variant={s.healthy === s.total ? 'success' : s.healthy > 0 ? 'warning' : 'destructive'}
                          className="text-xs"
                        >
                          {s.healthy === s.total ? 'All Healthy' : s.healthy > 0 ? 'Partial' : 'All Errors'}
                        </Badge>
                      </td>
                    </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
