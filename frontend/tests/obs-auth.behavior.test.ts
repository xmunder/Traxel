import { afterEach, describe, expect, test, vi } from "vitest";
import { hasSession, initObsLogin, loginErrorForStatus, obsNavigateTo } from "../src/lib/obs-auth";

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("observability auth", () => {
  test("formats all supported login errors", () => {
    expect(loginErrorForStatus(401)).toContain("Invalid credentials");
    expect(loginErrorForStatus(403)).toContain("Invalid credentials");
    expect(loginErrorForStatus(503)).toContain("not configured");
    expect(loginErrorForStatus(500)).toContain("HTTP 500");
  });

  test("navigates through the event and browser history in jsdom", () => {
    const listener = vi.fn();
    window.addEventListener("obs:navigate", listener);
    obsNavigateTo("/observability/dashboard");
    expect(listener).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe("/observability/dashboard");
    window.removeEventListener("obs:navigate", listener);
  });

  test("reports session availability and network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true }));
    await expect(hasSession("http://api.test")).resolves.toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("offline")));
    await expect(hasSession("http://api.test")).resolves.toBe(false);
  });

  test("requires credentials before submitting", () => {
    document.body.innerHTML = `<div data-obs-login data-obs-endpoint="http://api.test"><form data-obs-login-form><input data-obs-username><input data-obs-password><p data-obs-login-error hidden></p><button data-obs-login-submit></button></form></div>`;
    initObsLogin();
    const form = document.querySelector("form")!;
    const error = document.querySelector("[data-obs-login-error]")! as HTMLElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("required");
  });

  test("submits valid credentials and handles server errors", async () => {
    document.body.innerHTML = `<div data-obs-login data-obs-endpoint="http://api.test"><form data-obs-login-form><input data-obs-username value="admin"><input data-obs-password value="secret"><p data-obs-login-error hidden></p><button data-obs-login-submit></button></form></div>`;
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);
    initObsLogin();
    document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(document.querySelector("[data-obs-login-error]")!.textContent).toContain("Invalid credentials");
  });
});
