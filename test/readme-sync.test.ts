import { describe, expect, it } from "vitest";

import { checkChangedPair, compareOutlines, outline } from "../scripts/readme-sync.ts";

const english = "# Title\n\nIntro.\n\n## Install\n\n```sh\nnpm i x\n```\n";
const korean = "# 제목\n\n소개.\n\n## 설치\n\n```sh\nnpm i x\n```\n";

describe("README outline", () => {
  it("accepts translated prose with the same structure and code", () => {
    expect(compareOutlines(outline(english), outline(korean))).toEqual([]);
  });

  it("catches a section added to one language only", () => {
    expect(compareOutlines(outline(`${english}\n## FAQ\n`), outline(korean))[0]).toMatch(/Heading structure/);
  });

  it("catches a code example changed in one language only", () => {
    const changed = korean.replace("npm i x", "pnpm add x");
    expect(compareOutlines(outline(english), outline(changed))).toEqual(["Code block 1 differs between the READMEs."]);
  });

  it("ignores headings inside code blocks", () => {
    const withComment = "```sh\n# not a heading\n```\n";
    expect(outline(withComment).headings).toEqual([]);
  });
});

describe("changed README pair", () => {
  it("allows changing both or neither", () => {
    expect(checkChangedPair(["README.md", "README-ko_kr.md"], "")).toEqual([]);
    expect(checkChangedPair(["src/cli.ts"], "")).toEqual([]);
  });

  it("blocks a one-sided change without a reason", () => {
    expect(checkChangedPair(["README-ko_kr.md"], "")[0]).toMatch(/Only README-ko_kr.md changed/);
    expect(checkChangedPair(["README.md"], "README one-sided:   ")).toHaveLength(1);
  });

  it("allows a one-sided change with a reason", () => {
    expect(checkChangedPair(["README-ko_kr.md"], "Summary\n\nREADME one-sided: fix a Korean typo")).toEqual([]);
  });
});
