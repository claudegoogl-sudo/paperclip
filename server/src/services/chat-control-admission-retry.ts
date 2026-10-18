import { isExternalChatWaitAuthorizationContention } from "./native-runtime/chat-attachment-reuse.js";

export const CHAT_CONTROL_ADMISSION_RETRY_MIN_DELAY_MS = 50;
export const CHAT_CONTROL_ADMISSION_RETRY_MAX_DELAY_MS = 150;

export interface ChatControlAdmissionRetryOptions {
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retry only a rolled-back admission transaction, never provider execution. */
export async function retryChatControlAdmission<T>(
  attempt: () => Promise<T>,
  options: ChatControlAdmissionRetryOptions = {},
): Promise<T> {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const spread = CHAT_CONTROL_ADMISSION_RETRY_MAX_DELAY_MS - CHAT_CONTROL_ADMISSION_RETRY_MIN_DELAY_MS;
  for (let retry = 0; ; retry += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (retry >= 50 || !isExternalChatWaitAuthorizationContention(error)) throw error;
    }
    // The previous transaction has released all locks. The next attempt must
    // read current run ownership and close evidence again before admission.
    // Jitter keeps callers that contend on the same lock from retrying in lockstep.
    await sleep(CHAT_CONTROL_ADMISSION_RETRY_MIN_DELAY_MS + Math.floor(random() * (spread + 1)));
  }
}
