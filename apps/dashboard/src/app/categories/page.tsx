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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/toast-provider";

interface Category {
  id: number;
  slug: string;
  display_name: string;
  bot_token: string | null;
  chat_id: string | null;
  ai_prompt: string | null;
  is_active: boolean;
  delivery_channel: string | null;
  whatsapp_delivery_jid: string | null;
  has_bot_token?: boolean;
  has_chat_id?: boolean;
}

const BUILT_IN_SLUGS = ["cc", "deals"];

interface FormState {
  slug: string;
  display_name: string;
  bot_token: string;
  chat_id: string;
  ai_prompt: string;
  delivery_channel: string;
  whatsapp_delivery_jid: string;
}

const defaultForm: FormState = {
  slug: "",
  display_name: "",
  bot_token: "",
  chat_id: "",
  ai_prompt: "",
  delivery_channel: "",
  whatsapp_delivery_jid: "",
};

function formToPayload(form: FormState) {
  return {
    slug: form.slug,
    display_name: form.display_name,
    bot_token: form.bot_token || null,
    chat_id: form.chat_id || null,
    ai_prompt: form.ai_prompt || null,
    delivery_channel: form.delivery_channel || null,
    whatsapp_delivery_jid: form.whatsapp_delivery_jid || null,
  };
}

function CategoryFormFields({
  form,
  onChange,
  isEdit,
}: {
  form: FormState;
  onChange: (field: string, value: string) => void;
  isEdit?: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="text-sm font-medium">Slug</label>
        <Input
          value={form.slug}
          onChange={(e) => onChange("slug", e.target.value)}
          disabled={isEdit}
          placeholder="my-category"
        />
        {!isEdit && (
          <p className="text-xs text-text-muted">Lowercase letters and hyphens only</p>
        )}
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Display Name</label>
        <Input
          value={form.display_name}
          onChange={(e) => onChange("display_name", e.target.value)}
          placeholder="My Category"
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Bot Token</label>
        <Input
          value={form.bot_token}
          onChange={(e) => onChange("bot_token", e.target.value)}
          placeholder="123456:ABC-DEF..."
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Chat ID</label>
        <Input
          value={form.chat_id}
          onChange={(e) => onChange("chat_id", e.target.value)}
          placeholder="-1001234567890"
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">AI Prompt</label>
        <Textarea
          value={form.ai_prompt}
          onChange={(e) => onChange("ai_prompt", e.target.value)}
          placeholder="Instructions for AI processing..."
          rows={4}
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Delivery Channel</label>
        <Select
          value={form.delivery_channel}
          onChange={(e) => onChange("delivery_channel", e.target.value)}
          options={[
            { value: "", label: "None" },
            { value: "telegram", label: "Telegram" },
            { value: "whatsapp", label: "WhatsApp" },
            { value: "both", label: "Both" },
          ]}
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">WhatsApp Delivery JID</label>
        <Input
          value={form.whatsapp_delivery_jid}
          onChange={(e) => onChange("whatsapp_delivery_jid", e.target.value)}
          placeholder="1234567890@s.whatsapp.net"
        />
      </div>
    </div>
  );
}

export default function CategoriesPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm);

  const updateField = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const resetForm = () => setForm(defaultForm);

  const { data: categories, isLoading } = useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () => apiRequest<Category[]>("/api/categories"),
  });

  const createMutation = useMutation({
    mutationFn: (data: FormState) =>
      apiRequest("/api/categories", {
        method: "POST",
        body: JSON.stringify(formToPayload(data)),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      toast("Category created successfully", "success");
      setAddOpen(false);
      resetForm();
    },
    onError: (err: Error) => {
      toast(err.message, "error");
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: FormState }) => {
      const { slug: _, ...payload } = formToPayload(data);
      return apiRequest(`/api/categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      toast("Category updated successfully", "success");
      setEditOpen(false);
      setEditingCategory(null);
      resetForm();
    },
    onError: (err: Error) => {
      toast(err.message, "error");
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
      apiRequest(`/api/categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
    onError: (err: Error) => {
      toast(err.message, "error");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest(`/api/categories/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      toast("Category deleted", "success");
    },
    onError: (err: Error) => {
      toast(err.message, "error");
    },
  });

  const testMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest<{ success: boolean; message: string }>(`/api/categories/${id}/test`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      toast(data.message, "success");
    },
    onError: (err: Error) => {
      toast(err.message, "error");
    },
  });

  const handleEdit = (cat: Category) => {
    setEditingCategory(cat);
    setForm({
      slug: cat.slug,
      display_name: cat.display_name,
      // Redacted server-side — never prefill tokens/chat ids into the browser.
      bot_token: "",
      chat_id: "",
      ai_prompt: cat.ai_prompt || "",
      delivery_channel: cat.delivery_channel || "",
      whatsapp_delivery_jid: cat.whatsapp_delivery_jid || "",
    });
    setEditOpen(true);
  };

  const handleEditClose = () => {
    setEditOpen(false);
    setEditingCategory(null);
    resetForm();
  };

  const handleAddClose = () => {
    setAddOpen(false);
    resetForm();
  };

  const handleDelete = (cat: Category) => {
    setDeletingCategory(cat);
    setDeleteOpen(true);
  };

  const confirmDelete = () => {
    if (!deletingCategory) return;
    deleteMutation.mutate(deletingCategory.id);
    setDeleteOpen(false);
    setDeletingCategory(null);
  };

  const handleEditSubmit = () => {
    if (!editingCategory) return;
    updateMutation.mutate({ id: editingCategory.id, data: form });
  };

  const columns: Column<Category>[] = [
    {
      key: "id",
      header: "ID",
      sortable: true,
      className: "w-16",
    },
    {
      key: "slug",
      header: "Slug",
      sortable: true,
      render: (cat) => (
        <span className="font-mono text-xs">{cat.slug}</span>
      ),
    },
    {
      key: "display_name",
      header: "Display Name",
      sortable: true,
    },
    {
      key: "is_active",
      header: "Status",
      render: (cat) => (
        <Switch
          checked={cat.is_active}
          onChange={(checked) =>
            toggleActiveMutation.mutate({ id: cat.id, is_active: checked })
          }
        />
      ),
    },
    {
      key: "bot_token",
      header: "Telegram",
      render: (cat) =>
        cat.bot_token && cat.chat_id ? (
          <Badge variant="success">Configured</Badge>
        ) : (
          <Badge variant="secondary">Not Set</Badge>
        ),
    },
    {
      key: "delivery_channel",
      header: "Delivery Channel",
      sortable: true,
      render: (cat) =>
        cat.delivery_channel ? (
          <Badge variant="info">{cat.delivery_channel}</Badge>
        ) : (
          <span className="text-text-muted">&mdash;</span>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (cat) => (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => handleEdit(cat)}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => testMutation.mutate(cat.id)}
            disabled={testMutation.isPending}
          >
            Test
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleDelete(cat)}
            disabled={deleteMutation.isPending}
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
        <h1 className="text-2xl font-bold">Categories</h1>
        <Button onClick={() => setAddOpen(true)}>Add Category</Button>
      </div>

      <Card title="All Categories">
        <DataTable
          columns={columns}
          data={categories ?? []}
          keyExtractor={(cat) => cat.id}
          isLoading={isLoading}
          searchable
          searchPlaceholder="Search categories..."
          pageSize={10}
          emptyMessage="No categories found"
        />
      </Card>

      <Dialog open={addOpen} onClose={handleAddClose} title="Add Category" size="lg">
        <CategoryFormFields form={form} onChange={updateField} />
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={handleAddClose}>
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate(form)}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "Creating..." : "Create"}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={editOpen}
        onClose={handleEditClose}
        title="Edit Category"
        size="lg"
      >
        <CategoryFormFields form={form} onChange={updateField} isEdit />
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={handleEditClose}>
            Cancel
          </Button>
          <Button
            onClick={handleEditSubmit}
            disabled={updateMutation.isPending}
          >
            {updateMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => { setDeleteOpen(false); setDeletingCategory(null); }}
        title="Delete Category"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {deletingCategory && BUILT_IN_SLUGS.includes(deletingCategory.slug)
              ? `"${deletingCategory.slug}" is a built-in category. Deleting it may cause unexpected behavior. Are you sure?`
              : `Delete category "${deletingCategory?.display_name}"? This action cannot be undone.`}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setDeleteOpen(false); setDeletingCategory(null); }}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
