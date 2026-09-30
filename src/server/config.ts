import path from "node:path";

export interface AppConfig {
  port: number;
  musicLibraryPath: string;
  musicLibraryRoots?: string[];
  dataDir: string;
  databasePath: string;
  artworkDir: string;
  metadataDir: string;
  adminPassword: string;
  cookieSecret: string;
  cookieSecure?: boolean;
  enableOnlineMetadata: boolean;
  scanOnlineMetadata?: boolean;
  autoCompleteAlbumMetadata?: boolean;
  isProduction: boolean;
}

function envBool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

const DEVELOPMENT_COOKIE_SECRET = "local-dev-cookie-secret";
const PUBLIC_COOKIE_SECRETS = new Set([
  DEVELOPMENT_COOKIE_SECRET,
  "replace-with-a-long-random-string",
  "replace-with-a-long-random-secret",
  "change-me"
]);

export function loadConfig(): AppConfig {
  const isProduction = process.env.NODE_ENV === "production";
  const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
  const musicLibraryPath = path.resolve(process.env.MUSIC_LIBRARY_PATH ?? "./music");
  const adminPassword = process.env.ADMIN_PASSWORD ?? (isProduction ? "" : "admin");
  const cookieSecret = process.env.COOKIE_SECRET ?? (isProduction ? "" : DEVELOPMENT_COOKIE_SECRET);
  const cookieSecure = envBool("COOKIE_SECURE", process.env.COOKIE_SECURE, isProduction);
  const enableOnlineMetadata = envBool("ENABLE_ONLINE_METADATA", process.env.ENABLE_ONLINE_METADATA, false);
  const scanOnlineMetadata = envBool("SCAN_ONLINE_METADATA", process.env.SCAN_ONLINE_METADATA, true);
  const autoCompleteAlbumMetadata = envBool("AUTO_COMPLETE_ALBUM_METADATA", process.env.AUTO_COMPLETE_ALBUM_METADATA, true);
  const port = Number(process.env.PORT ?? 3000);

  if (!adminPassword.trim()) {
    throw new Error("ADMIN_PASSWORD is required in production");
  }
  if (isProduction && (cookieSecret.trim().length < 32 || PUBLIC_COOKIE_SECRETS.has(cookieSecret.trim().toLowerCase()))) {
    throw new Error("COOKIE_SECRET must be a private random string of at least 32 characters in production");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const artworkDir = path.join(dataDir, "artwork");
  const metadataDir = path.join(dataDir, "metadata");
  return {
    port,
    musicLibraryPath,
    musicLibraryRoots: process.env.MUSIC_LIBRARY_ROOTS?.split(path.delimiter).filter(Boolean).map((root) => path.resolve(root)),
    dataDir,
    databasePath: path.join(dataDir, "music-library.sqlite"),
    artworkDir,
    metadataDir,
    adminPassword,
    cookieSecret,
    cookieSecure,
    enableOnlineMetadata,
    scanOnlineMetadata,
    autoCompleteAlbumMetadata,
    isProduction
  };
}
