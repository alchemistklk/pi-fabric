import type { EntropyProposal } from "./types.js";

const METRIC_PRECISION = 6;
const MAX_APPLIED_DETAILS = 3;
const MAX_VALUE_LENGTH = 32;

export const formatEntropyMetric = (value: number): string => value.toFixed(METRIC_PRECISION);

const formatDuration = (elapsedMs: number): string =>
  elapsedMs >= 1_000 ? `${(elapsedMs / 1_000).toFixed(1)}s` : `${Math.max(1, Math.round(elapsedMs))}ms`;

const formatValue = (value: string | number | boolean): string => {
  const rendered = typeof value === "string"
    ? (value.replace(/\s+/gu, " ").trim() || '""')
    : String(value);
  return rendered.length <= MAX_VALUE_LENGTH
    ? rendered
    : `${rendered.slice(0, MAX_VALUE_LENGTH - 1)}…`;
};

const formatValues = (values: readonly (string | number | boolean)[]): string =>
  `{${values.map(formatValue).join(", ")}}`;

const autoProposal = (proposal: EntropyProposal): boolean =>
  proposal.kind === "enum-tighten" || proposal.kind === "noise-quarantine";

const formatApplied = (proposal: EntropyProposal): string => {
  if (proposal.kind === "enum-tighten") {
    return `tightened ${proposal.ref}.${proposal.key} to ${formatValues(proposal.values)}`;
  }
  if (proposal.kind === "noise-quarantine") {
    return `hid ${proposal.ref} (${proposal.failed} failed, ${proposal.succeeded} succeeded)`;
  }
  return proposal.kind;
};

const scoreChange = (before: number, after: number): string => {
  if (before === after) {
    return `entropy score unchanged at ${formatEntropyMetric(before)} (lower is better)`;
  }
  let precision = METRIC_PRECISION;
  while (precision < 12 && before.toFixed(precision) === after.toFixed(precision)) precision += 1;
  const delta = after - before;
  const format = (value: number): string => value.toFixed(precision);
  const absoluteDelta = format(Math.abs(delta));
  const renderedDelta = Number(absoluteDelta) === 0
    ? Math.abs(delta).toExponential(2)
    : absoluteDelta;
  return `entropy score ${delta < 0 ? "improved" : "changed"} ${format(before)} → ${format(after)} (${delta > 0 ? "+" : "−"}${renderedDelta}; lower is better)`;
};

export const entropyReviewKey = (proposals: readonly EntropyProposal[]): string => {
  const identities = proposals.map((proposal): string => {
    if (proposal.kind === "declare-enum") {
      return JSON.stringify([
        proposal.kind,
        proposal.ref,
        proposal.key,
        proposal.values.map((value) => [typeof value, value]),
      ]);
    }
    if (proposal.kind === "overload-split") {
      return JSON.stringify([
        proposal.kind,
        proposal.ref,
        proposal.clusters.map((cluster) => cluster.keys),
      ]);
    }
    if (proposal.kind === "sequence-fuse") {
      return JSON.stringify([proposal.kind, proposal.sequence]);
    }
    if (proposal.kind === "modal-rename") {
      return JSON.stringify([
        proposal.kind,
        proposal.level,
        proposal.ref,
        proposal.from,
        proposal.to,
      ]);
    }
    return JSON.stringify([proposal.kind, proposal.ref]);
  });
  identities.sort();
  return JSON.stringify(identities);
};

const reviewLabel = (kind: EntropyProposal["kind"], count: number): string => {
  const noun = kind === "declare-enum"
    ? "enum declaration"
    : kind === "overload-split"
      ? "action split"
      : kind === "sequence-fuse"
        ? "sequence fusion"
        : kind === "modal-rename"
          ? "rename"
          : kind;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
};

export const formatEntropyReviewNotice = (
  proposals: readonly EntropyProposal[],
): string => {
  const counts = new Map<EntropyProposal["kind"], number>();
  for (const proposal of proposals) counts.set(proposal.kind, (counts.get(proposal.kind) ?? 0) + 1);
  const summary = [...counts.entries()].map(([kind, count]) => reviewLabel(kind, count)).join(" · ");
  return `entropy: ${proposals.length} suggestion${proposals.length === 1 ? "" : "s"} await review${summary ? ` · ${summary}` : ""} · inspect with /fabric entropy`;
};

export const formatEntropyCompileNotice = (input: {
  proposals: readonly EntropyProposal[];
  beforeScore: number;
  afterScore: number;
  elapsedMs: number;
  reviewCount?: number;
}): string => {
  const applied = input.proposals.filter(autoProposal);
  const details = applied.slice(0, MAX_APPLIED_DETAILS).map(formatApplied);
  if (applied.length > MAX_APPLIED_DETAILS) {
    details.push(`+${applied.length - MAX_APPLIED_DETAILS} more`);
  }
  if (details.length === 0) details.push("surface updated");
  const review = input.reviewCount
    ? ` · ${input.reviewCount} suggestion${input.reviewCount === 1 ? "" : "s"} await review (/fabric entropy)`
    : "";
  return `entropy: background optimization complete (${formatDuration(input.elapsedMs)}) · ${details.join(" · ")} · ${scoreChange(input.beforeScore, input.afterScore)} · safety checks passed${review}`;
};
