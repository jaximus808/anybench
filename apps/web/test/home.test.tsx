import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import HomePage from "../app/(marketing)/page";
import { Footer } from "../components/site/Footer";
import { Header } from "../components/site/Header";

afterEach(cleanup);

describe("web home placeholder (TDM-98)", () => {
  it("renders the headline", () => {
    render(<HomePage />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Find out if what you built is actually better.",
      }),
    ).toBeTruthy();
  });

  it("header shows the signed-out nav", () => {
    render(<Header />);
    for (const name of ["Anybench", "How it works", "Pricing", "Docs", "Sign in"])
      expect(screen.getByRole("link", { name })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/signin");
  });

  it("header mobile menu opens, then closes on Escape", () => {
    render(<Header />);
    const toggle = screen.getByRole("button", { name: "Open menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("link", { name: "Sign in" })).toHaveLength(2);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("footer links the legal pages", () => {
    render(<Footer />);
    const legal = screen.getByRole("navigation", { name: "Legal" });
    const hrefs = within(legal)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/terms", "/privacy", "/refunds", "/aup"]);
  });
});
