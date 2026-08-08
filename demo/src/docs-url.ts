interface DemoLocation {
  readonly hostname: string;
  readonly href: string;
}

export function resolveDemoDocsUrl(
  configuredUrl: string | undefined,
  location: DemoLocation,
) {
  if (configuredUrl) {
    return configuredUrl;
  }

  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return "http://127.0.0.1:5175";
  }

  return new URL("../", location.href).href;
}
