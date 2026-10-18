"use client";

import { useState, useEffect } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { keyService } from "@/services/keyService";
import type { APIKeyResponse, APIKeyCreateResponse } from "@/lib/types";
import {
  Key,
  Plus,
  Trash2,
  RefreshCw,
  Loader2,
  Copy,
  Check,
  AlertTriangle,
  X,
  Clock,
  ShieldAlert,
} from "lucide-react";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function KeysPage() {
  const [keys, setKeys] = useState<APIKeyResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create modal state
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newExpiry, setNewExpiry] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<APIKeyCreateResponse | null>(
    null
  );
  const [copied, setCopied] = useState(false);

  const fetchKeys = () => {
    setLoading(true);
    setError(null);
    keyService
      .listKeys()
      .then((data) => {
        setKeys(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchKeys();
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const result = await keyService.createKey({
        name: newName.trim(),
        expires_in_days: newExpiry ? parseInt(newExpiry) : null,
      });
      setCreatedKey(result);
      fetchKeys();
    } catch (err) {
      alert(
        `Failed to create key: ${err instanceof Error ? err.message : err}`
      );
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (keyId: string) => {
    if (!confirm("Are you sure you want to revoke this API key?")) return;
    try {
      await keyService.revokeKey(keyId);
      fetchKeys();
    } catch (err) {
      alert(`Revoke failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <DashboardLayout>
      <header className="flex justify-between items-end mb-5">
        <div>
          <h1 className="text-2xl font-bold text-primary -tracking-wider">
            API Keys
          </h1>
          <p className="text-xs text-on-surface-variant mt-0.5">
            Manage programmatic access tokens for service integrations
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={fetchKeys}
            className="bg-surface-container-high text-primary px-4 py-2 rounded-full text-sm font-medium hover:bg-surface-container-highest transition-colors flex items-center gap-1.5"
          >
            <RefreshCw
              className={`w-4 h-4 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
          <button
            onClick={() => {
              setShowCreate(true);
              setCreatedKey(null);
              setNewName("");
              setNewExpiry("");
            }}
            className="bg-primary text-on-primary px-5 py-2 rounded-full text-sm font-medium hover:bg-primary-container transition-all flex items-center gap-1.5 shadow-lg shadow-primary/20"
          >
            <Plus className="w-4 h-4" /> Create Key
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-center gap-2 text-xs text-error bg-error-container/15 border border-error/15 rounded-lg px-3 py-2 mb-4">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && keys.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-on-surface-variant">
          <Loader2 className="w-6 h-6 animate-spin mr-3" />
          <span>Loading API keys...</span>
        </div>
      ) : keys.length === 0 && !error ? (
        <div className="bg-surface-container-lowest rounded-xl p-12 text-center border border-outline-variant/10">
          <Key className="w-12 h-12 text-primary/20 mx-auto mb-4" />
          <p className="text-sm text-on-surface-variant">
            No API keys created yet. Create one to enable programmatic access.
          </p>
        </div>
      ) : (
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/10 overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-outline-variant/15 bg-surface-container-low">
                <th className="text-left py-3 px-4 text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">
                  Name
                </th>
                <th className="text-left py-3 px-4 text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">
                  ID
                </th>
                <th className="text-left py-3 px-4 text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">
                  Created
                </th>
                <th className="text-left py-3 px-4 text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">
                  Expires
                </th>
                <th className="text-left py-3 px-4 text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">
                  Status
                </th>
                <th className="text-right py-3 px-4 text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => {
                const isRevoked = !!key.revoked_at;
                const isExpired =
                  key.expires_at && new Date(key.expires_at) < new Date();

                return (
                  <tr
                    key={key.id}
                    className={`border-b border-outline-variant/10 hover:bg-surface-container-low/50 transition-colors ${isRevoked ? "opacity-50" : ""}`}
                  >
                    <td className="py-3 px-4 font-medium text-on-surface">
                      {key.name}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-on-surface-variant">
                      {key.id.slice(0, 12)}…
                    </td>
                    <td className="py-3 px-4 text-xs text-on-surface-variant">
                      {formatDate(key.created_at)}
                    </td>
                    <td className="py-3 px-4 text-xs text-on-surface-variant">
                      {key.expires_at ? formatDate(key.expires_at) : "Never"}
                    </td>
                    <td className="py-3 px-4">
                      {isRevoked ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200">
                          <ShieldAlert className="w-3 h-3" />
                          Revoked
                        </span>
                      ) : isExpired ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                          <Clock className="w-3 h-3" />
                          Expired
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">
                          <Check className="w-3 h-3" />
                          Active
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {!isRevoked && (
                        <button
                          onClick={() => handleRevoke(key.id)}
                          className="inline-flex items-center gap-1 text-[10px] font-bold text-red-600 bg-red-50 hover:bg-red-100 px-2.5 py-1 rounded-lg transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Key Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div
            className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-md p-6 border border-outline-variant/15 animate-[fadeUp_0.25s_ease-out]"
          >
            <div className="flex justify-between items-center mb-5">
              <h3 className="font-headline font-bold text-lg text-on-surface">
                {createdKey ? "Key Created!" : "Create API Key"}
              </h3>
              <button
                onClick={() => setShowCreate(false)}
                className="text-on-surface-variant hover:text-on-surface p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {createdKey ? (
              <div className="space-y-4">
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                  <p className="text-xs font-bold text-emerald-700 mb-2">
                    ⚠️ Copy this key now — it will not be shown again!
                  </p>
                  <div className="flex items-center gap-2 bg-white rounded-lg p-2 border">
                    <code className="flex-1 text-xs font-mono text-on-surface break-all">
                      {createdKey.plain_text_key}
                    </code>
                    <button
                      onClick={() =>
                        copyToClipboard(createdKey.plain_text_key)
                      }
                      className="p-1.5 hover:bg-surface-container-high rounded-lg transition-colors shrink-0"
                    >
                      {copied ? (
                        <Check className="w-4 h-4 text-emerald-600" />
                      ) : (
                        <Copy className="w-4 h-4 text-on-surface-variant" />
                      )}
                    </button>
                  </div>
                </div>
                <button
                  onClick={() => setShowCreate(false)}
                  className="w-full bg-primary text-on-primary py-2.5 rounded-xl font-semibold text-sm"
                >
                  Done
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-on-surface-variant">
                    Key Name
                  </label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. CI/CD Pipeline"
                    className="w-full bg-surface-container-low border border-outline-variant/30 rounded-xl px-4 py-2.5 text-sm text-on-surface outline-none focus:border-primary/45 focus:ring-2 focus:ring-primary/10"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-on-surface-variant">
                    Expires in (days) — leave blank for no expiry
                  </label>
                  <input
                    type="number"
                    value={newExpiry}
                    onChange={(e) => setNewExpiry(e.target.value)}
                    placeholder="30"
                    min="1"
                    className="w-full bg-surface-container-low border border-outline-variant/30 rounded-xl px-4 py-2.5 text-sm text-on-surface outline-none focus:border-primary/45 focus:ring-2 focus:ring-primary/10"
                  />
                </div>
                <button
                  onClick={handleCreate}
                  disabled={creating || !newName.trim()}
                  className="w-full bg-primary text-on-primary py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {creating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> Creating...
                    </>
                  ) : (
                    <>
                      <Key className="w-4 h-4" /> Generate Key
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
