/**
 * src/App.tsx — Application shell (P0.3)
 *
 * Layout:
 *   - <ErrorBoundary> with glass-strong fallback
 *   - BrowserRouter with two routes:
 *       /         → AppShell (base layout placeholder)
 *       /_/design → DesignPreview (dev-only visual-diff target; absent in prod)
 */

import { lazy, Suspense } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import AppShell from "./AppShell";

// DesignPreview is lazy-loaded and the route is only registered in DEV.
// In production: this import never executes, tree-shaken away.
const DesignPreview = import.meta.env.DEV
  ? lazy(() => import("./pages/DesignPreview"))
  : null;

// ---------------------------------------------------------------------------
// ErrorBoundary fallback — glass-styled, dark-themed, actionable.
// ---------------------------------------------------------------------------

function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-0)",
        padding: "var(--sp-32)",
      }}
    >
      <div
        className="glass-strong"
        style={{
          maxWidth: 480,
          width: "100%",
          padding: "var(--sp-32)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-16)",
        }}
      >
        <div className="t-eyebrow" style={{ color: "var(--down)" }}>
          Unexpected error
        </div>
        <div className="t-h2">Something went wrong.</div>
        <p className="t-body">
          {error instanceof Error
            ? error.message
            : "An unknown error occurred."}
        </p>
        <button
          className="glass"
          style={{
            padding: "var(--sp-8) var(--sp-16)",
            borderRadius: "var(--r-8)",
            cursor: "pointer",
            alignSelf: "flex-start",
            color: "var(--ink-0)",
            fontSize: "var(--fs-body)",
          }}
          onClick={resetErrorBoundary}
        >
          Try again
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root app
// ---------------------------------------------------------------------------

export default function App() {
  return (
    <ErrorBoundary FallbackComponent={ErrorFallback}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<AppShell />} />
          {import.meta.env.DEV && DesignPreview && (
            <Route
              path="/_/design"
              element={
                <Suspense fallback={null}>
                  <DesignPreview />
                </Suspense>
              }
            />
          )}
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
