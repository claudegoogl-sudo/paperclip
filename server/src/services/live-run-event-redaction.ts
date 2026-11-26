import type { Db } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { redactCurrentUserValue } from "../log-redaction.js";
import { PRP_V1_EVENT_TYPES, PRP_V2_EVENT_TYPES, redactEventPayload } from "../redaction.js";
import { instanceSettingsService } from "./instance-settings.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";

export function createLiveRunEventRedactor(db: Db) {
  const settings = instanceSettingsService(db);
  const redactions = createRunSecretRedactionRegistry(db);
  return async (event: LiveEvent): Promise<LiveEvent | null> => {
    const runId = event.payload.runId;
    if (typeof runId !== "string") return null;
    const sanitized = redactEventPayload(event.payload) ?? {};
    // The envelope's own eventType is a public PRP discriminator; the dotted name is
    // JWT-shaped to the value heuristic, so restore it only for the exact known set.
    const envelopeType = event.payload.eventType;
    if (
      typeof envelopeType === "string" &&
      (PRP_V1_EVENT_TYPES.has(envelopeType) || PRP_V2_EVENT_TYPES.has(envelopeType))
    ) {
      sanitized.eventType = envelopeType;
    }
    const redacted = redactCurrentUserValue({ ...event,
      payload: sanitized,
    }, { enabled: (await settings.getGeneral()).censorUsernameInLogs });
    return redactions.redactForRun(event.companyId, runId, redacted);
  };
}
