export type AccountRole = "admin" | "member";
export type AccountStatus = "active" | "disabled";
export interface AccountUser {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  role: AccountRole;
  status: AccountStatus;
  color: "rose" | "sage" | "blue";
  joined: string;
  lastSeen: string;
  passwordUpdated: string;
  mustChangePassword: boolean;
}
export interface AccountSession {
  id: string;
  name: string;
  detail: string;
  lastSeen: string;
  current: boolean;
  mobile: boolean;
}
export interface UserPreferences {
  dense: boolean;
  darkMode: boolean;
  volume: number;
  shuffle: boolean;
  repeat: 0 | 1 | 2;
  queue: string[];
  currentId: string;
  position: number;
}
export const defaultPreferences: UserPreferences = { dense: false, darkMode: false, volume: 70, shuffle: false, repeat: 0, queue: [], currentId: "", position: 0 };
export interface DirectoryOption { path: string; detail: string; available: boolean; }
export interface DirectoryState {
  path: string;
  configured: boolean;
  available: boolean;
  options: DirectoryOption[];
}
export interface SessionResponse {
  user: AccountUser;
  preferences: UserPreferences;
  directory: DirectoryState;
}
