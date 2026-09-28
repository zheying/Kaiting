import { describe, expect, it, vi } from "vitest";
import { accountChangeIssue, characterCount, generateTemporaryPassword, initialAccounts, validateAccountFields, validateAccountIdentity, validateAccountPassword } from "../prototypes/listening-room/src/account-state";

const admin = initialAccounts[0];
const member = initialAccounts[1];

describe("原型账号权限边界", () => {
  it("普通账号不能升级自己，也不能改动其他成员", () => {
    expect(accountChangeIssue(member, initialAccounts, member, { role: "admin" })).toContain("只有管理员");
    expect(accountChangeIssue(member, initialAccounts, admin, { status: "disabled" })).toContain("只有管理员");
  });
  it("至少保留一位可用管理员，停用的管理员不计入保障", () => {
    const disabledAdmin = { ...member, role: "admin" as const, status: "disabled" as const };
    const users = [admin, disabledAdmin];
    expect(accountChangeIssue(admin, users, admin, { role: "member" })).toContain("至少需要保留");
    expect(accountChangeIssue(admin, users, admin, { status: "disabled" })).toContain("至少需要保留");
  });
  it("多个管理员时仍不能停用或降级自己，但可管理另一位", () => {
    const anotherAdmin = { ...member, role: "admin" as const };
    const users = [admin, anotherAdmin];
    expect(accountChangeIssue(admin, users, admin, { status: "disabled" })).toContain("自己的");
    expect(accountChangeIssue(admin, users, admin, { role: "member" })).toContain("自己的");
    expect(accountChangeIssue(admin, users, anotherAdmin, { role: "member" })).toBe("");
  });
  it("停用管理员和已失效的用户目标无法执行更新", () => {
    expect(accountChangeIssue({ ...admin, status: "disabled" }, initialAccounts, member, {})).toContain("只有管理员");
    expect(accountChangeIssue(admin, [admin], member, {})).toContain("已不存在");
  });
});

describe("原型账号表单校验", () => {
  it("停用账号仍保留用户名，重复比较忽略大小写", () => {
    expect(validateAccountIdentity("ADMIN", "新用户", initialAccounts)).toContain("已被使用");
    expect(validateAccountIdentity("quiet", "新用户", initialAccounts)).toContain("已被使用");
    expect(validateAccountIdentity("listener.new", "新用户", initialAccounts)).toBe("");
  });
  it("禁止无效用户名及空昵称", () => {
    expect(validateAccountIdentity("../admin", "新用户", [])).not.toBe("");
    expect(validateAccountIdentity("valid", "  ", [])).not.toBe("");
  });
  it("新密码必须符合长度且两次输入一致", () => {
    expect(validateAccountPassword("short", "short")).toContain("8–64");
    expect(validateAccountPassword("        ", "        ")).toContain("8–64");
    expect(validateAccountPassword("sample-only-123", "sample-only-456")).toContain("不一致");
    expect(validateAccountPassword("sample-only-123", "sample-only-123")).toBe("");
  });
  it("一次返回所有必填错误，且只校验当前表单的字段", () => {
    expect(Object.keys(validateAccountFields("create", {}))).toEqual(["username", "displayName"]);
    expect(Object.keys(validateAccountFields("profile", {}))).toEqual(["displayName"]);
    expect(Object.keys(validateAccountFields("manage", {}))).toEqual(["displayName"]);
    expect(Object.keys(validateAccountFields("reset", {}))).toEqual(["password", "confirmation"]);
    expect(Object.keys(validateAccountFields("password", {}))).toEqual(["currentPassword", "password", "confirmation"]);
  });
  it("用户名区分非法字符、非法开头、长度与重复，并允许规范化首尾空白", () => {
    const check = (username: string) => validateAccountFields("create", { username, displayName: "听风" }, initialAccounts);
    expect(check("大").username).toContain("请勿使用中文或空格");
    expect(check("music lover").username).toContain("请勿使用中文或空格");
    expect(check(".listener").username).toContain("开头");
    expect(check("a").username).toContain("2–24");
    expect(check("a".repeat(25)).username).toContain("2–24");
    expect(check(" QUIET ").username).toContain("已被使用");
    expect(check(" Music.Lover ")).toEqual({});
  });
  it("昵称和介绍按 Unicode 字符计数，并在超限时返回对应字段错误", () => {
    expect(characterCount("听🎵")).toBe(2);
    expect(validateAccountFields("profile", { displayName: "🎵".repeat(24), bio: "声".repeat(80) })).toEqual({});
    expect(Object.keys(validateAccountFields("profile", { displayName: "🎵".repeat(25), bio: "声".repeat(81) }))).toEqual(["displayName", "bio"]);
    expect(validateAccountFields("manage", { displayName: "声".repeat(25) }).displayName).toContain("24");
  });
  it("管理员授权确认随角色变化校验，不阻止普通账号创建", () => {
    const values = { username: "new-listener", displayName: "听风" };
    expect(validateAccountFields("create", values, [], true)).toHaveProperty("grantConfirmed");
    expect(validateAccountFields("create", { ...values, grantConfirmed: true }, [], true)).toEqual({});
    expect(validateAccountFields("create", values, [], false)).toEqual({});
  });
  it("密码错误归属各自字段，修改上方密码后重新比较确认密码", () => {
    expect(validateAccountFields("reset", { password: "short", confirmation: "other" })).toHaveProperty("password");
    expect(validateAccountFields("reset", { password: "short", confirmation: "other" })).toHaveProperty("confirmation");
    expect(validateAccountFields("reset", { password: "music-123", confirmation: "" }).confirmation).toContain("再输入一次");
    expect(validateAccountFields("reset", { password: "music-123", confirmation: "music-123" })).toEqual({});
    expect(validateAccountFields("reset", { password: "music-456", confirmation: "music-123" }).confirmation).toContain("不一致");
  });
  it("新密码不能复用当前或临时密码；已有登录密码不套用新密码规则", () => {
    const values = { currentPassword: "music-123", password: "music-123", confirmation: "music-123" };
    expect(validateAccountFields("password", values).password).toContain("当前密码相同");
    expect(validateAccountFields("first-password", values).password).toContain("临时密码不同");
    expect(validateAccountFields("login", { username: "admin", password: "a" })).toEqual({});
    expect(validateAccountFields("login", { username: "admin", password: "   " })).toHaveProperty("password");
    expect(Object.keys(validateAccountFields("login", {}))).toEqual(["username", "password"]);
  });
  it("不截断或修剪密码，保留空格和大小写并按字符限制长度", () => {
    expect(validateAccountPassword("a".repeat(64), "a".repeat(64))).toBe("");
    expect(validateAccountPassword("a".repeat(65), "a".repeat(65))).toContain("8–64");
    expect(validateAccountPassword("🎵".repeat(8), "🎵".repeat(8))).toBe("");
    expect(validateAccountPassword(" music-123 ", "music-123")).toContain("不一致");
    expect(validateAccountPassword("Music-123", "music-123")).toContain("不一致");
  });
});

describe("自动生成临时密码", () => {
  it("每次生成 12–22 位密码，包含大小写字母、数字及符号", () => {
    const passwords = Array.from({ length: 64 }, () => generateTemporaryPassword());
    for (const password of passwords) {
      expect(password.length).toBeGreaterThanOrEqual(12);
      expect(password.length).toBeLessThanOrEqual(22);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[2-9]/);
      expect(password).toMatch(/[!@#$%&*+_=?-]/);
      expect(password).not.toMatch(/[\s0O1Il]/);
      expect(validateAccountPassword(password, password)).toBe("");
    }
    expect(new Set(passwords).size).toBe(passwords.length);
  });
  it("长度上下界均包含在生成范围内", () => {
    const random = vi.spyOn(crypto, "getRandomValues");
    try {
      random.mockImplementationOnce((array) => { (array as Uint32Array).fill(0); return array; });
      expect(generateTemporaryPassword()).toHaveLength(12);
      random.mockImplementationOnce((array) => { (array as Uint32Array).fill(10); return array; });
      expect(generateTemporaryPassword()).toHaveLength(22);
    } finally { random.mockRestore(); }
  });
  it("安全随机源不可用时中止生成，不降级为普通随机数", () => {
    const random = vi.spyOn(crypto, "getRandomValues").mockImplementation(() => { throw new Error("随机源不可用"); });
    try { expect(() => generateTemporaryPassword()).toThrow("随机源不可用"); }
    finally { random.mockRestore(); }
  });
});
