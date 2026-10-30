// Modified for Atrium Share. See ATTRIBUTION.md for upstream provenance and changes.
import { useState } from "react";

type LoginFormProps = {
  isLoading: boolean;
  error: string | null;
  onSubmit: (accessKeyId: string, secretAccessKey: string) => Promise<void>;
};

export const LoginForm = ({ isLoading, error, onSubmit }: LoginFormProps) => {
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    await onSubmit(accessKeyId.trim(), secretAccessKey.trim());
  };

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Atrium Share</h1>
        <p>安全私有的对象存储(S3)浏览器</p>

        <label>
          Access Key ID
          <input
            type="text"
            value={accessKeyId}
            onChange={(event) => setAccessKeyId(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoCorrect="off"
            required
          />
        </label>

        <label>
          Secret Access Key
          <input
            type="password"
            value={secretAccessKey}
            onChange={(event) => setSecretAccessKey(event.target.value)}
            autoComplete="current-password"
            autoCapitalize="none"
            spellCheck={false}
            autoCorrect="off"
            required
          />
        </label>

        {error ? <div className="error-banner">{error}</div> : null}

        <button type="submit" disabled={isLoading}>
          {isLoading ? "登录中..." : "登录"}
        </button>
      </form>
    </div>
  );
};
