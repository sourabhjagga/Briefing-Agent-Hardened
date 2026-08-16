"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api-client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Dialog } from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/data-table";
import { useToast } from "@/components/toast-provider";
import { CardSkeleton } from "@/components/ui/skeleton";

const SITES = ["youtube", "technofino", "desidime", "reddit"] as const;
type Site = (typeof SITES)[number];

interface CookieEntry {
  site: string;
  has_cookies: boolean;
  updated_at: string | null;
  expires_at: number | null;
  is_valid: boolean | null;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "\u2014";
  const d = new Date(dateStr);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function CookiesPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [importSite, setImportSite] = useState<Site | null>(null);
  const [cookiesText, setCookiesText] = useState("");

  const { data: cookies, isLoading } = useQuery<CookieEntry[]>({
    queryKey: ["cookies"],
    queryFn: () => apiRequest<CookieEntry[]>("/api/cookies"),
  });

  const cookiesMap = new Map(cookies?.map((c) => [c.site, c]));

  const invalidate = () => {
    queryClient.removeQueries({ queryKey: ["cookies"] });
  };

  const importMutation = useMutation({
    mutationFn: ({ site, cookies }: { site: string; cookies: string }) =>
      apiRequest("/api/cookies/import", {
        method: "POST",
        body: JSON.stringify({ site, cookies }),
      }),
    onSuccess: () => {
      invalidate();
      setImportSite(null);
      setCookiesText("");
      toast("Cookies imported", "success");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (site: string) =>
      apiRequest(`/api/cookies/${encodeURIComponent(site)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      invalidate();
      toast("Cookies deleted", "success");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const handleDelete = (site: string) => {
    if (window.confirm(`Delete cookies for ${site}?`)) {
      deleteMutation.mutate(site);
    }
  };

  const handleImport = (site: Site) => {
    setImportSite(site);
    setCookiesText("");
  };

  const columns: Column<CookieEntry>[] = [
    { key: "site", header: "Site", sortable: true },
    {
      key: "has_cookies",
      header: "Has Cookies",
      sortable: true,
      render: (c) => (
        <Badge variant={c.has_cookies ? "success" : "secondary"}>
          {c.has_cookies ? "\u2713 Configured" : "\u2717 Not Set"}
        </Badge>
      ),
    },
    {
      key: "updated_at",
      header: "Last Updated",
      sortable: true,
      render: (c) => (
        <span className="text-sm text-muted-foreground">
          {formatDate(c.updated_at)}
        </span>
      ),
    },
    {
      key: "expires_at",
      header: "Expires",
      sortable: true,
      render: (c) => (
        c.expires_at ? (
          <span className={`text-sm ${c.is_valid === false ? "text-danger" : "text-success"}`}>{new Date(c.expires_at * 1000).toLocaleDateString()}</span>
        ) : c.has_cookies ? (
          <span className="text-sm text-warning">Session</span>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )
      ),
    },
    {
      key: "is_valid",
      header: "Status",
      sortable: true,
      render: (c) => (
        c.is_valid === false ? (
          <Badge variant="destructive">Expired</Badge>
        ) : c.is_valid === true ? (
          <Badge variant="success">Valid</Badge>
        ) : c.has_cookies ? (
          <Badge variant="info">Session</Badge>
        ) : (
          <Badge variant="secondary">Not Set</Badge>
        )
      ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (c) => (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleImport(c.site as Site)}
          >
            Import
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleDelete(c.site)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex-1 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Cookies</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {isLoading
          ? Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)
          : SITES.map((site) => {
              const entry = cookiesMap.get(site);
              return (
                <Card key={site}>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium capitalize">
                        {site}
                      </span>
                      <div className="flex flex-col items-end gap-1">
                        <Badge
                          variant={entry?.has_cookies ? "success" : "secondary"}
                        >
                          {entry?.has_cookies ? "Configured" : "Not Set"}
                        </Badge>
                        {entry?.is_valid === false && (
                          <Badge variant="destructive" className="text-xs">Expired</Badge>
                        )}
                        {entry?.is_valid === true && (
                          <Badge variant="success" className="text-xs">Valid</Badge>
                        )}
                        {entry?.is_valid === null && entry?.has_cookies && (
                          <Badge variant="info" className="text-xs">Session</Badge>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Last Updated: {formatDate(entry?.updated_at ?? null)}
                    </div>
                    {entry?.expires_at && (
                      <div className="text-xs">
                        Expires: {new Date(entry.expires_at * 1000).toLocaleDateString()}
                      </div>
                    )}
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleImport(site)}
                      >
                        Import Cookies
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(site)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
      </div>

      <Card title="All Cookie Entries">
        <DataTable<CookieEntry>
          columns={columns}
          data={cookies || []}
          keyExtractor={(c) => c.site}
          isLoading={isLoading}
          searchable
          searchPlaceholder="Search cookies..."
          pageSize={10}
          emptyMessage="No cookie entries found"
        />
      </Card>

      <Dialog
        open={importSite !== null}
        onClose={() => setImportSite(null)}
        title={`Import Cookies - ${importSite ?? ""}`}
        size="lg"
      >
        <div className="space-y-4">
          <div className="text-sm text-muted-foreground">
            Paste cookies as a <strong>JSON array</strong> or <strong>Netscape HTTP Cookie File</strong>
            {importSite === "youtube" && (
              <span className="block mt-1 text-xs">Tip: YouTube cookies exported via browser extensions are often in Netscape format — paste them directly.</span>
            )}
          </div>
          <Textarea
            placeholder='[{"name": "session", "value": "abc123", "domain": ".example.com"}]'
            value={cookiesText}
            onChange={(e) => setCookiesText(e.target.value)}
            rows={10}
            className="font-mono text-xs"
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setImportSite(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={importMutation.isPending || !cookiesText.trim()}
              onClick={() => {
                if (importSite) {
                  importMutation.mutate({
                    site: importSite,
                    cookies: cookiesText,
                  });
                }
              }}
            >
              {importMutation.isPending ? "Importing..." : "Import"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
