"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api-client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog } from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/data-table";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/toast-provider";
import { Plus, Trash2 } from "lucide-react";

interface Source {
  id: number;
  name: string;
  source_id: string;
  type: string;
  is_active: boolean;
  category_slug: string | null;
  url: string | null;
  is_private: number;
  health_status?: string;
  health_last_error?: string;
  message_count?: number;
  today_count?: number;
}

interface Category {
  id: number;
  slug: string;
  display_name: string;
  is_active: boolean;
}

interface SourceType {
  id: number;
  slug: string;
  display_name: string;
}

function displayType(type: string): string {
  const idx = type.lastIndexOf('-');
  return idx >= 0 ? type.slice(idx + 1) : type;
}

export default function SourcesPage() {
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingSource, setEditingSource] = useState<Source | null>(null);
  const [editTypeId, setEditTypeId] = useState<number | null>(null);
  const [editTypeValue, setEditTypeValue] = useState("");
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", source_id: "", type: "", category_slug: "", url: "", is_private: false });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: sourcesRaw = [], isLoading } = useQuery<Source[]>({
    queryKey: ["sources"],
    queryFn: () => apiRequest<Source[]>("/api/sources"),
  });

  const { data: sourceStats = [] } = useQuery<Source[]>({
    queryKey: ["source-stats"],
    queryFn: () => apiRequest<Source[]>("/api/source-stats"),
    refetchInterval: 60_000,
  });

  const statsMap = new Map(sourceStats.map(s => [s.id, s]));
  const sources = sourcesRaw.map(s => ({ ...s, ...statsMap.get(s.id) }));

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () => apiRequest<Category[]>("/api/categories"),
  });

  const { data: sourceTypes = [] } = useQuery<SourceType[]>({
    queryKey: ["source-types"],
    queryFn: () => apiRequest<SourceType[]>("/api/source-types"),
  });

  const sourceTypeOptions = sourceTypes.map(st => ({
    value: st.slug,
    label: st.display_name,
  }));

  const sourceIdPlaceholders: Record<string, string> = {};
  for (const st of sourceTypes) {
    sourceIdPlaceholders[st.slug] = `e.g. enter ${st.display_name} source identifier`;
  }

  const createMutation = useMutation({
    mutationFn: (body: { name: string; source_id: string; type: string; category_slug?: string; url?: string; is_private?: number }) =>
      apiRequest("/api/sources", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setAddOpen(false);
      setForm({ name: "", source_id: "", type: sourceTypes[0]?.slug || "", category_slug: categories[0]?.slug || "", url: "", is_private: false });
      toast("Source created", "success");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: { name?: string; type?: string; category_slug?: string | null; url?: string; is_private?: number } }) =>
      apiRequest(`/api/sources/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setEditOpen(false);
      setEditingSource(null);
      toast("Source updated", "success");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
      apiRequest(`/api/sources/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      toast("Source updated", "success");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const updateTypeMutation = useMutation({
    mutationFn: ({ id, type, category_slug }: { id: number; type: string; category_slug?: string | null }) =>
      apiRequest(`/api/sources/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ type, category_slug }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setEditTypeId(null);
      setEditTypeValue("");
      toast("Source type updated", "success");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest(`/api/sources/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setDeleteId(null);
      toast("Source deleted", "success");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const columns: Column<Source>[] = [
    { key: "id", header: "ID", sortable: true, className: "w-16", render: (item) => <span title="Database row ID">{item.id}</span> },
    { key: "name", header: "Name", sortable: true },
    {
      key: "source_id",
      header: "Source ID",
      sortable: true,
      render: (item) => (
        <span className="font-mono text-xs">{item.source_id}</span>
      ),
    },
    {
      key: "category_slug",
      header: "Category",
      sortable: true,
      render: (item) => {
        const cat = categories.find(c => c.slug === item.category_slug);
        return cat ? (
          <Badge variant="secondary">{cat.display_name}</Badge>
        ) : item.category_slug ? (
          <Badge variant="secondary">{item.category_slug}</Badge>
        ) : (
          <span className="text-xs text-text-secondary">—</span>
        );
      },
    },
    {
      key: "type",
      header: "Type",
      sortable: true,
      render: (item) =>
        editTypeId === item.id ? (
          <div className="flex items-center gap-2">
            <Select
              value={editTypeValue}
              onChange={(e) => setEditTypeValue(e.target.value)}
              options={sourceTypeOptions}
              className="h-8 text-xs"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                updateTypeMutation.mutate({ id: item.id, type: editTypeValue, category_slug: item.category_slug })
              }
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditTypeId(null)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Badge
            variant={displayType(item.type) === "whatsapp" ? "info" : "secondary"}
            className="cursor-pointer"
            onClick={() => {
              setEditTypeId(item.id);
              setEditTypeValue(displayType(item.type));
            }}
          >
            {displayType(item.type)}
          </Badge>
        ),
    },
    {
      key: "url",
      header: "URL",
      sortable: true,
      render: (item) => (
        <span className="text-xs text-text-secondary truncate max-w-48 block" title={item.url || ""}>
          {item.url || "—"}
        </span>
      ),
    },
    {
      key: "is_private",
      header: "Private",
      render: (item) => item.is_private ? <Badge variant="warning">Yes</Badge> : <span className="text-xs text-text-secondary">No</span>,
    },
    {
      key: "is_active",
      header: "Active",
      render: (item) => (
        <Switch
          checked={item.is_active}
          onChange={(checked) =>
            toggleMutation.mutate({ id: item.id, is_active: checked })
          }
        />
      ),
    },
    {
      key: "health_status",
      header: "Health",
      sortable: true,
      render: (item) => {
        const badgeVariant = item.health_status === "healthy" ? "success" as const
          : item.health_status === "warning" ? "warning" as const
          : item.health_status === "error" ? "destructive" as const
          : "secondary" as const;
        const label = item.health_status === "healthy" ? "OK"
          : item.health_status === "warning" ? "Degraded"
          : item.health_status === "error" ? "Failing"
          : item.health_status === "unknown" ? "—" : "—";
        return (
          <div className="flex items-center gap-2">
            <Badge variant={badgeVariant} title={item.health_last_error || ""}>{label}</Badge>
            <span className="text-xs text-text-secondary">
              {item.today_count != null && (
                <span title={`${item.message_count} total messages`}>{item.today_count}</span>
              )}
            </span>
          </div>
        );
      },
    },
    {
      key: "id",
      header: "",
      className: "w-24",
      render: (item) => (
        <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditingSource(item);
                setForm({ name: item.name, source_id: item.source_id, type: displayType(item.type), category_slug: item.category_slug || "", url: item.url || "", is_private: !!item.is_private });
                setEditOpen(true);
              }}
            >
              Edit
            </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDeleteId(item.id)}
          >
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex-1 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Sources</h1>
        <Button onClick={() => {
          setForm({ name: "", source_id: "", type: sourceTypes[0]?.slug || "", category_slug: categories[0]?.slug || "", url: "", is_private: false });
          setAddOpen(true);
        }}>
          <Plus className="h-4 w-4" />
          Add Source
        </Button>
      </div>

      <Card className="p-4 space-y-3">
        <h2 className="font-semibold">How Sources Work</h2>
        <p className="text-sm text-text-secondary">
          Every source the agent monitors comes from this table — nothing is hardcoded. Fill in the fields below when adding or editing a source. The scraper reads <code className="bg-surface-alt px-1 rounded">url</code> and <code className="bg-surface-alt px-1 rounded">is_private</code> from each source row at runtime.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div className="space-y-1">
            <h3 className="font-medium">Forums</h3>
            <p className="text-text-secondary">Set <strong>URL</strong> to the forum page URL (e.g. <code className="bg-surface-alt px-1 rounded text-xs">https://technofino.in/community/forums/.../</code>). Toggle <strong>is_private</strong> ON if the forum requires a logged-in session. The scraper alerts when private sources return 0 threads for 2 consecutive runs.</p>
          </div>
          <div className="space-y-1">
            <h3 className="font-medium">Deals</h3>
            <p className="text-text-secondary">Set <strong>URL</strong> to the deals listing page (e.g. <code className="bg-surface-alt px-1 rounded text-xs">https://www.desidime.com/forums/hot-deals-online</code>). Only the first active deals source is used per run.</p>
          </div>
          <div className="space-y-1">
            <h3 className="font-medium">Reddit</h3>
            <p className="text-text-secondary">Set <strong>Source ID</strong> to the subreddit name without <code className="bg-surface-alt px-1 rounded text-xs">r/</code> (e.g. <code className="bg-surface-alt px-1 rounded text-xs">CreditCardsIndia</code>). URL is optional but can be the subreddit URL.</p>
          </div>
          <div className="space-y-1">
            <h3 className="font-medium">YouTube</h3>
            <p className="text-text-secondary">Set <strong>Source ID</strong> to the channel ID or <code className="bg-surface-alt px-1 rounded text-xs">@handle</code>. URL is optional. Channel not found errors are handled gracefully.</p>
          </div>
          <div className="space-y-1">
            <h3 className="font-medium">WhatsApp</h3>
            <p className="text-text-secondary">Set <strong>Source ID</strong> to the group JID (<code className="bg-surface-alt px-1 rounded text-xs">120363xxx@g.us</code>) or newsletter/channel JID (<code className="bg-surface-alt px-1 rounded text-xs">120363xxx@newsletter</code>). URL is not used.</p>
          </div>
          <div className="space-y-1">
            <h3 className="font-medium">Telegram</h3>
            <p className="text-text-secondary">Set <strong>Source ID</strong> to the <code className="bg-surface-alt px-1 rounded text-xs">@username</code> or chat ID. URL is not used.</p>
          </div>
          <div className="space-y-1">
            <h3 className="font-medium">RSS</h3>
            <p className="text-text-secondary">Set <strong>URL</strong> to the RSS/Atom feed URL. The scraper fetches new entries on each cycle and tracks already-seen GUIDs to avoid duplicates.</p>
          </div>
          <div className="space-y-1">
            <h3 className="font-medium">Email</h3>
            <p className="text-text-secondary">Set <strong>Source ID</strong> to a label/folder name (e.g. <code className="bg-surface-alt px-1 rounded text-xs">INBOX</code>). <strong>URL</strong> optionally sets IMAP folder. Requires IMAP credentials in env.</p>
          </div>
          <div className="space-y-1">
            <h3 className="font-medium">JSON API</h3>
            <p className="text-text-secondary">Set <strong>URL</strong> to the JSON API endpoint. <strong>Source ID</strong> is an optional sub-path or identifier. The scraper GETs the URL and inserts each object with <code className="bg-surface-alt px-1 rounded text-xs">body</code> or <code className="bg-surface-alt px-1 rounded text-xs">title</code> fields.</p>
          </div>
          <div className="space-y-1">
            <h3 className="font-medium">Webhook</h3>
            <p className="text-text-secondary">No configuration needed — sources of this type accept incoming POST requests at <code className="bg-surface-alt px-1 rounded text-xs">/api/webhook/{'{sourceId}'}</code>. Set <strong>Source ID</strong> as the unique slug you'll use in the webhook URL.</p>
          </div>
        </div>
      </Card>

      <Card>
        <DataTable<Source>
          columns={columns}
          data={sources}
          keyExtractor={(item) => item.id}
          isLoading={isLoading}
          searchable
          searchPlaceholder="Search sources..."
        />
      </Card>

      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Source"
        size="md"
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Name</label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Source name"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Source ID</label>
            <Input
              value={form.source_id}
              onChange={(e) => setForm({ ...form, source_id: e.target.value })}
              placeholder={sourceIdPlaceholders[form.type] || "Source ID"}
            />
            <p className="mt-1 text-xs text-text-secondary">
              {form.type === "forums" && "Website slug or name the scraper uses to identify this source"}
              {form.type === "reddit" && "Subreddit name without r/ prefix"}
              {form.type === "youtube" && "YouTube channel ID or @handle for the scraper"}
              {form.type === "whatsapp" && "WhatsApp group/channel JID (e.g. 120363xxx@g.us)"}
              {(form.type !== "forums" && form.type !== "reddit" && form.type !== "youtube" && form.type !== "whatsapp") && `Enter the ${sourceTypes.find(st => st.slug === form.type)?.display_name || form.type} source identifier`}
            </p>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Type</label>
            <Select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              options={sourceTypeOptions}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Category</label>
            <Select
              value={form.category_slug}
              onChange={(e) => setForm({ ...form, category_slug: e.target.value })}
              options={categories.map(c => ({ value: c.slug, label: c.display_name }))}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">URL</label>
            <Input
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="Scraper target URL (forums/deals)"
            />
            <p className="mt-1 text-xs text-text-secondary">
              Required for forums and deals sources. The scraper navigates to this URL to collect posts.
            </p>
          </div>
          <div>
            <Switch
              checked={form.is_private}
              onChange={(checked) => setForm({ ...form, is_private: checked })}
              label="Requires login (is_private)"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate({
                name: form.name,
                source_id: form.source_id,
                type: form.type,
                category_slug: form.category_slug,
                url: form.url || undefined,
                is_private: form.is_private ? 1 : 0,
              })}
              disabled={!form.name || !form.source_id || !form.type || !form.category_slug || createMutation.isPending}
            >
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={editOpen}
        onClose={() => { setEditOpen(false); setEditingSource(null); }}
        title="Edit Source"
        size="md"
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Name</label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Source name"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Type</label>
            <Select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              options={sourceTypeOptions}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Category</label>
            <Select
              value={form.category_slug}
              onChange={(e) => setForm({ ...form, category_slug: e.target.value })}
              options={categories.map(c => ({ value: c.slug, label: c.display_name }))}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">URL</label>
            <Input
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="Scraper target URL (forums/deals)"
            />
          </div>
          <div>
            <Switch
              checked={form.is_private}
              onChange={(checked) => setForm({ ...form, is_private: checked })}
              label="Requires login (is_private)"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => { setEditOpen(false); setEditingSource(null); }}>
              Cancel
            </Button>
            <Button
              onClick={() => editingSource && updateMutation.mutate({
                id: editingSource.id,
                data: {
                  name: form.name,
                  type: form.type,
                  category_slug: form.category_slug,
                  url: form.url || undefined,
                  is_private: form.is_private ? 1 : 0,
                }
              })}
              disabled={!form.name || !form.type || !form.category_slug || updateMutation.isPending}
            >
              {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        title="Delete Source"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Are you sure you want to delete this source? This action cannot be
            undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                deleteId !== null && deleteMutation.mutate(deleteId)
              }
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
