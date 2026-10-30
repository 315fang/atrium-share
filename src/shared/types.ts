// Modified for Atrium Share. See ATTRIBUTION.md for upstream provenance and changes.
// Shared type definitions used by both frontend and backend

export type RuntimeSentryConfig = {
  dsn?: string;
  environment?: string;
  release?: string;
  tracesSampleRate?: string | number;
  enableLogs?: boolean;
  enableMetrics?: boolean;
  replaysSessionSampleRate?: string | number;
  replaysOnErrorSampleRate?: string | number;
};

export type RuntimeConfigResponse = {
  sentry?: RuntimeSentryConfig;
  features?: {
    enableS3UriCopy?: boolean;
    shareBaseUrl?: string;
    shareBucket?: string;
  };
};
