export {};

import type { AgentApiKeyScope, BoardApiKeyScope } from "@paperclipai/shared";

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "board" | "agent" | "none";
        userId?: string;
        userName?: string | null;
        userEmail?: string | null;
        agentId?: string;
        companyId?: string;
        companyIds?: string[];
        memberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        onBehalfOfMemberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        isInstanceAdmin?: boolean;
        keyId?: string;
        keyScope?: AgentApiKeyScope;
        // Board-key scope. Only meaningful when source === "board_key".
        // Null/absent = unscoped (key inherits user authority); kind:plugin_ops
        // restricts the key to plugin ops + issue read/comment. Enforced by
        // enforceBoardKeyScopeMiddleware in server/src/middleware/auth.ts.
        boardKeyScope?: BoardApiKeyScope;
        runId?: string;
        onBehalfOfUserId?: string | null;
        source?: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "cloud_tenant" | "none";
      };
    }
  }
}
