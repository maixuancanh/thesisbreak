/** Import Node-only bootstrap only in the Node runtime. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { configureDatabaseCertificate } =
      await import("./instrumentation-node");
    await configureDatabaseCertificate();
  }
}
