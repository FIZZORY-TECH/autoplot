import "@testing-library/jest-dom";

// Node 22+ ships an experimental built-in `localStorage` that is `undefined`
// unless launched with `--localstorage-file`. In the jsdom test environment this
// experimental global leaks in and shadows jsdom's own Storage implementation,
// causing `window.localStorage` to be `undefined`. Install a minimal in-memory
// Storage on `window` so tests that read/write `localStorage` (e.g. the
// `use-mock-provider` flag) work regardless of the Node version.
//
// This must run BEFORE any test module touches `window.localStorage`, which is
// why it lives here (setupFiles runs first) rather than in the test file itself.
if (typeof window !== "undefined" && !window.localStorage) {
  class InMemoryStorage implements Storage {
    private _store: Record<string, string> = {};
    get length(): number { return Object.keys(this._store).length; }
    key(index: number): string | null { return Object.keys(this._store)[index] ?? null; }
    getItem(key: string): string | null { return Object.prototype.hasOwnProperty.call(this._store, key) ? this._store[key] : null; }
    setItem(key: string, value: string): void { this._store[key] = String(value); }
    removeItem(key: string): void { delete this._store[key]; }
    clear(): void { this._store = {}; }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Object.defineProperty(window, "localStorage", {
    value: new InMemoryStorage(),
    writable: true,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Object.defineProperty(window, "sessionStorage", {
    value: new InMemoryStorage(),
    writable: true,
  });
}

// jsdom doesn't implement ResizeObserver; ChartCanvas uses it for layout.
// Provide a minimal stub so component tests can mount the canvas without
// throwing. Real layout is exercised in Playwright (P1.4).
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = ResizeObserverStub;
  // jsdom separates globalThis from window; assign to both so that
  // `new ResizeObserver(...)` succeeds whether the lookup resolves via
  // the window scope (browser path) or the node globalThis.
  if (typeof window !== "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).ResizeObserver = ResizeObserverStub;
  }
}

// jsdom's HTMLCanvasElement.getContext is "not implemented" — it logs a noisy
// stderr blob and returns null. ChartCanvas already handles a null context
// (early-returns from the render effect), but the log spam clutters CI. Stub
// it with a no-op 2D context that records nothing.
// Real canvas pixel output is verified by Playwright snapshots (P1.4).
if (typeof HTMLCanvasElement !== "undefined") {
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (id: string) => CanvasRenderingContext2D | null;
  };
  const originalGetContext = proto.getContext;
  proto.getContext = function (id: string): CanvasRenderingContext2D | null {
    if (id !== "2d") return originalGetContext.call(this, id);
    // Return a Proxy that swallows every method call and property read used
    // by the renderer. Properties we set (strokeStyle etc.) round-trip.
    const state: Record<string, unknown> = {};
    return new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop in state) return state[prop];
          // Method stubs — return a noop function for everything else.
          return () => undefined;
        },
        set(_t, prop: string, value: unknown) {
          state[prop] = value;
          return true;
        },
      },
    ) as unknown as CanvasRenderingContext2D;
  };
}
