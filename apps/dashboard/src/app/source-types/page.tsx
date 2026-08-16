"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api-client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/data-table";
import { useToast } from "@/components/toast-provider";
import { Plus, Trash2 } from "lucide-react";

interface SourceType {
  id: number;
  slug: string;
  display_name: string;
}

interface FormState {
  slug: string;
  display_name: string;
}

const defaultForm: FormState = { slug: "", display_name: "" };

const SLUG_PATTERN = /^[a-z]+$/;

export default function SourceTypesPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState<SourceType | null>(null);
  const [editing, setEditing] = useState<SourceType | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [slugError, setSlugError] = useState("");

  const updateField = (field: string, value: string) => {
    if (field === "slug") {
      const v = value.toLowerCase().replace(/[^a-z]/g, "");
      setForm((prev) => ({ ...prev, slug: v }));
      setSlugError(v.length > 0 && !SLUG_PATTERN.test(v) ? "Only lowercase letters allowed" : "");
    } else {
      setForm((prev) => ({ ...prev, [field]: value }));
    }
  };

  const resetForm = () => {
    setForm(defaultForm);
    setSlugError("");
  };

  const { data: sourceTypes, isLoading } = useQuery<SourceType[]>({
    queryKey: ["source-types"],
    queryFn: () => apiRequest<SourceType[]>("/api/source-types"),
  });

  const createMutation = useMutation({
    mutationFn: (data: FormState) =>
      apiRequest("/api/source-types", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["source-types"] });
      toast("Source type created", "success");
      setAddOpen(false);
      resetForm();
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: { display_name: string } }) =>
      apiRequest(`/api/source-types/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["source-types"] });
      toast("Source type updated", "success");
      setEditOpen(false);
      setEditing(null);
      resetForm();
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest(`/api/source-types/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["source-types"] });
      toast("Source type deleted", "success");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const handleEdit = (st: SourceType) => {
    setEditing(st);
    setForm({ slug: st.slug, display_name: st.display_name });
    setEditOpen(true);
  };

  const handleEditSubmit = () => {
    if (!editing) return;
    updateMutation.mutate({ id: editing.id, data: { display_name: form.display_name } });
  };

  const confirmDelete = () => {
    if (!deleting) return;
    deleteMutation.mutate(deleting.id);
    setDeleteOpen(false);
    setDeleting(null);
  };

  const columns: Column<SourceType>[] = [
    { key: "id", header: "ID", sortable: true, className: "w-16" },
    {
      key: "slug", header: "Slug", sortable: true,
      render: (item) => <span className="font-mono text-xs">{item.slug}</span>,
    },
    { key: "display_name", header: "Display Name", sortable: true },
    {
      key: "id",
      header: "Actions",
      render: (item) => (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => handleEdit(item)}>Edit</Button>
          <Button variant="ghost" size="sm" onClick={() => { setDeleting(item); setDeleteOpen(true); }}>
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex-1 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Source Types</h1>
        <Button onClick={() => { setAddOpen(true); resetForm(); }}>
          <Plus className="h-4 w-4" />
          Add Source Type
        </Button>
      </div>

      <Card>
        <DataTable<SourceType>
          columns={columns}
          data={sourceTypes ?? []}
          keyExtractor={(item) => item.id}
          isLoading={isLoading}
          searchable
          searchPlaceholder="Search source types..."
          pageSize={10}
          emptyMessage="No source types found"
        />
      </Card>

      <Dialog open={addOpen} onClose={() => { setAddOpen(false); resetForm(); }} title="Add Source Type" size="sm">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Slug</label>
            <Input
              value={form.slug}
              onChange={(e) => updateField("slug", e.target.value)}
              placeholder="e.g. forums"
            />
            <p className="mt-1 text-xs text-text-muted">Single lowercase word only</p>
            {slugError && <p className="mt-1 text-xs text-danger">{slugError}</p>}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Display Name</label>
            <Input
              value={form.display_name}
              onChange={(e) => updateField("display_name", e.target.value)}
              placeholder="e.g. Forums"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => { setAddOpen(false); resetForm(); }}>Cancel</Button>
            <Button
              onClick={() => createMutation.mutate(form)}
              disabled={!form.slug || !form.display_name || !!slugError || createMutation.isPending}
            >
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={editOpen} onClose={() => { setEditOpen(false); setEditing(null); resetForm(); }} title="Edit Source Type" size="sm">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Slug</label>
            <Input value={form.slug} disabled placeholder={form.slug} />
            <p className="mt-1 text-xs text-text-muted">Slug cannot be changed</p>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Display Name</label>
            <Input
              value={form.display_name}
              onChange={(e) => updateField("display_name", e.target.value)}
              placeholder="e.g. Forums"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => { setEditOpen(false); setEditing(null); resetForm(); }}>Cancel</Button>
            <Button
              onClick={handleEditSubmit}
              disabled={!form.display_name || updateMutation.isPending}
            >
              {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => { setDeleteOpen(false); setDeleting(null); }}
        title="Delete Source Type"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Delete source type "{deleting?.display_name}" ({deleting?.slug})? This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setDeleteOpen(false); setDeleting(null); }}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
