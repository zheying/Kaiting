import fs from "node:fs";
import path from "node:path";

export interface AppConfig {
  port: number;
  musicLibraryPath: string;
  dataDir: string;
  databasePath: string;
  artworkDir: string;
  metadataDir: string;
  adminPassword: string;
  cookieSecret: string;
  enableOnlineMetadata: boolean;
  isProduction: boolean;
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function loadConfig(): AppConfig {
  const isProduction = process.env.NODE_ENV === "production";
  const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
  const musicLibraryPath = path.resolve(process.env.MUSIC_LIBRARY_PATH ?? "./music");
  const adminPassword = process.env.ADMIN_PASSWORD ?? (isProduction ? "" : "admin");

  if (!adminPassword) {
    throw new Error("ADMIN_PASSWORD is required in production");
  }

  const artworkDir = path.join(dataDir, "artwork");
  const metadataDir = path.join(dataDir, "metadata");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(artworkDir, { recursive: true });
  fs.mkdirSync(metadataDir, { recursive: true });

  return {
    port: Number(process.env.PORT ?? 3000),
    musicLibraryPath,
    dataDir,
    databasePath: path.join(dataDir, "music-library.sqlite"),
    artworkDir,
    metadataDir,
    adminPassword,
    cookieSecret: process.env.COOKIE_SECRET ?? "local-dev-cookie-secret",
    enableOnlineMetadata: envBool(process.env.ENABLE_ONLINE_METADATA, false),
    isProduction
  };
}
