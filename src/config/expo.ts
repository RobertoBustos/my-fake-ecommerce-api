import { Expo } from "expo-server-sdk";
import env from "./env.ts";

// With "Enhanced push security" on in the Expo project, Expo only accepts
// sends that carry this token (Secret Manager: expo-access-token). The
// APNs and FCM credentials live in EAS, never in the API.
const expoClient = new Expo({ accessToken: env.EXPO_ACCESS_TOKEN });

export default expoClient;
