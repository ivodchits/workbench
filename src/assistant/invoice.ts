// The monthly invoice's draft (phase 3), worked out in code: what each configured
// cell becomes this month, from the sheet's cells as they are now. Nothing here
// talks to Google; `create_sheet_draft` reads the cells, plans with `planDraft`,
// shows the plan on its card and hands it to the backend.
//
// Dates follow their rule from today (local). An amount is a fixed number, stays
// as it is, is the user's answer, or is arithmetic over other cells (`C5*C6`),
// evaluated here over the cells' shown values, with this draft's new amounts in
// place of the old ones. A cell holding a formula is never changed: the sheet
// computes it, and overwriting it would break the copy.

import type { DateRule, InvoiceField, InvoiceSettings } from "./settings";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m, d));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

/** The date a rule gives on `today` (ISO, local). */
export function dateFor(rule: DateRule, today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  switch (rule) {
    case "today":
      return iso(y, m - 1, d);
    case "first_of_month":
      return iso(y, m - 1, 1);
    case "last_of_month":
      return iso(y, m, 0);
    case "first_of_prev_month":
      return iso(y, m - 2, 1);
    case "last_of_prev_month":
      return iso(y, m - 1, 0);
  }
}

/** The month a draft made on `today` is for ("YYYY-MM"): one draft per month. */
export const monthOf = (today: string) => today.slice(0, 7);

/** The draft's name: `<sheet> draft 2026-10 (Duck)`. */
export const draftTitle = (sheetName: string, month: string) => `${sheetName} draft ${month} (Duck)`;

/** A shown value as a number: `$1,200.50` → 1200.5; null when it isn't one. */
export function amountOf(shown: string): number | null {
  const s = shown.trim();
  const negative = /^\(.*\)$/.test(s) || s.includes("-");
  const digits = s.replace(/[^0-9.]/g, "");
  if (!/^\d*\.?\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

/** An amount as written into the cell: plain digits, at most 2 decimals. */
export const amountText = (n: number) => String(Math.round(n * 100) / 100);

const REF = /[A-Z]{1,3}[1-9][0-9]{0,6}/g;

/** The cells a `cells` formula reads. */
export function formulaRefs(formula: string): string[] {
  return [...new Set(formula.replace(/\$/g, "").match(REF) ?? [])];
}

/** `formula` over `values` (cell → number): + - * / and parentheses, nothing else.
 *  Throws on a cell without a number, a bad formula, or a division by zero. */
export function evalFormula(formula: string, values: (cell: string) => number | null): number {
  const tokens = formula.replace(/\$/g, "").match(/[A-Z]{1,3}[1-9][0-9]{0,6}|\d*\.?\d+|[-+*/()]|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const expr = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") v = tokens[i++] === "+" ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (peek() === "*" || peek() === "/") {
      if (tokens[i++] === "*") v *= unary();
      else {
        const d = unary();
        if (d === 0) throw new Error(`${formula} divides by zero`);
        v /= d;
      }
    }
    return v;
  };
  const unary = (): number => (peek() === "-" ? (i++, -unary()) : peek() === "+" ? (i++, unary()) : atom());
  const atom = (): number => {
    const t = tokens[i++];
    if (t === undefined) throw new Error(`${formula} ends too soon`);
    if (t === "(") {
      const v = expr();
      if (tokens[i++] !== ")") throw new Error(`${formula} is missing a ")"`);
      return v;
    }
    if (/^\d*\.?\d+$/.test(t)) return Number(t);
    if (/^[A-Z]/.test(t)) {
      const v = values(t);
      if (v === null) throw new Error(`${t} has no number in it`);
      return v;
    }
    throw new Error(`${formula} has "${t}" in it`);
  };
  const v = expr();
  if (i < tokens.length) throw new Error(`${formula} has "${tokens[i]}" in it`);
  return v;
}

/** A cell as the sheet has it now. */
export interface SheetCell {
  address: string;
  value: string;
  formula?: string;
}

/** One configured cell's change. */
export interface DraftChange {
  label: string;
  address: string;
  from: string;
  to: string;
}

export interface DraftPlan {
  month: string;
  title: string;
  /** The cells the draft sets (only those whose value changes). */
  changes: DraftChange[];
  /** Cells left as they are, and why. */
  kept: { label: string; address: string; why: string }[];
  /** The original's configured cells as read, which must still hold at copy time. */
  expect: { address: string; value: string }[];
}

/** The addresses to read for a plan: the configured cells and what their formulas use. */
export function cellsToRead(inv: InvoiceSettings): string[] {
  const out = new Set(inv.fields.map((f) => f.address));
  for (const f of inv.fields) if (f.kind === "amount" && f.rule === "cells" && f.formula) for (const r of formulaRefs(f.formula)) out.add(r);
  return [...out];
}

/** Amounts Duck has to ask the user for, by label. */
export const askedFields = (inv: InvoiceSettings) =>
  inv.fields.filter((f): f is Extract<InvoiceField, { kind: "amount" }> => f.kind === "amount" && f.rule === "ask");

/** This month's draft of `inv`, from the sheet's `cells` now. `answers` are the
 *  amounts for `ask` cells, by label (case-insensitive). Throws when an answer is
 *  missing or a formula can't be worked out. */
export function planDraft(
  inv: InvoiceSettings,
  sheetName: string,
  cells: SheetCell[],
  today: string,
  answers: Record<string, number> = {},
): DraftPlan {
  const month = monthOf(today);
  const now = new Map(cells.map((c) => [c.address, c]));
  const answer = (label: string) =>
    Object.entries(answers).find(([k]) => k.trim().toLowerCase() === label.toLowerCase())?.[1];
  const missing = askedFields(inv).filter((f) => answer(f.label) === undefined);
  if (missing.length)
    throw new Error(`ask the user for ${missing.map((f) => f.label).join(", ")} first, then pass it in amounts`);

  const next = new Map<string, string>();
  const plan = (f: InvoiceField): string | null => {
    if (f.kind === "date") return dateFor(f.rule, today);
    switch (f.rule) {
      case "fixed":
        return amountText(f.value ?? 0);
      case "ask":
        return amountText(answer(f.label)!);
      case "same_as_last":
        return null;
      case "cells":
        return amountText(
          evalFormula(f.formula ?? "", (cell) => {
            const v = next.get(cell) ?? now.get(cell)?.value;
            return v === undefined ? null : amountOf(v);
          }),
        );
    }
  };

  const changes: DraftChange[] = [];
  const kept: DraftPlan["kept"] = [];
  // Formulas last, so they see this draft's other amounts.
  const order = [...inv.fields].sort((a, b) => Number(isCells(a)) - Number(isCells(b)));
  for (const f of order) {
    const c = now.get(f.address);
    const from = c?.value ?? "";
    if (c?.formula) {
      kept.push({ label: f.label, address: f.address, why: `it holds a formula (${c.formula})` });
      continue;
    }
    const to = plan(f);
    if (to === null) {
      kept.push({ label: f.label, address: f.address, why: "same as last time" });
      continue;
    }
    next.set(f.address, to);
    if (same(from, to, f.kind)) kept.push({ label: f.label, address: f.address, why: "already that" });
    else changes.push({ label: f.label, address: f.address, from, to });
  }
  const byField = (a: { address: string }, b: { address: string }) =>
    inv.fields.findIndex((f) => f.address === a.address) - inv.fields.findIndex((f) => f.address === b.address);
  return {
    month,
    title: draftTitle(sheetName, month),
    changes: changes.sort(byField),
    kept: kept.sort(byField),
    expect: inv.fields.map((f) => ({ address: f.address, value: now.get(f.address)?.value ?? "" })),
  };
}

const isCells = (f: InvoiceField) => f.kind === "amount" && f.rule === "cells";

function same(from: string, to: string, kind: InvoiceField["kind"]): boolean {
  if (kind === "amount") {
    const a = amountOf(from);
    return a !== null && a === Number(to);
  }
  return from.trim() === to;
}

/** The card's line for a change: `Date (B2) 2026-09-01 → 2026-10-01`. */
export const changeLine = (c: DraftChange) => `${c.label} (${c.address}) ${c.from || "empty"} → ${c.to}`;
