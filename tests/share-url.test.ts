import { describe, expect, it } from "vitest";
import { isSharePageUrl } from "../src/shared/share-url";

describe("share page URLs", () => {
  it.each([
    "https://files.example.com/c/DemoSearch12",
    "http://localhost:3000/c/DemoSearch12",
    "http://127.0.0.1:3000/c/DemoSearch12",
    "http://[::1]:3000/c/DemoSearch12",
  ])("accepts a secure or local preview page: %s", (value) => {
    expect(isSharePageUrl(new URL(value))).toBe(true);
  });

  it.each([
    "http://files.example.com/c/DemoSearch12",
    "http://localhost.example.com/c/DemoSearch12",
    "https://user:password@files.example.com/c/DemoSearch12",
    "https://files.example.com/c/DemoSearch12?download=1",
    "https://files.example.com/c/DemoSearch12#file=0",
    "https://files.example.com/object/long-file-name.mp4",
    "javascript:alert(1)",
  ])("rejects an unsafe link or a direct download: %s", (value) => {
    expect(isSharePageUrl(new URL(value))).toBe(false);
  });
});
