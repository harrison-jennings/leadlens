import type { AuditReport } from "@emailens/engine";

/**
 * Rules the engine derives from the HTML `<title>` as though it were the
 * message's Subject header. The two values are independent: Marketo stores the
 * subject outside the email body, and ordinary imported HTML does not carry
 * its message headers either.
 */
const BODY_TITLE_SUBJECT_RULES = new Set([
  "missing-subject",
  "subject-too-long",
  "emoji-in-subject",
]);

/** Kept in step with the pinned engine's offline spam scorer. */
const SPAM_WEIGHTS: Record<string, number> = {
  "caps-ratio": 15,
  "excessive-punctuation": 10,
  "spam-phrases": 5,
  "missing-unsubscribe": 15,
  "hidden-text": 20,
  "url-shortener": 10,
  "image-only": 20,
  "high-image-ratio": 10,
  "deceptive-link": 15,
  "missing-physical-address": 8,
  "missing-one-click-unsubscribe": 5,
};

/**
 * Remove conclusions about message metadata that cannot be established from
 * body HTML. The document-title accessibility rule is intentionally left in
 * place: a useful `<title>` and an email Subject are separate concerns.
 */
export function withoutBodyTitleAsSubject(report: AuditReport): AuditReport {
  const spamIssues = report.spam.issues.filter((issue) => issue.rule !== "all-caps-subject");
  const spamScore = scoreSpam(spamIssues);

  return {
    ...report,
    spam: {
      ...report.spam,
      score: spamScore,
      level: spamScore >= 70 ? "low" : spamScore >= 40 ? "medium" : "high",
      issues: spamIssues,
    },
    inboxPreview: {
      ...report.inboxPreview,
      subject: null,
      subjectLength: 0,
      issues: report.inboxPreview.issues.filter(
        (issue) => !BODY_TITLE_SUBJECT_RULES.has(issue.rule),
      ),
      truncation: report.inboxPreview.truncation.map((item) => ({
        ...item,
        truncatedSubject: null,
        subjectTruncated: false,
      })),
    },
  };
}

function scoreSpam(issues: AuditReport["spam"]["issues"]): number {
  let penalty = 0;
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const count = (counts.get(issue.rule) ?? 0) + 1;
    counts.set(issue.rule, count);
    const weight = SPAM_WEIGHTS[issue.rule] ?? 5;
    if (issue.rule === "spam-phrases") {
      if (count <= 5) penalty += weight;
    } else if (issue.rule === "url-shortener" || issue.rule === "deceptive-link") {
      if (count <= 2) penalty += weight;
    } else if (issue.severity !== "info") {
      penalty += weight;
    }
  }
  return Math.max(0, Math.min(100, 100 - penalty));
}
