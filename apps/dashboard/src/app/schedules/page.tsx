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

interface Schedule {
  id: number;
  category_slug: string;
  cron_expression: string;
  label: string;
  is_active: boolean;
  is_running: boolean;
}

interface Category {
  slug: string;
  display_name: string;
}

interface ScheduleForm {
  category_slug: string;
  cron_expression: string;
  label: string;
}

function timeToCron(hours: number, minutes: number): string {
  return `${minutes} ${hours} * * *`;
}

function cronToTime(cron: string): { hours: number; minutes: number } | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const min = parseInt(parts[0], 10);
  const hr = parseInt(parts[1], 10);
  if (isNaN(min) || isNaN(hr)) return null;
  return { hours: hr, minutes: min };
}

const emptyForm: ScheduleForm = { category_slug: "", cron_expression: "", label: "" };

export default function SchedulesPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingSchedule, setDeletingSchedule] = useState<Schedule | null>(null);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [form, setForm] = useState<ScheduleForm>(emptyForm);

  const { data: schedules, isLoading } = useQuery<Schedule[]>({
    queryKey: ['schedules'],
    queryFn: () => apiRequest<Schedule[]>('/api/schedules'),
  });

  const { data: categories } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => apiRequest<Category[]>('/api/categories'),
  });

  const categoryOptions = categories?.map((c) => ({ value: c.slug, label: c.display_name })) || [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['schedules'] });

  const createMutation = useMutation({
    mutationFn: (data: ScheduleForm) =>
      apiRequest('/api/schedules', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      invalidate();
      setAddOpen(false);
      setForm(emptyForm);
      toast('Schedule created', 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<ScheduleForm & { is_active: boolean }> }) =>
      apiRequest(`/api/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    onSuccess: () => {
      invalidate();
      setEditOpen(false);
      setEditing(null);
      toast('Schedule updated', 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
      apiRequest(`/api/schedules/${id}/toggle`, { method: 'PATCH', body: JSON.stringify({ is_active }) }),
    onSuccess: () => {
      invalidate();
      toast('Schedule toggled', 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest(`/api/schedules/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      toast('Schedule deleted', 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });

  const triggerMutation = useMutation({
    mutationFn: ({ slug }: { slug?: string }) => {
      const body = slug ? JSON.stringify({ slug }) : '{}';
      return apiRequest<{ success: boolean; message: string }>('/api/schedules/trigger', { method: 'POST', body });
    },
    onSuccess: (data) => toast(data.message, 'success'),
    onError: (err: Error) => toast(err.message, 'error'),
  });

  const handleAdd = () => {
    setEditing(null);
    setForm(emptyForm);
    setAddOpen(true);
  };

  const handleEdit = (schedule: Schedule) => {
    setEditing(schedule);
    setForm({
      category_slug: schedule.category_slug,
      cron_expression: schedule.cron_expression,
      label: schedule.label,
    });
    setEditOpen(true);
  };

  const handleDelete = (schedule: Schedule) => {
    setDeletingSchedule(schedule);
    setDeleteOpen(true);
  };

  const confirmDelete = () => {
    if (!deletingSchedule) return;
    deleteMutation.mutate(deletingSchedule.id);
    setDeleteOpen(false);
    setDeletingSchedule(null);
  };

  const columns: Column<Schedule>[] = [
    { key: 'id', header: 'ID', sortable: true, className: 'w-16' },
    { key: 'label', header: 'Label', sortable: true },
    {
      key: 'category_slug',
      header: 'Category',
      sortable: true,
      render: (s) => <Badge variant="info" className="text-xs">{s.category_slug}</Badge>,
    },
    {
      key: 'cron_expression',
      header: 'Cron Expression',
      sortable: true,
      render: (s) => (
        <code className="font-mono text-xs bg-surface-2 px-1.5 py-0.5 rounded">{s.cron_expression}</code>
      ),
    },
    {
      key: 'is_active',
      header: 'Status',
      sortable: true,
      render: (s) => (
        <Badge variant={s.is_active ? 'success' : 'secondary'}>
          {s.is_active ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
    {
      key: 'is_running',
      header: 'Running',
      sortable: true,
      render: (s) => (
        <Badge variant={s.is_running ? 'success' : 'outline'}>
          {s.is_running ? 'Running' : 'Idle'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (s) => (
        <div className="flex items-center gap-1">
          <Switch
            checked={s.is_active}
            onChange={(checked) => toggleMutation.mutate({ id: s.id, is_active: checked })}
          />
          <Button variant="ghost" size="sm" onClick={() => handleEdit(s)}>Edit</Button>
          <Button variant="ghost" size="sm" onClick={() => triggerMutation.mutate({ slug: s.category_slug })}>Trigger</Button>
          <Button variant="ghost" size="sm" onClick={() => handleDelete(s)}>Delete</Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex-1 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Schedules</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => triggerMutation.mutate({})}>
            Trigger All
          </Button>
          <Button variant="default" size="sm" onClick={handleAdd}>
            Add Schedule
          </Button>
        </div>
      </div>

      <Card title="Schedule Rules">
        <DataTable<Schedule>
          columns={columns}
          data={schedules || []}
          keyExtractor={(s) => s.id}
          isLoading={isLoading}
          searchable
          searchPlaceholder="Search schedules..."
          pageSize={10}
          emptyMessage="No schedules found"
        />
      </Card>

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} title="Add Schedule" size="md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createMutation.mutate(form);
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <label className="text-sm font-medium">Label</label>
            <Input
              placeholder="e.g. Morning Briefing"
              value={form.label}
              onChange={(e) => setForm((p) => ({ ...p, label: e.target.value }))}
              required
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Category</label>
            <Select
              options={categoryOptions}
              placeholder="Select a category"
              value={form.category_slug}
              onChange={(e) => setForm((p) => ({ ...p, category_slug: e.target.value }))}
              required
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Time</label>
            <input
              type="time"
              value={
                cronToTime(form.cron_expression)
                  ? `${String(cronToTime(form.cron_expression)!.hours).padStart(2, '0')}:${String(cronToTime(form.cron_expression)!.minutes).padStart(2, '0')}`
                  : ''
              }
              onChange={(e) => {
                if (!e.target.value) return;
                const [hr, min] = e.target.value.split(':').map(Number);
                setForm((p) => ({ ...p, cron_expression: timeToCron(hr, min) }));
              }}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            />
            <p className="text-xs text-text-muted">Or enter a custom cron expression below</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Cron Expression</label>
            <Input
              placeholder="e.g. 0 8 * * *"
              value={form.cron_expression}
              onChange={(e) => setForm((p) => ({ ...p, cron_expression: e.target.value }))}
              required
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={createMutation.isPending}>Create</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={editOpen} onClose={() => setEditOpen(false)} title="Edit Schedule" size="md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!editing) return;
            updateMutation.mutate({ id: editing.id, data: form });
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <label className="text-sm font-medium">Label</label>
            <Input
              placeholder="e.g. Morning Briefing"
              value={form.label}
              onChange={(e) => setForm((p) => ({ ...p, label: e.target.value }))}
              required
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Category</label>
            <Select
              options={categoryOptions}
              placeholder="Select a category"
              value={form.category_slug}
              onChange={(e) => setForm((p) => ({ ...p, category_slug: e.target.value }))}
              required
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Time</label>
            <input
              type="time"
              value={
                cronToTime(form.cron_expression)
                  ? `${String(cronToTime(form.cron_expression)!.hours).padStart(2, '0')}:${String(cronToTime(form.cron_expression)!.minutes).padStart(2, '0')}`
                  : ''
              }
              onChange={(e) => {
                if (!e.target.value) return;
                const [hr, min] = e.target.value.split(':').map(Number);
                setForm((p) => ({ ...p, cron_expression: timeToCron(hr, min) }));
              }}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            />
            <p className="text-xs text-text-muted">Or enter a custom cron expression below</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Cron Expression</label>
            <Input
              placeholder="e.g. 0 8 * * *"
              value={form.cron_expression}
              onChange={(e) => setForm((p) => ({ ...p, cron_expression: e.target.value }))}
              required
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={updateMutation.isPending}>Save</Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => { setDeleteOpen(false); setDeletingSchedule(null); }}
        title="Delete Schedule"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Delete schedule "{deletingSchedule?.label}"? This action cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setDeleteOpen(false); setDeletingSchedule(null); }}>
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
