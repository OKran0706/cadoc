import type { AvatarDefinition } from "@bible-strong/avatar-core";
import sentinelData from "@/data/sentinel.avatar.json";

export const sentinelAvatarDefinition = sentinelData as unknown as AvatarDefinition;

export type SentinelExpression =
  | "neutral"
  | "happy"
  | "explaining"
  | "thinking"
  | "alert"
  | "secure";

export type SentinelAnimation = "idle" | "guide" | "scanning" | "warning";
