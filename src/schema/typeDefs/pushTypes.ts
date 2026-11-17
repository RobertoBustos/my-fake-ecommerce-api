const pushTypes = /* GraphQL */ `#graphql
  # Comments in GraphQL strings (such as this one) start with the hash (#) symbol.
  enum PushPlatform {
    IOS
    ANDROID
  }

  input RegisterPushToken {
    "Expo push token of the device, ExponentPushToken[...]."
    token: String!
    platform: PushPlatform!
  }

  type RegisterPushTokenResponse implements MutationResponse {
    code: String!
    success: Boolean!
    message: String!
  }

  input UnregisterPushToken {
    token: String!
  }

  type UnregisterPushTokenResponse implements MutationResponse {
    code: String!
    success: Boolean!
    message: String!
  }
`;

export default pushTypes;
