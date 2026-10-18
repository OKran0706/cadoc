import { api } from "@/lib/api";
import type { OnboardRequest, JoinRequest, JoinResponse } from "@/lib/types";

export const onboardingService = {
  /** POST /api/v1/onboarding/provision */
  provisionTenant: (payload: OnboardRequest) =>
    api.post<void>("/api/v1/onboarding/provision", payload),

  /** POST /api/v1/bootstrap/join */
  brokeredJoin: (payload: JoinRequest) =>
    api.post<JoinResponse>("/api/v1/bootstrap/join", payload),
};
