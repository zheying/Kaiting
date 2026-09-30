export type AccountRole = "admin" | "member";
export type AccountStatus = "active" | "disabled";
export type AccountUser = {
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
};
export type AccountSession = { id: string; name: string; detail: string; lastSeen: string; current: boolean; mobile: boolean };
export const roleLabel = (role: AccountRole) => role === "admin" ? "管理员" : "普通账号";

// Client feedback mirrors the server rules; authorization is also enforced by the API.
export function accountChangeIssue(actor: AccountUser, users: AccountUser[], target: AccountUser, patch: Partial<AccountUser>): string {
  if (actor.status !== "active" || actor.role !== "admin") return "只有管理员可以管理其他账号。";
  if (!users.some((user) => user.id === target.id)) return "这个账号已不存在，请重新载入。";
  const next = { ...target, ...patch };
  if (target.role === "admin" && target.status === "active" && (next.role !== "admin" || next.status !== "active") && users.filter((user) => user.role === "admin" && user.status === "active").length <= 1) return "音乐室至少需要保留一位可用的管理员。";
  if (actor.id === target.id && (next.role !== actor.role || next.status !== "active")) return "不能更改自己的角色或停用自己的账号，请由另一位管理员操作。";
  return "";
}
export function validateAccountIdentity(username: string, displayName: string, users: AccountUser[]): string {
  return usernameIssue(username, users) || displayNameIssue(displayName);
}
export function validateAccountPassword(password: string, confirmation: string): string {
  return passwordIssue(password, "新密码") || confirmationIssue(password, confirmation);
}

export const characterCount = (value: string) => Array.from(value).length;
export type AccountField = "username" | "displayName" | "bio" | "grantConfirmed" | "currentPassword" | "password" | "confirmation";
export type AccountFieldIssues = Partial<Record<AccountField, string>>;
export type AccountFormMode = "create" | "profile" | "manage" | "password" | "reset" | "first-password" | "login";
export type AccountFormValues = Partial<Record<Exclude<AccountField, "grantConfirmed">, string>> & { grantConfirmed?: boolean };

function usernameIssue(value: string, users?: AccountUser[]): string {
  const name = value.trim();
  if (!name) return "请输入用户名，用于登录音乐室。";
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return "只支持英文字母、数字和 . _ -，请勿使用中文或空格。";
  if (!/^[a-zA-Z0-9]/.test(name)) return "请以英文字母或数字开头。";
  if (name.length < 2 || name.length > 24) return "用户名需为 2–24 个字符。";
  if (users?.some((user) => user.username.toLowerCase() === name.toLowerCase())) return "这个用户名已被使用，请换一个。";
  return "";
}
function displayNameIssue(value: string): string {
  if (!value.trim()) return "请输入昵称，可以使用中文。";
  if (characterCount(value.trim()) > 24) return "昵称最多 24 个字符，请缩短一些。";
  return "";
}
function passwordIssue(value: string, label: string): string {
  if (!value) return `请输入${label}。`;
  if (characterCount(value) < 8 || characterCount(value) > 64 || !value.trim()) return `${label}需为 8–64 个字符，不能全部为空格。`;
  return "";
}
function confirmationIssue(password: string, confirmation: string): string {
  if (!confirmation) return "请再输入一次密码。";
  if (password !== confirmation) return "两次输入的密码不一致，请检查。";
  return "";
}

export function validateAccountFields(mode: AccountFormMode, values: AccountFormValues, users: AccountUser[] = [], grantRequired = false): AccountFieldIssues {
  const issues: AccountFieldIssues = {};
  const add = (field: AccountField, message: string) => { if (message) issues[field] = message; };
  if (mode === "create" || mode === "login") add("username", usernameIssue(values.username ?? "", mode === "create" ? users : undefined));
  if (["create", "profile", "manage"].includes(mode)) add("displayName", displayNameIssue(values.displayName ?? ""));
  if (mode === "profile" && characterCount(values.bio ?? "") > 80) add("bio", "介绍最多 80 个字符，请缩短一些。");
  if (grantRequired && !values.grantConfirmed) add("grantConfirmed", "请勾选确认以授予管理员权限，或改选普通账号。");
  if (mode === "password" && !values.currentPassword?.trim()) add("currentPassword", "请输入当前密码，确认这是你的账号。");
  if (["password", "reset", "first-password"].includes(mode)) {
    const label = mode === "reset" ? "临时密码" : "新密码";
    add("password", passwordIssue(values.password ?? "", label));
    if (!issues.password && values.currentPassword && values.password === values.currentPassword && (mode === "password" || mode === "first-password")) add("password", mode === "first-password" ? "请设置一个与临时密码不同的新密码。" : "新密码不能与当前密码相同。");
    add("confirmation", confirmationIssue(values.password ?? "", values.confirmation ?? ""));
  }
  if (mode === "login" && !values.password?.trim()) add("password", "请输入登录密码。");
  return issues;
}
