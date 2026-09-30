import { describe, expect, it, vi } from "vitest";
import * as accounts from "../prototypes/listening-room/src/account-state";
import { accountContract } from "./support/account-contract.js";
const { generateTemporaryPassword, validateAccountPassword } = accounts;
accountContract(accounts);

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
