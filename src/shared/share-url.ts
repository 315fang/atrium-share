/** Published links use HTTPS; loopback HTTP keeps local development usable. */
export const isSharePageUrl = (url: URL): boolean => {
  const secure = url.protocol === "https:";
  const loopback =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return (
    (secure || loopback) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    /^\/c\/[A-Za-z0-9_-]+$/.test(url.pathname)
  );
};
