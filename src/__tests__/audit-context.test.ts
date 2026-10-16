import { describe, expect, test } from "bun:test";
import { auditEmail } from "@emailens/engine";
import { withoutBodyTitleAsSubject } from "../audit-context";
import { toFindings } from "../report";

describe("message metadata context", () => {
  test("HTML title is not reported or scored as the message subject", () => {
    const upper = auditEmail(
      "<html><head><title>AN INTERNAL DOCUMENT TITLE THAT IS DELIBERATELY LONG 🚀</title></head><body>Hello</body></html>",
      { positions: true },
    );
    const ordinary = auditEmail(
      "<html><head><title>An internal document title</title></head><body>Hello</body></html>",
      { positions: true },
    );
    const corrected = withoutBodyTitleAsSubject(upper);

    expect(corrected.spam.score).toBe(ordinary.spam.score);
    expect(corrected.spam.issues.some((issue) => issue.rule === "all-caps-subject")).toBe(false);
    expect(corrected.inboxPreview.subject).toBeNull();
    expect(corrected.inboxPreview.subjectLength).toBe(0);
    expect(corrected.inboxPreview.issues.map((issue) => issue.rule)).not.toContain("subject-too-long");
    expect(corrected.inboxPreview.issues.map((issue) => issue.rule)).not.toContain("emoji-in-subject");
    expect(corrected.inboxPreview.truncation.every((item) => (
      item.truncatedSubject === null && !item.subjectTruncated
    ))).toBe(true);
  });

  test("missing document title remains an accessibility issue, not a missing subject", () => {
    const corrected = withoutBodyTitleAsSubject(
      auditEmail("<html><head></head><body>Hello</body></html>", { positions: true }),
    );
    const findings = toFindings(corrected);

    expect(findings.some((finding) => finding.code === "missing-title")).toBe(true);
    expect(findings.some((finding) => finding.code === "missing-subject")).toBe(false);
  });
});

describe("prepared Marketo size context", () => {
  const large = `<html><body>${"x".repeat(103_000)}</body></html>`;

  test("size warnings say when unresolved output limits the result", () => {
    const findings = toFindings(withoutBodyTitleAsSubject(auditEmail(large)), {
      marketoOutput: { unresolved: 2 },
    });
    const clipping = findings.find((finding) => finding.code === "gmail-clip-warning")!;

    expect(clipping.message).toContain("prepared Marketo preview HTML");
    expect(clipping.message).toContain("Final delivered size remains unknown");
    expect(clipping.message).toContain("2 unresolved dynamic outputs");
  });

  test("fully resolved prepared output is still not labelled as delivery HTML", () => {
    const findings = toFindings(withoutBodyTitleAsSubject(auditEmail(large)), {
      marketoOutput: { unresolved: 0 },
    });
    const clipping = findings.find((finding) => finding.code === "gmail-clip-warning")!;

    expect(clipping.message).toContain("This is not Marketo-generated delivery HTML");
  });
});
