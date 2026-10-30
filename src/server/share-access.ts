import crypto from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getShareStore, type ShareKind, type ShareStore, type StoredShare } from "./share-store.js";

const deriveKey = promisify(crypto.scrypt);
export const ownerHashFor = (request: FastifyRequest): string => {
  const key = request.sessionCredentials?.accessKeyId;
  if (!key) throw Object.assign(new Error("登录会话不可用，请重新登录"), { statusCode: 401 });
  return crypto.createHash("sha256").update(key).digest("hex");
};

/** A shared background reader must never grant a different login its broader S3 permissions. */
export const assertSharePublisher = (request: FastifyRequest): string => {
  const owner = ownerHashFor(request),
    configured = process.env.SHARE_OWNER_HASH;
  if (process.env.SHARE_READER_CREDENTIALS_FILE && !configured)
    throw Object.assign(new Error("分享权限尚未配置，请联系管理员"), { statusCode: 503 });
  if (configured && configured !== owner)
    throw Object.assign(new Error("此账号未启用文件分享"), { statusCode: 403 });
  return owner;
};

export const hashSharePassword = async (password: string): Promise<string> => {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = (await deriveKey(password, salt, 32)) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
};

export const verifySharePassword = async (password: string, encoded: string): Promise<boolean> => {
  const [algorithm, salt, key] = encoded.split(":");
  if (algorithm !== "scrypt" || !salt || !/^[a-f0-9]{64}$/.test(key || "")) return false;
  const actual = (await deriveKey(password, salt, 32)) as Buffer;
  return crypto.timingSafeEqual(actual, Buffer.from(key, "hex"));
};

const cookieName = (share: StoredShare): string =>
  `atrium_share_${share.kind === "file" ? "s" : "c"}_${share.code}`;
const readCookie = (request: FastifyRequest, name: string): string | undefined => {
  if (request.cookies?.[name]) return request.cookies[name];
  const value = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(name + "="));
  if (!value) return undefined;
  try {
    return decodeURIComponent(value.slice(name.length + 1));
  } catch {
    return undefined;
  }
};

const signature = (store: ShareStore, value: string): string =>
  crypto.createHmac("sha256", store.signingSecret).update(value).digest("base64url");
const unlocked = (request: FastifyRequest, store: ShareStore, share: StoredShare): boolean => {
  if (!share.passwordHash) return true;
  const token = readCookie(request, cookieName(share));
  if (!token) return false;
  const [expiry, version, provided] = token.split(".");
  if (
    !expiry ||
    !version ||
    !provided ||
    Number(expiry) <= Date.now() ||
    Number(version) !== share.accessVersion
  )
    return false;
  const expected = signature(store, `${share.kind}:${share.code}:${expiry}:${version}`);
  const actual = Buffer.from(provided),
    reference = Buffer.from(expected);
  return actual.length === reference.length && crypto.timingSafeEqual(actual, reference);
};

export const shareChain = (store: ShareStore, share: StoredShare): StoredShare[] | undefined => {
  const chain: StoredShare[] = [];
  const visited = new Set<string>();
  let current: StoredShare | undefined = share;
  while (current) {
    const identity = `${current.kind}:${current.code}`;
    if (visited.has(identity) || chain.length >= 10) return undefined;
    visited.add(identity);
    chain.unshift(current);
    if (!current.parentCode) break;
    current = store.get(current.parentKind || "collection", current.parentCode);
    if (!current) return undefined;
  }
  return chain;
};

export const inactiveShare = (
  chain: StoredShare[],
): { revoked: boolean; expired: boolean } | undefined => {
  const revoked = chain.some((share) => share.revoked);
  const expired = chain.some(
    (share) => share.expiresAt !== undefined && Date.parse(share.expiresAt) <= Date.now(),
  );
  return revoked || expired ? { revoked, expired } : undefined;
};

const visitorIdentity = (request: FastifyRequest): string =>
  `${request.ip}|${request.headers["user-agent"] || ""}`;
export type ShareAccessOptions = {
  countView?: boolean;
  countDownload?: boolean;
  eventKey?: string;
};
export const createShareAccess = (app: FastifyInstance) => {
  const store = getShareStore(app);
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
    kind: ShareKind,
    code: string,
    options: ShareAccessOptions = {},
  ): Promise<StoredShare | null> => {
    reply.header("Cache-Control", "no-store");
    const share = store.get(kind, code);
    const chain = share && shareChain(store, share);
    if (!share || !chain) {
      reply.code(404).send({ error: "分享不存在或已失效" });
      return null;
    }
    const inactive = inactiveShare(chain);
    if (inactive) {
      reply
        .code(410)
        .send({ error: inactive.revoked ? "分享者已停止分享" : "分享已到期", ...inactive });
      return null;
    }
    if (chain.some((entry) => !unlocked(request, store, entry))) {
      reply.code(401).send({ error: "请输入提取码后查看文件", requiresPassword: true });
      return null;
    }
    if (request.method !== "HEAD") {
      if (options.countView) store.recordAccess(share, visitorIdentity(request), "view");
      if (options.countDownload)
        store.recordAccess(share, visitorIdentity(request), "download", options.eventKey);
    }
    return share;
  };
};

export const unlockShare = async (
  request: FastifyRequest,
  reply: FastifyReply,
  store: ShareStore,
  kind: ShareKind,
  code: string,
) => {
  reply.header("Cache-Control", "no-store");
  const share = store.get(kind, code),
    chain = share && shareChain(store, share);
  if (!share || !chain) return reply.code(404).send({ error: "分享不存在或已失效" });
  const inactive = inactiveShare(chain);
  if (inactive)
    return reply
      .code(410)
      .send({ error: inactive.revoked ? "分享者已停止分享" : "分享已到期", ...inactive });
  const locked = chain.find((entry) => !unlocked(request, store, entry));
  if (!locked) return { ok: true };
  const identifier = crypto
    .createHmac("sha256", store.signingSecret)
    .update(`${locked.kind}:${locked.code}:${request.ip}`)
    .digest("hex");
  if (!store.consumeLimit(`unlock:${identifier}`, 10, 15 * 60_000))
    return reply
      .code(429)
      .header("Retry-After", "900")
      .send({ error: "提取码尝试过于频繁，请稍后重试" });
  const password = (request.body as { password?: unknown } | undefined)?.password;
  if (
    typeof password !== "string" ||
    password.length < 1 ||
    password.length > 100 ||
    !(await verifySharePassword(password, locked.passwordHash!))
  )
    return reply.code(401).send({ error: "提取码不正确，请重试", requiresPassword: true });
  const expires = Math.min(
    Date.now() + 6 * 60 * 60_000,
    ...chain.filter((entry) => entry.expiresAt).map((entry) => Date.parse(entry.expiresAt!)),
  );
  const payload = `${expires}.${locked.accessVersion}`;
  const value = `${payload}.${signature(store, `${locked.kind}:${locked.code}:${expires}:${locked.accessVersion}`)}`;
  const name = cookieName(locked);
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.max(1, Math.floor((expires - Date.now()) / 1000)),
  };
  if (typeof reply.setCookie === "function") reply.setCookie(name, value, cookieOptions);
  else
    reply.header(
      "Set-Cookie",
      `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cookieOptions.maxAge}${cookieOptions.secure ? "; Secure" : ""}`,
    );
  return { ok: true };
};
