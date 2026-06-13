import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import App from "./App";

// Mock Tauri API — not available in jsdom test environment
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue("Hello, test!"),
}));

describe("App", () => {
  it("renders the app shell without crashing", () => {
    const { container } = render(<App />);
    // P2.1: Headline renders the active symbol in the chrome.
    // The Headline component displays the symbol ("BTC") in its own span.
    // The hint strip is also present (aria-hidden, but in the DOM).
    expect(screen.getByLabelText(/BTC price headline/i)).toBeInTheDocument();
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });
});
