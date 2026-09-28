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

// Credentials stay in the creation result only; the prototype never persists them.
export function generateTemporaryPassword(): string {
  const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%&*+-_=?"];
  const alphabet = groups.join("");
  const randomIndex = (limit: number) => {
    const buffer = new Uint32Array(1);
    const ceiling = Math.floor(0x100000000 / limit) * limit;
    do { crypto.getRandomValues(buffer); } while (buffer[0] >= ceiling);
    return buffer[0] % limit;
  };
  const length = 12 + randomIndex(11);
  const characters = groups.map((group) => group[randomIndex(group.length)]);
  while (characters.length < length) characters.push(alphabet[randomIndex(alphabet.length)]);
  for (let index = characters.length - 1; index > 0; index--) {
    const other = randomIndex(index + 1);
    [characters[index], characters[other]] = [characters[other], characters[index]];
  }
  return characters.join("");
}

export const initialAccounts: AccountUser[] = [
  { id: "room-admin", username: "admin", displayName: "林间", bio: "让喜欢的声音，有一个停靠的地方。", role: "admin", status: "active", color: "rose", joined: "2026.09.01", lastSeen: "当前在线", passwordUpdated: "2026.09.20", mustChangePassword: false },
  { id: "listener", username: "listener", displayName: "漫游", bio: "在每一段旋律里，慢慢走。", role: "member", status: "active", color: "sage", joined: "2026.09.12", lastSeen: "今天 09:42", passwordUpdated: "2026.09.12", mustChangePassword: false },
  { id: "new-listener", username: "newcomer", displayName: "初来", bio: "", role: "member", status: "active", color: "blue", joined: "2026.09.27", lastSeen: "尚未登录", passwordUpdated: "尚未设置", mustChangePassword: true },
  { id: "paused-listener", username: "quiet", displayName: "安静收藏", bio: "", role: "member", status: "disabled", color: "blue", joined: "2026.09.08", lastSeen: "9 月 18 日", passwordUpdated: "2026.09.08", mustChangePassword: false }
];
export const initialSessions = (): AccountSession[] => [
  { id: "current", name: "此浏览器", detail: "当前音乐室会话", lastSeen: "正在使用", current: true, mobile: false },
  { id: "phone", name: "iPhone · Safari", detail: "移动设备 · 演示会话", lastSeen: "今天 08:36", current: false, mobile: true },
  { id: "desktop", name: "Mac · Chrome", detail: "桌面设备 · 演示会话", lastSeen: "昨天 21:18", current: false, mobile: false }
];

// These guards model the intended UI permissions; the standalone prototype has no auth API.
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
