import { GraphQLError } from "graphql";
import {
  registerPushToken as registerPushTokenDb,
  unregisterPushToken as unregisterPushTokenDb,
} from "#src/db/index";
import type { RegisterPushToken, UnregisterPushToken } from "#src/generated/graphql";
import { checkRegisterPushToken, checkUnregisterPushToken } from "#src/schema/validators/index";
import type { MutationAck } from "#src/types/models";
import { logger } from "#src/utils/logger";
import { assertValidInput, withContentionRetryHint } from "./errors.ts";

// The app registers its token on every start, so a repeated call only
// refreshes lastSeenAt.
export const registerPushToken = async (input: RegisterPushToken, userId: string): Promise<MutationAck> => {
  assertValidInput(checkRegisterPushToken, input);
  const { movedFromAnotherUser } = await withContentionRetryHint(() =>
    registerPushTokenDb({ token: input.token.trim(), platform: input.platform }, userId)
  );
  if (movedFromAnotherUser) {
    logger.info("Push token moved to another user", { platform: input.platform });
  }
  return {
    code: "200",
    success: true,
    message: "Push token registered",
  };
};

// Another user's token answers NOT_FOUND, as if it didn't exist (H2).
export const unregisterPushToken = async (input: UnregisterPushToken, userId: string): Promise<MutationAck> => {
  assertValidInput(checkUnregisterPushToken, input);
  const deleted = await withContentionRetryHint(() => unregisterPushTokenDb(input.token.trim(), userId));
  if (!deleted) {
    throw new GraphQLError("Push token not found", {
      extensions: {
        code: "NOT_FOUND",
        invalidArgument: "token",
      },
    });
  }
  return {
    code: "200",
    success: true,
    message: "Push token unregistered",
  };
};
