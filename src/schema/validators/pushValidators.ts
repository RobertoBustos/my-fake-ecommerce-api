import { Expo } from "expo-server-sdk";
import { z } from "zod";
import { firstInvalidField } from "./validate.ts";

// Only a token Expo's push service accepts; anything else would be stored
// and then fail on every send.
const token = z.string().trim().refine((value) => Expo.isExpoPushToken(value));

const registerPushTokenSchema = z.object({ token, platform: z.enum(["IOS", "ANDROID"]) });

const unregisterPushTokenSchema = z.object({ token: z.string().trim().min(1) });

export const checkRegisterPushToken = (input: unknown) => firstInvalidField(registerPushTokenSchema, input);

export const checkUnregisterPushToken = (input: unknown) => firstInvalidField(unregisterPushTokenSchema, input);
