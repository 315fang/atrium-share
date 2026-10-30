import { useEffect, useRef, useState } from "react";
import { createShareCollection, type ShareCollectionResult } from "../app/lib/api";
import type { FileEntry } from "../app/lib/types";
import { copyTextToClipboard } from "../app/lib/s3-uri";
import { Dialog } from "./Dialog";
import "./share-dialog.css";

type Props = {
  bucket: string;
  files: FileEntry[];
  initialTitle: string;
  existing?: ShareCollectionResult;
  onCreated: (result: ShareCollectionResult) => void;
  onClose: () => void;
};

const formatSize = (size: number): string => {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
};

const fileType = (name: string): string => {
  const extension = name.includes(".") ? name.split(".").pop() : "";
  return extension?.slice(0, 12).toUpperCase() || "文件";
};

export const ShareDialog = ({
  bucket,
  files,
  initialTitle,
  existing,
  onCreated,
  onClose,
}: Props) => {
  const [title, setTitle] = useState((existing?.title || initialTitle).slice(0, 120));
  const [result, setResult] = useState<ShareCollectionResult | null>(existing ?? null);
  const [busy, setBusy] = useState(!existing);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [expiryMode, setExpiryMode] = useState("keep");
  const [expiresAt, setExpiresAt] = useState("");
  const [passwordMode, setPasswordMode] = useState("keep");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const requestRef = useRef<Promise<ShareCollectionResult> | null>(null);
  const deliveredRef = useRef<ShareCollectionResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const titleChanged = Boolean(result && title.trim() && title.trim() !== result.title);
  const settingsChanged = titleChanged || expiryMode !== "keep" || passwordMode !== "keep";

  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(null);
    if (!requestRef.current) {
      requestRef.current =
        existing && attempt === 0
          ? Promise.resolve(existing)
          : createShareCollection(
              bucket,
              title.trim() || initialTitle.slice(0, 120) || "文件分享",
              files,
            );
    }
    void requestRef.current
      .then(async (share) => {
        if (!active) return;
        setResult(share);
        setBusy(false);
        if (deliveredRef.current === share) return;
        deliveredRef.current = share;
        onCreated(share);
        try {
          await copyTextToClipboard(share.url);
          if (active) setFeedback("分享短链已复制，发送给对方即可。");
        } catch {
          if (active) setFeedback("分享页已准备好。请点击复制，或选中下方短链手动复制。");
        }
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setBusy(false);
        setError(cause instanceof Error ? cause.message : "生成分享短链失败，请重试。");
      });
    return () => {
      active = false;
    };
    // Title is captured only when generating; editing the optional title does not issue requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, bucket, existing, files, onCreated]);

  const copy = async () => {
    if (!result) return;
    try {
      await copyTextToClipboard(result.url);
      setFeedback("分享短链已复制，发送给对方即可。");
    } catch {
      setFeedback("复制未成功，请选中短链后手动复制。");
    }
  };
  const regenerate = () => {
    requestRef.current = null;
    setResult(null);
    setFeedback("");
    setAttempt((value) => value + 1);
  };

  const saveSettings = async () => {
    if (!result || saving) return;
    if (passwordMode === "set" && password.length < 4) {
      setError("提取码至少需要 4 个字符。");
      return;
    }
    if (
      expiryMode === "custom" &&
      (!expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())
    ) {
      setError("请选择晚于当前时间的有效期。");
      return;
    }
    setSaving(true);
    setError(null);
    const days = expiryMode === "day" ? 1 : expiryMode === "week" ? 7 : 30;
    const options = {
      ...(titleChanged ? { title: title.trim() } : {}),
      ...(expiryMode === "keep"
        ? {}
        : {
            expiresAt:
              expiryMode === "none"
                ? null
                : expiryMode === "custom"
                  ? new Date(expiresAt).toISOString()
                  : new Date(Date.now() + days * 86400000).toISOString(),
          }),
      ...(passwordMode === "keep" ? {} : { password: passwordMode === "remove" ? null : password }),
    };
    try {
      const response = await fetch(
        `/api/manage/shares/collection/${encodeURIComponent(result.code)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "分享设置未保存，请重试。");
      }
      const updated = { ...result, title: title.trim() || result.title };
      setResult(updated);
      onCreated(updated);
      setExpiryMode("keep");
      setPasswordMode("keep");
      setPassword("");
      try {
        await copyTextToClipboard(updated.url);
        setFeedback("分享设置已保存，短链已复制。已发出的同一短链也会使用新设置。");
      } catch {
        setFeedback("分享设置已保存。请选中短链手动复制。");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存分享设置失败。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog labelledBy="share-dialog-title" onClose={onClose} className="share-dialog-overlay">
      <section className="modal-card share-dialog-card">
        <div className="share-dialog-heading">
          <div>
            <p className="share-dialog-kicker">文件分享</p>
            <h3 id="share-dialog-title">
              {busy ? "正在准备分享页" : result ? "分享页已准备好" : "分享文件"}
            </h3>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭分享">
            关闭
          </button>
        </div>
        <div className="share-dialog-summary">
          <strong>{files.length} 个文件</strong>
          <span>{formatSize(totalSize)}</span>
          <span>一个短链</span>
        </div>
        <p className="share-dialog-note">
          接收方打开后先预览，按需下载。图片可以直接看，视频可以在线播放，无需登录。
        </p>
        {busy ? (
          <p className="share-dialog-feedback" role="status">
            正在生成分享页面短链…
          </p>
        ) : null}
        {error ? (
          <p className="share-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        {result ? (
          <>
            <label className="share-dialog-field">
              <span>分享页面短链</span>
              <input
                className="share-dialog-url"
                value={result.url}
                readOnly
                onFocus={(event) => event.target.select()}
              />
            </label>
            <div className="share-dialog-main-actions">
              <button type="button" className="share-dialog-primary" onClick={() => void copy()}>
                复制分享短链
              </button>
              <a
                className="share-dialog-preview"
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看接收方页面
              </a>
            </div>
          </>
        ) : null}
        {feedback ? (
          <p className="share-dialog-feedback" role="status">
            {feedback}
          </p>
        ) : null}
        {!busy && error && !result ? (
          <button type="button" onClick={regenerate}>
            重试生成短链
          </button>
        ) : null}
        <details className="share-dialog-title-options">
          <summary>标题、有效期与提取码</summary>
          <label className="share-dialog-field">
            <span>对方看到的标题</span>
            <input
              value={title}
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              disabled={busy || saving}
            />
          </label>
          <label className="share-dialog-field">
            <span>有效期</span>
            <select
              value={expiryMode}
              onChange={(event) => setExpiryMode(event.target.value)}
              disabled={busy || saving}
            >
              <option value="keep">保留当前设置</option>
              <option value="day">1 天后到期</option>
              <option value="week">7 天后到期</option>
              <option value="month">30 天后到期</option>
              <option value="custom">指定日期时间</option>
              <option value="none">长期有效</option>
            </select>
          </label>
          {expiryMode === "custom" ? (
            <label className="share-dialog-field">
              <span>有效期至</span>
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                disabled={busy || saving}
              />
            </label>
          ) : null}
          <label className="share-dialog-field">
            <span>提取码</span>
            <select
              value={passwordMode}
              onChange={(event) => setPasswordMode(event.target.value)}
              disabled={busy || saving}
            >
              <option value="keep">保留当前设置</option>
              <option value="set">设置提取码</option>
              <option value="remove">取消提取码</option>
            </select>
          </label>
          {passwordMode === "set" ? (
            <label className="share-dialog-field">
              <span>新提取码（4 至 128 个字符）</span>
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                minLength={4}
                maxLength={128}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy || saving}
              />
              <small>请将提取码单独告知接收者，短链中不会包含提取码。</small>
            </label>
          ) : null}
          {settingsChanged && result && !busy ? (
            <>
              <p className="share-dialog-note">设置将直接应用于当前短链，已发出的链接也会更新。</p>
              <button type="button" onClick={() => void saveSettings()} disabled={saving}>
                {saving ? "正在保存…" : "保存设置并复制短链"}
              </button>
            </>
          ) : null}
        </details>
        <details className="share-dialog-files" open={files.length <= 3}>
          <summary>本次分享的文件（{files.length}）</summary>
          <ul>
            {files.map((file) => (
              <li key={file.key}>
                <span className="share-dialog-file-type" aria-hidden="true">
                  {fileType(file.name)}
                </span>
                <span className="share-dialog-file-name" title={file.key}>
                  {file.name}
                </span>
                <span className="share-dialog-file-size">{formatSize(file.size)}</span>
              </li>
            ))}
          </ul>
        </details>
      </section>
    </Dialog>
  );
};
