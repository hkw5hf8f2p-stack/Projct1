import { describe, expect, it } from "vitest";
import { isCritical, listTree, scanFiles } from "./scan-todo.js";

const PLANT = "// TO" + "DO: підкладений маркер";
describe("scan-todo (уміє впасти)", () => {
  it("позитивний: підкладений маркер у критичному файлі знайдено (усі 4 слова)", () => {
    for (const w of ["TO" + "DO", "FIX" + "ME", "XX" + "X", "HA" + "CK"]) {
      const r = scanFiles([{ path: "packages/x/src/a.ts", text: `const a = 1;\n// ${w} later\n` }]);
      expect(r.hits).toEqual([{ file: "packages/x/src/a.ts", line: 2, text: `// ${w} later` }]);
    }
    expect(scanFiles([{ path: "scripts/run.sh", text: `# ${PLANT}` }]).hits).toHaveLength(1);
    expect(scanFiles([{ path: "apps/web/src/components/A.tsx", text: PLANT }]).hits).toHaveLength(1);
  });
  it("негативний: чистий код, тести й некритичні шляхи не дають збігу; слово-частина не збігається", () => {
    expect(scanFiles([{ path: "packages/x/src/a.ts", text: "const mastodon = 'TODOS'; // ok\n" }]).hits).toHaveLength(0);
    expect(scanFiles([{ path: "packages/x/test/a.test.ts", text: PLANT }]).hits).toHaveLength(0);
    expect(scanFiles([{ path: "scripts/a.test.ts", text: PLANT }]).hits).toHaveLength(0);
    expect(scanFiles([{ path: "planning/x.md", text: PLANT }]).hits).toHaveLength(0);
    expect(isCritical("packages/x/src/a.ts")).toBe(true);
  });
  it("allowlist: пояснений виняток не рахується, інший рядок того ж файлу — рахується", () => {
    const allow = [{ file: /^scripts\/a\.ts$/, line: /DEV-99/, why: "тест" }];
    const r = scanFiles([{ path: "scripts/a.ts", text: `// ${PLANT} DEV-99\n// ${PLANT}\n` }], allow);
    expect(r.explained).toHaveLength(1);
    expect(r.hits).toHaveLength(1);
  });
  it("реальне дерево: 0 маркерів у критичному шляху (і сканер справді бачить файли)", () => {
    const files = listTree();
    expect(files.length).toBeGreaterThan(100);
    expect(scanFiles(files).hits).toEqual([]);
  });
});
