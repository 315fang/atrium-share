import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { copyTextToClipboard } from "../app/lib/s3-uri";
import "./share-manager.css";

type ManagedShare = {
  code: string;
  kind: "collection" | "file";
  title: string;
  url: string;
  count: number;
  totalSize: number;
  createdAt?: string;
  expiresAt?: string | null;
  revoked: boolean;
  passwordProtected: boolean;
  views: number;
  downloadStarts: number;
  lastAccessAt?: string | null;
};
type SharePatch = {
  title?: string;
  expiresAt?: string | null;
  password?: string | null;
  revoked?: boolean;
};
type ShareList = { shares: ManagedShare[]; nextCursor?: string };
const formatDate = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      )
    : "—";
const formatSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
};
const localDateInput = (value?: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

const ShareEditor = ({
  share,
  save,
  close,
}: {
  share: ManagedShare;
  save: (patch: SharePatch) => Promise<void>;
  close: () => void;
}) => {
  const [title, setTitle] = useState(share.title);
  const [expires, setExpires] = useState(localDateInput(share.expiresAt));
  const [passwordAction, setPasswordAction] = useState<"keep" | "set" | "remove">("keep");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!title.trim()) {
      setError("请输入分享标题。");
      return;
    }
    if (expires && (!Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= Date.now())) {
      setError("有效期需要晚于当前时间，或清空以设为长期有效。");
      return;
    }
    if (passwordAction === "set" && password.length < 4) {
      setError("提取码至少需要 4 个字符。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await save({
        title: title.trim(),
        expiresAt: expires ? new Date(expires).toISOString() : null,
        ...(passwordAction === "set"
          ? { password }
          : passwordAction === "remove"
            ? { password: null }
            : {}),
      });
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="share-manager-editor" onSubmit={(event) => void submit(event)}>
      <label>
        分享标题
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={120}
          required
          disabled={busy}
        />
      </label>
      <label>
        有效期至
        <input
          type="datetime-local"
          value={expires}
          onChange={(event) => setExpires(event.target.value)}
          disabled={busy}
        />
        <small>留空表示长期有效。</small>
      </label>
      <label>
        提取码设置
        <select
          value={passwordAction}
          onChange={(event) => setPasswordAction(event.target.value as "keep" | "set" | "remove")}
          disabled={busy}
        >
          <option value="keep">保留当前设置</option>
          <option value="set">设置新提取码</option>
          <option value="remove">取消提取码</option>
        </select>
      </label>
      {passwordAction === "set" ? (
        <label>
          新提取码
          <input
            type="password"
            autoComplete="new-password"
            minLength={4}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
            required
          />
        </label>
      ) : null}
      <div className="share-manager-editor-actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "正在保存…" : "保存设置"}
        </button>
        <button type="button" onClick={close} disabled={busy}>
          取消编辑
        </button>
      </div>
      {error ? (
        <p className="share-manager-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
};

export const ShareManager = ({ onClose }: { onClose?: () => void } = {}) => {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [shares, setShares] = useState<ManagedShare[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const idFor = (share: ManagedShare) => `${share.kind}:${share.code}`;
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const load = useCallback(
    async (cursor?: string) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const id = ++requestId.current;
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({ limit: "30" });
        if (query) params.set("search", query);
        if (cursor) params.set("cursor", cursor);
        const response = await fetch(`/api/manage/shares?${params}`, {
          credentials: "include",
          signal: abort.signal,
        });
        const body = (await response.json()) as ShareList & { error?: string };
        if (!response.ok) throw new Error(body.error || "暂时无法读取分享列表。");
        if (!Array.isArray(body.shares)) throw new Error("分享列表格式无效，请刷新重试。");
        if (id !== requestId.current || abort.signal.aborted) return;
        setShares((previous) =>
          cursor
            ? [
                ...new Map(
                  [...previous, ...body.shares].map((share) => [
                    `${share.kind}:${share.code}`,
                    share,
                  ]),
                ).values(),
              ]
            : body.shares,
        );
        setNextCursor(body.nextCursor);
      } catch (cause) {
        if (!abort.signal.aborted && id === requestId.current)
          setError(cause instanceof Error ? cause.message : "加载失败，请重试。");
      } finally {
        if (!abort.signal.aborted && id === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [query],
  );
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(""), 3000);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  const update = async (share: ManagedShare, patch: SharePatch) => {
    const id = idFor(share);
    setSaving(id);
    setError("");
    try {
      const response = await fetch(
        `/api/manage/shares/${share.kind}/${encodeURIComponent(share.code)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "设置未保存，请重试。");
      }
      const { password: _password, ...publicPatch } = patch;
      setShares((previous) =>
        previous.map((item) =>
          idFor(item) === id
            ? {
                ...item,
                ...publicPatch,
                passwordProtected:
                  patch.password === undefined ? item.passwordProtected : patch.password !== null,
              }
            : item,
        ),
      );
      setFeedback(
        patch.revoked === true
          ? "分享已停用，短链将显示失效。"
          : patch.revoked === false
            ? "分享已恢复。"
            : "分享设置已保存，短链保持不变。",
      );
      setConfirming(null);
    } finally {
      setSaving(null);
    }
  };
  const toggle = async (share: ManagedShare) => {
    try {
      await update(share, { revoked: !share.revoked });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法更新分享状态。");
    }
  };
  const copy = async (share: ManagedShare) => {
    try {
      await copyTextToClipboard(share.url);
      setFeedback("分享短链已复制。");
    } catch {
      setFeedback("复制未成功，请选中短链手动复制。");
    }
  };
  return (
    <section className="modal-card share-manager-card" aria-label="我的分享管理">
      <header className="share-manager-heading">
        <div>
          <p>分享管理</p>
          <h3 id="share-manager-title">我的分享</h3>
        </div>
        {onClose ? (
          <button type="button" onClick={onClose}>
            关闭
          </button>
        ) : null}
      </header>
      <p className="share-manager-intro">找回已发出的短链，设置有效期、提取码，或随时停用分享。</p>
      <div className="share-manager-tools">
        <label>
          <span className="share-manager-visually-hidden">搜索分享</span>
          <input
            type="search"
            placeholder="搜索标题或短码…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button type="button" onClick={() => void load()} disabled={loading}>
          刷新列表
        </button>
      </div>
      {feedback ? (
        <p className="share-manager-feedback" role="status">
          {feedback}
        </p>
      ) : null}
      {error ? (
        <p className="share-manager-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p role="status">正在读取分享…</p>
      ) : shares.length ? (
        <ul className="share-manager-list">
          {shares.map((share) => {
            const id = idFor(share);
            const expired = Boolean(share.expiresAt && Date.parse(share.expiresAt) <= Date.now());
            return (
              <li key={id} className="share-manager-item">
                <div className="share-manager-item-heading">
                  <h4>{share.title || "文件分享"}</h4>
                  <span
                    className={`share-manager-badge${share.revoked || expired ? " inactive" : ""}`}
                  >
                    {share.revoked
                      ? "已停用"
                      : expired
                        ? "已到期"
                        : share.passwordProtected
                          ? "提取码保护"
                          : "分享中"}
                  </span>
                </div>
                <p className="share-manager-summary">
                  {share.count} 个文件 · {formatSize(share.totalSize)} · 创建于{" "}
                  {formatDate(share.createdAt)}
                </p>
                <input
                  className="share-manager-url"
                  value={share.url}
                  readOnly
                  aria-label={`${share.title} 的分享短链`}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <dl className="share-manager-stats">
                  <div>
                    <dt>访问</dt>
                    <dd>{share.views || 0}</dd>
                  </div>
                  <div>
                    <dt>下载发起</dt>
                    <dd>{share.downloadStarts || 0}</dd>
                  </div>
                  <div>
                    <dt>最近访问</dt>
                    <dd>{formatDate(share.lastAccessAt)}</dd>
                  </div>
                  <div>
                    <dt>有效期</dt>
                    <dd>{share.expiresAt ? formatDate(share.expiresAt) : "长期有效"}</dd>
                  </div>
                </dl>
                <div className="share-manager-item-actions">
                  <button type="button" onClick={() => void copy(share)}>
                    复制短链
                  </button>
                  <a href={share.url} target="_blank" rel="noopener noreferrer">
                    查看分享页
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(editing === id ? null : id);
                      setConfirming(null);
                    }}
                    aria-expanded={editing === id}
                  >
                    修改设置
                  </button>
                  <button
                    type="button"
                    className={share.revoked ? "" : "danger"}
                    disabled={saving === id}
                    onClick={() => {
                      if (share.revoked) void toggle(share);
                      else {
                        setConfirming(id);
                        setEditing(null);
                      }
                    }}
                  >
                    {share.revoked ? "恢复分享" : "停用分享"}
                  </button>
                </div>
                {confirming === id ? (
                  <div className="share-manager-confirm" role="group" aria-label="确认停用分享">
                    <p>停用后，对方将无法通过此短链预览或下载。可以随时恢复。</p>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void toggle(share)}
                      disabled={saving === id}
                    >
                      {saving === id ? "正在停用…" : "确认停用"}
                    </button>
                    <button type="button" onClick={() => setConfirming(null)}>
                      暂不停用
                    </button>
                  </div>
                ) : null}
                {editing === id ? (
                  <ShareEditor
                    share={share}
                    save={(patch) => update(share, patch)}
                    close={() => setEditing(null)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : error ? null : (
        <div className="share-manager-empty">
          <p>
            {query
              ? "没有找到匹配的分享。"
              : "还没有分享记录。选择文件后点击分享，即可在这里找回短链。"}
          </p>
        </div>
      )}
      {nextCursor && !loading ? (
        <button
          className="share-manager-load-more"
          type="button"
          onClick={() => void load(nextCursor)}
          disabled={loadingMore}
        >
          {loadingMore ? "正在加载…" : "加载更多分享"}
        </button>
      ) : null}
      <p className="share-manager-footnote">
        下载发起表示有人请求下载，不代表文件已成功保存到对方设备。
      </p>
    </section>
  );
};
