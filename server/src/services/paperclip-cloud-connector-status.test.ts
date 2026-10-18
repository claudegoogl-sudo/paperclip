import { describe, expect, it, vi } from "vitest";

const mockEnrollmentStatus = vi.hoisted(() => vi.fn());
const mockConfigFromEnv = vi.hoisted(() => vi.fn());
const mockGetInstanceStatus = vi.hoisted(() => vi.fn());
const mockCreateConnector = vi.hoisted(() => vi.fn(() => ({ getInstanceStatus: mockGetInstanceStatus })));

vi.mock("./paperclip-cloud-connector-enrollment.js", () => ({
  paperclipCloudConnectorEnrollmentStatus: mockEnrollmentStatus,
}));
vi.mock("./paperclip-cloud-connector.js", () => ({
  paperclipCloudConnectorConfigFromEnv: mockConfigFromEnv,
  createPaperclipCloudConnector: mockCreateConnector,
}));

import { reconcilePaperclipCloudConnectorEnrollmentStatus } from "./paperclip-cloud-connector-status.js";

const LOCAL_CONFIGURED = { configured: true, status: "active", brokerBaseUrl: "https://broker.example" };
const LOCAL_UNCONFIGURED = { configured: false, status: "not_configured", brokerBaseUrl: "https://broker.example" };

describe("reconcilePaperclipCloudConnectorEnrollmentStatus", () => {
  it("returns the local status unchanged when not locally configured, without resolving a remote config", async () => {
    mockEnrollmentStatus.mockReturnValue(LOCAL_UNCONFIGURED);
    const result = await reconcilePaperclipCloudConnectorEnrollmentStatus({});
    expect(result).toEqual(LOCAL_UNCONFIGURED);
    expect(mockConfigFromEnv).not.toHaveBeenCalled();
    expect(mockCreateConnector).not.toHaveBeenCalled();
  });

  it("returns not_configured when locally configured but no remote config can be resolved", async () => {
    mockEnrollmentStatus.mockReturnValue(LOCAL_CONFIGURED);
    mockConfigFromEnv.mockReturnValue(null);
    const result = await reconcilePaperclipCloudConnectorEnrollmentStatus({});
    expect(result).toEqual({ ...LOCAL_CONFIGURED, configured: false, status: "not_configured" });
    expect(mockCreateConnector).not.toHaveBeenCalled();
  });

  it("reports active when the remote instance status is active", async () => {
    mockEnrollmentStatus.mockReturnValue(LOCAL_CONFIGURED);
    mockConfigFromEnv.mockReturnValue({ instanceId: "i-1" });
    mockGetInstanceStatus.mockResolvedValue("active");
    const result = await reconcilePaperclipCloudConnectorEnrollmentStatus({});
    expect(result).toEqual({ ...LOCAL_CONFIGURED, configured: true, status: "active" });
  });

  it("reports suspended (and configured: false) when the remote instance status is suspended", async () => {
    mockEnrollmentStatus.mockReturnValue(LOCAL_CONFIGURED);
    mockConfigFromEnv.mockReturnValue({ instanceId: "i-1" });
    mockGetInstanceStatus.mockResolvedValue("suspended");
    const result = await reconcilePaperclipCloudConnectorEnrollmentStatus({});
    expect(result).toEqual({ ...LOCAL_CONFIGURED, configured: false, status: "suspended" });
  });

  it("falls back to not_configured for any other remote status value", async () => {
    mockEnrollmentStatus.mockReturnValue(LOCAL_CONFIGURED);
    mockConfigFromEnv.mockReturnValue({ instanceId: "i-1" });
    mockGetInstanceStatus.mockResolvedValue("something_else");
    const result = await reconcilePaperclipCloudConnectorEnrollmentStatus({});
    expect(result).toEqual({ ...LOCAL_CONFIGURED, configured: false, status: "not_configured" });
  });

  it("reports unverified when the remote status check throws", async () => {
    mockEnrollmentStatus.mockReturnValue(LOCAL_CONFIGURED);
    mockConfigFromEnv.mockReturnValue({ instanceId: "i-1" });
    mockGetInstanceStatus.mockRejectedValue(new Error("network error"));
    const result = await reconcilePaperclipCloudConnectorEnrollmentStatus({});
    expect(result).toEqual({ ...LOCAL_CONFIGURED, configured: false, status: "unverified" });
  });
});
