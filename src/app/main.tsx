// Modified for Atrium Share. See ATTRIBUTION.md for upstream provenance and changes.
// Select the entry before importing administration, monitoring, or query dependencies.
const shareRoute = /^\/(c|s)\/([A-Za-z0-9_-]+)\/?$/.exec(window.location.pathname);
const start = shareRoute
  ? import("./public-bootstrap").then(({ mountShare }) =>
      mountShare(shareRoute[2], shareRoute[1] === "s" ? "file" : "collection"),
    )
  : import("./admin-bootstrap").then(({ mountAdmin }) => mountAdmin());

void start.catch(() => {
  const root = document.getElementById("root");
  if (root) root.textContent = "页面加载失败，请刷新后重试。";
});
