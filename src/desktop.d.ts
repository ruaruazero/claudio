export {};

declare global {
  interface Window {
    claudioDesktop?: {
      platform: string;
      loginMusic(): Promise<
        { status: "connected"; connected: true; profile: { userId: number; nickname: string } } |
        { status: "cancelled" } | { status: "error"; message: string }
      >;
    };
  }
}
