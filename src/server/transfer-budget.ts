import type { FastifyReply, FastifyRequest } from "fastify";

const activeByIp = new Map<string, number>();
let active = 0;

/** Bound open upstream connections across previews and direct downloads. */
export const acquireTransfer = (request: FastifyRequest, reply: FastifyReply): boolean => {
  const ip = request.ip;
  const perIp = activeByIp.get(ip) || 0;
  if (active >= 32 || perIp >= 8) {
    reply.header("Retry-After", "3").code(429).send({ error: "当前下载较多，请稍后重试" });
    return false;
  }
  active += 1;
  activeByIp.set(ip, perIp + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    active -= 1;
    const remaining = (activeByIp.get(ip) || 1) - 1;
    if (remaining) activeByIp.set(ip, remaining);
    else activeByIp.delete(ip);
  };
  reply.raw.once("close", release);
  reply.raw.once("finish", release);
  request.raw.once("aborted", release);
  return true;
};
