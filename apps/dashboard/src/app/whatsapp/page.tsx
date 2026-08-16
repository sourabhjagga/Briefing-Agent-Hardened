"use client";

import { useState, useEffect } from "react";
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
import { Plus, Trash2, Search, RefreshCw, Wifi, WifiOff, Loader2 } from "lucide-react";

interface WhatsAppSource extends Record<string, unknown> {
  id: number;
  name: string;
  source_id: string;
  type: string;
  is_active: boolean;
}

interface DiscoveredGroup {
  id: string;
  name: string;
  participantCount?: number;
}

interface Category {
  id: number;
  slug: string;
  display_name: string;
}

interface HealthStatus {
  healthy: boolean;
  whatsapp: string;
  messagesToday: number;
  targetGroups: number;
  uptime: number;
}

function extractCategory(type: string): string {
  const idx = type.indexOf("-whatsapp");
  return idx > 0 ? type.slice(0, idx) : type;
}

export default function WhatsAppPage() {
  const [addOpen, setAddOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [discoverEnabled, setDiscoverEnabled] = useState(false);
  const [form, setForm] = useState({ name: "", source_id: "", category_slug: "" });
  const [whatsappStatus, setWhatsAppStatus] = useState<string>("unknown");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch WhatsApp connection status from health endpoint
  const { data: health, refetch: refetchHealth } = useQuery<HealthStatus>({
    queryKey: ["health"],
    queryFn: () => apiRequest<HealthStatus>("/health"),
    refetchInterval: 10000, // Refetch every 10 seconds
    staleTime: 5000,
  });

  // Update local state when health data changes
  useEffect(() => {
    if (health) {
      setWhatsAppStatus(health.whatsapp);
    }
  }, [health]);

  const { data: sources = [], isLoading: sourcesLoading } = useQuery<WhatsAppSource[]>({
    queryKey: ["whatsapp-sources"],
    queryFn: () => apiRequest<WhatsAppSource[]>("/api/whatsapp/sources"),
    staleTime: 0,
  });

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () => apiRequest<Category[]>("/api/categories"),
  });

  const { data: discovered = [], isLoading: discoverLoading, refetch: refetchDiscover } = useQuery<DiscoveredGroup[]>({
    queryKey: ["whatsapp-discover"],
    queryFn: () => apiRequest<DiscoveredGroup[]>("/api/whatsapp/discover"),
    enabled: discoverEnabled,
  });

  const createMutation = useMutation({
    mutationFn: (body: typeof form) =>
      apiRequest("/api/whatsapp/sources", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-sources"] });
      queryClient.invalidateQueries({ queryKey: ["whatsapp-discover"] });
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setAddOpen(false);
      setForm({ name: "", source_id: "", category_slug: "" });
      toast("Source created", "success");
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
      queryClient.invalidateQueries({ queryKey: ["whatsapp-sources"] });
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      toast("Source updated", "success");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest(`/api/whatsapp/sources/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-sources"] });
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setDeleteId(null);
      toast("Source deleted", "success");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const handleDiscover = () => {
    if (!discoverEnabled) {
      setDiscoverEnabled(true);
    } else {
      refetchDiscover();
    }
  };

  const addedSourceIds = new Set(sources.map((s) => s.source_id));

  const handleAddFromDiscover = (group: DiscoveredGroup) => {
    setForm({ name: group.name, source_id: group.id, category_slug: categories[0]?.slug || "" });
    setAddOpen(true);
  };

  const handleOpenAdd = () => {
    setForm({ name: "", source_id: "", category_slug: categories[0]?.slug || "" });
    setAddOpen(true);
  };

  const categoryOptions = categories.map((c) => ({
    value: c.slug,
    label: c.display_name,
  }));

  const sourceColumns: Column<WhatsAppSource>[] = [
    { key: "source_id", header: "Source ID / JID", sortable: true, render: (item) => <span className="font-mono text-xs">{item.source_id}</span> },
    { key: "name", header: "Name", sortable: true },
    {
      key: "type",
      header: "Category",
      sortable: true,
      render: (item) => (
        <Badge variant="info">{extractCategory(item.type)}</Badge>
      ),
    },
    {
      key: "is_active",
      header: "Status",
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
      key: "id",
      header: "",
      className: "w-12",
      render: (item) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setDeleteId(item.id);
          }}
        >
          <Trash2 className="h-4 w-4 text-danger" />
        </Button>
      ),
    },
  ];

  const isAdded = (groupId: string) => addedSourceIds.has(groupId);

  const groupColumns: Column<DiscoveredGroup>[] = [
    { key: "name", header: "Name", sortable: true },
    {
      key: "id",
      header: "ID",
      sortable: true,
      render: (item) => (
        <span className="font-mono text-xs">{item.id}</span>
      ),
    },
    {
      key: "participantCount",
      header: "Participants",
      sortable: true,
      render: (item) =>
        item.participantCount != null ? (
          item.participantCount
        ) : (
          <span className="text-text-muted">&mdash;</span>
        ),
    },
    {
      key: "id",
      header: "",
      className: "w-24",
      render: (item) =>
        isAdded(item.id) ? (
          <Badge variant="secondary">Added</Badge>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleAddFromDiscover(item)}
          >
            <Plus className="h-3 w-3" />
            Add
          </Button>
        ),
    },
  ];

  // Refresh timestamp for cache-busting QR image
  const [qrTimestamp, setQrTimestamp] = useState(Date.now());
  const [qrForce, setQrForce] = useState(false);

  const fetchQrCode = (force = false) => {
    setQrForce(force);
    setQrTimestamp(Date.now());
    toast("QR code refreshed", "success");
  };

  // Refresh QR when status changes to connecting/close
  useEffect(() => {
    if (whatsappStatus === "connecting" || whatsappStatus === "close") {
      setQrTimestamp(Date.now());
    }
  }, [whatsappStatus]);

  const isConnected = whatsappStatus === "connected";

  return (
    <div className="flex-1 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">WhatsApp</h1>
        <div className="flex items-center gap-2">
          <span className={`flex items-center gap-1.5 text-sm font-medium ${
            isConnected ? "text-success" : "text-warning"
          }`}>
            {isConnected ? (
              <Wifi className="h-4 w-4" />
            ) : (
              <WifiOff className="h-4 w-4" />
            )}
            <span className="capitalize">{whatsappStatus}</span>
          </span>
          {!isConnected && (
            <Button variant="outline" size="sm" onClick={() => fetchQrCode(true)} disabled={whatsappStatus !== "connecting" && whatsappStatus !== "close"}>
              <RefreshCw className="h-4 w-4 mr-1" />
              Refresh QR
            </Button>
          )}
        </div>
      </div>

      {/* QR Code Display when disconnected */}
      {!isConnected && (
        <Card className="border-warning">
          <div className="p-4 text-center">
            <h3 className="mb-3 font-medium text-warning">Scan QR Code to Connect WhatsApp</h3>
            <div className="inline-block p-2 bg-background rounded border">
              <img 
                src={`/api/whatsapp/qr?t=${qrTimestamp}${qrForce ? '&force=1' : ''}`}
                alt="WhatsApp QR Code" 
                className="w-64 h-64" 
                style={{ maxWidth: "100%" }}
                onError={(e) => {
                  // If image fails to load, show placeholder
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            </div>
            <p className="mt-3 text-sm text-text-muted">
              Open WhatsApp → Settings → Linked Devices → Link a Device
            </p>
            <Button variant="outline" size="sm" onClick={() => fetchQrCode(true)} className="mt-2">
              <RefreshCw className="h-4 w-4 mr-1" />
              Refresh QR Code
            </Button>
          </div>
        </Card>
      )}

      <Card title="WhatsApp Sources">
        <div className="mb-4 flex items-center justify-between">
          <div />
          <Button onClick={handleOpenAdd}>
            <Plus className="h-4 w-4" />
            Add Source
          </Button>
        </div>
        <DataTable<WhatsAppSource>
          columns={sourceColumns}
          data={sources}
          keyExtractor={(item) => item.id}
          isLoading={sourcesLoading}
          searchable
          searchPlaceholder="Search sources..."
        />
      </Card>

      <Card title="Discovered Groups">
        <div className="mb-4 flex items-center justify-between">
          <div />
          <Button onClick={handleDiscover} disabled={discoverLoading}>
            <Search className="h-4 w-4" />
            {discoverEnabled ? "Refresh" : "Discover Groups"}
          </Button>
        </div>
        {discoverEnabled ? (
          <DataTable<DiscoveredGroup>
            columns={groupColumns}
            data={discovered}
            keyExtractor={(item) => item.id}
            isLoading={discoverLoading}
            searchable
            searchPlaceholder="Search groups..."
          />
        ) : (
          <div className="flex items-center justify-center py-12 text-sm text-text-muted">
            Click &ldquo;Discover Groups&rdquo; to fetch available WhatsApp groups
          </div>
        )}
      </Card>

      <Dialog
        open={addOpen}
        onClose={() => { setAddOpen(false); setForm({ name: "", source_id: "", category_slug: "" }); }}
        title="Add WhatsApp Source"
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
              placeholder="e.g. group-jid@s.whatsapp.net"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Category</label>
            <Select
              value={form.category_slug}
              onChange={(e) => setForm({ ...form, category_slug: e.target.value })}
              options={categoryOptions}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => { setAddOpen(false); setForm({ name: "", source_id: "", category_slug: "" }); }}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate(form)}
              disabled={!form.name || !form.source_id || !form.category_slug || createMutation.isPending}
            >
              {createMutation.isPending ? "Creating..." : "Create"}
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
            Are you sure you want to delete this WhatsApp source? This action
            cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteId !== null && deleteMutation.mutate(deleteId)}
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