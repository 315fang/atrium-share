import React from "react";
import * as Sentry from "@sentry/react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initializeSentry } from "./sentry.client";
import { App } from "./App";
import "@fontsource-variable/work-sans";
import "./styles.css";

export const mountAdmin = async (): Promise<void> => {
  await initializeSentry();
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing application root");
  createRoot(root).render(
    <React.StrictMode>
      <Sentry.ErrorBoundary fallback={<div className="centered">页面加载失败，请刷新后重试。</div>}>
        <QueryClientProvider client={new QueryClient()}>
          <App />
        </QueryClientProvider>
      </Sentry.ErrorBoundary>
    </React.StrictMode>,
  );
};
