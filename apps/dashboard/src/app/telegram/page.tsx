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
import { useToast } from "@/components/toast-provider";
import { Plus } from "lucide-react";

interface TelegramStatus {
  isReady: boolean;
  tempPhone: string | null;
}

interface TelegramChannel {
  id: string;
  title: string;
  username?: string;
  participantCount?: number;
}

interface Category {
  id: number;
  slug: string;
  display_name: string;
}

interface SourceType {
  id: number;
  slug: string;
  display_name: string;
}

export default function TelegramPage() {
  const [loginOpen, setLoginOpen] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [channels, setChannels] = useState<TelegramChannel[] | null>(null);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [addSourceChannel, setAddSourceChannel] = useState<TelegramChannel | null>(null);
  const [addSourceForm, setAddSourceForm] = useState({ name: "", source_id: "", category_slug: "" });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: status, isLoading: statusLoading } = useQuery<TelegramStatus>({
    queryKey: ["telegram-status"],
    queryFn: () => apiRequest<TelegramStatus>("/api/telegram/status"),
    refetchInterval: (query) => (query.state.data?.isReady ? false : 5000),
  });

  const sendCodeMutation = useMutation({
    mutationFn: (phone: string) =>
      apiRequest("/api/telegram/send-code", {
        method: "POST",
        body: JSON.stringify({ phoneNumber: phone }),
      }),
    onSuccess: () => {
      setCodeSent(true);
      toast("Verification code sent", "success");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const submitCodeMutation = useMutation({
    mutationFn: (body: { code: string; password?: string }) =>
      apiRequest("/api/telegram/submit-code", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["telegram-status"] });
      setLoginOpen(false);
      setCodeSent(false);
      setPhoneNumber("");
      setCode("");
      setPassword("");
      toast("Logged in successfully", "success");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () => apiRequest<Category[]>("/api/categories"),
  });

  const { data: sourceTypes = [] } = useQuery<SourceType[]>({
    queryKey: ["source-types"],
    queryFn: () => apiRequest<SourceType[]>("/api/source-types"),
  });

  const createSourceMutation = useMutation({
    mutationFn: (body: { name: string; source_id: string; type: string; category_slug?: string }) =>
      apiRequest("/api/sources", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setAddSourceOpen(false);
      setAddSourceChannel(null);
      toast("Source added", "success");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const logoutMutation = useMutation({
    mutationFn: () =>
      apiRequest("/api/telegram/logout", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["telegram-status"] });
      setChannels(null);
      setDiscoverOpen(false);
      toast("Logged out", "success");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const discoverMutation = useMutation({
    mutationFn: () => apiRequest<TelegramChannel[]>("/api/telegram/discover"),
    onSuccess: (data) => {
      setChannels(data);
      setDiscoverOpen(true);
      toast(`Found ${data.length} channels`, "success");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const handleLoginClose = () => {
    setLoginOpen(false);
    setCodeSent(false);
    setPhoneNumber("");
    setCode("");
    setPassword("");
  };

  const handleSendCode = () => {
    if (!phoneNumber.trim()) return;
    sendCodeMutation.mutate(phoneNumber.trim());
  };

  const handleSubmitCode = () => {
    if (!code.trim()) return;
    const body: { code: string; password?: string } = { code: code.trim() };
    if (password.trim()) body.password = password.trim();
    submitCodeMutation.mutate(body);
  };

  const telegramTypeSlug = sourceTypes.find(
    (st) => st.slug === "telegram" || st.display_name.toLowerCase() === "telegram"
  )?.slug || "telegram";

  const columns: Column<TelegramChannel>[] = [
    {
      key: "title",
      header: "Title",
      sortable: true,
    },
    {
      key: "id",
      header: "ID",
      sortable: true,
      render: (ch) => (
        <span className="font-mono text-xs">{ch.id}</span>
      ),
    },
    {
      key: "username",
      header: "Username",
      sortable: true,
      render: (ch) =>
        ch.username ? (
          <span className="font-mono text-xs">{ch.username}</span>
        ) : (
          <span className="text-text-muted">&mdash;</span>
        ),
    },
    {
      key: "participantCount",
      header: "Participants",
      sortable: true,
      render: (ch) =>
        ch.participantCount != null ? (
          <span>{ch.participantCount.toLocaleString()}</span>
        ) : (
          <span className="text-text-muted">&mdash;</span>
        ),
    },
    {
      key: "id",
      header: "",
      className: "w-28",
      render: (ch) => (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setAddSourceChannel(ch);
            setAddSourceForm({ name: ch.title, source_id: ch.id, category_slug: categories[0]?.slug || "" });
            setAddSourceOpen(true);
          }}
        >
          <Plus className="mr-1 h-3 w-3" />
          Add to Source
        </Button>
      ),
    },
  ];

  return (
    <div className="flex-1 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Telegram</h1>
      </div>

      <Card title="Connection Status">
        {statusLoading ? (
          <div className="space-y-3">
            <div className="h-5 w-48 animate-pulse rounded bg-surface-2" />
            <div className="h-5 w-32 animate-pulse rounded bg-surface-2" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Status</span>
              <Badge variant={status?.isReady ? "success" : "secondary"}>
                {status?.isReady ? "Ready" : "Not Connected"}
              </Badge>
            </div>
            {status?.tempPhone && (
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Phone</span>
                <span className="font-mono text-sm">{status.tempPhone}</span>
              </div>
            )}
            <div className="flex gap-2">
              {status?.isReady ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => logoutMutation.mutate()}
                  disabled={logoutMutation.isPending}
                >
                  {logoutMutation.isPending ? "Logging out..." : "Logout"}
                </Button>
              ) : (
                <Button size="sm" onClick={() => setLoginOpen(true)}>
                  Login with Phone
                </Button>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card title="Channel Discovery">
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => discoverMutation.mutate()}
              disabled={discoverMutation.isPending || !status?.isReady}
            >
              {discoverMutation.isPending ? "Discovering..." : "Discover Channels"}
            </Button>
            {!status?.isReady && (
              <span className="text-xs text-text-muted">
                Login to discover channels
              </span>
            )}
          </div>
          {discoverOpen && channels && (
            <DataTable<TelegramChannel>
              columns={columns}
              data={channels}
              keyExtractor={(ch) => ch.id}
              searchable
              searchPlaceholder="Search channels..."
              pageSize={10}
              emptyMessage="No channels found"
            />
          )}
        </div>
      </Card>

      <Dialog
        open={loginOpen}
        onClose={handleLoginClose}
        title="Login to Telegram"
        description={codeSent ? "Enter the code sent to your Telegram" : "Enter your phone number to receive a verification code"}
        size="sm"
      >
        {!codeSent ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Phone Number</label>
              <Input
                placeholder="+1234567890"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={handleLoginClose}>
                Cancel
              </Button>
              <Button
                onClick={handleSendCode}
                disabled={!phoneNumber.trim() || sendCodeMutation.isPending}
              >
                {sendCodeMutation.isPending ? "Sending..." : "Send Code"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Code</label>
              <Input
                placeholder="12345"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Password <span className="text-text-muted">(optional)</span>
              </label>
              <Input
                type="password"
                placeholder="2FA password if enabled"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={handleLoginClose}>
                Cancel
              </Button>
              <Button
                onClick={handleSubmitCode}
                disabled={!code.trim() || submitCodeMutation.isPending}
              >
                {submitCodeMutation.isPending ? "Verifying..." : "Submit Code"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={addSourceOpen}
        onClose={() => { setAddSourceOpen(false); setAddSourceChannel(null); }}
        title="Add Telegram Channel as Source"
        description={addSourceChannel ? `Add "${addSourceChannel.title}" to your monitored sources` : ""}
        size="md"
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Name</label>
            <Input
              value={addSourceForm.name}
              onChange={(e) => setAddSourceForm({ ...addSourceForm, name: e.target.value })}
              placeholder="Source name"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Channel ID</label>
            <Input
              value={addSourceForm.source_id}
              onChange={(e) => setAddSourceForm({ ...addSourceForm, source_id: e.target.value })}
              placeholder="Channel ID"
            />
            <p className="mt-1 text-xs text-text-secondary">
              Telegram channel identifier used by the scraper
            </p>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Type</label>
            <Input value="telegram" disabled className="text-text-muted" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Category</label>
            <Select
              value={addSourceForm.category_slug}
              onChange={(e) => setAddSourceForm({ ...addSourceForm, category_slug: e.target.value })}
              options={categories.map((c) => ({ value: c.slug, label: c.display_name }))}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => { setAddSourceOpen(false); setAddSourceChannel(null); }}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                createSourceMutation.mutate({
                  name: addSourceForm.name,
                  source_id: addSourceForm.source_id,
                  type: telegramTypeSlug,
                  category_slug: addSourceForm.category_slug,
                })
              }
              disabled={!addSourceForm.name || !addSourceForm.source_id || !addSourceForm.category_slug || createSourceMutation.isPending}
            >
              {createSourceMutation.isPending ? "Adding..." : "Add Source"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
