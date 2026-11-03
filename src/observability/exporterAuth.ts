import { credentials, Metadata, type ChannelCredentials } from "@grpc/grpc-js";
import { GoogleAuth } from "google-auth-library";

// How the OTLP exporter proves who it is. The standard way is a fixed header
// in OTEL_EXPORTER_OTLP_HEADERS (an API key), and that's what happens when
// TELEMETRY_AUTH isn't set. Google takes no fixed header: it wants an OAuth
// token that expires every hour, so with TELEMETRY_AUTH=google each export
// asks the runtime's service account for a fresh one. Moving to another
// provider is unsetting TELEMETRY_AUTH and setting its headers.

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

// grpc-js has credentials.createFromGoogleCredential, but it copies headers
// with Object.keys, and google-auth-library 10+ returns a Headers object: the
// token would be silently dropped. This copies them with Headers' own forEach.
const googleCredentials = (): ChannelCredentials => {
  const auth = new GoogleAuth({ scopes: [SCOPE] });
  return credentials.combineChannelCredentials(
    credentials.createSsl(),
    credentials.createFromMetadataGenerator(({ service_url }, callback) => {
      auth.getRequestHeaders(service_url).then(
        (headers) => {
          const metadata = new Metadata();
          headers.forEach((value, key) => metadata.add(key, value));
          callback(null, metadata);
        },
        (err: Error) => callback(err)
      );
    })
  );
};

export const exporterCredentials = (env: NodeJS.ProcessEnv = process.env): ChannelCredentials | undefined => {
  switch (env.TELEMETRY_AUTH) {
    case undefined:
    case "":
      // The exporter's own default: TLS, plus OTEL_EXPORTER_OTLP_HEADERS.
      return undefined;
    case "google":
      return googleCredentials();
    default:
      throw new Error(`Unknown TELEMETRY_AUTH "${env.TELEMETRY_AUTH}"; leave it unset or use "google"`);
  }
};
